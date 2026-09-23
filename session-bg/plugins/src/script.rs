use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime};

use mlua::{AnyUserData, HookTriggers, Lua, Table, Value, VmState};
use serde_json::Value as JsonValue;

use crate::api::{Fx, FxBuf};
use crate::effects::Effect;
use crate::frame::Glyph;
use crate::rng::Rng;
use crate::state::ScriptState;

const MEMORY_LIMIT: usize = 8 * 1024 * 1024;
const HOOK_STRIDE: u32 = 100_000;
const HOOK_BUDGET: u64 = 30;
const DEBOUNCE: Duration = Duration::from_millis(250);
const MAX_FAILURES: u32 = 3;

type Stamp = Option<(SystemTime, u64)>;

#[derive(Clone, Default)]
pub struct Reporter {
    dir: Option<PathBuf>,
}

impl Reporter {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self { dir }
    }

    pub fn from_env() -> Self {
        Self::new(std::env::var_os("SBG_STATE").map(PathBuf::from))
    }

    pub fn log(&self, message: &str) {
        let Some(dir) = &self.dir else { return };
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("fx.log"))
        {
            let _ = writeln!(file, "{:.3} {}", crate::state::now_secs(), message);
        }
    }

    pub fn error(&self, phase: &str, message: &str) {
        let message = message.trim();
        self.log(&format!("{phase}: {message}"));
        let Some(dir) = &self.dir else { return };
        let body = serde_json::json!({
            "ts": crate::state::now_secs(),
            "phase": phase,
            "message": message,
        });
        let tmp = dir.join("error.json.tmp");
        if std::fs::write(&tmp, body.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, dir.join("error.json"));
        }
    }

    pub fn clear(&self) {
        if let Some(dir) = &self.dir {
            let _ = std::fs::remove_file(dir.join("error.json"));
        }
    }

    pub fn runtime(&self, value: &JsonValue) {
        let Some(dir) = &self.dir else { return };
        let tmp = dir.join(format!(".runtime.{}.tmp", std::process::id()));
        if std::fs::write(&tmp, value.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, dir.join("runtime.json"));
        }
    }
}

struct Instance {
    lua: Lua,
    fx: AnyUserData,
    buf: Rc<RefCell<FxBuf>>,
    budget: Rc<Cell<u64>>,
    has_init: bool,
    has_resize: bool,
    has_step: bool,
    journey: RefCell<Option<Table>>,
    mood: RefCell<Option<Table>>,
}

fn json_to_lua(lua: &Lua, value: &JsonValue) -> mlua::Result<Value> {
    Ok(match value {
        JsonValue::Null => Value::Nil,
        JsonValue::Bool(b) => Value::Boolean(*b),
        JsonValue::Number(n) => match n.as_i64() {
            Some(i) => Value::Integer(i),
            None => Value::Number(n.as_f64().unwrap_or(0.0)),
        },
        JsonValue::String(s) => Value::String(lua.create_string(s)?),
        JsonValue::Array(items) => {
            let table = lua.create_table_with_capacity(items.len(), 0)?;
            for (i, item) in items.iter().enumerate() {
                table.set(i + 1, json_to_lua(lua, item)?)?;
            }
            Value::Table(table)
        }
        JsonValue::Object(map) => {
            let table = lua.create_table_with_capacity(0, map.len())?;
            for (key, item) in map {
                table.set(key.as_str(), json_to_lua(lua, item)?)?;
            }
            Value::Table(table)
        }
    })
}

// Return data only: bounded conversion, no Lua-selected filesystem path or I/O.
fn lua_to_json(value: Value, depth: usize, remaining: &mut usize) -> mlua::Result<JsonValue> {
    if depth > 20 || *remaining == 0 {
        return Err(mlua::Error::runtime("checkpoint too large"));
    }
    *remaining -= 1;
    Ok(match value {
        Value::Nil => JsonValue::Null,
        Value::Boolean(v) => JsonValue::Bool(v),
        Value::Integer(v) => JsonValue::from(v),
        Value::Number(v) => JsonValue::from(v),
        Value::String(v) => JsonValue::String(v.to_str()?.to_string()),
        Value::Table(t) => {
            if t.raw_len() > 0 {
                let mut items = Vec::new();
                for item in t.sequence_values::<Value>() {
                    items.push(lua_to_json(item?, depth + 1, remaining)?);
                }
                JsonValue::Array(items)
            } else {
                let mut map = serde_json::Map::new();
                for pair in t.pairs::<String, Value>() {
                    let (key, value) = pair?;
                    map.insert(key, lua_to_json(value, depth + 1, remaining)?);
                }
                JsonValue::Object(map)
            }
        }
        _ => {
            return Err(mlua::Error::runtime(
                "checkpoint contains executable values",
            ))
        }
    })
}

fn json_to_table(lua: &Lua, value: Option<&JsonValue>) -> mlua::Result<Table> {
    match value.map(|v| json_to_lua(lua, v)).transpose()? {
        Some(Value::Table(table)) => Ok(table),
        _ => lua.create_table(),
    }
}

const ALLOWED: &[&str] = &[
    "math",
    "string",
    "table",
    "select",
    "ipairs",
    "pairs",
    "next",
    "type",
    "tostring",
    "tonumber",
    "error",
    "assert",
    "pcall",
    "xpcall",
    "rawget",
    "rawset",
    "rawequal",
    "rawlen",
    "setmetatable",
    "getmetatable",
    "sbg",
    "_G",
    "_VERSION",
];

fn sandbox(lua: &Lua) -> mlua::Result<()> {
    let globals = lua.globals();
    let mut removed = Vec::new();
    for pair in globals.pairs::<Value, Value>() {
        let (key, _) = pair?;
        let keep = match &key {
            Value::String(name) => name
                .to_str()
                .map(|name| ALLOWED.contains(&&*name))
                .unwrap_or(false),
            _ => false,
        };
        if !keep {
            removed.push(key);
        }
    }
    for key in removed {
        globals.set(key, Value::Nil)?;
    }
    if let Ok(table) = globals.get::<Table>("table") {
        if let Ok(unpack) = table.get::<Value>("unpack") {
            globals.set("unpack", unpack)?;
        }
    }
    Ok(())
}

