//! Passive screen observation and bounded background-only ANSI diffs.
//! Native application bytes and terminal responses never originate here.
use alacritty_terminal::{
    event::VoidListener,
    grid::Dimensions,
    index::{Column, Line},
    term::{cell::Flags, Config, TermDamage, TermMode},
    vte::ansi::{Color, NamedColor, Processor},
    Term,
};
use sbg_fx::frame::{Glyph, Occupancy};
use std::fmt::Write as _;

const FRAME_BUDGET: usize = 64 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Size(pub u16, pub u16);
impl Dimensions for Size {
    fn columns(&self) -> usize {
        usize::from(self.0)
    }
    fn screen_lines(&self) -> usize {
        usize::from(self.1)
    }
    fn total_lines(&self) -> usize {
        self.screen_lines()
    }
}

#[derive(Default, Debug)]
enum Parse {
    #[default]
    Ground,
    Escape,
    Csi(Vec<u8>),
    String {
        osc: bool,
        escape: bool,
    },
    Charset,
    Utf8(u8),
}

/// A framing observer, not an output filter. It prevents a frame from being
/// injected inside an escape sequence or UTF-8 codepoint. SGR is replayed exactly
/// instead of borrowing the application's DECSC/DECRC cursor-save register.
#[derive(Default, Debug)]
struct Fence {
    parse: Parse,
    sync: bool,
    anchored: bool,
    style_known: bool,
    sgr: Vec<u8>,
    styles: Vec<Style>,
    compact_style: bool,
    graphics: bool,
    charset: bool,
    keyboard_depth: u16,
    awaiting_clear: [bool; 2],
    theme_reporting: bool,
    modified_keys: bool,
    saved_styles: [Option<SavedStyle>; 2],
    alternate: bool,
}

#[derive(Clone, Debug)]
struct Style {
    raw: Vec<u8>,
    writes: u32,
}

#[derive(Clone, Debug)]
struct SavedStyle {
    sgr: Vec<u8>,
    styles: Vec<Style>,
    compact: bool,
    known: bool,
    anchored: bool,
}

/// Identify independent SGR attributes while treating extended-color payloads
/// as values, never as standalone reset/bold/etc. Unknown extensions retain
/// the exact bounded history instead of being compacted speculatively.
fn style_writes(parameters: &[u8]) -> Option<u32> {
    let text = std::str::from_utf8(parameters).ok()?;
    let mut parts = text.split(';');
    let mut writes = 0;
    while let Some(part) = parts.next() {
        let code = part.split(':').next()?;
        let code = if code.is_empty() {
            0
        } else {
            code.parse::<u16>().ok()?
        };
        let bit = match code {
            0 => u32::MAX,
            1 => 1,
            2 => 2,
            22 => 3,
            3 | 20 | 23 => 1 << 2,
            4 | 21 | 24 => 1 << 3,
            5 | 6 | 25 => 1 << 4,
            7 | 27 => 1 << 5,
            8 | 28 => 1 << 6,
            9 | 29 => 1 << 7,
            10..=19 => 1 << 8,
            26 | 50 => 1 << 9,
            30..=37 | 39 | 90..=97 => 1 << 10,
            40..=47 | 49 | 100..=107 => 1 << 11,
            51 | 52 | 54 => 1 << 12,
            53 | 55 => 1 << 13,
            59 => 1 << 14,
            60..=65 => 1 << 15,
            73..=75 => 1 << 16,
            38 | 48 | 58 => {
                if !part.contains(':') {
                    let count = match parts.next()? {
                        "2" => 3,
                        "5" => 1,
                        _ => return None,
                    };
                    for _ in 0..count {
                        parts.next()?.parse::<u16>().ok()?;
                    }
                }
                1 << match code {
                    38 => 10,
                    48 => 11,
                    _ => 14,
                }
            }
            _ => return None,
        };
        writes |= bit;
    }
    Some(writes)
}

impl Fence {
    fn save_style(&mut self) {
        self.saved_styles[usize::from(self.alternate)] = Some(SavedStyle {
            sgr: self.sgr.clone(),
            styles: self.styles.clone(),
            compact: self.compact_style,
            known: self.style_known,
            anchored: self.anchored,
        });
    }

