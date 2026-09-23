//! A small Unix PTY host. The observer cannot consume or answer terminal traffic.
mod pty;
mod screen;

use sbg_fx::engine::Engine;
use screen::{Screen, Size};
use std::{
    collections::VecDeque,
    ffi::OsString,
    fs, io,
    os::fd::AsRawFd,
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const QUEUE_LIMIT: usize = 256 * 1024;

#[derive(Default)]
struct Queue {
    bytes: Vec<u8>,
    offset: usize,
}
impl Queue {
    fn len(&self) -> usize {
        self.bytes.len() - self.offset
    }
    fn empty(&self) -> bool {
        self.len() == 0
    }
    fn append(&mut self, data: &[u8]) {
        if self.offset > 0 {
            self.bytes.drain(..self.offset);
            self.offset = 0;
        }
        self.bytes.extend_from_slice(data);
    }
    fn flush(&mut self, fd: i32) -> io::Result<()> {
        while !self.empty() {
            let bytes = &self.bytes[self.offset..];
            let count = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
            if count < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::WouldBlock {
                    break;
                }
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if count == 0 {
                return Err(io::ErrorKind::WriteZero.into());
            }
            self.offset += count as usize;
        }
        if self.empty() {
            self.bytes.clear();
            self.offset = 0;
        }
        Ok(())
    }
}

struct Signals {
    reader: UnixStream,
    flags: Vec<(i32, Arc<AtomicBool>)>,
    registrations: Vec<signal_hook::SigId>,
}
impl Signals {
    fn new() -> io::Result<Self> {
        let (reader, writer) = UnixStream::pair()?;
        reader.set_nonblocking(true)?;
        let mut signals = Self {
            reader,
            flags: Vec::new(),
            registrations: Vec::new(),
        };
        for signal in [
            libc::SIGCHLD,
            libc::SIGWINCH,
            libc::SIGINT,
            libc::SIGTERM,
            libc::SIGHUP,
            libc::SIGQUIT,
            libc::SIGTSTP,
            libc::SIGCONT,
        ] {
            let flag = Arc::new(AtomicBool::new(false));
            signals
                .registrations
                .push(signal_hook::flag::register(signal, flag.clone())?);
            signals
                .registrations
                .push(signal_hook::low_level::pipe::register(
                    signal,
                    writer.try_clone()?,
                )?);
            signals.flags.push((signal, flag));
        }
        Ok(signals)
    }
    fn take(&self) -> Vec<i32> {
        let mut bytes = [0; 1024];
        while matches!(read(self.reader.as_raw_fd(), &mut bytes), Ok(Some(n)) if n > 0) {}
        self.flags
            .iter()
            .filter_map(|(signal, flag)| flag.swap(false, Ordering::SeqCst).then_some(*signal))
            .collect()
    }
}
impl Drop for Signals {
    fn drop(&mut self) {
        for id in &self.registrations {
            signal_hook::low_level::unregister(*id);
        }
    }
}

fn read(fd: i32, bytes: &mut [u8]) -> io::Result<Option<usize>> {
    let count = unsafe { libc::read(fd, bytes.as_mut_ptr().cast(), bytes.len()) };
    if count >= 0 {
        return Ok(Some(count as usize));
    }
    let error = io::Error::last_os_error();
    if matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    ) {
        Ok(None)
    } else if error.raw_os_error() == Some(libc::EIO) {
        Ok(Some(0))
    } else {
        Err(error)
    }
}

fn poll(fds: &mut [libc::pollfd], timeout: Duration) -> io::Result<()> {
    let millis = timeout.as_millis().clamp(1, 1000) as i32;
    if unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, millis) } < 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    Ok(())
}
fn fd(fd: i32, events: i16) -> libc::pollfd {
    libc::pollfd {
        fd,
        events,
        revents: 0,
    }
}

