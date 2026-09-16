const GRAD3: [[f32; 3]; 12] = [
    [1.0, 1.0, 0.0],
    [-1.0, 1.0, 0.0],
    [1.0, -1.0, 0.0],
    [-1.0, -1.0, 0.0],
    [1.0, 0.0, 1.0],
    [-1.0, 0.0, 1.0],
    [1.0, 0.0, -1.0],
    [-1.0, 0.0, -1.0],
    [0.0, 1.0, 1.0],
    [0.0, -1.0, 1.0],
    [0.0, 1.0, -1.0],
    [0.0, -1.0, -1.0],
];

fn hash(x: i64, y: i64, z: i64) -> u64 {
    let mut h = (x as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ (y as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F)
        ^ (z as u64).wrapping_mul(0x1656_67B1_9E37_79F9);
    h ^= h >> 33;
    h = h.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    h ^= h >> 29;
    h = h.wrapping_mul(0xC4CE_B9FE_1A85_EC53);
    h ^ (h >> 32)
}

fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn grad2(ix: i64, iy: i64, dx: f32, dy: f32) -> f32 {
    let angle = (hash(ix, iy, 0) >> 40) as f32 / (1u64 << 24) as f32 * std::f32::consts::TAU;
    let (sin, cos) = angle.sin_cos();
    dx * cos + dy * sin
}

fn grad3(ix: i64, iy: i64, iz: i64, dx: f32, dy: f32, dz: f32) -> f32 {
    let g = GRAD3[(hash(ix, iy, iz) % 12) as usize];
    dx * g[0] + dy * g[1] + dz * g[2]
}

fn split(v: f32) -> (i64, f32) {
    let floor = v.floor();
    (floor as i64, v - floor)
}

pub fn noise2(x: f32, y: f32) -> f32 {
    if !x.is_finite() || !y.is_finite() {
        return 0.0;
    }
    let (ix, fx) = split(x);
    let (iy, fy) = split(y);
    let (u, v) = (fade(fx), fade(fy));
    let n00 = grad2(ix, iy, fx, fy);
    let n10 = grad2(ix + 1, iy, fx - 1.0, fy);
    let n01 = grad2(ix, iy + 1, fx, fy - 1.0);
    let n11 = grad2(ix + 1, iy + 1, fx - 1.0, fy - 1.0);
    let value = lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
    (value * std::f32::consts::SQRT_2).clamp(-1.0, 1.0)
}

pub fn noise3(x: f32, y: f32, z: f32) -> f32 {
    if !x.is_finite() || !y.is_finite() || !z.is_finite() {
        return 0.0;
    }
    let (ix, fx) = split(x);
    let (iy, fy) = split(y);
    let (iz, fz) = split(z);
    let (u, v, w) = (fade(fx), fade(fy), fade(fz));
    let c = |a: i64, b: i64, c: i64| {
        grad3(
            ix + a,
            iy + b,
            iz + c,
            fx - a as f32,
            fy - b as f32,
            fz - c as f32,
        )
    };
    let x00 = lerp(c(0, 0, 0), c(1, 0, 0), u);
    let x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
    let x01 = lerp(c(0, 0, 1), c(1, 0, 1), u);
    let x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
    let value = lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
    (value * 1.2).clamp(-1.0, 1.0)
}

pub fn fbm(x: f32, y: f32, octaves: u32) -> f32 {
    let octaves = octaves.clamp(1, 8);
    let mut sum = 0.0;
    let mut amplitude = 1.0;
    let mut total = 0.0;
    let mut frequency = 1.0;
    for _ in 0..octaves {
        sum += amplitude * noise2(x * frequency, y * frequency);
        total += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    (sum / total).clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_is_deterministic_and_bounded() {
        for i in 0..200 {
            let x = i as f32 * 0.37;
            let y = i as f32 * -0.11;
            let a = noise2(x, y);
            assert_eq!(a, noise2(x, y));
            assert!((-1.0..=1.0).contains(&a), "noise2 out of range: {a}");
            let b = noise3(x, y, 0.5);
            assert_eq!(b, noise3(x, y, 0.5));
            assert!((-1.0..=1.0).contains(&b), "noise3 out of range: {b}");
            let c = fbm(x, y, 4);
            assert_eq!(c, fbm(x, y, 4));
            assert!((-1.0..=1.0).contains(&c), "fbm out of range: {c}");
        }
    }

    #[test]
    fn noise_varies_across_the_field() {
        let samples: Vec<f32> = (0..64).map(|i| noise2(i as f32 * 0.25, 3.0)).collect();
        let min = samples.iter().copied().fold(f32::MAX, f32::min);
        let max = samples.iter().copied().fold(f32::MIN, f32::max);
        assert!(max - min > 0.5, "noise2 is flat: {min}..{max}");
    }

    #[test]
    fn non_finite_input_is_zero() {
        assert_eq!(noise2(f32::NAN, 1.0), 0.0);
        assert_eq!(noise3(1.0, f32::INFINITY, 1.0), 0.0);
    }
}
