mod api;
mod effects;
mod frame;
mod noise;
mod rng;
mod script;
mod state;

use std::collections::hash_map::DefaultHasher;
use std::collections::VecDeque;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use frame::Occupancy;
use script::{Reporter, ScriptEffect};

struct Shared {
    occupancy: Occupancy,
    generation: u64,
    closed: bool,
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
                eprintln!("sbg-fx: ignoring unknown effect {name:?}");
                None
            }
        },
        Choice::Script(path) => {
            match ScriptEffect::load(&PathBuf::from(path), settings.seed, density, settings.fps) {
                Ok(effect) => Some(Box::new(effect.with_reporter(reporter.clone()))),
                Err(message) => {
                    reporter.error("compile", &message);
                    eprintln!("sbg-fx: {message}");
                    None
                }
            }
        }
    }
}

fn percentile(samples: &VecDeque<(Instant, f32)>, q: f32) -> f32 {
    let mut values: Vec<f32> = samples.iter().map(|(_, v)| *v).collect();
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let index = ((values.len() as f32 - 1.0) * q).round() as usize;
    values.get(index).copied().unwrap_or(0.0)
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

fn apply(shared: &Mutex<Shared>, message: tattoy_protocol::PluginInputMessages) {
    let mut guard = shared.lock().expect("shared state poisoned");
    match message {
        tattoy_protocol::PluginInputMessages::PTYUpdate { size, cells, .. } => {
            let mut occupancy = Occupancy::new(size.0, size.1);
            for cell in cells {
                occupancy.set(cell.coordinates.0, cell.coordinates.1);
            }
            guard.occupancy = occupancy;
            guard.generation += 1;
        }
        tattoy_protocol::PluginInputMessages::TTYResize { width, height } => {
            guard.occupancy = Occupancy::new(width, height);
            guard.generation += 1;
        }
        _ => {}
    }
}

fn read_stdin(shared: Arc<Mutex<Shared>>) {
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<tattoy_protocol::PluginInputMessages>(&line) {
            Ok(message) => apply(&shared, message),
            Err(error) => eprintln!("sbg-fx: ignoring malformed input: {error}"),
        }
    }
    shared.lock().expect("shared state poisoned").closed = true;
}

