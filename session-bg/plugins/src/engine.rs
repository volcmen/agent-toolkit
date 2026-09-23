//! Backend-independent effect lifecycle: state, Lua, recovery, and checkpointing.
use crate::frame::Occupancy;
use crate::health::{Action, Recovery, RenderGuard};
use crate::script::{Reporter, ScriptEffect};
use crate::{effects, frame, rng, state};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Charge this host for work done on the render thread, not time it was
/// descheduled while another application was compiling or the machine slept.
/// Unsupported platforms keep the previous monotonic wall-clock behavior.
fn thread_cpu_time() -> Option<Duration> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let mut value: libc::timespec = unsafe { std::mem::zeroed() };
        if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut value) } == 0 {
            return Some(Duration::new(value.tv_sec as u64, value.tv_nsec as u32));
        }
    }
    None
}

fn render_cost(start: Option<Duration>, wall: Duration) -> Duration {
    start
        .and_then(|start| thread_cpu_time()?.checked_sub(start))
        .unwrap_or(wall)
}

#[cfg(test)]
mod clock_tests {
    use super::*;

    #[test]
    fn waiting_does_not_spend_the_effect_cpu_budget() {
        let Some(start) = thread_cpu_time() else {
            return;
        };
        let wall_started = Instant::now();
        std::thread::sleep(Duration::from_millis(40));
        let wall = wall_started.elapsed();
        let cost = render_cost(Some(start), wall);
        assert!(
            cost < wall / 2,
            "sleep/descheduling was charged as rendering: CPU={cost:?}, wall={wall:?}"
        );
    }
}

struct Settings {
    effect: String,
    script: Option<String>,
    seed: u64,
    fps: f32,
    density: f32,
}

#[derive(Clone, Debug, PartialEq)]
enum Choice {
    Builtin(String),
    Script(String),
}

fn choose(settings: &Settings, override_: &state::Override) -> Choice {
    if let Some(path) = &override_.script {
        return Choice::Script(path.clone());
    }
    if let Some(name) = &override_.effect {
        return Choice::Builtin(name.clone());
    }
    if let Some(path) = &settings.script {
        return Choice::Script(path.clone());
    }
    Choice::Builtin(settings.effect.clone())
}

fn build(
    choice: &Choice,
    settings: &Settings,
    density: f32,
    reporter: &Reporter,
) -> Option<Box<dyn effects::Effect>> {
    match choice {
        Choice::Builtin(name) => match effects::create(name, density) {
            Some(effect) => Some(effect),
            None => {
                reporter.log(&format!("ignoring unknown effect {name:?}"));
                None
            }
        },
        Choice::Script(path) => {
            match ScriptEffect::load(&PathBuf::from(path), settings.seed, density, settings.fps) {
                Ok(effect) => Some(Box::new(effect.with_reporter(reporter.clone()))),
                Err(message) => {
                    reporter.error("compile", &message);
                    None
                }
            }
        }
    }
}

impl Choice {
    fn json(&self) -> serde_json::Value {
        match self {
            Self::Builtin(name) => serde_json::json!({"kind": "builtin", "name": name}),
            Self::Script(path) => serde_json::json!({"kind": "script", "path": path}),
        }
    }
}

#[derive(Default)]
struct RuntimeReport {
    last: Option<Duration>,
    reason: Option<String>,
}

impl RuntimeReport {
    fn write(&mut self, reporter: &Reporter, now: Duration, mut value: serde_json::Value) {
        if self
            .last
            .is_some_and(|last| now.saturating_sub(last) < Duration::from_secs(1))
        {
            return;
        }
        self.last = Some(now);
        value["v"] = 1.into();
        value["ts"] = state::now_secs().into();
        value["pid"] = std::process::id().into();
        value["backend"] = std::env::var("SBG_BACKEND")
            .unwrap_or_else(|_| "tattoy".into())
            .into();
        value["reason"] = serde_json::json!(self.reason);
        reporter.runtime(&value);
    }
}

fn env_or<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn default_seed() -> u64 {
    let mut hasher = DefaultHasher::new();
    if let Ok(pane) = std::env::var("ZELLIJ_PANE_ID") {
        pane.hash(&mut hasher);
    } else {
        std::process::id().hash(&mut hasher);
        Instant::now().elapsed().as_nanos().hash(&mut hasher);
    }
    hasher.finish()
}

fn settings() -> Settings {
    Settings {
        effect: std::env::var("SBG_EFFECT").unwrap_or_else(|_| "matrix".to_owned()),
        script: std::env::var("SBG_SCRIPT").ok().filter(|v| !v.is_empty()),
        seed: env_or("SBG_SEED", default_seed()),
        fps: env_or("SBG_FPS", 12.0f32).clamp(1.0, 60.0),
        density: env_or("SBG_DENSITY", 1.0f32),
    }
}

