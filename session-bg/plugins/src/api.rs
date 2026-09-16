use std::cell::RefCell;
use std::rc::Rc;

use mlua::{AnyUserData, Lua, Result as LuaResult, Table, UserData, UserDataMethods, Value};

use crate::frame::{self, Glyph};
use crate::noise;
use crate::rng::Rng;

#[derive(Default)]
pub struct FxBuf {
    pub width: u16,
    pub height: u16,
    pub glyphs: Vec<Glyph>,
}

#[derive(Clone, Default)]
pub struct Fx(pub Rc<RefCell<FxBuf>>);

fn number(value: &Value) -> Option<f64> {
    let n = match value {
        Value::Integer(i) => *i as f64,
        Value::Number(n) => *n,
        _ => return None,
    };
    n.is_finite().then_some(n)
}

fn channel(value: &Value) -> Option<f32> {
    number(value).map(|v| v.clamp(0.0, 1.0) as f32)
}

fn single_char(value: &Value) -> Option<char> {
    let Value::String(text) = value else {
        return None;
    };
    let text = text.to_str().ok()?;
    let mut chars = text.chars();
    let first = chars.next()?;
    chars.next().is_none().then_some(first)
}

impl UserData for Fx {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_method(
            "put",
            |_, this, (x, y, ch, r, g, b): (Value, Value, Value, Value, Value, Value)| {
                let mut buf = this.0.borrow_mut();
                let (Some(x), Some(y)) = (number(&x), number(&y)) else {
                    return Ok(());
                };
                let (x, y) = (x.floor(), y.floor());
                if x < 0.0 || y < 0.0 || x >= f64::from(buf.width) || y >= f64::from(buf.height) {
                    return Ok(());
                }
                let (Some(ch), Some(r), Some(g), Some(b)) =
                    (single_char(&ch), channel(&r), channel(&g), channel(&b))
                else {
                    return Ok(());
                };
                buf.glyphs.push(Glyph {
                    x: x as u16,
                    y: y as u16,
                    ch,
                    rgb: [r, g, b],
                });
                Ok(())
            },
        );
        methods.add_method("clear", |_, this, ()| {
            this.0.borrow_mut().glyphs.clear();
            Ok(())
        });
        methods.add_method("count", |_, this, ()| Ok(this.0.borrow().glyphs.len()));
    }
}

struct LuaRng(RefCell<Rng>);

impl UserData for LuaRng {
    fn add_methods<M: UserDataMethods<Self>>(methods: &mut M) {
        methods.add_method("f", |_, this, ()| Ok(this.0.borrow_mut().f32()));
        methods.add_method("range", |_, this, (lo, hi): (f32, f32)| {
            Ok(this.0.borrow_mut().range(lo, hi))
        });
        methods.add_method("below", |_, this, n: i64| {
            let n = n.max(0) as usize;
            Ok(this.0.borrow_mut().below(n) as i64)
        });
        methods.add_method("chance", |_, this, p: f32| {
            Ok(this.0.borrow_mut().chance(p))
        });
    }
}

fn glyph_table(lua: &Lua, chars: &[char]) -> LuaResult<Table> {
    let table = lua.create_table_with_capacity(chars.len(), 0)?;
    for (i, ch) in chars.iter().enumerate() {
        table.set(i + 1, ch.to_string())?;
    }
    Ok(table)
}

fn glyphs(lua: &Lua) -> LuaResult<Table> {
    let table = lua.create_table()?;
    table.set("matrix", glyph_table(lua, frame::MATRIX_GLYPHS)?)?;
    table.set("blocks", glyph_table(lua, frame::BLOCK_GLYPHS)?)?;
    table.set("shades", glyph_table(lua, frame::SHADE_GLYPHS)?)?;
    table.set("ascii", glyph_table(lua, frame::ASCII_GLYPHS)?)?;
    table.set("dots", glyph_table(lua, frame::DOT_GLYPHS)?)?;
    table.set("box", glyph_table(lua, frame::BOX_GLYPHS)?)?;
    let braille: Vec<char> = (0..256).map(frame::braille).collect();
    table.set("braille", glyph_table(lua, &braille)?)?;
    Ok(table)
}

