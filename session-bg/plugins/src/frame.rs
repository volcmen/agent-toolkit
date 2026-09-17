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

    pub fn is_free_with_halo(&self, x: u16, y: u16, halo: u16) -> bool {
        if !self.is_free(x, y) {
            return false;
        }
        let halo = halo.min(1);
        for yy in y.saturating_sub(halo)..=y.saturating_add(halo).min(self.height.saturating_sub(1))
        {
            for xx in
                x.saturating_sub(halo)..=x.saturating_add(halo).min(self.width.saturating_sub(1))
            {
                if !self.is_free(xx, yy) {
                    return false;
                }
            }
        }
        true
    }

    pub fn is_free(&self, x: u16, y: u16) -> bool {
        x < self.width
            && y < self.height
            && !self.cells[y as usize * self.width as usize + x as usize]
    }
}

// Deliberate one-cell vocabulary. All other code points (controls, emoji,
// combining marks, wide CJK and private-use characters) become safe ASCII.
pub fn safe_glyph(ch: char) -> char {
    match ch {
        ' '..='~' | '\u{2500}'..='\u{259f}' | '\u{2800}'..='\u{28ff}' | '\u{ff66}'..='\u{ff9d}' => {
            ch
        }
        '·' | '•' | '∙' | '●' | '☺' | '☻' | '♟' | '♙' | '⚙' | '✎' | '⌨' | '▣' | '▤' | '▥' | '▦'
        | '▧' | '▨' | '▩' | '♥' | '★' | '✦' | '✧' | '☁' | '☂' | '☀' | '☾' | '♠' | '♣' | '°' => {
            ch
        }
        _ => '?',
    }
}

pub const FORTRESS_GLYPHS: &[char] = &[
    '#', '.', '+', '=', ':', '<', '>', '@', 'd', '*', '!', '~', '?',
];

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

pub const MATRIX_GLYPHS: &[char] = &[
    'ｱ', 'ｲ', 'ｳ', 'ｴ', 'ｵ', 'ｶ', 'ｷ', 'ｸ', 'ｹ', 'ｺ', 'ｻ', 'ｼ', 'ｽ', 'ｾ', 'ｿ', 'ﾀ', 'ﾁ', 'ﾂ', 'ﾃ',
    'ﾄ', 'ﾅ', 'ﾆ', 'ﾈ', 'ﾉ', 'ﾊ', 'ﾋ', 'ﾌ', 'ﾍ', 'ﾎ', 'ﾏ', 'ﾐ', 'ﾑ', 'ﾒ', 'ﾓ', 'ﾔ', 'ﾕ', 'ﾖ', 'ﾗ',
    'ﾘ', 'ﾙ', 'ﾚ', 'ﾜ', 'ﾝ', '0', '1', '2', '3', '5', '7', '8', '9', 'Z', 'X', ':', '=', '*', '+',
    '<', '>',
];

pub const BLOCK_GLYPHS: &[char] = &['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

pub const SHADE_GLYPHS: &[char] = &['░', '▒', '▓', '█'];

pub const ASCII_GLYPHS: &[char] = &['.', ':', '-', '=', '+', '*', '#', '%', '@'];

pub const DOT_GLYPHS: &[char] = &['·', '•', '∙', '●'];

pub const BOX_GLYPHS: &[char] = &['─', '│', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼'];

pub const RAMPS: &[(&str, &[u32])] = &[
    ("matrix", &[0x0b2915, 0x1f5a2a, 0x9ece6a, 0xd7ffe0]),
    ("ember", &[0x1a0a05, 0x7a2410, 0xe0601a, 0xffd08a]),
    ("ice", &[0x081828, 0x1f4f7a, 0x2ac3de, 0xdff6ff]),
    ("tokyonight", &[0x1a1b26, 0x3d59a1, 0x7aa2f7, 0xbb9af7]),
    ("mono", &[0x101010, 0x505050, 0xa0a0a0, 0xffffff]),
    ("warn", &[0x2a1000, 0xb35c00, 0xe0af68, 0xfff0c0]),
];

pub fn ramp(name: &str, t: f32) -> [f32; 3] {
    let stops = RAMPS
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, stops)| *stops)
        .unwrap_or(RAMPS[4].1);
    let t = if t.is_finite() {
        t.clamp(0.0, 1.0)
    } else {
        0.0
    };
    let last = stops.len() - 1;
    let scaled = t * last as f32;
    let index = (scaled.floor() as usize).min(last - 1);
    mix(
        hex(stops[index]),
        hex(stops[index + 1]),
        scaled - index as f32,
    )
}

pub fn hsl(h: f32, s: f32, l: f32) -> [f32; 3] {
    let h = h.rem_euclid(1.0);
    let s = s.clamp(0.0, 1.0);
    let l = l.clamp(0.0, 1.0);
    if s <= 0.0 {
        return [l, l, l];
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let hue_to_rgb = |p: f32, q: f32, t: f32| -> f32 {
        let t = t.rem_euclid(1.0);
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    [
        hue_to_rgb(p, q, h + 1.0 / 3.0),
        hue_to_rgb(p, q, h),
        hue_to_rgb(p, q, h - 1.0 / 3.0),
    ]
}

pub fn braille(mask: u32) -> char {
    char::from_u32(0x2800 + (mask & 0xff)).unwrap_or('⠀')
}