impl Instance {
    fn load(source: &str, name: &str) -> Result<Self, String> {
        let lua = Lua::new();
        let _ = lua.set_memory_limit(MEMORY_LIMIT);
        let budget = Rc::new(Cell::new(0u64));
        let counter = Rc::clone(&budget);
        lua.set_hook(
            HookTriggers::new().every_nth_instruction(HOOK_STRIDE),
            move |_, _| {
                let used = counter.get() + 1;
                counter.set(used);
                if used > HOOK_BUDGET {
                    Err(mlua::Error::RuntimeError(
                        "sbg: script exceeded its per-frame instruction budget".to_owned(),
                    ))
                } else {
                    Ok(VmState::Continue)
                }
            },
        );
        let fx = crate::api::install(&lua).map_err(|e| e.to_string())?;
        sandbox(&lua).map_err(|e| e.to_string())?;
        let buf = fx.borrow::<Fx>().map_err(|e| e.to_string())?.0.clone();
        budget.set(0);
        lua.load(source)
            .set_name(name)
            .exec()
            .map_err(|e| e.to_string())?;
        let globals = lua.globals();
        let has = |key: &str| matches!(globals.get::<Value>(key), Ok(Value::Function(_)));
        if !has("render") {
            return Err("sbg: script defines no render(fx, state) function".to_owned());
        }
        Ok(Self {
            has_init: has("init"),
            has_resize: has("resize"),
            has_step: has("step"),
            fx,
            buf,
            budget,
            lua,
            journey: RefCell::new(None),
            mood: RefCell::new(None),
        })
    }

    fn function(&self, name: &str) -> Option<mlua::Function> {
        self.lua.globals().get::<mlua::Function>(name).ok()
    }

    fn generic_tables(&self, state: &ScriptState) -> mlua::Result<(Table, Table)> {
        if state.changed || self.journey.borrow().is_none() {
            let journey = json_to_table(&self.lua, state.journey.as_ref())?;
            let mood = json_to_table(&self.lua, state.mood.as_ref())?;
            *self.journey.borrow_mut() = Some(journey);
            *self.mood.borrow_mut() = Some(mood);
        }
        let journey = self.journey.borrow().clone().expect("journey cached");
        let mood = self.mood.borrow().clone().expect("mood cached");
        Ok((journey, mood))
    }

    fn state_table(&self, state: &ScriptState) -> mlua::Result<Table> {
        let table = self.lua.create_table()?;
        table.set("mode", state.mode.as_str())?;
        table.set("session_name", state.session_name.as_str())?;
        table.set("tool", state.tool.as_str())?;
        table.set("tool_kind", state.tool_kind.as_str())?;
        table.set("agent", state.agent.as_str())?;
        table.set("context_pct", state.context_pct)?;
        table.set("cost", state.cost)?;
        table.set("model", state.model.as_str())?;
        table.set("prompt", state.prompt.as_str())?;
        table.set("age", state.age)?;
        table.set("changed", state.changed)?;
        let m = self.lua.create_table()?;
        m.set("speed", state.modulation.speed)?;
        m.set("density", state.modulation.density)?;
        m.set("hue", state.modulation.hue)?;
        m.set("bright", state.modulation.bright)?;
        m.set("burst", state.modulation.burst)?;
        table.set("mod", m)?;
        let params = self.lua.create_table()?;
        params.set("density", state.params.density)?;
        params.set("speed", state.params.speed)?;
        params.set("hue", state.params.hue)?;
        params.set("opacity", state.params.opacity)?;
        params.set("palette", state.params.palette.as_str())?;
        params.set("fortress", state.params.fortress.as_str())?;
        params.set("difficulty", state.params.difficulty.as_str())?;
        params.set("paused", state.params.paused)?;
        params.set("presentation", state.params.presentation.as_str())?;
        params.set("reduced_motion", state.params.reduced_motion)?;
        params.set("scene", state.params.scene.as_str())?;
        params.set("glyphs", state.params.glyphs.as_str())?;
        table.set("params", params)?;
        table.set("lines_added", state.lines_added as i64)?;
        table.set("lines_removed", state.lines_removed as i64)?;
        table.set("duration", state.duration)?;
        table.set("branch", state.branch.as_str())?;
        table.set("effort", state.effort.as_str())?;
        let (journey, mood) = self.generic_tables(state)?;
        table.set("journey", journey)?;
        table.set("mood", mood)?;
        Ok(table)
    }

    fn init(
        &self,
        width: u16,
        height: u16,
        seed: u64,
        density: f32,
        fps: f32,
    ) -> Result<(), String> {
        {
            let mut buf = self.buf.borrow_mut();
            buf.width = width;
            buf.height = height;
            buf.glyphs.clear();
        }
        let name = if self.has_resize { "resize" } else { "init" };
        if name == "init" && !self.has_init {
            return Ok(());
        }
        let Some(function) = self.function(name) else {
            return Ok(());
        };
        let ctx = self.lua.create_table().map_err(|e| e.to_string())?;
        let build = || -> mlua::Result<()> {
            ctx.set("w", width)?;
            ctx.set("h", height)?;
            ctx.set("seed", seed as i64)?;
            ctx.set("density", density)?;
            ctx.set("fps", fps)?;
            Ok(())
        };
        build().map_err(|e| e.to_string())?;
        self.budget.set(0);
        function.call::<()>(ctx).map_err(|e| e.to_string())
    }

    fn step(&self, dt: f32, state: &ScriptState) -> Result<(), String> {
        if !self.has_step {
            return Ok(());
        }
        let Some(function) = self.function("step") else {
            return Ok(());
        };
        let table = self.state_table(state).map_err(|e| e.to_string())?;
        self.budget.set(0);
        function.call::<()>((dt, table)).map_err(|e| e.to_string())
    }

    fn render(&self, state: &ScriptState) -> Result<(), String> {
        let Some(function) = self.function("render") else {
            return Err("sbg: script lost its render function".to_owned());
        };
        self.buf.borrow_mut().glyphs.clear();
        let table = self.state_table(state).map_err(|e| e.to_string())?;
        self.budget.set(0);
        function
            .call::<()>((self.fx.clone(), table))
            .map_err(|e| e.to_string())
    }
}

