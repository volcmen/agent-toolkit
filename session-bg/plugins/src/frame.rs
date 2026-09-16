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
