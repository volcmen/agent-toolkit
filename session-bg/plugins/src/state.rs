use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::Value;

pub const MODES: &[&str] = &[
    "start",
    "idle",
    "thinking",
    "tool",
    "waiting",
    "error",
    "compacting",
    "end",
];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Session {
    pub mode: String,
    pub ts: f64,
    pub tool_kind: String,
    pub subagents: u32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Status {
    pub context_pct: f32,
    pub ts: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Override {
    pub effect: Option<String>,
    pub script: Option<String>,
    pub mode: Option<String>,
    pub frozen: bool,
    pub enabled: bool,
    pub density: Option<f32>,
    pub speed: Option<f32>,
    pub hue: Option<f32>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    pub session: Option<Session>,
    pub status: Option<Status>,
    pub override_: Override,
    pub changed: bool,
}

impl Default for Override {
    fn default() -> Self {
        Self {
            effect: None,
            script: None,
            mode: None,
            frozen: false,
            enabled: true,
            density: None,
            speed: None,
            hue: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Modulation {
    pub speed: f32,
    pub density: f32,
    pub hue: f32,
    pub bright: f32,
    pub burst: f32,
    pub tint: [f32; 3],
    pub tint_k: f32,
}

impl Default for Modulation {
    fn default() -> Self {
        Self {
            speed: 1.0,
            density: 1.0,
            hue: 0.0,
            bright: 1.0,
            burst: 0.0,
            tint: [1.0, 0.25, 0.2],
            tint_k: 0.0,
        }
    }
}

fn f(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn s(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

fn parse_session(value: &Value) -> Session {
    Session {
        mode: s(value, "mode").unwrap_or_else(|| "idle".to_owned()),
        ts: f(value, "ts").unwrap_or(0.0),
        tool_kind: s(value, "tool_kind").unwrap_or_default(),
        subagents: f(value, "subagents").unwrap_or(0.0).max(0.0) as u32,
    }
}

fn parse_status(value: &Value) -> Status {
    Status {
        context_pct: f(value, "context_pct").unwrap_or(0.0).clamp(0.0, 100.0) as f32,
        ts: f(value, "ts").unwrap_or(0.0),
    }
}

fn parse_override(value: &Value) -> Override {
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    Override {
        effect: s(value, "effect"),
        script: s(value, "script"),
        mode: s(value, "mode").filter(|m| MODES.contains(&m.as_str())),
        frozen: value.get("frozen").and_then(Value::as_bool).unwrap_or(false),
        enabled: value.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        density: f(&params, "density").map(|v| v.clamp(0.1, 3.0) as f32),
        speed: f(&params, "speed").map(|v| v.clamp(0.25, 3.0) as f32),
        hue: f(&params, "hue").map(|v| v.clamp(-1.0, 1.0) as f32),
    }
}

type Stamp = Option<(SystemTime, u64)>;

pub struct Watcher {
    dir: Option<PathBuf>,
    stamps: HashMap<&'static str, Stamp>,
    values: HashMap<&'static str, Value>,
    snapshot: Snapshot,
}

const FILES: [&str; 3] = ["session.json", "status.json", "override.json"];

impl Watcher {
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self {
            dir,
            stamps: HashMap::new(),
            values: HashMap::new(),
            snapshot: Snapshot::default(),
        }
    }

    pub fn from_env() -> Self {
        Self::new(std::env::var_os("SBG_STATE").map(PathBuf::from))
    }

    fn stamp(path: &Path) -> Stamp {
        let meta = std::fs::metadata(path).ok()?;
        Some((meta.modified().ok()?, meta.len()))
    }

    pub fn poll(&mut self) -> &Snapshot {
        let mut changed = false;
        if let Some(dir) = self.dir.clone() {
            for name in FILES {
                let path = dir.join(name);
                let stamp = Self::stamp(&path);
                if self.stamps.get(name) == Some(&stamp) {
                    continue;
                }
                self.stamps.insert(name, stamp);
                changed = true;
                match stamp {
                    None => {
                        self.values.remove(name);
                    }
                    Some(_) => {
                        if let Some(value) = std::fs::read_to_string(&path)
                            .ok()
                            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                            .filter(Value::is_object)
                        {
                            self.values.insert(name, value);
                        }
                    }
                }
            }
        }
        if changed {
            self.snapshot = Snapshot {
                session: self.values.get("session.json").map(parse_session),
                status: self.values.get("status.json").map(parse_status),
                override_: self
                    .values
                    .get("override.json")
                    .map(parse_override)
                    .unwrap_or_default(),
                changed: true,
            };
        } else {
            self.snapshot.changed = false;
        }
        &self.snapshot
    }
}

pub fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

pub fn effective_mode(snapshot: &Snapshot, now: f64) -> (String, f32) {
    if let Some(mode) = &snapshot.override_.mode {
        return (mode.clone(), 0.0);
    }
    let Some(session) = &snapshot.session else {
        return ("idle".to_owned(), f32::INFINITY);
    };
    let age = (now - session.ts).max(0.0) as f32;
    let mode = match session.mode.as_str() {
        "end" => "idle",
        m if age > 120.0 && m != "waiting" => "idle",
        "tool" if age > 20.0 => "thinking",
        "error" if age > 3.4 => "thinking",
        "start" if age > 2.0 => "idle",
        m => m,
    };
    (mode.to_owned(), age)
}

pub fn modulation(snapshot: &Snapshot, now: f64, clock: f32) -> Modulation {
    use std::f32::consts::TAU;
    let mut m = Modulation::default();
    let (mode, age) = effective_mode(snapshot, now);
    let ctx = snapshot.status.as_ref().map_or(0.0, |st| st.context_pct / 100.0);
    m.hue += 0.35 * ctx;
    m.density *= 0.85 + 0.4 * ctx;
    if ctx > 0.9 {
        m.bright *= 1.0 + 0.08 * (clock * TAU * 0.25).sin();
    }
    let kind = snapshot
        .session
        .as_ref()
        .map(|se| se.tool_kind.as_str())
        .unwrap_or("");
    match mode.as_str() {
        "thinking" => m.speed *= 1.5,
        "tool" => {
            m.burst = (-age / 0.8).exp();
            let nudge = match kind {
                "exec" => -0.08,
                "edit" => 0.12,
                "web" => -0.2,
                _ => 0.0,
            };
            m.hue += nudge * m.burst;
            m.speed *= 1.2 + 0.6 * m.burst;
        }
        "waiting" => {
            m.speed *= 0.35;
            m.bright *= 1.3 * (0.85 + 0.15 * (clock * TAU * 0.5).sin());
        }
        "error" => {
            m.tint = [1.0, 0.25, 0.2];
            m.tint_k = if age < 0.4 {
                1.0
            } else {
                (-(age - 0.4) / 1.0).exp()
            };
        }
        "compacting" => m.density *= (1.0 - 0.4 * age).max(0.2),
        "idle" => {
            m.speed *= 0.6;
            m.bright *= 0.8;
        }
        _ => {}
    }
    let subagents = snapshot.session.as_ref().map_or(0, |se| se.subagents) as f32;
    m.density *= (1.0 + 0.15 * subagents).min(1.6);
    let o = &snapshot.override_;
    if let Some(v) = o.density {
        m.density *= v;
    }
    if let Some(v) = o.speed {
        m.speed *= v;
    }
    if let Some(v) = o.hue {
        m.hue += v;
    }
    if o.frozen {
        m.speed = 0.0;
    } else {
        m.speed = m.speed.clamp(0.25, 3.0);
    }
    m.density = m.density.clamp(0.1, 3.0);
    m.bright = m.bright.clamp(0.3, 1.35);
    m.burst = m.burst.clamp(0.0, 1.0);
    m.tint_k = m.tint_k.clamp(0.0, 1.0);
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(session: Option<&str>, status: Option<&str>, override_: Option<&str>) -> Snapshot {
        let parse = |t: &str| serde_json::from_str::<Value>(t).expect("test json");
        Snapshot {
            session: session.map(|t| parse_session(&parse(t))),
            status: status.map(|t| parse_status(&parse(t))),
            override_: override_.map(|t| parse_override(&parse(t))).unwrap_or_default(),
            changed: true,
        }
    }

    #[test]
    fn missing_session_is_idle_and_calm() {
        let m = modulation(&snap(None, None, None), 1000.0, 0.0);
        assert!(m.speed < 1.0 && m.bright < 1.0);
        assert_eq!(effective_mode(&snap(None, None, None), 0.0).0, "idle");
    }

    #[test]
    fn tool_mode_decays_to_thinking_then_idle() {
        let s = snap(Some(r#"{"mode":"tool","ts":1000.0}"#), None, None);
        assert_eq!(effective_mode(&s, 1001.0).0, "tool");
        assert_eq!(effective_mode(&s, 1030.0).0, "thinking");
        assert_eq!(effective_mode(&s, 1200.0).0, "idle");
    }

    #[test]
    fn override_mode_pins_regardless_of_age() {
        let s = snap(Some(r#"{"mode":"tool","ts":0.0}"#), None, Some(r#"{"mode":"waiting"}"#));
        assert_eq!(effective_mode(&s, 1e9).0, "waiting");
    }

    #[test]
    fn context_warms_and_densifies() {
        let lo = modulation(&snap(None, Some(r#"{"context_pct":0}"#), None), 0.0, 0.0);
        let hi = modulation(&snap(None, Some(r#"{"context_pct":100}"#), None), 0.0, 0.0);
        assert!(hi.hue > lo.hue && hi.density > lo.density);
    }

    #[test]
    fn ceilings_hold_for_every_mode_and_context() {
        for mode in MODES {
            for pct in [0, 50, 100] {
                for age in [0.0, 0.5, 5.0, 60.0] {
                    let s = snap(
                        Some(&format!(r#"{{"mode":"{mode}","ts":{},"subagents":9}}"#, 1000.0 - age)),
                        Some(&format!(r#"{{"context_pct":{pct}}}"#)),
                        Some(r#"{"params":{"density":3.0,"speed":3.0}}"#),
                    );
                    let m = modulation(&s, 1000.0, 1.3);
                    assert!((0.25..=3.0).contains(&m.speed), "{mode} speed {}", m.speed);
                    assert!(m.bright <= 1.35 && m.density <= 3.0, "{mode} ceilings");
                }
            }
        }
    }

    #[test]
    fn error_tint_flashes_then_fades() {
        let s = snap(Some(r#"{"mode":"error","ts":1000.0}"#), None, None);
        assert_eq!(modulation(&s, 1000.2, 0.0).tint_k, 1.0);
        let later = modulation(&s, 1002.5, 0.0).tint_k;
        assert!(later > 0.0 && later < 0.2);
    }

    #[test]
    fn watcher_reads_and_keeps_previous_on_malformed() {
        let dir = std::env::temp_dir().join(format!("sbg-state-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("override.json");
        std::fs::write(&path, r#"{"effect":"stars","params":{"density":0.5}}"#).unwrap();
        let mut w = Watcher::new(Some(dir.clone()));
        let snap = w.poll();
        assert!(snap.changed);
        assert_eq!(snap.override_.effect.as_deref(), Some("stars"));
        assert_eq!(snap.override_.density, Some(0.5));
        assert!(!w.poll().changed);
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&path, "{ not json").unwrap();
        let snap = w.poll();
        assert_eq!(snap.override_.effect.as_deref(), Some("stars"));
        std::fs::remove_file(&path).unwrap();
        assert_eq!(w.poll().override_.effect, None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
