//! Unix PTY lifecycle. Child setup performs only async-signal-safe libc calls.
use std::ffi::{CString, OsString};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;

pub fn size(fd: RawFd) -> io::Result<libc::winsize> {
    let mut size: libc::winsize = unsafe { std::mem::zeroed() };
    if unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut size) } < 0 {
        return Err(io::Error::last_os_error());
    }
    if size.ws_col == 0
        || size.ws_row == 0
        || u32::from(size.ws_col) * u32::from(size.ws_row) > 250_000
    {
        return Err(io::Error::other(
            "terminal dimensions must be nonzero and at most 250000 cells",
        ));
    }
    Ok(size)
}

pub struct TtyGuard {
    original: libc::termios,
    flags: [(RawFd, libc::c_int); 2],
}

impl TtyGuard {
    pub fn new() -> io::Result<Self> {
        let mut original = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(0, &mut original) } < 0 {
            return Err(io::Error::other(
                "sbg-term requires an interactive terminal",
            ));
        }
        let guard = Self {
            original,
            flags: [(0, flags(0)?), (1, flags(1)?)],
        };
        guard.raw()?;
        Ok(guard)
    }

    pub fn raw(&self) -> io::Result<()> {
        let mut raw = self.original;
        unsafe {
            libc::cfmakeraw(&mut raw);
        }
        if unsafe { libc::tcsetattr(0, libc::TCSANOW, &raw) } < 0 {
            return Err(io::Error::last_os_error());
        }
        for (fd, _) in self.flags {
            nonblocking(fd)?;
        }
        Ok(())
    }

    pub fn restore(&self) {
        for (fd, flags) in self.flags {
            unsafe {
                libc::fcntl(fd, libc::F_SETFL, flags);
            }
        }
        unsafe {
            libc::tcsetattr(0, libc::TCSANOW, &self.original);
        }
    }
}

impl Drop for TtyGuard {
    fn drop(&mut self) {
        self.restore();
    }
}

fn flags(fd: RawFd) -> io::Result<libc::c_int> {
    let value = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if value < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(value)
    }
}

pub fn nonblocking(fd: RawFd) -> io::Result<()> {
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags(fd)? | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub struct Child {
    pub master: OwnedFd,
    pub pid: libc::pid_t,
    pub status: Option<i32>,
}

impl Child {
    pub fn spawn(args: &[OsString], tty: &TtyGuard, size: &libc::winsize) -> io::Result<Self> {
        let args: Vec<CString> = args
            .iter()
            .map(|s| CString::new(s.as_bytes()))
            .collect::<Result<_, _>>()
            .map_err(io::Error::other)?;
        let mut argv: Vec<_> = args.iter().map(|s| s.as_ptr()).collect();
        argv.push(std::ptr::null());
        let mut master = -1;
        // Arguments and termios are prepared before fork. No Rust allocation,
        // unwinding, or logging is permitted in the child before exec.
        let mut child_termios = tty.original;
        let mut child_size = *size;
        let pid = unsafe {
            libc::forkpty(
                &mut master,
                std::ptr::null_mut(),
                &mut child_termios,
                &mut child_size,
            )
        };
        if pid < 0 {
            return Err(io::Error::last_os_error());
        }
        if pid == 0 {
            unsafe {
                for signal in [
                    libc::SIGINT,
                    libc::SIGTERM,
                    libc::SIGHUP,
                    libc::SIGQUIT,
                    libc::SIGPIPE,
                    libc::SIGTSTP,
                    libc::SIGTTIN,
                    libc::SIGTTOU,
                    libc::SIGCONT,
                ] {
                    libc::signal(signal, libc::SIG_DFL);
                }
                libc::execvp(argv[0], argv.as_ptr());
                let message = b"sbg-term: could not execute child command\r\n";
                libc::write(2, message.as_ptr().cast(), message.len());
                libc::_exit(127);
            }
        }
        let child = Self {
            master: unsafe { OwnedFd::from_raw_fd(master) },
            pid,
            status: None,
        };
        nonblocking(master)?;
        unsafe {
            libc::fcntl(master, libc::F_SETFD, libc::FD_CLOEXEC);
        }
        Ok(child)
    }

    pub fn resize(&self, size: &libc::winsize) -> io::Result<()> {
        if unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ, size) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn signal(&self, signal: i32) {
        // The child owns the PTY session. Deliver to its foreground job, which
        // may be a shell's child rather than the original session leader.
        let group = unsafe { libc::tcgetpgrp(self.master.as_raw_fd()) };
        // Once the leader is reaped, only target a group still associated with
        // this PTY; its old PID must not become a fallback signal destination.
        if group <= 0 && self.status.is_some() {
            return;
        }
        unsafe {
            libc::kill(-if group > 0 { group } else { self.pid }, signal);
        }
    }

    pub fn poll(&mut self) -> io::Result<Option<i32>> {
        if self.status.is_some() {
            return Ok(None);
        }
        let mut status = 0;
        let pid = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG | libc::WUNTRACED) };
        if pid < 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        } else if pid > 0 {
            if libc::WIFSTOPPED(status) {
                return Ok(Some(libc::WSTOPSIG(status)));
            }
            self.status = Some(if libc::WIFEXITED(status) {
                libc::WEXITSTATUS(status)
            } else {
                128 + libc::WTERMSIG(status)
            });
        }
        Ok(None)
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        if self.status.is_none() {
            self.signal(libc::SIGHUP);
            // Cleanup is bounded even for a child ignoring signals.
            for _ in 0..20 {
                let _ = self.poll();
                if self.status.is_some() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            self.signal(libc::SIGKILL);
            unsafe {
                libc::kill(self.pid, libc::SIGKILL);
                libc::waitpid(self.pid, std::ptr::null_mut(), 0);
            }
        }
    }
}