fn preview(
    effect: &mut dyn effects::Effect,
    rng: &mut rng::Rng,
    width: u16,
    height: u16,
    frames: usize,
) -> String {
    effect.resize(width, height, rng);
    let mut glyphs = Vec::new();
    for _ in 0..frames {
        effect.step(1.0 / 12.0, rng);
    }
    effect.render(&mut glyphs);
    let mut rows = vec![vec![' '; width as usize]; height as usize];
    for g in effects::visible(&glyphs, &Occupancy::new(width, height)) {
        rows[g.y as usize][g.x as usize] = g.ch;
    }
    rows.into_iter()
        .map(|row| row.into_iter().collect::<String>().trim_end().to_owned())
        .collect::<Vec<_>>()
        .join("\n")
}

/// One in-process effect with the same lifecycle on both terminal backends.
pub struct Engine {
    settings: Settings,
    reporter: Reporter,
    watcher: state::Watcher,
    snapshot: state::Snapshot,
    density: f32,
    started: Instant,
    recovery: Recovery,
    runtime: RuntimeReport,
    requested: Choice,
    choice: Choice,
    effect: Box<dyn effects::Effect>,
    rng: rng::Rng,
    frame: Duration,
    size: (u16, u16),
    glyphs: Vec<frame::Glyph>,
    blanked: bool,
    guard: RenderGuard,
}

impl Engine {
    pub fn from_env() -> Result<Self, String> {
        let settings = settings();
        let reporter = Reporter::from_env();
        let mut watcher = state::Watcher::from_env();
        let snapshot = watcher.poll().clone();
        let density = settings.density;
        let started = Instant::now();
        let mut recovery = Recovery::default();
        let mut runtime = RuntimeReport::default();
        let requested = choose(&settings, &snapshot.override_);
        let mut choice = requested.clone();
        let effect = match build(&choice, &settings, density, &reporter) {
            Some(effect) => effect,
            None => {
                if std::env::var_os("SBG_PREVIEW").is_some() {
                    return Err("preview effect could not be loaded".into());
                }
                recovery.defer(started.elapsed());
                runtime.reason = Some("requested effect could not be loaded".to_owned());
                choice = Choice::Builtin(settings.effect.clone());
                match build(&choice, &settings, density, &reporter) {
                    Some(effect) => effect,
                    None => {
                        return Err(format!(
                            "unknown SBG_EFFECT {:?}; expected one of {:?}",
                            settings.effect,
                            effects::NAMES
                        ));
                    }
                }
            }
        };
        let rng = rng::Rng::new(settings.seed);

        let frame = Duration::from_secs_f32(1.0 / settings.fps);
        Ok(Self {
            settings,
            reporter,
            watcher,
            snapshot,
            density,
            started,
            recovery,
            runtime,
            requested,
            choice,
            effect,
            rng,
            frame,
            size: (0, 0),
            glyphs: Vec::new(),
            blanked: false,
            guard: RenderGuard::default(),
        })
    }

    pub fn interval(&self) -> Duration {
        self.frame
    }

    pub fn opacity(&self, base: f32) -> f32 {
        self.snapshot.override_.opacity.unwrap_or(base)
    }

    pub fn preview(&mut self, frames: usize, width: u16, height: u16) -> Result<String, String> {
        let neutral = state::script_state(
            &self.snapshot,
            &state::Modulation::default(),
            state::now_secs(),
        );
        self.effect.set_state(&neutral);
        let text = preview(self.effect.as_mut(), &mut self.rng, width, height, frames);
        if self.effect.failed() {
            Err("preview failed".into())
        } else {
            Ok(text)
        }
    }