pub struct ScriptEffect {
    path: PathBuf,
    source: String,
    good: Option<String>,
    instance: Option<Instance>,
    reporter: Reporter,
    seed: u64,
    density: f32,
    fps: f32,
    width: u16,
    height: u16,
    state: ScriptState,
    failures: u32,
    step_failed: bool,
    outstanding: Option<&'static str>,
    dead: bool,
    stamp: Stamp,
    pending: Option<(Instant, Stamp)>,
    last_checkpoint: Option<Instant>,
}

fn stamp_of(path: &Path) -> Stamp {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

impl ScriptEffect {
    pub fn load(path: &Path, seed: u64, density: f32, fps: f32) -> Result<Self, String> {
        let source =
            std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let name = path.display().to_string();
        let instance = Instance::load(&source, &name)?;
        Ok(Self {
            path: path.to_path_buf(),
            good: None,
            source,
            instance: Some(instance),
            reporter: Reporter::default(),
            seed,
            density: density.clamp(0.1, 3.0),
            fps,
            width: 0,
            height: 0,
            state: ScriptState::default(),
            failures: 0,
            step_failed: false,
            outstanding: None,
            dead: false,
            stamp: stamp_of(path),
            pending: None,
            last_checkpoint: None,
        })
    }

    pub fn with_reporter(mut self, reporter: Reporter) -> Self {
        self.reporter = reporter;
        // A newly loaded instance may be replacing a failed one. Clear its
        // persisted error only after this instance completes a whole frame.
        self.outstanding = Some("recovery");
        self
    }

    fn restore_checkpoint(&self) {
        let (Some(instance), Some(dir)) = (&self.instance, &self.reporter.dir) else {
            return;
        };
        let Some(restore) = instance.function("restore") else {
            return;
        };
        let path = dir.join("fortress.json");
        if std::fs::metadata(&path).map_or(true, |m| m.len() > 256 * 1024) {
            return;
        }
        let Some(data) = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<JsonValue>(&s).ok())
        else {
            return;
        };
        instance.budget.set(0);
        if let Ok(value) = json_to_lua(&instance.lua, &data) {
            if let Err(e) = restore.call::<()>(value) {
                self.reporter.log(&format!("checkpoint restore: {e}"));
            }
        }
    }

    fn save_checkpoint(&mut self) {
        if self
            .last_checkpoint
            .is_some_and(|t| t.elapsed() < Duration::from_secs(1))
        {
            return;
        }
        let (Some(instance), Some(dir)) = (&self.instance, &self.reporter.dir) else {
            return;
        };
        let Some(export) = instance.function("checkpoint") else {
            return;
        };
        self.last_checkpoint = Some(Instant::now());
        instance.budget.set(0);
        let result = export
            .call::<Value>(())
            .and_then(|v| lua_to_json(v, 0, &mut 20000));
        match result {
            Ok(value) if value.is_object() => {
                let body = value.to_string();
                if body.len() > 256 * 1024 {
                    self.reporter.log("checkpoint exceeds 256 KiB");
                    return;
                }
                for (name, data) in [("fortress.json", body), ("legends.json", serde_json::json!({
                    "schema_version": 2, "seq": value.get("seq"), "legends": value.get("legends"), "summary": value.get("summary")
                }).to_string())] {
                    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
                    if std::fs::write(&tmp, data).is_ok() { let _ = std::fs::rename(&tmp, dir.join(name)); }
                }
            }
            Err(e) => self.reporter.log(&format!("checkpoint: {e}")),
            _ => {}
        }
    }

    fn succeed(&mut self) {
        self.failures = 0;
        if self.good.as_deref() != Some(self.source.as_str()) {
            self.good = Some(self.source.clone());
        }
        if matches!(self.outstanding, Some(phase) if phase != "compile") {
            self.outstanding = None;
            self.reporter.clear();
        }
    }

    fn fail(&mut self, phase: &'static str, message: &str) {
        self.failures += 1;
        self.outstanding = Some(phase);
        self.reporter.error(phase, message);
        if self.failures >= MAX_FAILURES {
            self.recover();
        }
    }

    fn recover(&mut self) {
        let candidate = self
            .good
            .clone()
            .filter(|good| good.as_str() != self.source.as_str());
        let Some(source) = candidate else {
            self.dead = true;
            self.instance = None;
            self.reporter
                .log("giving up on the script and falling back to the builtin effect");
            return;
        };
        match Instance::load(&source, &self.path.display().to_string()) {
            Ok(instance) => {
                self.source = source;
                self.instance = Some(instance);
                self.failures = 0;
                self.outstanding = None;
                self.reporter.clear();
                self.reporter.log("reverted to the last good script");
                self.init_instance();
            }
            Err(_) => {
                self.dead = true;
                self.instance = None;
            }
        }
    }

    fn init_instance(&mut self) {
        if self.width == 0 || self.height == 0 {
            return;
        }
        let result = match &self.instance {
            Some(instance) => {
                instance.init(self.width, self.height, self.seed, self.density, self.fps)
            }
            None => return,
        };
        if let Err(message) = result {
            // Retrying step/render cannot repair an invalid initial state.
            // Restore the last proved source, or let the host back off.
            self.outstanding = Some("init");
            self.reporter.error("init", &message);
            self.recover();
        } else {
            // A successful init does not prove that step/render works. Keep
            // the last fully rendered source available for runtime rollback.
            self.restore_checkpoint();
        }
    }

    fn maybe_reload(&mut self) {
        let stamp = stamp_of(&self.path);
        if stamp != self.stamp {
            self.stamp = stamp;
            if stamp.is_some() {
                self.pending = Some((Instant::now(), stamp));
            }
            return;
        }
        let Some((since, pending)) = self.pending else {
            return;
        };
        if pending != stamp || since.elapsed() < DEBOUNCE {
            return;
        }
        self.pending = None;
        let source = match std::fs::read_to_string(&self.path) {
            Ok(source) => source,
            Err(error) => {
                self.reporter.error("compile", &error.to_string());
                self.outstanding = Some("compile");
                return;
            }
        };
        if source == self.source && self.instance.is_some() {
            return;
        }
        match Instance::load(&source, &self.path.display().to_string()) {
            Ok(instance) => {
                self.source = source;
                self.instance = Some(instance);
                self.failures = 0;
                self.dead = false;
                self.outstanding = None;
                self.reporter.clear();
                self.reporter.log("reloaded script");
                self.init_instance();
            }
            Err(message) => {
                self.reporter.error("compile", &message);
                self.outstanding = Some("compile");
            }
        }
    }
}

