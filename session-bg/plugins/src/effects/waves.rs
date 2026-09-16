use super::Effect;
use crate::frame::{hex, scale, Glyph};
use crate::rng::Rng;

const SURFACE: [char; 8] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

struct Layer {
    depth: f32,
    amp: f32,
    freq: f32,
    speed: f32,
    phase: f32,
    rgb: [f32; 3],
    fill: char,
}

pub struct Waves {
    width: u16,
    height: u16,
    density: f32,
    t: f32,
    layers: Vec<Layer>,
}

impl Waves {
    pub fn new(density: f32) -> Self {
        Self {
            width: 0,
            height: 0,
            density,
            t: 0.0,
            layers: Vec::new(),
        }
    }

    fn surface_y(&self, layer: &Layer, x: f32) -> f32 {
        let h = f32::from(self.height);
        let base = h * (1.0 - layer.depth);
        base
            - layer.amp
                * ((x * layer.freq + self.t * layer.speed + layer.phase).sin()
                    + 0.5 * ((x * layer.freq * 2.3 - self.t * layer.speed * 0.7).sin()))
    }
}

impl Effect for Waves {
    fn resize(&mut self, width: u16, height: u16, rng: &mut Rng) {
        self.width = width;
        self.height = height;
        if self.layers.is_empty() {
            let palette = [hex(0x2ac3de), hex(0x7aa2f7), hex(0x3d59a1), hex(0x1f2f5a)];
            let fills = ['·', '~', '≈', '░'];
            for (i, rgb) in palette.iter().enumerate() {
                self.layers.push(Layer {
                    depth: 0.34 - i as f32 * 0.08,
                    amp: rng.range(0.8, 1.8) + i as f32 * 0.3,
                    freq: rng.range(0.08, 0.16),
                    speed: rng.range(0.6, 1.4) * if i % 2 == 0 { 1.0 } else { -1.0 },
                    phase: rng.range(0.0, std::f32::consts::TAU),
                    rgb: *rgb,
                    fill: fills[i],
                });
            }
        }
    }

    fn set_density(&mut self, density: f32) {
        self.density = density.clamp(0.1, 3.0);
    }

    fn step(&mut self, dt: f32, _rng: &mut Rng) {
        self.t += dt;
    }

    fn render(&self, out: &mut Vec<Glyph>) {
        let h = i32::from(self.height);
        let fill_rows = (2.0 * self.density).round().max(1.0) as i32;
        for x in 0..self.width {
            let mut covered = h;
            for (i, layer) in self.layers.iter().enumerate() {
                let sy = self.surface_y(layer, f32::from(x));
                let row = sy.floor() as i32;
                if row < 0 || row >= h {
                    continue;
                }
                if row >= covered {
                    continue;
                }
                let frac = 1.0 - (sy - sy.floor());
                let idx = ((frac * 7.0).round() as usize).min(7);
                let shade = 1.0 - i as f32 * 0.18;
                out.push(Glyph {
                    x,
                    y: row as u16,
                    ch: SURFACE[idx],
                    rgb: scale(layer.rgb, 0.55 * shade),
                });
                let mut y = row + 1;
                while y < covered && y < row + 1 + fill_rows {
                    out.push(Glyph {
                        x,
                        y: y as u16,
                        ch: layer.fill,
                        rgb: scale(layer.rgb, 0.35 * shade),
                    });
                    y += 1;
                }
                covered = row;
            }
        }
    }
}