/// Probe before spawning the child, so a response cannot be confused with one
/// of its own requests. Preserve every unrelated byte, including early typing.
type CursorProbe = (Option<(u16, u16)>, Vec<u8>);
fn cursor_probe() -> io::Result<CursorProbe> {
    let mut output = Queue::default();
    // A background host starts its child with neutral graphic rendition. This
    // gives partial-SGR clients (including Claude) an explicit known baseline.
    // It does not erase existing cells or borrow the cursor-save register.
    output.append(b"\x1b[0m\x1b[6n");
    let deadline = Instant::now() + Duration::from_millis(200);
    let mut input = Vec::new();
    while Instant::now() < deadline && input.len() < 64 * 1024 {
        output.flush(1)?;
        let mut fds = [
            fd(0, libc::POLLIN),
            fd(1, if output.empty() { 0 } else { libc::POLLOUT }),
        ];
        poll(&mut fds, deadline.saturating_duration_since(Instant::now()))?;
        if fds[0].revents & libc::POLLIN != 0 {
            let mut bytes = [0; 4096];
            if let Some(n) = read(0, &mut bytes)? {
                input.extend_from_slice(&bytes[..n]);
            }
            if let Some((start, end, row, col)) = cursor_report(&input) {
                input.drain(start..end);
                return Ok((Some((row, col)), input));
            }
        }
    }
    Ok((None, input))
}

fn cursor_report(bytes: &[u8]) -> Option<(usize, usize, u16, u16)> {
    for (start, prefix) in bytes.windows(2).enumerate() {
        if prefix != b"\x1b[" {
            continue;
        }
        let tail = &bytes[start + 2..];
        let count = tail
            .iter()
            .take_while(|b| b.is_ascii_digit() || **b == b';')
            .count();
        if count > 11 || tail.get(count) != Some(&b'R') {
            continue;
        }
        let value = std::str::from_utf8(&tail[..count]).ok()?;
        let Some((row, col)) = value.split_once(';') else {
            continue;
        };
        if let (Ok(row), Ok(col)) = (row.parse::<u16>(), col.parse::<u16>()) {
            if row > 0 && col > 0 {
                return Some((start, start + count + 3, row, col));
            }
        }
    }
    None
}

#[derive(Default)]
struct Metrics {
    input_bytes: u64,
    native_bytes: u64,
    background_bytes: u64,
    skipped_frames: u64,
    render_us: VecDeque<u64>,
    visible_glyphs: usize,
}

#[derive(Default)]
struct Health {
    last: Option<Instant>,
    cpu: f64,
}
impl Health {
    fn update(&mut self, metrics: &Metrics, screen: &Screen) {
        let now = Instant::now();
        if self
            .last
            .is_some_and(|last| now.duration_since(last) < Duration::from_secs(1))
        {
            return;
        }
        let Some(dir) = std::env::var_os("SBG_STATE").map(PathBuf::from) else {
            return;
        };
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        unsafe {
            libc::getrusage(libc::RUSAGE_SELF, &mut usage);
        }
        let seconds = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1_000_000.0;
        let cpu = seconds(usage.ru_utime) + seconds(usage.ru_stime);
        let percent = self
            .last
            .map(|last| (cpu - self.cpu) / now.duration_since(last).as_secs_f64() * 100.0);
        self.cpu = cpu;
        self.last = Some(now);
        let mut costs: Vec<_> = metrics.render_us.iter().copied().collect();
        costs.sort_unstable();
        let p95 = costs
            .get(costs.len().saturating_sub(1) * 95 / 100)
            .copied()
            .unwrap_or(0);
        let value = serde_json::json!({"v": 1, "backend": "own", "observer": "alacritty_terminal 0.26.0",
            "pid": std::process::id(), "ts": sbg_fx::state::now_secs(), "cpu_percent_one_core": percent,
            "max_rss_bytes": usage.ru_maxrss as u64 * if cfg!(target_os = "macos") { 1 } else { 1024 },
            "render_p95_ms": p95 as f64 / 1000.0, "frames": screen.frames,
            "skipped_frames": metrics.skipped_frames, "native_bytes": metrics.native_bytes,
            "background_bytes": metrics.background_bytes, "painting_safe": screen.safe(),
            "painting_suspended_reason": screen.suspension_reason(), "visible_glyphs": metrics.visible_glyphs});
        let temporary = dir.join("backend.json.tmp");
        if fs::write(&temporary, format!("{value}\n")).is_ok() {
            let _ = fs::rename(temporary, dir.join("backend.json"));
        }
    }
}