    fn restore_style(&mut self) {
        if let Some(saved) = &self.saved_styles[usize::from(self.alternate)] {
            self.sgr.clone_from(&saved.sgr);
            self.styles.clone_from(&saved.styles);
            self.compact_style = saved.compact;
            self.style_known = saved.known;
            self.anchored = saved.anchored;
        } else {
            self.style_known = false;
            self.anchored = false;
        }
    }

    fn feed(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            match &mut self.parse {
                Parse::Ground => match byte {
                    0x1b => self.parse = Parse::Escape,
                    0x0e => self.charset = true,
                    // Once a legacy charset is used, wait for RIS. A saved
                    // cursor can restore its designation without a new SGR.
                    0x0f => (),
                    0xc2..=0xdf => self.parse = Parse::Utf8(1),
                    0xe0..=0xef => self.parse = Parse::Utf8(2),
                    0xf0..=0xf4 => self.parse = Parse::Utf8(3),
                    _ => (),
                },
                Parse::Utf8(left) => {
                    if *left == 1 || !(0x80..=0xbf).contains(&byte) {
                        self.parse = Parse::Ground;
                    } else {
                        *left -= 1;
                    }
                    // Invalid UTF-8 followed by ESC must still protect its sequence.
                    if byte == 0x1b {
                        self.parse = Parse::Escape;
                    }
                }
                Parse::Escape => {
                    self.parse = match byte {
                        b'[' => Parse::Csi(Vec::new()),
                        b']' => Parse::String {
                            osc: true,
                            escape: false,
                        },
                        b'P' | b'_' | b'^' | b'X' => {
                            // Graphics/DCS positioning is not represented by the cell
                            // grid. Native output continues; backgrounds stay suspended.
                            self.graphics = true;
                            Parse::String {
                                osc: false,
                                escape: false,
                            }
                        }
                        b'(' | b')' | b'*' | b'+' => Parse::Charset,
                        b'c' => {
                            self.anchored = true;
                            self.style_known = true;
                            self.sgr.clear();
                            self.styles.clear();
                            self.compact_style = true;
                            self.charset = false;
                            self.graphics = false;
                            self.awaiting_clear = [false; 2];
                            self.saved_styles = [None, None];
                            self.alternate = false;
                            Parse::Ground
                        }
                        b'7' => {
                            self.save_style();
                            Parse::Ground
                        }
                        b'8' => {
                            self.restore_style();
                            Parse::Ground
                        }
                        0x1b => Parse::Escape,
                        _ => Parse::Ground,
                    };
                }
                Parse::Charset => {
                    self.charset |= byte != b'B';
                    self.parse = Parse::Ground;
                }
                Parse::String { osc, escape } => {
                    if (*osc && byte == 7) || (*escape && byte == b'\\') {
                        self.parse = Parse::Ground;
                    } else {
                        *escape = byte == 0x1b;
                    }
                }
                Parse::Csi(parameters) => {
                    if (0x40..=0x7e).contains(&byte) {
                        let parameters = std::mem::take(parameters);
                        self.csi(&parameters, byte);
                        self.parse = Parse::Ground;
                    } else if byte == 0x1b {
                        self.parse = Parse::Escape;
                    } else if parameters.len() < 4096 {
                        parameters.push(byte);
                    } else {
                        self.graphics = true;
                    }
                }
            }
        }
    }

    fn csi(&mut self, parameters: &[u8], final_byte: u8) {
        if final_byte == b's' && parameters.is_empty() {
            self.save_style();
        }
        if final_byte == b'm' && parameters.starts_with(b">4;") {
            self.modified_keys = &parameters[3..] != b"0";
        }
        if final_byte == b'J' && parameters == b"2" {
            self.awaiting_clear[usize::from(self.alternate)] = false;
        }
        if matches!(final_byte, b'H' | b'f')
            && parameters.iter().all(|b| b.is_ascii_digit() || *b == b';')
        {
            self.anchored = true;
        }
        if final_byte == b'm'
            && parameters
                .iter()
                .all(|b| b.is_ascii_digit() || matches!(*b, b';' | b':'))
        {
            if parameters.is_empty() || parameters == b"0" || parameters.starts_with(b"0;") {
                self.sgr.clear();
                self.styles.clear();
                self.compact_style = true;
                self.style_known = true;
            }
            let mut raw = b"\x1b[".to_vec();
            raw.extend_from_slice(parameters);
            raw.push(b'm');
            let writes = style_writes(parameters);
            if let Some(writes) = writes.filter(|_| self.compact_style) {
                for style in &mut self.styles {
                    style.writes &= !writes;
                }
                self.styles.retain(|style| style.writes != 0);
                self.styles.push(Style { raw, writes });
                self.sgr = self
                    .styles
                    .iter()
                    .flat_map(|style| style.raw.iter().copied())
                    .collect();
            } else {
                self.compact_style = false;
                if self.sgr.len() + raw.len() <= 4096 {
                    self.sgr.extend(raw);
                } else {
                    self.style_known = false;
                }
            }
            if self.sgr.len() > 4096 {
                self.style_known = false;
                self.sgr.clear();
                self.styles.clear();
                self.compact_style = false;
            }
        }
        if final_byte == b'u' {
            if parameters.starts_with(b">") {
                self.keyboard_depth = self.keyboard_depth.saturating_add(1);
            } else if parameters.starts_with(b"<") {
                let count = std::str::from_utf8(&parameters[1..])
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1);
                self.keyboard_depth = self.keyboard_depth.saturating_sub(count);
            } else if parameters.is_empty() {
                self.restore_style();
            }
        }
        if matches!(final_byte, b'h' | b'l') && parameters.starts_with(b"?") {
            for mode in parameters[1..].split(|b| *b == b';') {
                if matches!(mode, b"3" | b"5" | b"47" | b"1047" | b"69") {
                    self.graphics = true;
                }
                if mode == b"2026" {
                    self.sync = final_byte == b'h';
                }
                if mode == b"2031" {
                    self.theme_reporting = final_byte == b'h';
                }
                if mode == b"1049" && final_byte == b'l' && self.alternate {
                    self.alternate = false;
                    self.restore_style();
                }
                if mode == b"1049" && final_byte == b'h' {
                    if !self.alternate {
                        self.save_style();
                        self.alternate = true;
                    }
                    self.awaiting_clear[1] = false;
                }
                if mode == b"1048" {
                    if final_byte == b'h' {
                        self.save_style();
                    } else {
                        self.restore_style();
                    }
                }
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Paint {
    ch: char,
    rgb: [u8; 3],
}

pub struct Screen {
    term: Term<VoidListener>,
    parser: Processor,
    fence: Fence,
    size: Size,
    painted: Vec<Option<Paint>>,
    pub frames: u64,
    pub changed_cells: u64,
}

impl Screen {
    pub fn new(size: Size) -> Self {
        let config = Config {
            scrolling_history: 0,
            kitty_keyboard: true,
            ..Config::default()
        };
        let mut term = Term::new(config, &size, VoidListener);
        // The outer terminal may already contain text. Unknown inherited cells
        // remain occupied until the child writes or erases them explicitly.
        for y in 0..size.1 {
            for x in 0..size.0 {
                term.grid_mut()[Line(i32::from(y))][Column(usize::from(x))].c = '\u{fdd0}';
            }
        }
        Self {
            term,
            parser: Processor::new(),
            fence: Fence::default(),
            size,
            painted: vec![None; size.columns() * size.screen_lines()],
            frames: 0,
            changed_cells: 0,
        }
    }

    pub fn observe(&mut self, bytes: &[u8]) {
        self.fence.feed(bytes);
        self.parser.advance(&mut self.term, bytes);
    }

    /// Observe a native chunk, returning bytes to emit BEFORE that chunk.
    /// Damage includes cursor movement and insertion/deletion ranges. Scrolling
    /// marks full damage, so none of our glyphs can enter native scrollback.
    pub fn relay(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut restore = String::new();
        self.restore(&mut restore);
        self.term.reset_damage();
        self.observe(bytes);
        if !self.painted.iter().any(Option::is_some) {
            return Vec::new();
        }
        let mut next = self.painted.clone();
        if !self.safe() {
            next.fill(None);
        } else {
            match self.term.damage() {
                TermDamage::Full => next.fill(None),
                TermDamage::Partial(lines) => {
                    for line in lines {
                        let start = line.line * self.size.columns() + line.left;
                        let end = line.line * self.size.columns() + line.right + 1;
                        next[start..end].fill(None);
                    }
                }
            }
        }
        let mut out = Vec::new();
        while self.painted != next {
            out.extend(self.diff_restoring(&next, &restore));
        }
        out
    }

    pub fn anchor(&mut self, row: u16, col: u16) {
        self.observe(format!("\x1b[{row};{col}H").as_bytes());
    }

    pub fn safe(&self) -> bool {
        self.suspension_reason().is_none()
    }

    pub fn suspension_reason(&self) -> Option<&'static str> {
        if !matches!(self.fence.parse, Parse::Ground) {
            Some("partial terminal sequence")
        } else if self.fence.sync {
            Some("application synchronized update")
        } else if !self.fence.anchored {
            Some("unknown cursor position")
        } else if !self.fence.style_known {
            Some("unknown graphic rendition")
        } else if self.fence.graphics {
            Some("graphics or untracked terminal mode")
        } else if self.fence.charset {
            Some("legacy character set")
        } else if self.fence.awaiting_clear[usize::from(self.fence.alternate)] {
            Some("waiting for redraw after resize")
        } else if self.term.grid().cursor.input_needs_wrap {
            Some("cursor awaiting line wrap")
        } else if self.term.grid().cursor.template.hyperlink().is_some() {
            Some("active hyperlink")
        } else if self
            .term
            .mode()
            .intersects(TermMode::ORIGIN | TermMode::INSERT)
        {
            Some("origin or insert mode")
        } else {
            None
        }
    }

    pub fn occupancy(&self) -> Occupancy {
        let mut out = Occupancy::new(self.size.0, self.size.1);
        for y in 0..self.size.1 {
            for x in 0..self.size.0 {
                let c = &self.term.grid()[Line(i32::from(y))][Column(usize::from(x))];
                if c.c != ' '
                    || c.bg != Color::Named(NamedColor::Background)
                    || c.flags.intersects(
                        Flags::INVERSE
                            | Flags::ALL_UNDERLINES
                            | Flags::STRIKEOUT
                            | Flags::WIDE_CHAR
                            | Flags::WIDE_CHAR_SPACER
                            | Flags::LEADING_WIDE_CHAR_SPACER,
                    )
                    || c.zerowidth().is_some_and(|v| !v.is_empty())
                    || c.hyperlink().is_some()
                {
                    out.set(u32::from(x), u32::from(y));
                }
            }
        }
        let point = self.term.grid().cursor.point;
        out.set(point.column.0 as u32, point.line.0.max(0) as u32);
        // Never introduce wrap-pending state or scroll by painting the last column.
        for y in 0..self.size.1 {
            out.set(u32::from(self.size.0 - 1), u32::from(y));
        }
        out
    }

    fn restore(&self, out: &mut String) {
        let p = self.term.grid().cursor.point;
        let _ = write!(out, "\x1b[{};{}H\x1b[0m", p.line.0 + 1, p.column.0 + 1);
        out.push_str(std::str::from_utf8(&self.fence.sgr).unwrap_or(""));
        out.push_str("\x1b[?2026l");
    }

    pub fn paint(&mut self, glyphs: &[Glyph], opacity: f32) -> Vec<u8> {
        if !self.safe() {
            return Vec::new();
        }
        let occupancy = self.occupancy();
        let mut next = vec![None; self.painted.len()];
        for g in glyphs {
            if occupancy.is_free(g.x, g.y) {
                next[usize::from(g.y) * self.size.columns() + usize::from(g.x)] = Some(Paint {
                    ch: g.ch,
                    rgb: g
                        .rgb
                        .map(|v| (v * opacity.clamp(0.0, 1.0) * 255.0).clamp(0.0, 255.0) as u8),
                });
            }
        }
        self.diff(&next)
    }

    fn diff(&mut self, next: &[Option<Paint>]) -> Vec<u8> {
        let mut restore = String::new();
        self.restore(&mut restore);
        self.diff_restoring(next, &restore)
    }

    fn diff_restoring(&mut self, next: &[Option<Paint>], restore: &str) -> Vec<u8> {
        let mut out = String::new();
        let mut previous_position = None;
        let mut previous_rgb = None;
        for (index, &paint) in next.iter().enumerate() {
            if self.painted[index] == paint {
                continue;
            }
            if out.is_empty() {
                out.push_str("\x1b[?2026h\x1b[0m");
            }
            // Reserve room for cursor/SGR restoration. Finish remaining changes
            // next tick; never queue obsolete complete animation frames.
            if out.len() + restore.len() + 128 >= FRAME_BUDGET {
                break;
            }
            let x = index % self.size.columns();
            let y = index / self.size.columns();
            if previous_position != Some(index) {
                let _ = write!(out, "\x1b[{};{}H", y + 1, x + 1);
            }
            match paint {
                Some(p) => {
                    if previous_rgb != Some(p.rgb) {
                        let _ = write!(out, "\x1b[38;2;{};{};{}m", p.rgb[0], p.rgb[1], p.rgb[2]);
                        previous_rgb = Some(p.rgb);
                    }
                    out.push(p.ch);
                }
                None => out.push(' '),
            }
            previous_position = if x + 1 < self.size.columns() {
                Some(index + 1)
            } else {
                None
            };
            self.painted[index] = paint;
            self.changed_cells += 1;
        }
        if !out.is_empty() {
            out.push_str(restore);
            self.frames += 1;
        }
        out.into_bytes()
    }

    /// Remove the underlay *before* native output can scroll it into history.
    pub fn clear(&mut self) -> Vec<u8> {
        if !self.painted.iter().any(Option::is_some) {
            return Vec::new();
        }
        let next = vec![None; self.painted.len()];
        // An erase run is much smaller than a color frame; nevertheless honor the
        // same bound and drain all layers before allowing application output.
        let mut out = Vec::new();
        while self.painted.iter().any(Option::is_some) {
            out.extend(self.diff(&next));
        }
        out
    }

    pub fn resize(&mut self, size: Size) {
        // WINCH can arrive without a geometry change. Dropping the
        // cache then both strands visible glyphs and freezes a quiet client.
        if self.size == size {
            return;
        }
        self.term.resize(size);
        self.size = size;
        self.invalidate();
    }

    /// The host may have reflowed, or another job may have drawn while stopped.
    /// Neither saved cursor registers nor an inactive buffer are fresh evidence
    /// of the outer terminal's contents. Never erase guessed old coordinates.
    pub fn invalidate(&mut self) {
        self.painted = vec![None; self.size.columns() * self.size.screen_lines()];
        // The application must establish a fresh absolute anchor after resize.
        // Avoid projecting old coordinates into a host that may have reflowed.
        self.fence.anchored = false;
        self.fence.awaiting_clear = [true; 2];
        for saved in self.fence.saved_styles.iter_mut().flatten() {
            saved.anchored = false;
        }
    }

    pub fn cleanup(&self) -> Vec<u8> {
        let mut out = Vec::new();
        if self.term.grid().cursor.template.hyperlink().is_some() {
            out.extend_from_slice(b"\x1b]8;;\x1b\\");
        }
        if self.fence.modified_keys {
            out.extend_from_slice(b"\x1b[>4;0m");
        }
        if self.fence.theme_reporting {
            out.extend_from_slice(b"\x1b[?2031l");
        }
        if self.fence.sync {
            out.extend_from_slice(b"\x1b[?2026l");
        }
        if !self.term.mode().contains(TermMode::SHOW_CURSOR) {
            out.extend_from_slice(b"\x1b[?25h");
        }
        for (flag, sequence) in [
            (TermMode::ALT_SCREEN, b"\x1b[?1049l".as_slice()),
            (TermMode::BRACKETED_PASTE, b"\x1b[?2004l"),
            (TermMode::FOCUS_IN_OUT, b"\x1b[?1004l"),
            (TermMode::MOUSE_MODE, b"\x1b[?1000l\x1b[?1002l\x1b[?1003l"),
            (TermMode::SGR_MOUSE, b"\x1b[?1006l"),
        ] {
            if self.term.mode().intersects(flag) {
                out.extend_from_slice(sequence);
            }
        }
        if self.fence.keyboard_depth > 0 {
            out.extend_from_slice(format!("\x1b[<{}u", self.fence.keyboard_depth).as_bytes());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> Screen {
        let mut s = Screen::new(Size(80, 24));
        s.observe(b"\x1b[2J\x1b[H\x1b[0m");
        s
    }

    #[test]
    fn partial_sequences_and_sync_updates_never_accept_frames() {
        for data in [
            b"\x1b[38;2;1;2;3m".as_slice(),
            b"\x1b]0;title\x07",
            b"\xf0\x9f\x8c\x8d",
        ] {
            for split in 1..data.len() {
                let mut s = ready();
                s.observe(&data[..split]);
                assert!(!s.safe());
                s.observe(&data[split..]);
                assert!(s.safe());
            }
        }
        let mut s = ready();
        s.observe(b"\x1b[?2026hhello");
        assert!(!s.safe());
        s.observe(b"\x1b[?2026l");
        assert!(s.safe());
    }

    #[test]
    fn colored_spaces_wide_characters_and_cursor_are_protected() {
        let mut s = ready();
        s.observe("\x1b[48;2;30;40;50m   \x1b[0m界\x1b[4m \x1b[0m".as_bytes());
        let mask = s.occupancy();
        for x in 0..=6 {
            assert!(!mask.is_free(x, 0), "column {x}");
        }
        assert!(mask.is_free(7, 0));
    }

    #[test]
    fn native_damage_does_not_repaint_an_unchanged_background() {
        let mut s = ready();
        s.paint(
            &[Glyph {
                x: 30,
                y: 20,
                ch: '*',
                rgb: [1.0, 0.5, 0.2],
            }],
            0.6,
        );
        for _ in 0..100 {
            assert!(s.relay(b"\x1b[2;1Hnative update\x1b[K\x1b[0m").is_empty());
        }
        // A scrolling update must erase the layer before reaching the terminal.
        assert!(!s.relay(b"\x1b[24;1H\n").is_empty());
        assert!(s.painted.iter().all(Option::is_none));
    }

    #[test]
    fn modified_keyboard_protocol_is_not_replayed_as_style() {
        let mut s = ready();
        s.observe(b"\x1b[>4;2m");
        let frame = s.paint(
            &[Glyph {
                x: 2,
                y: 4,
                ch: '*',
                rgb: [1.0; 3],
            }],
            0.6,
        );
        let private_mode = b"\x1b[>4;2m";
        assert!(!frame.windows(private_mode.len()).any(|w| w == private_mode));
    }

    #[test]
    fn inherited_contents_and_uncertain_resize_are_not_painted() {
        let mut s = Screen::new(Size(80, 24));
        s.observe(b"\x1b[0m\x1b[1;1H");
        assert!(!s.occupancy().is_free(20, 10));
        s.observe(b"\x1b[2J");
        assert!(s.occupancy().is_free(20, 10));
        s.resize(Size(100, 30));
        s.observe(b"\x1b[H");
        assert!(!s.safe());
        s.observe(b"\x1b[2J");
        assert!(s.safe());
    }

    #[test]
    fn unchanged_size_preserves_animation_and_overlay_ownership() {
        let mut s = ready();
        let glyphs = [Glyph {
            x: 30,
            y: 20,
            ch: '*',
            rgb: [1.0; 3],
        }];
        assert!(!s.paint(&glyphs, 0.6).is_empty());
        for _ in 0..50 {
            s.resize(Size(80, 24));
            assert!(s.safe(), "unchanged dimensions suspended animation");
            assert!(s.paint(&glyphs, 0.6).is_empty());
        }
        assert!(!s.clear().is_empty(), "lost ownership of existing glyphs");
    }

    #[test]
    fn resize_invalidates_saved_anchors_and_both_screen_buffers() {
        for (save, restore) in [
            (b"\x1b7".as_slice(), b"\x1b8".as_slice()),
            (b"\x1b[s", b"\x1b[u"),
            (b"\x1b[?1048h", b"\x1b[?1048l"),
        ] {
            let mut s = ready();
            s.observe(save);
            s.resize(Size(100, 30));
            s.observe(b"\x1b[2J");
            s.observe(restore);
            assert!(!s.safe(), "saved position from before resize was trusted");
            s.observe(b"\x1b[H");
            assert!(s.safe());
        }
        let mut s = ready();
        s.observe(b"\x1b[?1049h\x1b[H");
        s.resize(Size(100, 30));
        s.observe(b"\x1b[2J\x1b[H");
        assert!(s.safe());
        s.observe(b"\x1b[?1049l\x1b[H");
        assert!(
            !s.safe(),
            "alternate redraw also trusted stale primary contents"
        );
        s.observe(b"\x1b[2J");
        assert!(s.safe());
    }

    #[test]
    fn repeated_resize_redraws_keep_foreground_cursor_and_style_intact() {
        let mut s = ready();
        let mut outer = ready();
        for index in 0..50 {
            let size = Size(81 + index, 24 + index % 7);
            // The host resizes before notifying the wrapper. Its previous
            // overlay may reflow differently from the native-only observer.
            outer.term.resize(size);
            s.resize(size);
            let native = format!(
                "\x1b[?2026h\x1b[0m\x1b[2J\x1b[HVIEW={}x{}\x1b[2;1H\x1b[48;2;30;40;50m   \x1b[0m\x1b[3;1H界🌍\x1b[?2026l",
                size.0, size.1
            );
            // Split the redraw inside CSI and UTF-8 sequences as PTYs may do.
            for chunk in native.as_bytes().chunks(7) {
                outer.observe(&s.relay(chunk));
                outer.observe(chunk);
            }
            assert!(s.safe());
            let glyphs = [Glyph {
                x: 30,
                y: 20,
                ch: '*',
                rgb: [1.0; 3],
            }];
            let frame = s.paint(&glyphs, 0.6);
            assert!(!frame.is_empty());
            outer.observe(&frame);
            assert_eq!(outer.term.grid().cursor, s.term.grid().cursor);
            outer.observe(&s.clear());
            for y in 0..size.1 {
                for x in 0..size.0 {
                    assert_eq!(
                        outer.term.grid()[Line(i32::from(y))][Column(usize::from(x))],
                        s.term.grid()[Line(i32::from(y))][Column(usize::from(x))],
                        "resize {index}, cell {x},{y}"
                    );
                }
            }
        }
    }

    #[test]
    fn partial_sgr_history_stays_bounded_and_restores_combined_attributes() {
        let mut s = ready();
        let mut physical = ready();
        let sequences = [
            b"\x1b[1;31m".as_slice(),
            b"\x1b[38;2;255;0;0m",
            b"\x1b[2;22;4:3m",
            b"\x1b[49;48;2;3;4;5m",
            b"\x1b[58:2::1:2:3m",
            b"\x1b[38;5;0m",
            b"\x1b[9;29;3;23;53;55m",
            b"\x1b[4;1;7;27;39m",
        ];
        for index in 0..5000 {
            let native = sequences[index % sequences.len()];
            physical.observe(&s.relay(native));
            physical.observe(native);
            let before = physical.term.grid().cursor.clone();
            physical.observe(&s.paint(
                &[Glyph {
                    x: 2,
                    y: 4,
                    ch: if index % 2 == 0 { '*' } else { '+' },
                    rgb: [1.0; 3],
                }],
                0.6,
            ));
            assert_eq!(physical.term.grid().cursor, before, "after update {index}");
            assert!(s.safe());
            assert!(s.fence.sgr.len() < 256);
        }
    }

    #[test]
    fn saved_rendition_and_alternate_slots_remain_known_and_correct() {
        for (save, restore) in [
            (b"\x1b7".as_slice(), b"\x1b8".as_slice()),
            (b"\x1b[s", b"\x1b[u"),
        ] {
            let mut s = ready();
            let mut physical = ready();
            for native in [
                b"\x1b[3;4H\x1b[31m".as_slice(),
                save,
                b"\x1b[12;4H\x1b[32m",
                restore,
                b"\x1b[?1049h\x1b[H\x1b[33m\x1b7\x1b[34m\x1b8",
                b"\x1b[?1049l",
            ] {
                physical.observe(&s.relay(native));
                physical.observe(native);
                assert!(s.safe());
                let before = physical.term.grid().cursor.clone();
                physical.observe(&s.paint(
                    &[Glyph {
                        x: 2,
                        y: 4,
                        ch: '*',
                        rgb: [1.0; 3],
                    }],
                    0.6,
                ));
                assert_eq!(physical.term.grid().cursor, before);
                physical.observe(&s.clear());
            }
        }
    }

    #[test]
    fn partial_native_updates_clear_before_the_sequence_and_keep_foreground() {
        for native in [
            b"\x1b[5;3Hnew text\x1b[31m".as_slice(),
            b"\x1b[2;1H\x1b[L",
            b"\x1b[4;1H\x1b[M",
            b"\x1b[24;1H\n",
            b"\x1b]0;unfinished",
        ] {
            let mut s = ready();
            let mut physical = ready();
            let frame = s.paint(
                &[
                    Glyph {
                        x: 2,
                        y: 4,
                        ch: '*',
                        rgb: [1.0; 3],
                    },
                    Glyph {
                        x: 3,
                        y: 20,
                        ch: '+',
                        rgb: [1.0; 3],
                    },
                ],
                0.6,
            );
            physical.observe(&frame);
            physical.observe(&s.relay(native));
            physical.observe(native);
            if native.ends_with(b"unfinished") {
                physical.observe(&s.relay(b"\x07"));
                physical.observe(b"\x07");
            }
            physical.observe(&s.clear());
            for y in 0..24 {
                for x in 0..80 {
                    let expected = &s.term.grid()[Line(y)][Column(x)];
                    let actual = &physical.term.grid()[Line(y)][Column(x)];
                    assert_eq!(
                        (actual.c, actual.bg),
                        (expected.c, expected.bg),
                        "{native:?} at {x},{y}"
                    );
                }
            }
            assert_eq!(physical.term.grid().cursor, s.term.grid().cursor);
        }
    }

    #[test]
    fn diff_preserves_cursor_style_saved_register_and_foreground() {
        let mut s = ready();
        s.observe(b"\x1b[3;4H\x1b[31mword\x1b7\x1b[10;12H\x1b[1;4;38;2;11;22;33m");
        let mut physical = ready();
        physical.observe(b"\x1b[3;4H\x1b[31mword\x1b7\x1b[10;12H\x1b[1;4;38;2;11;22;33m");
        let before = physical.term.grid().cursor.clone();
        let frame = s.paint(
            &[Glyph {
                x: 2,
                y: 4,
                ch: '*',
                rgb: [1.0, 0.5, 0.2],
            }],
            0.6,
        );
        physical.observe(&frame);
        assert_eq!(physical.term.grid().cursor, before);
        assert!(s
            .paint(
                &[Glyph {
                    x: 2,
                    y: 4,
                    ch: '*',
                    rgb: [1.0, 0.5, 0.2]
                }],
                0.6
            )
            .is_empty());
        physical.observe(&s.clear());
        physical.observe(b"\x1b8");
        s.observe(b"\x1b8");
        assert_eq!(physical.term.grid().cursor, s.term.grid().cursor);
        assert_eq!(physical.term.grid()[Line(4)][Column(2)].c, ' ');
    }
}
