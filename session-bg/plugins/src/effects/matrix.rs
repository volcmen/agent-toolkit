use super::Effect;
use crate::frame::{hex, mix, scale, Glyph};
use crate::rng::Rng;

const GLYPHS: &[char] = &[
    'ｱ', 'ｲ', 'ｳ', 'ｴ', 'ｵ', 'ｶ', 'ｷ', 'ｸ', 'ｹ', 'ｺ', 'ｻ', 'ｼ', 'ｽ', 'ｾ', 'ｿ', 'ﾀ', 'ﾁ', 'ﾂ', 'ﾃ',
    'ﾄ', 'ﾅ', 'ﾆ', 'ﾈ', 'ﾉ', 'ﾊ', 'ﾋ', 'ﾌ', 'ﾍ', 'ﾎ', 'ﾏ', 'ﾐ', 'ﾑ', 'ﾒ', 'ﾓ', 'ﾔ', 'ﾕ', 'ﾖ', 'ﾗ',
    'ﾘ', 'ﾙ', 'ﾚ', 'ﾜ', 'ﾝ', '0', '1', '2', '3', '5', '7', '8', '9', 'Z', 'X', ':', '=', '*', '+',
    '<', '>',
];

struct Drop {
    x: u16,
    head: f32,
    len: u16,
    speed: f32,
    glyphs: Vec<char>,
}

pub struct Matrix {
    width: u16,
    height: u16,
    density: f32,
    drops: Vec<Drop>,
    shimmer: f32,
}

impl Matrix {
    pub fn new(density: f32) -> Self {
        Self {
            width: 0,
            height: 0,
            density,
            drops: Vec::new(),
            shimmer: 0.0,
        }
    }

    fn target_drops(&self) -> usize {
        ((f32::from(self.width) * 0.22 * self.density).round() as usize).max(1)
    }

    fn spawn(&mut self, rng: &mut Rng, above: bool) {
        if self.width == 0 || self.height == 0 {
            return;
        }
        let len = rng.range(4.0, f32::from(self.height).max(6.0) * 0.6) as u16;
        let head = if above {
            -rng.range(0.0, f32::from(self.height))
        } else {
            rng.range(0.0, f32::from(self.height))
        };
        let glyphs = (0..len + 2).map(|_| GLYPHS[rng.below(GLYPHS.len())]).collect();
        self.drops.push(Drop {
            x: rng.below(self.width as usize) as u16,
            head,
            len: len.max(3),
            speed: rng.range(4.0, 14.0),
            glyphs,
        });
    }
}

impl Effect for Matrix {
    fn resize(&mut self, width: u16, height: u16, rng: &mut Rng) {
        self.width = width;
        self.height = height;
        self.drops.clear();
        let n = self.target_drops();
        for _ in 0..n {
            self.spawn(rng, false);
        }
    }

    fn set_density(&mut self, density: f32) {
        self.density = density.clamp(0.1, 3.0);
    }

    fn step(&mut self, dt: f32, rng: &mut Rng) {
        self.shimmer += dt;
        let h = f32::from(self.height);
        for d in &mut self.drops {
            d.head += d.speed * dt;
            if rng.chance(dt * 6.0) {
                let i = rng.below(d.glyphs.len());
                d.glyphs[i] = GLYPHS[rng.below(GLYPHS.len())];
            }
        }
        self.drops.retain(|d| d.head - f32::from(d.len) < h);
        while self.drops.len() < self.target_drops() {
            self.spawn(rng, true);
        }
    }

    fn render(&self, out: &mut Vec<Glyph>) {
        let head_col = hex(0xd7ffe0);
        let bright = hex(0x9ece6a);
        let dark = hex(0x1f5a2a);
        for d in &self.drops {
            let head = d.head.floor() as i32;
            for i in 0..i32::from(d.len) {
                let y = head - i;
                if y < 0 || y >= i32::from(self.height) {
                    continue;
                }
                let t = i as f32 / f32::from(d.len);
                let rgb = if i == 0 {
                    head_col
                } else {
                    let base = mix(bright, dark, t);
                    let pulse = 0.85 + 0.15 * ((self.shimmer * 3.0 + f32::from(d.x)).sin());
                    scale(base, (1.0 - t * 0.6) * pulse)
                };
                out.push(Glyph {
                    x: d.x,
                    y: y as u16,
                    ch: d.glyphs[i as usize % d.glyphs.len()],
                    rgb,
                });
            }
        }
    }
}