impl Effect for ScriptEffect {
    fn resize(&mut self, width: u16, height: u16, _rng: &mut Rng) {
        self.width = width;
        self.height = height;
        self.init_instance();
    }

    fn set_density(&mut self, density: f32) {
        self.density = density.clamp(0.1, 3.0);
    }

    fn set_state(&mut self, state: &ScriptState) {
        self.state = state.clone();
    }

    fn failed(&self) -> bool {
        self.dead
    }

    fn foreground_halo(&self) -> u16 {
        self.instance
            .as_ref()
            .and_then(|i| i.function("foreground_halo"))
            .and_then(|f| f.call::<u16>(()).ok())
            .unwrap_or(0)
            .min(1)
    }

    fn step(&mut self, dt: f32, _rng: &mut Rng) {
        self.step_failed = false;
        self.maybe_reload();
        let result = match &self.instance {
            Some(instance) => instance.step(dt, &self.state),
            None => return,
        };
        match result {
            Ok(()) => {
                self.save_checkpoint();
            }
            Err(message) => {
                self.step_failed = true;
                self.fail("step", &message);
            }
        }
    }

    fn render(&mut self, out: &mut Vec<Glyph>) {
        let result = match &self.instance {
            Some(instance) => {
                let result = instance.render(&self.state);
                out.extend(instance.buf.borrow().glyphs.iter().copied());
                for ch in instance.buf.borrow_mut().substituted.drain(..) {
                    self.reporter.log(&format!(
                        "glyph U+{:04X} replaced with ASCII fallback",
                        ch as u32
                    ));
                }
                result
            }
            None => return,
        };
        match result {
            Ok(()) if !self.step_failed => self.succeed(),
            Err(message) if !self.step_failed => self.fail("render", &message),
            _ => (), // Count a failed step/render pair once, and retain its error.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::Occupancy;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("sbg-script-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("scratch dir");
            Self(dir)
        }

        fn write(&self, name: &str, body: &str) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, body).expect("write script");
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const PLASMA: &str = r#"
local t = 0
local w, h = 0, 0
function init(ctx)
  w, h = ctx.w, ctx.h
  t = 0
end
function step(dt, state)
  t = t + dt
end
function render(fx, state)
  for y = 0, h - 1 do
    for x = 0, w - 1 do
      local n = sbg.noise3(x * 0.1, y * 0.2, t)
      if n > 0.3 then
        local r, g, b = sbg.ramp("ice", n)
        fx:put(x, y, sbg.glyphs.ascii[1 + math.floor(n * 8)], r, g, b)
      end
    end
  end
end
"#;

    fn run(path: &Path, frames: usize, w: u16, h: u16) -> Vec<Glyph> {
        let mut effect = ScriptEffect::load(path, 7, 1.0, 12.0).expect("script loads");
        let mut rng = Rng::new(7);
        effect.resize(w, h, &mut rng);
        for _ in 0..frames {
            effect.step(1.0 / 12.0, &mut rng);
        }
        let mut out = Vec::new();
        effect.render(&mut out);
        out
    }

    #[test]
    fn a_valid_script_renders_deterministic_in_bounds_glyphs() {
        let scratch = Scratch::new("valid");
        let path = scratch.write("plasma.lua", PLASMA);
        let a = run(&path, 6, 60, 20);
        let b = run(&path, 6, 60, 20);
        assert!(!a.is_empty(), "script rendered nothing");
        assert_eq!(a, b, "script output is not deterministic");
        assert!(
            a.iter().all(|g| g.x < 60 && g.y < 20),
            "script drew out of bounds"
        );
        let free = crate::effects::visible(&a, &Occupancy::new(60, 20));
        assert!(!free.is_empty());
    }

    #[test]
    fn the_sandbox_denies_host_access() {
        let scratch = Scratch::new("sandbox");
        for (name, body) in [
            ("io", "local f = io.open('/etc/passwd')"),
            ("os", "local v = os.getenv('HOME')"),
            ("require", "require('os')"),
            ("load", "load('return 1')()"),
            ("loadstring", "loadstring('return 1')()"),
            ("dofile", "dofile('/etc/passwd')"),
            ("debug", "debug.getinfo(1)"),
            ("coroutine", "coroutine.create(function() end)"),
        ] {
            let path = scratch.write(
                &format!("{name}.lua"),
                &format!("function render(fx, state)\n{body}\nend\n"),
            );
            let mut effect = ScriptEffect::load(&path, 1, 1.0, 12.0).expect("loads");
            let mut rng = Rng::new(1);
            effect.resize(10, 5, &mut rng);
            let mut out = Vec::new();
            effect.render(&mut out);
            assert!(out.is_empty(), "{name} produced output");
            assert!(effect.failures > 0, "{name} did not fail");
        }
    }

    #[test]
    fn a_runaway_loop_is_aborted_within_a_frame() {
        let scratch = Scratch::new("runaway");
        let path = scratch.write(
            "spin.lua",
            "function render(fx, state)\nwhile true do end\nend\n",
        );
        let mut effect = ScriptEffect::load(&path, 1, 1.0, 12.0)
            .expect("loads")
            .with_reporter(Reporter::new(Some(scratch.0.clone())));
        let mut rng = Rng::new(1);
        effect.resize(40, 10, &mut rng);
        let started = Instant::now();
        let mut out = Vec::new();
        effect.render(&mut out);
        let elapsed = started.elapsed();
        assert!(elapsed < Duration::from_secs(2), "runaway took {elapsed:?}");
        assert!(scratch.0.join("error.json").is_file(), "no error recorded");
    }

