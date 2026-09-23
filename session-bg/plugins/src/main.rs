use frame::Occupancy;
use sbg_fx::engine::Engine;
use sbg_fx::frame;
#[cfg(test)]
use sbg_fx::{effects, rng};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};
#[cfg(test)]
use std::time::Duration;
use std::time::Instant;

struct Shared {
    occupancy: Occupancy,
    generation: u64,
    closed: bool,
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

fn main() {
    let mut engine = Engine::from_env().unwrap_or_else(|message| {
        eprintln!("sbg-fx: {message}");
        std::process::exit(2);
    });
    if let Ok(frames) = std::env::var("SBG_PREVIEW") {
        let width = std::env::var("COLUMNS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(100);
        let height = std::env::var("LINES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30);
        match engine.preview(frames.parse().unwrap_or(24), width, height) {
            Ok(text) => println!("{text}"),
            Err(message) => {
                eprintln!("sbg-fx: {message}");
                std::process::exit(2);
            }
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
    let mut last = Instant::now();
    let mut next = last;
    let stdout = std::io::stdout();
    loop {
        next += engine.interval();
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
        if let Some(glyphs) = engine.render(&occupancy, dt) {
            let message = tattoy_protocol::PluginOutputMessages::OutputCells(to_cells(&glyphs));
            let mut out = stdout.lock();
            if serde_json::to_writer(&mut out, &message).is_err()
                || out.write_all(b"\n").is_err()
                || out.flush().is_err()
            {
                return;
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
