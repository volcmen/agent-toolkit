mod matrix;
mod plasma;
mod stars;
mod waves;

use crate::frame::{Glyph, Occupancy};
use crate::rng::Rng;

pub trait Effect {
    fn resize(&mut self, width: u16, height: u16, rng: &mut Rng);
    fn step(&mut self, dt: f32, rng: &mut Rng);
    fn render(&self, out: &mut Vec<Glyph>);
}

pub const NAMES: &[&str] = &["matrix", "plasma", "waves", "stars"];

pub fn create(name: &str, density: f32) -> Option<Box<dyn Effect>> {
    let density = density.clamp(0.1, 3.0);
    match name {
        "matrix" => Some(Box::new(matrix::Matrix::new(density))),
        "plasma" => Some(Box::new(plasma::Plasma::new(density))),
        "waves" => Some(Box::new(waves::Waves::new(density))),
        "stars" => Some(Box::new(stars::Stars::new(density))),
        _ => None,
    }
}

pub fn visible(glyphs: &[Glyph], occupancy: &Occupancy) -> Vec<Glyph> {
    glyphs
        .iter()
        .copied()
        .filter(|g| g.ch != ' ' && occupancy.is_free(g.x, g.y))
        .collect()
}
