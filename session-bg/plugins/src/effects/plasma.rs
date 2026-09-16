use super::Effect;
use crate::frame::{hex, mix, scale, Glyph};
use crate::rng::Rng;

pub struct Plasma {
    width: u16,
    height: u16,
    density: f32,
    t: f32,
    phase: [f32; 4],
}

impl Plasma {
    pub fn new(density: f32) -> Self {
        Self {
            width: 0,
            height: 0,
            density,
            t: 0.0,
            phase: [0.0; 4],
        }
    }

    fn field(&self, x: f32, y: f32) -> f32 {
        let t = self.t;
        let p = &self.phase;
        let cx = 90.0 + 60.0 * (t * 0.23 + p[0]).sin();
        let cy = 30.0 + 20.0 * (t * 0.17 + p[1]).cos();
        let dx = x - cx;
        let dy = (y - cy) * 2.0;
        let v = (x * 0.13 + t * 0.5 + p[0]).sin()
            + (y * 0.31 - t * 0.4 + p[1]).sin()
            + ((x * 0.08 + y * 0.17) + t * 0.3 + p[2]).sin()
            + ((dx * dx + dy * dy).sqrt() * 0.15 - t * 0.7 + p[3]).sin();
        v / 4.0
    }
}

const BRAILLE_BITS: [[u8; 2]; 4] = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];

impl Effect for Plasma {
    fn resize(&mut self, width: u16, height: u16, rng: &mut Rng) {
        self.width = width;
        self.height = height;
        if self.phase == [0.0; 4] {
            self.phase = [
                rng.range(0.0, std::f32::consts::TAU),
                rng.range(0.0, std::f32::consts::TAU),
                rng.range(0.0, std::f32::consts::TAU),
                rng.range(0.0, std::f32::consts::TAU),
            ];
        }
    }

    fn set_density(&mut self, density: f32) {
        self.density = density.clamp(0.1, 3.0);
    }

    fn step(&mut self, dt: f32, _rng: &mut Rng) {
        self.t += dt;
    }

    fn render(&mut self, out: &mut Vec<Glyph>) {
        let threshold = (0.3 - 0.2 * (self.density - 1.0)).clamp(0.05, 0.9);
        let cold = hex(0x3d59a1);
        let warm = hex(0xbb9af7);
        let hot = hex(0x7dcfff);
        for cy in 0..self.height {
            for cx in 0..self.width {
                let mut bits = 0u8;
                let mut sum = 0.0;
                for (row, pair) in BRAILLE_BITS.iter().enumerate() {
                    for (col, bit) in pair.iter().enumerate() {
                        let x = f32::from(cx) * 2.0 + col as f32;
                        let y = f32::from(cy) * 4.0 + row as f32;
                        let v = self.field(x, y * 0.5);
                        sum += v;
                        if v > threshold {
                            bits |= bit;
                        }
                    }
                }
                if bits == 0 {
                    continue;
                }
                let avg = (sum / 8.0 + 1.0) * 0.5;
                let rgb = if avg < 0.6 {
                    mix(cold, warm, avg / 0.6)
                } else {
                    mix(warm, hot, (avg - 0.6) / 0.4)
                };
                out.push(Glyph {
                    x: cx,
                    y: cy,
                    ch: char::from_u32(0x2800 + u32::from(bits)).unwrap_or('⠿'),
                    rgb: scale(rgb, 0.55),
                });
            }
        }
    }
}