fn drain(output: &mut Queue, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    while !output.empty() && Instant::now() < deadline {
        output.flush(1)?;
        if !output.empty() {
            poll(&mut [fd(1, libc::POLLOUT)], Duration::from_millis(20))?;
        }
    }
    Ok(())
}

fn suspend(
    tty: &pty::TtyGuard,
    child: &pty::Child,
    screen: &mut Screen,
    output: &mut Queue,
) -> io::Result<()> {
    output.append(&screen.clear());
    drain(output, Duration::from_millis(250))?;
    tty.restore();
    unsafe {
        libc::raise(libc::SIGSTOP);
    }
    resume(tty, child, screen)
}

fn resume(tty: &pty::TtyGuard, child: &pty::Child, screen: &mut Screen) -> io::Result<()> {
    // A shell or another job may have changed the display while we were stopped,
    // even when its dimensions stayed the same. This also handles an external
    // SIGSTOP, which cannot enter our managed suspend path. Ask for a redraw.
    tty.raw()?;
    screen.invalidate();
    let size = pty::size(0)?;
    screen.resize(Size(size.ws_col, size.ws_row));
    child.resize(&size)?;
    child.signal(libc::SIGCONT);
    child.signal(libc::SIGWINCH);
    Ok(())
}

struct Session<'a> {
    signals: &'a Signals,
    tty: &'a pty::TtyGuard,
    child: &'a mut pty::Child,
    screen: &'a mut Screen,
    engine: &'a mut Option<Engine>,
    output: &'a mut Queue,
    metrics: &'a mut Metrics,
}
impl Session<'_> {
    fn run(&mut self, early_input: &[u8]) -> io::Result<i32> {
        let mut input = Queue::default();
        input.append(early_input);
        self.metrics.input_bytes += early_input.len() as u64;
        let master = self.child.master.as_raw_fd();
        let mut stdin_open = true;
        let mut master_open = true;
        let mut next = Instant::now();
        let mut last_frame = next;
        let mut last_output = next;
        let mut exited = None;
        let mut terminating = None;
        let mut health = Health::default();
        let opacity = std::env::var("SBG_OPACITY")
            .ok()
            .and_then(|s| s.parse::<f32>().ok())
            .filter(|v| v.is_finite())
            .unwrap_or(0.6);
        loop {
            if let Some(_signal) = self.child.poll()? {
                suspend(self.tty, self.child, self.screen, self.output)?;
            }
            if self.child.status.is_some() && exited.is_none() {
                exited = Some(Instant::now());
            }
            if !master_open && self.child.status.is_none() && terminating.is_none() {
                self.child.signal(libc::SIGHUP);
                terminating = Some(Instant::now());
            }
            if self.child.status.is_none()
                && terminating.is_some_and(|at: Instant| at.elapsed() > Duration::from_secs(2))
            {
                self.child.signal(libc::SIGKILL);
                unsafe {
                    libc::kill(self.child.pid, libc::SIGKILL);
                }
            }
            if exited.is_some() && !master_open && self.output.empty() {
                return Ok(self.child.status.unwrap_or(1));
            }
            if exited.is_some_and(|at: Instant| at.elapsed() > Duration::from_secs(1)) {
                // Reap descendants retaining the slave, but still drain every
                // byte already buffered in either PTY under backpressure.
                self.child.signal(libc::SIGHUP);
                if exited.is_some_and(|at: Instant| at.elapsed() > Duration::from_secs(3)) {
                    self.child.signal(libc::SIGKILL);
                }
            }
            self.output.flush(1)?;
            if master_open && !input.empty() {
                match input.flush(master) {
                    Err(e) if e.raw_os_error() == Some(libc::EIO) => {
                        master_open = false;
                    }
                    result => result?,
                }
            }
            let now = Instant::now();
            if now >= next {
                if let Some(engine) = self.engine.as_mut() {
                    if self.child.status.is_none() {
                        let measured = Instant::now();
                        let occupancy = self.screen.occupancy();
                        if let Some(glyphs) =
                            engine.render(&occupancy, last_frame.elapsed().as_secs_f32().min(0.25))
                        {
                            self.metrics.visible_glyphs = glyphs.len();
                            if self.output.empty()
                                && last_output.elapsed() >= Duration::from_millis(20)
                            {
                                let bytes = self.screen.paint(&glyphs, engine.opacity(opacity));
                                self.metrics.background_bytes += bytes.len() as u64;
                                self.output.append(&bytes);
                            } else {
                                self.metrics.skipped_frames += 1;
                            }
                        }
                        last_frame = now;
                        self.metrics
                            .render_us
                            .push_back(measured.elapsed().as_micros() as u64);
                        if self.metrics.render_us.len() > 120 {
                            self.metrics.render_us.pop_front();
                        }
                        health.update(self.metrics, self.screen);
                    }
                    next = now + engine.interval();
                } else {
                    next = now + Duration::from_millis(500);
                }
            }
            let mut fds = [
                fd(
                    if stdin_open && input.len() < QUEUE_LIMIT {
                        0
                    } else {
                        -1
                    },
                    libc::POLLIN,
                ),
                fd(
                    if master_open && (self.output.len() < QUEUE_LIMIT || !input.empty()) {
                        master
                    } else {
                        -1
                    },
                    (if self.output.len() < QUEUE_LIMIT {
                        libc::POLLIN
                    } else {
                        0
                    }) | if input.empty() { 0 } else { libc::POLLOUT },
                ),
                fd(
                    1,
                    if self.output.empty() {
                        0
                    } else {
                        libc::POLLOUT
                    },
                ),
                fd(self.signals.reader.as_raw_fd(), libc::POLLIN),
            ];
            poll(&mut fds, next.saturating_duration_since(Instant::now()))?;
            // Apply pending geometry before observing a redraw delivered by the
            // same poll wakeup. Invalidating after that redraw would lose it.
            for signal in self.signals.take() {
                match signal {
                    libc::SIGCHLD => (),
                    libc::SIGWINCH => {
                        let size = pty::size(0)?;
                        // Resizing invalidates the old overlay coordinates. Resume
                        // painting only after the child clears and anchors its view.
                        self.screen.resize(Size(size.ws_col, size.ws_row));
                        self.child.resize(&size)?;
                    }
                    libc::SIGCONT => resume(self.tty, self.child, self.screen)?,
                    libc::SIGTSTP => {
                        self.child.signal(signal);
                        suspend(self.tty, self.child, self.screen, self.output)?;
                    }
                    signal => {
                        self.child.signal(signal);
                        if matches!(signal, libc::SIGTERM | libc::SIGHUP | libc::SIGQUIT) {
                            terminating = Some(Instant::now());
                        }
                    }
                }
            }
            // Native output wins a tie with the animation deadline.
            if fds[1].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0
                && self.output.len() < QUEUE_LIMIT
            {
                let mut bytes = [0; 32 * 1024];
                if let Some(n) = read(master, &mut bytes)? {
                    if n == 0 {
                        master_open = false;
                    } else {
                        let erased = self.screen.relay(&bytes[..n]);
                        self.metrics.background_bytes += erased.len() as u64;
                        self.output.append(&erased);
                        self.output.append(&bytes[..n]);
                        self.metrics.native_bytes += n as u64;
                        last_output = Instant::now();
                    }
                }
            }
            if fds[0].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                let mut bytes = [0; 32 * 1024];
                if let Some(n) = read(0, &mut bytes)? {
                    if n == 0 {
                        stdin_open = false;
                        self.child.signal(libc::SIGHUP);
                        terminating = Some(Instant::now());
                    } else {
                        input.append(&bytes[..n]);
                        self.metrics.input_bytes += n as u64;
                    }
                }
            }
        }
    }
}