    /// None means the disabled layer has already been cleared.
    pub fn render(&mut self, occupancy: &frame::Occupancy, dt: f32) -> Option<Vec<frame::Glyph>> {
        let Self {
            settings,
            reporter,
            watcher,
            snapshot,
            density,
            started,
            recovery,
            runtime,
            requested,
            choice,
            effect,
            rng,
            frame,
            size,
            glyphs,
            blanked,
            guard,
        } = self;
        let resized = (occupancy.width, occupancy.height) != *size;
        if resized {
            *size = (occupancy.width, occupancy.height);
            effect.resize(size.0, size.1, rng);
        }
        *snapshot = watcher.poll().clone();
        let wanted = choose(settings, &snapshot.override_);
        if wanted != *requested {
            *requested = wanted;
            *recovery = Recovery::default();
            runtime.reason = None;
            runtime.last = None;
        }
        let elapsed = started.elapsed();
        // Session events must not bypass backoff. Conversely, idle sessions
        // must recover without needing any hook, rename or override write.
        if requested != choice
            && snapshot.override_.enabled
            && (recovery.retry_at.is_none()
                || recovery.due(elapsed, true, snapshot.override_.paused))
        {
            if let Some(mut fresh) = build(requested, settings, *density, reporter) {
                fresh.set_state(&state::script_state(
                    snapshot,
                    &state::Modulation::default(),
                    state::now_secs(),
                ));
                fresh.resize(size.0, size.1, rng);
                *effect = fresh;
                *choice = requested.clone();
                *guard = RenderGuard::default();
                *frame = Duration::from_secs_f32(1.0 / settings.fps);
                reporter.log("resuming the requested effect from its checkpoint");
            } else {
                recovery.defer(elapsed);
                runtime.reason = Some("requested effect could not be loaded".to_owned());
            }
            runtime.last = None;
        }
        let clock = started.elapsed().as_secs_f32();
        let wall = state::now_secs();
        let modulation = state::modulation(snapshot, wall, clock);
        if !snapshot.override_.enabled {
            runtime.write(
                reporter,
                elapsed,
                serde_json::json!({
                    "status": "disabled", "requested": requested.json(), "active": choice.json(),
                    "fps": 0, "retry_at": null,
                }),
            );
            if !*blanked {
                *blanked = true;
                return Some(Vec::new());
            }
            return None;
        }
        *blanked = false;
        let wanted_density = (settings.density * modulation.density).clamp(0.1, 3.0);
        if (wanted_density - *density).abs() > 0.01 {
            *density = wanted_density;
            effect.set_density(*density);
        }
        effect.set_state(&state::script_state(snapshot, &modulation, wall));
        let scripted = matches!(choice, Choice::Script(_));
        let measured = Instant::now();
        let cpu_started = thread_cpu_time();
        effect.step(dt * modulation.speed, rng);
        glyphs.clear();
        effect.render(glyphs);
        let wall_cost = measured.elapsed();
        let cost = render_cost(cpu_started, wall_cost);
        let halo = effect.foreground_halo();
        for g in glyphs.iter_mut() {
            g.rgb = frame::modulate(
                g.rgb,
                if halo > 0 { 0.0 } else { modulation.hue },
                modulation.bright,
                modulation.tint,
                if halo > 0 { 0.0 } else { modulation.tint_k },
            );
        }
        let visible = effects::visible_with_halo(glyphs, occupancy, halo);
        let mut fallback_reason = scripted
            .then(|| effect.failed())
            .filter(|failed| *failed)
            .map(|_| "repeated script failures".to_owned());
        if scripted {
            match guard.observe(started.elapsed(), cost, *frame) {
                Action::Fallback => {
                    fallback_reason = Some(
                        "three consecutive renders exceeded 3x the CPU frame budget".to_owned(),
                    );
                }
                Action::Throttle => {
                    *frame *= 2;
                    reporter.log(&format!("sustained script CPU cost over 30% of the frame budget; halving this pane to {:.1} fps", 1.0 / frame.as_secs_f32()));
                }
                Action::None => (),
            }
        }
        if let Some(reason) = fallback_reason {
            let wanted = Choice::Builtin(
                snapshot
                    .override_
                    .effect
                    .clone()
                    .unwrap_or_else(|| settings.effect.clone()),
            );
            if let Some(mut fresh) = build(&wanted, settings, *density, reporter) {
                fresh.resize(size.0, size.1, rng);
                *effect = fresh;
                *choice = wanted;
                *guard = RenderGuard::default();
                let delay = recovery.defer(started.elapsed());
                reporter.log(&format!(
                    "{reason}; running the builtin effect, retry in {}s",
                    delay.as_secs()
                ));
                runtime.reason = Some(reason);
                runtime.last = None;
            }
        } else if choice == requested {
            recovery.healthy(started.elapsed());
            runtime.reason = None;
        }
        let status = if snapshot.override_.paused {
            "paused"
        } else if choice != requested {
            "recovering"
        } else {
            "running"
        };
        let retry_at = recovery
            .retry_at
            .map(|at| state::now_secs() + at.saturating_sub(started.elapsed()).as_secs_f64());
        runtime.write(
            reporter,
            started.elapsed(),
            serde_json::json!({
                "status": status, "requested": requested.json(), "active": choice.json(),
                "fps": 1.0 / frame.as_secs_f32(), "retry_at": retry_at,
                "render_cpu_ms": cost.as_secs_f64() * 1000.0,
                "render_wall_ms": wall_cost.as_secs_f64() * 1000.0,
            }),
        );
        Some(visible)
    }
}