fn to_cells(glyphs: &[frame::Glyph]) -> Vec<tattoy_protocol::Cell> {
    glyphs
        .iter()
        .map(|g| {
            tattoy_protocol::Cell::builder()
                .character(g.ch)
                .coordinates((u32::from(g.x), u32::from(g.y)))
                .maybe_bg(None)
                .maybe_fg(Some((g.rgb[0], g.rgb[1], g.rgb[2], 1.0)))
                .build()
        })
        .collect()
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

fn main() {
    let settings = settings();
    let reporter = Reporter::from_env();
    let mut watcher = state::Watcher::from_env();
    let mut snapshot = watcher.poll().clone();
    let mut density = settings.density;
    let mut choice = choose(&settings, &snapshot.override_);
    let mut effect = match build(&choice, &settings, density, &reporter) {
        Some(effect) => effect,
        None => {
            if std::env::var_os("SBG_PREVIEW").is_some() {
                std::process::exit(2);
            }
            choice = Choice::Builtin(settings.effect.clone());
            match build(&choice, &settings, density, &reporter) {
                Some(effect) => effect,
                None => {
                    eprintln!(
                        "sbg-fx: unknown SBG_EFFECT {:?}; expected one of {:?}",
                        settings.effect,
                        effects::NAMES
                    );
                    std::process::exit(2);
                }
            }
        }
    };
    let mut rng = rng::Rng::new(settings.seed);
    if let Ok(frames) = std::env::var("SBG_PREVIEW") {
        let frames = frames.parse().unwrap_or(24);
        let width = env_or("COLUMNS", 100u16);
        let height = env_or("LINES", 30u16);
        let neutral =
            state::script_state(&snapshot, &state::Modulation::default(), state::now_secs());
        effect.set_state(&neutral);
        println!(
            "{}",
            preview(effect.as_mut(), &mut rng, width, height, frames)
        );
        if effect.failed() {
            std::process::exit(2);
        }
        return;
    }
    let shared = Arc::new(Mutex::new(Shared {
        occupancy: Occupancy::default(),
        generation: 0,
        closed: false,
    }));
    let reader = Arc::clone(&shared);
    std::thread::spawn(move || read_stdin(reader));

    let mut frame = Duration::from_secs_f32(1.0 / settings.fps);
    let mut size = (0u16, 0u16);
    let started = Instant::now();
    let mut last = Instant::now();
    let mut next = last;
    let mut glyphs = Vec::new();
    let stdout = std::io::stdout();
    let mut blanked = false;
    let mut samples: VecDeque<(Instant, f32)> = VecDeque::new();
    let mut over_since: Option<Instant> = None;
    let mut throttled = false;
    loop {
        next += frame;
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else {
            next = now;
        }
        let dt = last.elapsed().as_secs_f32().min(0.25);
        last = Instant::now();

        let occupancy = {
            let guard = shared.lock().expect("shared state poisoned");
            if guard.closed {
                return;
            }
            guard.occupancy.clone()
        };
        if occupancy.width == 0 || occupancy.height == 0 {
            continue;
        }
        let resized = (occupancy.width, occupancy.height) != size;
        if resized {
            size = (occupancy.width, occupancy.height);
            effect.resize(size.0, size.1, &mut rng);
        }
        snapshot = watcher.poll().clone();
        if snapshot.changed {
            let wanted = choose(&settings, &snapshot.override_);
            if wanted != choice {
                if let Some(mut fresh) = build(&wanted, &settings, density, &reporter) {
                    if size != (0, 0) {
                        fresh.resize(size.0, size.1, &mut rng);
                    }
                    effect = fresh;
                    choice = wanted;
                    samples.clear();
                    over_since = None;
                }
            }
        }
        let clock = started.elapsed().as_secs_f32();
        let wall = state::now_secs();
        let modulation = state::modulation(&snapshot, wall, clock);
        if !snapshot.override_.enabled {
            if !blanked {
                blanked = true;
                let message = tattoy_protocol::PluginOutputMessages::OutputCells(Vec::new());
                let mut out = stdout.lock();
                if serde_json::to_writer(&mut out, &message).is_err()
                    || out.write_all(b"\n").is_err()
                    || out.flush().is_err()
                {
                    return;
                }
            }
            continue;
        }
        blanked = false;
        let wanted_density = (settings.density * modulation.density).clamp(0.1, 3.0);
        if (wanted_density - density).abs() > 0.01 {
            density = wanted_density;
            effect.set_density(density);
        }
        effect.set_state(&state::script_state(&snapshot, &modulation, wall));
        let scripted = matches!(choice, Choice::Script(_));
        let measured = Instant::now();
        effect.step(dt * modulation.speed, &mut rng);
        glyphs.clear();
        effect.render(&mut glyphs);
        let cost = measured.elapsed().as_secs_f32();
        let halo = effect.foreground_halo();
        for g in &mut glyphs {
            g.rgb = frame::modulate(
                g.rgb,
                if halo > 0 { 0.0 } else { modulation.hue },
                modulation.bright,
                modulation.tint,
                if halo > 0 { 0.0 } else { modulation.tint_k },
            );
        }
        let cells = to_cells(&effects::visible_with_halo(&glyphs, &occupancy, halo));
        let message = tattoy_protocol::PluginOutputMessages::OutputCells(cells);
        let mut out = stdout.lock();
        let ok = serde_json::to_writer(&mut out, &message).is_ok()
            && out.write_all(b"\n").is_ok()
            && out.flush().is_ok();
        drop(out);
        if !ok {
            return;
        }
        if !scripted {
            continue;
        }
        let mut fallback = effect.failed();
        samples.push_back((last, cost));
        while samples
            .front()
            .is_some_and(|(at, _)| at.elapsed() > Duration::from_secs(2))
        {
            samples.pop_front();
        }
        if samples.len() >= 8 {
            let budget = frame.as_secs_f32();
            let p95 = percentile(&samples, 0.95);
            if p95 > budget * 3.0 {
                reporter.log(&format!(
                    "script p95 {:.1} ms over 3x the {:.1} ms frame budget; falling back to the builtin effect",
                    p95 * 1000.0,
                    budget * 1000.0
                ));
                fallback = true;
            } else if p95 > budget * 0.3 {
                let since = *over_since.get_or_insert(last);
                if !throttled && since.elapsed() >= Duration::from_secs(2) {
                    throttled = true;
                    frame *= 2;
                    reporter.log(&format!(
                        "script p95 {:.1} ms over 30% of the frame budget; halving this pane to {:.1} fps",
                        p95 * 1000.0,
                        1.0 / frame.as_secs_f32()
                    ));
                }
            } else {
                over_since = None;
            }
        }
        if fallback {
            let wanted = Choice::Builtin(
                snapshot
                    .override_
                    .effect
                    .clone()
                    .unwrap_or_else(|| settings.effect.clone()),
            );
            if let Some(mut fresh) = build(&wanted, &settings, density, &reporter) {
                fresh.resize(size.0, size.1, &mut rng);
                effect = fresh;
                choice = wanted;
                samples.clear();
                over_since = None;
                reporter.log("running the builtin effect");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use effects::{create, visible, NAMES};

    fn run(name: &str, seed: u64, steps: usize, w: u16, h: u16) -> Vec<frame::Glyph> {
        let mut effect = create(name, 1.0).expect("known effect");
        let mut rng = rng::Rng::new(seed);
        effect.resize(w, h, &mut rng);
        for _ in 0..steps {
            effect.step(1.0 / 12.0, &mut rng);
        }
        let mut out = Vec::new();
        effect.render(&mut out);
        out
    }

    #[test]
    fn every_effect_is_deterministic_for_a_seed() {
        for name in NAMES {
            let a = run(name, 42, 40, 120, 40);
            let b = run(name, 42, 40, 120, 40);
            assert_eq!(a, b, "{name} diverged for the same seed");
            let c = run(name, 43, 40, 120, 40);
            assert_ne!(a, c, "{name} ignores the seed");
        }
    }

    #[test]
    fn every_effect_draws_something_inside_bounds() {
        for name in NAMES {
            let out = run(name, 7, 30, 100, 30);
            assert!(!out.is_empty(), "{name} rendered nothing");
            assert!(
                out.iter().all(|g| g.x < 100 && g.y < 30),
                "{name} drew outside the grid"
            );
        }
    }

    #[test]
    fn every_effect_stays_sparse() {
        for name in NAMES {
            let out = run(name, 11, 60, 200, 60);
            let free = visible(&out, &Occupancy::new(200, 60));
            let ratio = free.len() as f32 / (200.0 * 60.0);
            assert!(ratio < 0.4, "{name} covers {ratio:.2} of the grid");
        }
    }

    #[test]
    fn plasma_never_goes_blank_or_solid() {
        for seed in 1..=6u64 {
            for steps in [0usize, 30, 90, 200] {
                let out = run("plasma", seed, steps, 160, 40);
                let ratio = out.len() as f32 / (160.0 * 40.0);
                assert!(
                    (0.03..0.45).contains(&ratio),
                    "plasma seed {seed} step {steps} covers {ratio:.2}"
                );
            }
        }
    }

    #[test]
    fn occupied_cells_are_never_painted() {
        let mut occupancy = Occupancy::new(80, 24);
        for x in 0..80 {
            for y in 0..24 {
                if (x + y) % 3 == 0 {
                    occupancy.set(x, y);
                }
            }
        }
        for name in NAMES {
            let out = run(name, 5, 20, 80, 24);
            for g in visible(&out, &occupancy) {
                assert!(
                    occupancy.is_free(g.x, g.y),
                    "{name} painted over occupied cell ({}, {})",
                    g.x,
                    g.y
                );
            }
        }
    }

    #[test]
    fn frame_budget_is_small() {
        for name in NAMES {
            let mut effect = create(name, 1.0).expect("known effect");
            let mut rng = rng::Rng::new(1);
            effect.resize(200, 60, &mut rng);
            let started = Instant::now();
            let mut out = Vec::new();
            for _ in 0..12 {
                effect.step(1.0 / 12.0, &mut rng);
                out.clear();
                effect.render(&mut out);
                let _ = to_cells(&visible(&out, &Occupancy::new(200, 60)));
            }
            let per_frame = started.elapsed() / 12;
            assert!(
                per_frame < Duration::from_millis(40),
                "{name} takes {per_frame:?} per frame"
            );
        }
    }

    #[test]
    fn pty_update_replaces_occupancy_and_resize_clears_it() {
        let shared = Mutex::new(Shared {
            occupancy: Occupancy::default(),
            generation: 0,
            closed: false,
        });
        let update: tattoy_protocol::PluginInputMessages = serde_json::from_str(
            r#"{"pty_update":{"size":[10,4],"cells":[{"character":"x","coordinates":[3,1],"bg":null,"fg":null}],"cursor":[0,0]}}"#,
        )
        .unwrap();
        apply(&shared, update);
        {
            let guard = shared.lock().unwrap();
            assert!(!guard.occupancy.is_free(3, 1));
            assert!(guard.occupancy.is_free(4, 1));
            assert_eq!((guard.occupancy.width, guard.occupancy.height), (10, 4));
        }
        let resize: tattoy_protocol::PluginInputMessages =
            serde_json::from_str(r#"{"tty_resize":{"width":5,"height":2}}"#).unwrap();
        apply(&shared, resize);
        let guard = shared.lock().unwrap();
        assert_eq!((guard.occupancy.width, guard.occupancy.height), (5, 2));
        assert_eq!(guard.generation, 2);
    }

    #[test]
    fn output_matches_tattoy_protocol_shape() {
        let cells = to_cells(&[frame::Glyph {
            x: 1,
            y: 2,
            ch: 'ｱ',
            rgb: [0.5, 0.25, 0.0],
        }]);
        let json = serde_json::to_value(tattoy_protocol::PluginOutputMessages::OutputCells(cells))
            .unwrap();
        let cell = &json["output_cells"][0];
        assert_eq!(cell["character"], "ｱ");
        assert_eq!(cell["coordinates"], serde_json::json!([1, 2]));
        assert!(cell["bg"].is_null());
        assert_eq!(cell["fg"], serde_json::json!([0.5, 0.25, 0.0, 1.0]));
    }
}