fn run(args: &[OsString], background: bool, metrics_path: Option<PathBuf>) -> io::Result<i32> {
    let started = Instant::now();
    let size = pty::size(0)?;
    let signals = Signals::new()?;
    let tty = pty::TtyGuard::new()?;
    let (anchor, early_input) = if background {
        cursor_probe()?
    } else {
        (None, Vec::new())
    };
    let mut child = pty::Child::spawn(args, &tty, &size)?;
    let mut screen = Screen::new(Size(size.ws_col, size.ws_row));
    if background {
        screen.observe(b"\x1b[0m");
    }
    if let Some((row, col)) = anchor {
        screen.anchor(row, col);
    }
    let mut engine = if background {
        if let Some(dir) = std::env::var_os("SBG_STATE") {
            fs::create_dir_all(dir)?;
        }
        Some(Engine::from_env().map_err(io::Error::other)?)
    } else {
        None
    };
    let mut output = Queue::default();
    let mut metrics = Metrics::default();
    // Unwind through both guards, including when an effect panics. Terminal
    // mode cleanup and termios restoration happen before reporting the failure.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        Session {
            signals: &signals,
            tty: &tty,
            child: &mut child,
            screen: &mut screen,
            engine: &mut engine,
            output: &mut output,
            metrics: &mut metrics,
        }
        .run(&early_input)
    }));
    let erased = screen.clear();
    metrics.background_bytes += erased.len() as u64;
    output.append(&erased);
    output.append(&screen.cleanup());
    if background {
        output.append(b"\x1b[0m");
    }
    let _ = drain(&mut output, Duration::from_secs(1));
    if let Some(path) = metrics_path {
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        unsafe {
            libc::getrusage(libc::RUSAGE_SELF, &mut usage);
        }
        let seconds = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1_000_000.0;
        let value = serde_json::json!({"backend": "own", "elapsed_seconds": started.elapsed().as_secs_f64(),
            "cpu_seconds": seconds(usage.ru_utime) + seconds(usage.ru_stime),
            "max_rss_bytes": usage.ru_maxrss as u64 * if cfg!(target_os = "macos") { 1 } else { 1024 },
            "input_bytes": metrics.input_bytes, "native_bytes": metrics.native_bytes,
            "background_bytes": metrics.background_bytes, "frames": screen.frames,
            "changed_cells": screen.changed_cells, "skipped_frames": metrics.skipped_frames});
        let _ = fs::write(path, format!("{value}\n"));
    }
    match result {
        Ok(result) => result,
        Err(_) => Err(io::Error::other("terminal backend panicked")),
    }
}

