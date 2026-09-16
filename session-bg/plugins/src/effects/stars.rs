use super::Effect;
use crate::frame::{hex, scale, Glyph};
use crate::rng::Rng;

struct Star {
    x: u16,
    y: u16,
    phase: f32,
    speed: f32,
    ch: char,
    rgb: [f32; 3],
}

struct Shooter {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    life: f32,
}

pub struct Stars {
    width: u16,
    height: u16,
    density: f32,
    t: f32,
    stars: Vec<Star>,
    shooters: Vec<Shooter>,
}

impl Stars {
    pub fn new(density: f32) -> Self {
        Self {
            width: 0,
            height: 0,
            density,
            t: 0.0,
            stars: Vec::new(),
            shooters: Vec::new(),
        }
    }
}

impl Effect for Stars {
    fn resize(&mut self, width: u16, height: u16, rng: &mut Rng) {
        self.width = width;
        self.height = height;
        self.stars.clear();
        let n = ((f32::from(width) * f32::from(height) / 28.0) * self.density) as usize;
        let chars = ['·', '·', '·', '•', '✦', '✧', '⋆', '*', '.'];
        let colors = [
            hex(0xc0caf5),
            hex(0xe0af68),
            hex(0x7dcfff),
            hex(0xbb9af7),
            hex(0xa9b1d6),
        ];
        for _ in 0..n {
            self.stars.push(Star {
                x: rng.below(width as usize) as u16,
                y: rng.below(height as usize) as u16,
                phase: rng.range(0.0, std::f32::consts::TAU),
                speed: rng.range(0.4, 2.2),
                ch: chars[rng.below(chars.len())],
                rgb: colors[rng.below(colors.len())],
            });
        }
    }

    fn set_density(&mut self, density: f32) {
        self.density = density.clamp(0.1, 3.0);
    }

    fn step(&mut self, dt: f32, rng: &mut Rng) {
        self.t += dt;
        for s in &mut self.shooters {
            s.x += s.vx * dt;
            s.y += s.vy * dt;
            s.life -= dt;
        }
        self.shooters.retain(|s| s.life > 0.0);
        if self.width > 0 && rng.chance(dt * 0.12 * self.density) {
            self.shooters.push(Shooter {
                x: rng.range(0.0, f32::from(self.width)),
                y: rng.range(0.0, f32::from(self.height) * 0.4),
                vx: rng.range(18.0, 34.0) * if rng.chance(0.5) { 1.0 } else { -1.0 },
                vy: rng.range(3.0, 7.0),
                life: rng.range(0.8, 1.6),
            });
        }
    }

    fn render(&mut self, out: &mut Vec<Glyph>) {
        for s in &self.stars {
            let twinkle = 0.5 + 0.5 * (self.t * s.speed + s.phase).sin();
            let k = 0.18 + 0.5 * twinkle * twinkle;
            out.push(Glyph {
                x: s.x,
                y: s.y,
                ch: s.ch,
                rgb: scale(s.rgb, k),
            });
        }
        for sh in &self.shooters {
            let dir = if sh.vx > 0.0 { -1.0 } else { 1.0 };
            for i in 0..6 {
                let x = sh.x + dir * i as f32 * 1.4;
                let y = sh.y - dir * i as f32 * 0.25 * sh.vy.signum();
                if x < 0.0 || y < 0.0 || x >= f32::from(self.width) || y >= f32::from(self.height) {
                    continue;
                }
                let fade = (1.0 - i as f32 / 6.0) * (sh.life.min(0.5) / 0.5);
                out.push(Glyph {
                    x: x as u16,
                    y: y as u16,
                    ch: if i == 0 { '✦' } else { '─' },
                    rgb: scale(hex(0xffffff), 0.25 + 0.7 * fade),
                });
            }
        }
    }
}
