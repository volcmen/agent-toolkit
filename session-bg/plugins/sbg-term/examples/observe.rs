//! Headless OUTER terminal fixture for optional real-app conformance probes.
//! stdin/stdout are JSON lines. This is never part of the runtime backend.
use alacritty_terminal::{
    event::{Event, EventListener, WindowSize},
    grid::Dimensions,
    index::{Column, Line},
    term::Config,
    vte::ansi::{Color, Processor, Rgb},
    Term,
};
use std::{
    io::{self, BufRead, Write},
    sync::{Arc, Mutex},
};

#[derive(Clone)]
struct Listener(Arc<Mutex<Vec<u8>>>);
impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        let response = match event {
            Event::PtyWrite(text) => text,
            Event::ColorRequest(index, format) => format(if index == 257 {
                Rgb {
                    r: 26,
                    g: 27,
                    b: 38,
                }
            } else {
                Rgb {
                    r: 192,
                    g: 202,
                    b: 245,
                }
            }),
            Event::TextAreaSizeRequest(format) => format(WindowSize {
                num_lines: 35,
                num_cols: 120,
                cell_width: 8,
                cell_height: 16,
            }),
            _ => return,
        };
        self.0
            .lock()
            .unwrap()
            .extend_from_slice(response.as_bytes());
    }
}
struct Size;
impl Dimensions for Size {
    fn columns(&self) -> usize {
        120
    }
    fn screen_lines(&self) -> usize {
        35
    }
    fn total_lines(&self) -> usize {
        35
    }
}
fn main() {
    let responses = Arc::new(Mutex::new(Vec::<u8>::new()));
    let mut term = Term::new(
        Config {
            scrolling_history: 0,
            kitty_keyboard: true,
            ..Config::default()
        },
        &Size,
        Listener(responses.clone()),
    );
    let mut parser: Processor = Processor::new();
    for line in io::stdin().lock().lines() {
        let input: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        if let Some(bytes) = input.get("bytes") {
            let bytes: Vec<u8> = serde_json::from_value(bytes.clone()).unwrap();
            parser.advance(&mut term, &bytes);
        }
        let mut value =
            serde_json::json!({"reply": std::mem::take(&mut *responses.lock().unwrap())});
        if input.get("snapshot").is_some() {
            let mut rows = Vec::new();
            let mut shaded_spaces = 0;
            for y in 0..35 {
                let mut row = String::new();
                for x in 0..120 {
                    let cell = &term.grid()[Line(y)][Column(x)];
                    row.push(cell.c);
                    if cell.c == ' ' && matches!(cell.bg, Color::Spec(_)) {
                        shaded_spaces += 1;
                    }
                }
                rows.push(row);
            }
            value["rows"] = serde_json::json!(rows);
            value["shaded_spaces"] = shaded_spaces.into();
        }
        println!("{value}");
        io::stdout().flush().unwrap();
    }
}