fn main() {
    // Also correct when invoked directly rather than through bin/sbg. Set these
    // before signal registration, effects or child processes are initialized.
    std::env::set_var("SBG_BACKEND", "own");
    std::env::set_var("SBG_ACTIVE", "1");
    let mut args = std::env::args_os().skip(1);
    let mut background = true;
    let mut metrics = None;
    let mut command = Vec::new();
    while let Some(arg) = args.next() {
        if arg == "--" {
            command.extend(args);
            break;
        } else if arg == "--no-background" {
            background = false;
        } else if arg == "--metrics" {
            metrics = args.next().map(PathBuf::from);
        } else if arg == "--help" || arg == "-h" {
            println!("sbg-term [--no-background] [--metrics FILE] -- COMMAND [ARG ...]\nExperimental Unix PTY backend with in-process session-bg effects.");
            return;
        } else if arg == "--version" {
            println!("sbg-term {}", env!("CARGO_PKG_VERSION"));
            return;
        } else {
            eprintln!("sbg-term: unknown option {arg:?}; use -- before the command");
            std::process::exit(2);
        }
    }
    if command.is_empty() {
        eprintln!("sbg-term: missing command; use -- COMMAND [ARG ...]");
        std::process::exit(2);
    }
    let code = match run(&command, background, metrics) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("sbg-term: {error}");
            1
        }
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cursor_probe_matches_only_complete_reports() {
        assert_eq!(
            cursor_report(b"typed\x1b[12;34Rmore"),
            Some((5, 13, 12, 34))
        );
        for invalid in [
            b"\x1b[1;2".as_slice(),
            b"\x1b[0;0R",
            b"\x1b[?1;2R",
            b"\x1b[1;2;3R",
        ] {
            assert_eq!(cursor_report(invalid), None);
        }
    }
}
