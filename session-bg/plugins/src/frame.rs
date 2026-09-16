#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Glyph {
    pub x: u16,
    pub y: u16,
    pub ch: char,
    pub rgb: [f32; 3],
}

#[derive(Clone, Debug, Default)]
pub struct Occupancy {
    pub width: u16,
    pub height: u16,
    cells: Vec<bool>,
}

impl Occupancy {
    pub fn new(width: u16, height: u16) -> Self {
        Self {
            width,
            height,
            cells: vec![false; width as usize * height as usize],
        }
    }

    pub fn set(&mut self, x: u32, y: u32) {
        if x < u32::from(self.width) && y < u32::from(self.height) {
            self.cells[y as usize * self.width as usize + x as usize] = true;
        }
    }

    pub fn is_free(&self, x: u16, y: u16) -> bool {
        x < self.width
            && y < self.height
            && !self.cells[y as usize * self.width as usize + x as usize]
    }
}

pub fn scale(rgb: [f32; 3], k: f32) -> [f32; 3] {
    [
        (rgb[0] * k).clamp(0.0, 1.0),
        (rgb[1] * k).clamp(0.0, 1.0),
        (rgb[2] * k).clamp(0.0, 1.0),
    ]
}

pub fn mix(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    let t = t.clamp(0.0, 1.0);
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

pub fn hex(rgb: u32) -> [f32; 3] {
    [
        ((rgb >> 16) & 0xff) as f32 / 255.0,
        ((rgb >> 8) & 0xff) as f32 / 255.0,
        (rgb & 0xff) as f32 / 255.0,
    ]
}

pub fn shift_hue(rgb: [f32; 3], turns: f32) -> [f32; 3] {
    if turns.abs() < 1e-4 {
        return rgb;
    }
    let angle = turns * std::f32::consts::TAU;
    let (sin, cos) = angle.sin_cos();
    let y = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    let i = 0.596 * rgb[0] - 0.274 * rgb[1] - 0.322 * rgb[2];
    let q = 0.211 * rgb[0] - 0.523 * rgb[1] + 0.312 * rgb[2];
    let i2 = i * cos - q * sin;
    let q2 = i * sin + q * cos;
    [
        (y + 0.956 * i2 + 0.621 * q2).clamp(0.0, 1.0),
        (y - 0.272 * i2 - 0.647 * q2).clamp(0.0, 1.0),
        (y - 1.106 * i2 + 1.703 * q2).clamp(0.0, 1.0),
    ]
}

pub fn modulate(rgb: [f32; 3], hue: f32, bright: f32, tint: [f32; 3], tint_k: f32) -> [f32; 3] {
    let shifted = shift_hue(rgb, hue);
    let luma = 0.299 * shifted[0] + 0.587 * shifted[1] + 0.114 * shifted[2];
    let tinted = mix(shifted, scale(tint, (luma * 1.6).max(0.35)), tint_k * 0.8);
    scale(tinted, bright)
}
