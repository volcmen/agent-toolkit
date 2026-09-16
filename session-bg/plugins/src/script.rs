use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime};

use mlua::{AnyUserData, HookTriggers, Lua, Table, Value, VmState};

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
}

struct Instance {
    lua: Lua,
    fx: AnyUserData,
    buf: Rc<RefCell<FxBuf>>,
    budget: Rc<Cell<u64>>,
    has_init: bool,
    has_resize: bool,
    has_step: bool,
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
        })
    }

    fn function(&self, name: &str) -> Option<mlua::Function> {
        self.lua.globals().get::<mlua::Function>(name).ok()
    }

    fn state_table(&self, state: &ScriptState) -> mlua::Result<Table> {
        let table = self.lua.create_table()?;
        table.set("mode", state.mode.as_str())?;
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
        table.set("params", params)?;
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
    outstanding: Option<&'static str>,
    dead: bool,
    stamp: Stamp,
    pending: Option<(Instant, Stamp)>,
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
            outstanding: None,
            dead: false,
            stamp: stamp_of(path),
            pending: None,
        })
    }

    pub fn with_reporter(mut self, reporter: Reporter) -> Self {
        self.reporter = reporter;
        self
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
            self.fail("init", &message);
        } else {
            self.succeed();
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

    fn step(&mut self, dt: f32, _rng: &mut Rng) {
        self.maybe_reload();
        let result = match &self.instance {
            Some(instance) => instance.step(dt, &self.state),
            None => return,
        };
        match result {
            Ok(()) => self.succeed(),
            Err(message) => self.fail("step", &message),
        }
    }

    fn render(&mut self, out: &mut Vec<Glyph>) {
        let result = match &self.instance {
            Some(instance) => {
                let result = instance.render(&self.state);
                out.extend(instance.buf.borrow().glyphs.iter().copied());
                result
            }
            None => return,
        };
        match result {
            Ok(()) => self.succeed(),
            Err(message) => self.fail("render", &message),
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
}