pub fn install(lua: &Lua) -> LuaResult<AnyUserData> {
    let sbg = lua.create_table()?;
    sbg.set(
        "rng",
        lua.create_function(|lua, seed: Option<f64>| {
            let seed = seed.filter(|s| s.is_finite()).unwrap_or(0.0) as i64 as u64;
            lua.create_userdata(LuaRng(RefCell::new(Rng::new(seed))))
        })?,
    )?;
    sbg.set(
        "noise2",
        lua.create_function(|_, (x, y): (f32, f32)| Ok(noise::noise2(x, y)))?,
    )?;
    sbg.set(
        "noise3",
        lua.create_function(|_, (x, y, z): (f32, f32, f32)| Ok(noise::noise3(x, y, z)))?,
    )?;
    sbg.set(
        "fbm",
        lua.create_function(|_, (x, y, octaves): (f32, f32, Option<i64>)| {
            Ok(noise::fbm(x, y, octaves.unwrap_or(4).clamp(1, 8) as u32))
        })?,
    )?;
    sbg.set(
        "ramp",
        lua.create_function(|_, (name, t): (String, f32)| {
            let rgb = frame::ramp(&name, t);
            Ok((rgb[0], rgb[1], rgb[2]))
        })?,
    )?;
    sbg.set(
        "mix",
        lua.create_function(
            |_, (r1, g1, b1, r2, g2, b2, t): (f32, f32, f32, f32, f32, f32, f32)| {
                let rgb = frame::mix([r1, g1, b1], [r2, g2, b2], t);
                Ok((rgb[0], rgb[1], rgb[2]))
            },
        )?,
    )?;
    sbg.set(
        "scale",
        lua.create_function(|_, (r, g, b, k): (f32, f32, f32, f32)| {
            let rgb = frame::scale([r, g, b], k);
            Ok((rgb[0], rgb[1], rgb[2]))
        })?,
    )?;
    sbg.set(
        "hex",
        lua.create_function(|_, value: i64| {
            let rgb = frame::hex((value.clamp(0, 0xff_ffff)) as u32);
            Ok((rgb[0], rgb[1], rgb[2]))
        })?,
    )?;
    sbg.set(
        "shift_hue",
        lua.create_function(|_, (r, g, b, turns): (f32, f32, f32, f32)| {
            let rgb = frame::shift_hue([r, g, b], turns);
            Ok((rgb[0], rgb[1], rgb[2]))
        })?,
    )?;
    sbg.set(
        "braille",
        lua.create_function(|_, mask: i64| {
            Ok(frame::braille(mask.clamp(0, 255) as u32).to_string())
        })?,
    )?;
    sbg.set(
        "lerp",
        lua.create_function(|_, (a, b, t): (f32, f32, f32)| Ok(a + (b - a) * t))?,
    )?;
    sbg.set(
        "clamp",
        lua.create_function(|_, (v, lo, hi): (f32, f32, f32)| {
            Ok(if v < lo {
                lo
            } else if v > hi {
                hi
            } else {
                v
            })
        })?,
    )?;
    sbg.set(
        "smoothstep",
        lua.create_function(|_, (e0, e1, x): (f32, f32, f32)| {
            let t = if (e1 - e0).abs() < f32::EPSILON {
                0.0
            } else {
                ((x - e0) / (e1 - e0)).clamp(0.0, 1.0)
            };
            Ok(t * t * (3.0 - 2.0 * t))
        })?,
    )?;
    sbg.set(
        "wrap",
        lua.create_function(|_, (v, n): (f32, f32)| {
            Ok(if n.abs() < f32::EPSILON {
                0.0
            } else {
                v - n * (v / n).floor()
            })
        })?,
    )?;
    sbg.set("glyphs", glyphs(lua)?)?;
    lua.globals().set("sbg", sbg)?;
    lua.create_userdata(Fx::default())
}