    #[test]
    fn a_memory_bomb_hits_the_limit_without_panicking() {
        let scratch = Scratch::new("memory");
        let path = scratch.write(
            "bomb.lua",
            "function render(fx, state)\nlocal t = {}\nwhile true do t[#t+1] = string.rep('x', 1000000) end\nend\n",
        );
        let mut effect = ScriptEffect::load(&path, 1, 1.0, 12.0).expect("loads");
        let mut rng = Rng::new(1);
        effect.resize(40, 10, &mut rng);
        let mut out = Vec::new();
        effect.render(&mut out);
        assert!(out.is_empty());
        assert!(effect.failures > 0, "memory bomb was not reported");
    }

    #[test]
    fn put_ignores_garbage_arguments() {
        let scratch = Scratch::new("garbage");
        let path = scratch.write(
            "garbage.lua",
            r#"
function render(fx, state)
  fx:put()
  fx:put(nil, nil, nil, nil, nil, nil)
  fx:put(0/0, 1, "x", 1, 1, 1)
  fx:put(1, 1, "x", 0/0, 1, 1)
  fx:put(9999, 9999, "x", 1, 1, 1)
  fx:put(-1, -1, "x", 1, 1, 1)
  fx:put(2, 2, "multi", 1, 1, 1)
  fx:put(2, 2, "", 1, 1, 1)
  fx:put(2, 2, 5, 1, 1, 1)
  fx:put(3, 3, "ok", 1, 1, 1)
  fx:put(3.9, 3.2, "@", 2, -5, 0.5)
  if fx:count() ~= 1 then error("expected one glyph, got " .. fx:count()) end
end
"#,
        );
        let out = run(&path, 0, 20, 10);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].ch, '@');
        assert_eq!((out[0].x, out[0].y), (3, 3));
        assert_eq!(out[0].rgb, [1.0, 0.0, 0.5]);
    }

    #[test]
    fn hot_reload_keeps_the_last_good_script_and_records_the_error() {
        let scratch = Scratch::new("reload");
        let path = scratch.write(
            "live.lua",
            "function render(fx, state)\nfx:put(0, 0, '@', 1, 1, 1)\nend\n",
        );
        let reporter = Reporter::new(Some(scratch.0.clone()));
        let mut effect = ScriptEffect::load(&path, 1, 1.0, 12.0)
            .expect("loads")
            .with_reporter(reporter);
        let mut rng = Rng::new(1);
        effect.resize(20, 10, &mut rng);
        let mut out = Vec::new();
        effect.step(0.08, &mut rng);
        effect.render(&mut out);
        assert_eq!(out.len(), 1);

        std::fs::write(&path, "function render(fx, state) this is not lua end").unwrap();
        effect.step(0.08, &mut rng);
        std::thread::sleep(DEBOUNCE + Duration::from_millis(30));
        effect.step(0.08, &mut rng);
        out.clear();
        effect.render(&mut out);
        assert_eq!(out.len(), 1, "broken reload replaced the running script");
        assert_eq!(out[0].ch, '@');
        assert!(
            scratch.0.join("error.json").is_file(),
            "no error.json written"
        );

        std::fs::write(
            &path,
            "function render(fx, state)\nfx:put(1, 1, '#', 1, 1, 1)\nend\n",
        )
        .unwrap();
        effect.step(0.08, &mut rng);
        std::thread::sleep(DEBOUNCE + Duration::from_millis(30));
        effect.step(0.08, &mut rng);
        out.clear();
        effect.render(&mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].ch, '#', "good reload did not swap");
        assert!(
            !scratch.0.join("error.json").exists(),
            "error.json survived a good reload"
        );
    }

    #[test]
    fn a_broken_frame_three_times_falls_back() {
        let scratch = Scratch::new("fallback");
        let path = scratch.write(
            "bad.lua",
            "function render(fx, state)\nerror('boom')\nend\n",
        );
        let mut effect = ScriptEffect::load(&path, 1, 1.0, 12.0).expect("loads");
        let mut rng = Rng::new(1);
        effect.resize(20, 10, &mut rng);
        let mut out = Vec::new();
        for _ in 0..3 {
            effect.render(&mut out);
        }
        assert!(
            effect.failed(),
            "three failing frames did not request a fallback"
        );
    }

    #[test]
    fn a_successful_half_frame_does_not_hide_repeated_failures() {
        for (tag, source) in [
            ("bad-step", "function step() error('step fault') end\nfunction render() end"),
            ("bad-render", "function step() end\nfunction render() error('render fault') end"),
            ("both-bad", "function step() error('step fault') end\nfunction render() error('render fault') end"),
        ] {
            let scratch = Scratch::new(tag);
            let path = scratch.write("effect.lua", source);
            let mut effect = ScriptEffect::load(&path, 1, 1.0, 12.0).unwrap()
                .with_reporter(Reporter::new(Some(scratch.0.clone())));
            let mut rng = Rng::new(1);
            effect.resize(20, 10, &mut rng);
            for i in 0..3 {
                effect.step(0.08, &mut rng);
                effect.render(&mut Vec::new());
                assert!(scratch.0.join("error.json").exists(), "{tag}: error cleared");
                assert_eq!(effect.failed(), i == 2, "{tag}: failure must count whole frames");
            }
        }
    }

    #[test]
    fn invalid_init_is_not_hidden_by_a_successful_render() {
        let scratch = Scratch::new("bad-init");
        let path = scratch.write(
            "effect.lua",
            "function init() error('init fault') end\nfunction render() end",
        );
        let mut effect = ScriptEffect::load(&path, 1, 1.0, 12.0)
            .unwrap()
            .with_reporter(Reporter::new(Some(scratch.0.clone())));
        effect.resize(20, 10, &mut Rng::new(1));
        effect.render(&mut Vec::new());
        assert!(effect.failed());
        let error: JsonValue =
            serde_json::from_str(&std::fs::read_to_string(scratch.0.join("error.json")).unwrap())
                .unwrap();
        assert_eq!(error["phase"], "init");
    }

    #[test]
    fn runtime_failure_after_valid_reload_restores_the_last_rendered_source() {
        let scratch = Scratch::new("runtime-rollback");
        let path = scratch.write(
            "effect.lua",
            "function render(fx) fx:put(1,1,'@',1,1,1) end",
        );
        let mut effect = ScriptEffect::load(&path, 1, 1.0, 12.0).unwrap();
        let mut rng = Rng::new(1);
        effect.resize(20, 10, &mut rng);
        effect.render(&mut Vec::new());
        std::fs::write(
            &path,
            "function step() end\nfunction render() error('bad reload') end",
        )
        .unwrap();
        effect.step(0.08, &mut rng);
        std::thread::sleep(DEBOUNCE + Duration::from_millis(30));
        for _ in 0..3 {
            effect.step(0.08, &mut rng);
            effect.render(&mut Vec::new());
        }
        assert!(
            !effect.failed(),
            "last good source should survive a runtime-broken reload"
        );
        let mut out = Vec::new();
        effect.step(0.08, &mut rng);
        effect.render(&mut out);
        assert_eq!(out[0].ch, '@');
    }

    #[test]
    fn a_full_grid_script_is_fast() {
        let scratch = Scratch::new("bench");
        let path = scratch.write(
            "full.lua",
            r#"
local t = 0
local w, h = 0, 0
function init(ctx) w, h = ctx.w, ctx.h end
function step(dt, state) t = t + dt end
function render(fx, state)
  for y = 0, h - 1 do
    for x = 0, w - 1 do
      local n = 0.5 + 0.5 * math.sin(x * 0.2 + t) * math.cos(y * 0.3 - t)
      local r, g, b = sbg.ramp("tokyonight", n)
      fx:put(x, y, sbg.glyphs.shades[1 + math.floor(n * 3)], r, g, b)
    end
  end
end
"#,
        );
        let mut effect = ScriptEffect::load(&path, 1, 1.0, 12.0).expect("loads");
        let mut rng = Rng::new(1);
        effect.resize(200, 60, &mut rng);
        let mut out = Vec::new();
        let mut samples = Vec::new();
        for _ in 0..24 {
            let started = Instant::now();
            effect.step(1.0 / 12.0, &mut rng);
            out.clear();
            effect.render(&mut out);
            samples.push(started.elapsed());
        }
        assert_eq!(out.len(), 200 * 60);
        samples.sort_unstable();
        let p50 = samples[samples.len() / 2];
        let p95 = samples[samples.len() * 95 / 100];
        println!("full-grid script p50 {p50:?} p95 {p95:?}");
        if cfg!(debug_assertions) {
            assert!(p95 < Duration::from_millis(200), "debug p95 {p95:?}");
        } else {
            assert!(p95 < Duration::from_millis(8), "release p95 {p95:?}");
        }
    }

    fn build_script_state(state_dir: &Path) -> ScriptState {
        let mut watcher = crate::state::Watcher::new(Some(state_dir.to_path_buf()));
        let snapshot = watcher.poll().clone();
        let modulation = crate::state::modulation(&snapshot, 0.0, 0.0);
        crate::state::script_state(&snapshot, &modulation, 0.0)
    }

    #[test]
    fn journey_and_mood_round_trip_into_lua() {
        let scratch = Scratch::new("journey");
        let state_dir = scratch.0.join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(
            state_dir.join("journey.json"),
            r#"{"tools":["exec","edit","web"]}"#,
        )
        .unwrap();
        std::fs::write(state_dir.join("mood.json"), r#"{"title":"calm"}"#).unwrap();
        let script_state = build_script_state(&state_dir);

        let path = scratch.write(
            "journey.lua",
            r##"
function render(fx, state)
  local tools = state.journey.tools or {}
  for i = 1, #tools do
    fx:put(i - 1, 0, "#", 1, 1, 1)
  end
  sbg.text(fx, 0, 1, state.mood.title or "", 1, 1, 1)
end
"##,
        );
        let mut effect = ScriptEffect::load(&path, 1, 1.0, 12.0).expect("loads");
        let mut rng = Rng::new(1);
        effect.resize(20, 10, &mut rng);
        effect.set_state(&script_state);
        let mut out = Vec::new();
        effect.render(&mut out);

        let hashes = out.iter().filter(|g| g.ch == '#').count();
        assert_eq!(hashes, 3, "expected one # per journey tool");
        let mut title: Vec<(u16, char)> = out
            .iter()
            .filter(|g| g.y == 1)
            .map(|g| (g.x, g.ch))
            .collect();
        title.sort_by_key(|(x, _)| *x);
        let text: String = title.into_iter().map(|(_, c)| c).collect();
        assert_eq!(text, "calm");
    }

    #[test]
    fn effort_and_glyphs_reach_lua() {
        let scratch = Scratch::new("effort");
        let state_dir = scratch.0.join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        std::fs::write(state_dir.join("status.json"), r#"{"effort":"xhigh"}"#).unwrap();
        std::fs::write(
            state_dir.join("override.json"),
            r#"{"params":{"glyphs":"ascii"}}"#,
        )
        .unwrap();
        let script_state = build_script_state(&state_dir);
        let path = scratch.write(
            "effort.lua",
            r#"
function render(fx, state)
  sbg.text(fx, 0, 0, state.effort .. ":" .. state.params.glyphs, 1, 1, 1)
end
"#,
        );
        let mut effect = ScriptEffect::load(&path, 1, 1.0, 12.0).expect("loads");
        let mut rng = Rng::new(1);
        effect.resize(20, 2, &mut rng);
        effect.set_state(&script_state);
        let mut out = Vec::new();
        effect.render(&mut out);
        out.sort_by_key(|g| g.x);
        let text: String = out.iter().map(|g| g.ch).collect();
        assert_eq!(text, "xhigh:ascii");
    }

    #[test]
    fn missing_journey_and_mood_yield_empty_tables_without_erroring() {
        let scratch = Scratch::new("journey-missing");
        let state_dir = scratch.0.join("state");
        std::fs::create_dir_all(&state_dir).unwrap();
        let script_state = build_script_state(&state_dir);

        let path = scratch.write(
            "missing.lua",
            r#"
function render(fx, state)
  local recent = state.journey.recent or {}
  fx:put(0, 0, tostring(#recent), 1, 1, 1)
  if next(state.mood) ~= nil then error("mood should be empty") end
end
"#,
        );
        let mut effect = ScriptEffect::load(&path, 1, 1.0, 12.0).expect("loads");
        let mut rng = Rng::new(1);
        effect.resize(20, 10, &mut rng);
        effect.set_state(&script_state);
        let mut out = Vec::new();
        effect.render(&mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].ch, '0');
    }

    #[test]
    fn text_clips_at_the_right_edge_without_panicking() {
        let scratch = Scratch::new("text-clip");
        let path = scratch.write(
            "clip.lua",
            r#"
function render(fx, state)
  local n = sbg.text(fx, 8, 0, "hello world", 1, 1, 1)
  fx:put(0, 1, tostring(n), 1, 1, 1)
  local c = sbg.text_center(fx, 2, "a very long centered line", 0.5, 0.5, 0.5)
  fx:put(0, 3, tostring(c), 1, 1, 1)
end
"#,
        );
        let out = run(&path, 0, 10, 5);
        assert!(!out.is_empty());
        let n: i64 = out
            .iter()
            .find(|g| g.y == 1)
            .map(|g| g.ch.to_digit(10).unwrap() as i64)
            .unwrap();
        assert_eq!(n, 2, "only two cells of the clipped string should fit");
    }

    #[test]
    fn hash_and_pick_are_deterministic() {
        let scratch = Scratch::new("hash");
        let path = scratch.write(
            "hash.lua",
            r#"
function render(fx, state)
  local h1 = sbg.hash("hello")
  local h2 = sbg.hash("hello")
  if h1 ~= h2 then error("hash not deterministic") end
  local list = {"a", "b", "c", "d"}
  local p1 = sbg.pick(list, "session-key")
  local p2 = sbg.pick(list, "session-key")
  if p1 ~= p2 then error("pick not deterministic") end
  sbg.text(fx, 0, 0, p1, 1, 1, 1)
end
"#,
        );
        let out = run(&path, 0, 10, 5);
        assert_eq!(out.len(), 1);
    }
    #[test]
    fn glyph_gate_and_foreground_halo_protect_the_grid() {
        for &ch in crate::frame::FORTRESS_GLYPHS {
            assert_eq!(crate::frame::safe_glyph(ch), ch);
        }
        for ch in ['☕', '界', '😀', '\u{0301}', '\u{001b}'] {
            assert_eq!(crate::frame::safe_glyph(ch), '?');
        }
        for ch in ['─', '⣀', 'ｱ'] {
            assert_eq!(crate::frame::safe_glyph(ch), ch);
        }
        let scratch = Scratch::new("glyph-gate");
        let path = scratch.write("wide.lua", "function render(fx) fx:put(0,0,'界',1,1,1) end");
        let mut effect = ScriptEffect::load(&path, 1, 1.0, 12.0)
            .unwrap()
            .with_reporter(Reporter::new(Some(scratch.0.clone())));
        effect.resize(10, 5, &mut Rng::new(1));
        let mut glyphs = Vec::new();
        effect.render(&mut glyphs);
        effect.render(&mut glyphs);
        assert!(glyphs.iter().all(|g| g.ch == '?'));
        let log = std::fs::read_to_string(scratch.0.join("fx.log")).unwrap();
        assert_eq!(log.matches("U+754C").count(), 1);
        let mut occupancy = Occupancy::new(10, 5);
        occupancy.set(4, 2);
        for y in 1..=3 {
            for x in 3..=5 {
                assert!(!occupancy.is_free_with_halo(x, y, 1));
            }
        }
        assert!(occupancy.is_free_with_halo(2, 2, 1));
    }

    #[test]
    fn fortress_checkpoint_resize_and_release_frame_budget() {
        let scratch = Scratch::new("fortress");
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("fx/fortress.lua");
        let mut effect = ScriptEffect::load(&path, 1, 1.0, 12.0)
            .unwrap()
            .with_reporter(Reporter::new(Some(scratch.0.clone())));
        let mut rng = Rng::new(1);
        effect.resize(200, 60, &mut rng);
        let mut state = ScriptState {
            changed: true,
            mode: "tool".into(),
            journey: Some(serde_json::json!({
                "repo":"test","tools":500,"subagents":11,"compactions":2
            })),
            params: crate::state::Params {
                scene: "settlement".into(),
                ..crate::state::Params::default()
            },
            ..ScriptState::default()
        };
        effect.set_state(&state);
        effect.step(0.25, &mut rng);
        let mut glyphs = Vec::new();
        effect.render(&mut glyphs);
        assert!(!effect.failed());
        assert!(!glyphs.is_empty());
        assert!(glyphs.len() <= 3000);
        assert!(glyphs
            .iter()
            .all(|g| g.ch.is_ascii() && g.x < 200 && g.y < 60));
        assert!(glyphs.iter().any(|g| g.x >= 36 && g.x < 164));
        assert_eq!(effect.foreground_halo(), 1);
        let checkpoint = std::fs::read_to_string(scratch.0.join("fortress.json")).unwrap();
        let mut data: JsonValue = serde_json::from_str(&checkpoint).unwrap();
        assert_eq!(data["status"]["population"], 12);
        // Exercise the full supported incident capacity in the same renderer as
        // the twelve residents. This is an isolated, valid checkpoint fixture.
        let next_id = data["world_state"]["next_id"].as_u64().unwrap();
        let clock = data["world_state"]["clock"].as_u64().unwrap();
        data["world_state"]["incidents"] = serde_json::json!((0..8)
            .map(|i| serde_json::json!({
                "id": next_id + i + 1,
                "kind": (["ambush", "caravan", "mandate"][i as usize % 3]),
                "severity": 2, "opened": clock, "expires": clock + 400, "open": 0
            }))
            .collect::<Vec<_>>());
        data["world_state"]["next_id"] = (next_id + 8).into();
        data["office"] =
            serde_json::json!({"elapsed": 99.0, "actors": {}, "facts": {"legacy": true}});
        std::fs::write(scratch.0.join("fortress.json"), data.to_string()).unwrap();
        let mut effect = ScriptEffect::load(&path, 1, 1.0, 12.0)
            .unwrap()
            .with_reporter(Reporter::new(Some(scratch.0.clone())));
        effect.resize(200, 60, &mut rng);
        effect.set_state(&state);
        effect.step(0.0, &mut rng);
        let exported = |e: &ScriptEffect| {
            let instance = e.instance.as_ref().unwrap();
            let value = instance
                .function("checkpoint")
                .unwrap()
                .call::<Value>(())
                .unwrap();
            lua_to_json(value, 0, &mut 20000).unwrap()
        };
        let hash = |e: &ScriptEffect| exported(e)["world_state"].clone();
        let before = hash(&effect);
        assert_eq!(before["dwarves"].as_array().unwrap().len(), 12);
        assert_eq!(before["incidents"].as_array().unwrap().len(), 8);
        let legends = exported(&effect)["legends"].clone();
        assert!(
            exported(&effect).get("office").is_none(),
            "legacy office record survived restore"
        );
        effect.resize(80, 24, &mut rng);
        effect.step(0.0, &mut rng);
        effect.resize(200, 60, &mut rng);
        effect.step(0.0, &mut rng);
        assert_eq!(before, hash(&effect), "resize changed history");
        let mut resumed = ScriptEffect::load(&path, 1, 1.0, 12.0)
            .unwrap()
            .with_reporter(Reporter::new(Some(scratch.0.clone())));
        resumed.resize(200, 60, &mut rng);
        resumed.set_state(&state);
        resumed.step(0.0, &mut rng);
        assert_eq!(before, hash(&resumed), "restore changed history");
        assert_eq!(
            legends,
            exported(&resumed)["legends"],
            "restore changed legends"
        );
        let mut samples = Vec::new();
        state.changed = false;
        effect.set_state(&state);
        for _ in 0..1000 {
            glyphs.clear();
            let t = Instant::now();
            effect.render(&mut glyphs);
            samples.push(t.elapsed());
        }
        assert_eq!(before, hash(&effect), "render changed history");
        samples.sort_unstable();
        let p95 = samples[950];
        println!("fortress 12-resident / 8-incident render p95 {p95:?}");
        assert!(
            p95 < Duration::from_millis(if cfg!(debug_assertions) { 50 } else { 3 }),
            "fortress p95 {p95:?}"
        );
        assert!(!scratch.0.join("error.json").exists(), "sandbox error");
    }

    #[test]
    fn studio_busy_frame_budget() {
        let scratch = Scratch::new("studio");
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("fx/fortress.lua");
        let mut effect = ScriptEffect::load(&path, 1, 1.0, 12.0)
            .unwrap()
            .with_reporter(Reporter::new(Some(scratch.0.clone())));
        let mut rng = Rng::new(1);
        effect.resize(200, 60, &mut rng);
        let kinds = ["edit", "read", "exec", "web", "mcp", "task", "other"];
        let tail = [
            ("subagent_start", serde_json::json!({"count": 3})),
            ("tool_failed", serde_json::json!({})),
            ("success", serde_json::json!({"kind": "edit"})),
            ("success", serde_json::json!({"kind": "read"})),
            ("success", serde_json::json!({"kind": "exec"})),
            ("success", serde_json::json!({"kind": "web"})),
            ("tool", serde_json::json!({"kind": "edit"})),
            ("tool", serde_json::json!({"kind": "exec"})),
        ];
        let recent: Vec<JsonValue> = (0..64)
            .map(|i| {
                let (kind, payload) = if i < 56 {
                    ("tool", serde_json::json!({"kind": kinds[i % kinds.len()]}))
                } else {
                    tail[i - 56].clone()
                };
                serde_json::json!({"seq": 700 + i, "kind": kind, "tick": 2000 + 3 * i, "payload": payload})
            })
            .collect();
        let state = ScriptState {
            changed: true,
            session_name: "Studio budget".into(),
            mode: "tool".into(),
            tool: "Bash".into(),
            tool_kind: "exec".into(),
            agent: "claude".into(),
            context_pct: 62.0,
            model: "opus".into(),
            effort: "high".into(),
            branch: "feat/studio".into(),
            journey: Some(serde_json::json!({
                "schema_version": 2, "seq": 763, "tick": 2189, "recent": recent,
                "repo": "test", "tools": 700, "prompts": 20, "errors": 1, "compactions": 1,
                "subagents": 3,
                "tool_kinds": {"edit": 200, "read": 150, "exec": 200, "web": 50, "mcp": 30, "task": 30, "other": 40}
            })),
            ..ScriptState::default()
        };
        effect.set_state(&state);
        effect.step(0.25, &mut rng);
        let checkpoint: JsonValue = serde_json::from_str(
            &std::fs::read_to_string(scratch.0.join("fortress.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(checkpoint["status"]["scene"], "studio");
        assert_eq!(checkpoint["status"]["studio"]["tier"], 5);
        let mut glyphs = Vec::new();
        let mut samples = Vec::new();
        let mut crew = 0;
        for _ in 0..1000 {
            effect.step(0.25, &mut rng);
            glyphs.clear();
            let t = Instant::now();
            effect.render(&mut glyphs);
            samples.push(t.elapsed());
            assert!(!glyphs.is_empty() && glyphs.len() <= 3000);
            assert!(glyphs.iter().all(|g| g.x < 200 && g.y < 60));
            crew = crew.max(glyphs.iter().filter(|g| g.ch == '☻' || g.ch == '♙').count());
        }
        assert!(!effect.failed());
        assert!(crew >= 10, "busy studio drew {crew} crew");
        samples.sort_unstable();
        let p95 = samples[950];
        println!("studio busy render p95 {p95:?}");
        assert!(
            p95 < Duration::from_millis(if cfg!(debug_assertions) { 50 } else { 3 }),
            "studio p95 {p95:?}"
        );
        assert!(!scratch.0.join("error.json").exists(), "sandbox error");
    }
}
