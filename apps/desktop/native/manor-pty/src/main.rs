//! manor-pty: owns one pane's PTY for Manor's terminal host daemon.
//!
//! A drop-in for `pty-subprocess.js`: the daemon starts it with stdin and
//! stdout as pipes and speaks the frame protocol in `frame.rs` over them. One
//! thread, one `poll` loop:
//!
//! - stdin → frames → the PTY (Write), its size (Resize), its flow (Pause/Resume)
//! - PTY output → DATA frames on stdout, never splitting a UTF-8 character
//! - when stdout backs up, or the daemon sent Pause, the PTY isn't read, so the
//!   kernel's buffers fill and the program in the pane blocks: nothing piles up
//!   here
//! - SIGCHLD → EXIT once the shell is gone

mod foreground;
mod frame;
mod procs;
mod pty;
mod utf8;
mod wait;

use serde::Deserialize;
use std::collections::HashMap;
use std::io::ErrorKind;
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

/// Stop reading the PTY while this much is waiting to go to the daemon.
const OUT_HIGH_WATER: usize = 256 * 1024;
const READ_CHUNK: usize = 64 * 1024;
/// How long streaming output gathers before it's framed: pty-subprocess.js's
/// OUTPUT_BATCH_INTERVAL_MS.
const BATCH_WINDOW: Duration = Duration::from_millis(4);
/// A frame at least this big means output is streaming, not being typed.
const STREAMING_FRAME: usize = 256;
const KILL_ESCALATE_AFTER: Duration = Duration::from_secs(5);
/// node-pty's DESTROY_SOCKET_TIMEOUT_MS: how long EXIT waits for the PTY to
/// drain after the shell has gone.
const EXIT_DRAIN: Duration = Duration::from_millis(200);

#[derive(Deserialize)]
struct SpawnPayload {
    shell: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: String,
    cols: u16,
    rows: u16,
    #[serde(default)]
    env: HashMap<String, String>,
    /// Agent CLIs to look for in command lines (`pane-facts.ts`'s table),
    /// so the list lives in one place. Absent from an older daemon: then
    /// only plain process names are reported.
    #[serde(default, rename = "agentNames")]
    agent_names: Vec<String>,
}

#[derive(Deserialize)]
struct ResizePayload {
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum SignalName {
    Name(String),
    Number(i32),
}

#[derive(Deserialize)]
struct SignalPayload {
    signal: SignalName,
}

fn signal_number(s: &SignalName) -> Option<i32> {
    match s {
        SignalName::Number(n) => Some(*n),
        SignalName::Name(name) => Some(match name.trim_start_matches("SIG") {
            "HUP" => libc::SIGHUP,
            "INT" => libc::SIGINT,
            "QUIT" => libc::SIGQUIT,
            "KILL" => libc::SIGKILL,
            "TERM" => libc::SIGTERM,
            "USR1" => libc::SIGUSR1,
            "USR2" => libc::SIGUSR2,
            "STOP" => libc::SIGSTOP,
            "CONT" => libc::SIGCONT,
            "TSTP" => libc::SIGTSTP,
            "WINCH" => libc::SIGWINCH,
            "ALRM" => libc::SIGALRM,
            _ => return None,
        }),
    }
}

// ── Signals arrive through a self-pipe so the poll loop sees them ──

static SIGNAL_PIPE: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_signal(sig: libc::c_int) {
    let fd = SIGNAL_PIPE.load(Ordering::Relaxed);
    let b = sig as u8;
    // SAFETY: write(2) is async-signal-safe.
    unsafe { libc::write(fd, (&b as *const u8).cast(), 1) };
}

fn install_signals() -> i32 {
    let mut fds = [0; 2];
    // SAFETY: pipe into a 2-int array.
    unsafe { libc::pipe(fds.as_mut_ptr()) };
    for fd in fds {
        pty::set_nonblocking(fd);
        pty::set_cloexec(fd);
    }
    SIGNAL_PIPE.store(fds[1], Ordering::Relaxed);
    // SAFETY: installing handlers that only write to the pipe.
    unsafe {
        for sig in [libc::SIGCHLD, libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            let mut sa: libc::sigaction = std::mem::zeroed();
            sa.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as usize;
            sa.sa_flags = libc::SA_RESTART;
            libc::sigemptyset(&mut sa.sa_mask);
            libc::sigaction(sig, &sa, std::ptr::null_mut());
        }
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    fds[0]
}

fn json_frame(out: &mut Vec<u8>, kind: u8, value: serde_json::Value) {
    frame::encode_into(out, kind, value.to_string().as_bytes());
}

struct Helper {
    decoder: frame::Decoder,
    child: Option<pty::Child>,
    /// Bytes waiting for stdout, from `out_off`.
    out: Vec<u8>,
    out_off: usize,
    /// Bytes waiting for the PTY.
    pty_in: Vec<u8>,
    /// PTY output not framed yet (see `after_read`).
    pending: Vec<u8>,
    flush_at: Option<Instant>,
    /// When the last DATA frame went, and how big it was.
    last_flush: Option<(Instant, usize)>,
    paused: bool,
    pty_eof: bool,
    exited: bool,
    /// The shell's exit code, waiting for the PTY to drain before EXIT goes.
    exit_code: Option<i32>,
    exit_by: Option<Instant>,
    stdin_open: bool,
    kill_deadline: Option<Instant>,
    read_buf: Vec<u8>,
    sampler: Option<foreground::Sampler>,
}

impl Helper {
    fn new() -> Self {
        let mut h = Helper {
            decoder: frame::Decoder::default(),
            child: None,
            out: Vec::new(),
            out_off: 0,
            pty_in: Vec::new(),
            pending: Vec::new(),
            flush_at: None,
            last_flush: None,
            paused: false,
            pty_eof: false,
            exited: false,
            exit_code: None,
            exit_by: None,
            stdin_open: true,
            kill_deadline: None,
            read_buf: vec![0; READ_CHUNK],
            sampler: None,
        };
        frame::encode_into(&mut h.out, frame::READY, b"");
        h
    }

    fn out_pending(&self) -> usize {
        self.out.len() - self.out_off
    }

    fn may_read_pty(&self) -> bool {
        self.child.as_ref().and_then(pty::Child::fd).is_some()
            && !self.pty_eof
            && !self.paused
            && self.queued() < OUT_HIGH_WATER
    }

    fn handle_frame(&mut self, kind: u8, payload: &[u8]) {
        match kind {
            frame::SPAWN => self.spawn(payload),
            frame::WRITE => {
                if self.child.is_some() {
                    self.pty_in.extend_from_slice(payload);
                }
            }
            frame::RESIZE => {
                if let (Some(fd), Ok(r)) = (
                    self.child.as_ref().and_then(pty::Child::fd),
                    serde_json::from_slice::<ResizePayload>(payload),
                ) {
                    let _ = pty::resize(fd, r.cols, r.rows);
                }
                // Output read at the old size goes out ahead of this.
                self.flush_data(false);
                frame::encode_into(&mut self.out, frame::RESIZED, b"");
            }
            frame::KILL => {
                if let Some(child) = &self.child
                    && procs::kill_tree(child.pid, libc::SIGTERM).is_ok()
                {
                    self.kill_deadline = Some(Instant::now() + KILL_ESCALATE_AFTER);
                }
            }
            frame::SIGNAL => {
                if let (Some(child), Ok(s)) = (&self.child, serde_json::from_slice::<SignalPayload>(payload))
                    && let Some(sig) = signal_number(&s.signal)
                {
                    // SAFETY: plain syscall.
                    unsafe { libc::kill(child.pid, sig) };
                }
            }
            frame::DISPOSE => self.dispose(),
            frame::PAUSE => self.paused = true,
            frame::RESUME => self.paused = false,
            _ => {} // unknown frame types are ignored, as in pty-subprocess.js
        }
    }

    fn spawn(&mut self, payload: &[u8]) {
        if self.child.is_some() {
            return;
        }
        let p: SpawnPayload = match serde_json::from_slice(payload) {
            Ok(p) => p,
            Err(e) => {
                json_frame(
                    &mut self.out,
                    frame::ERROR,
                    serde_json::json!({ "message": format!("Error: bad spawn payload: {e}") }),
                );
                return;
            }
        };
        // As node-pty: the shell starts with PWD and TERM naming its own
        // cwd and terminal, whatever the daemon's environment said.
        let mut env_map = p.env;
        env_map.insert("PWD".into(), p.cwd.clone());
        env_map.insert("TERM".into(), "xterm-256color".into());
        let env: Vec<(String, String)> = env_map.into_iter().collect();
        match pty::spawn(&p.shell, &p.args, &p.cwd, &env, p.cols, p.rows) {
            Ok(child) => {
                json_frame(&mut self.out, frame::SPAWNED, serde_json::json!({ "pid": child.pid }));
                if let Some(msg) = &child.failed {
                    frame::encode_into(&mut self.out, frame::DATA, format!("{msg}\r\n").as_bytes());
                }
                self.sampler = Some(foreground::Sampler::new(child.pid, &p.shell, p.agent_names));
                self.child = Some(child);
            }
            Err(e) => {
                json_frame(
                    &mut self.out,
                    frame::ERROR,
                    serde_json::json!({ "message": format!("Error: spawn {} failed: {e}", p.shell) }),
                );
            }
        }
    }

    /// Read what the PTY has into `pending`, up to the high-water mark.
    fn read_pty(&mut self) {
        let Some(fd) = self.child.as_ref().and_then(pty::Child::fd) else {
            return;
        };
        while !self.pty_eof && !self.paused && self.queued() < OUT_HIGH_WATER {
            // SAFETY: reading into our buffer.
            let n = unsafe { libc::read(fd, self.read_buf.as_mut_ptr().cast(), READ_CHUNK) };
            if n > 0 {
                self.pending.extend_from_slice(&self.read_buf[..n as usize]);
                self.after_read();
                continue;
            }
            let err = std::io::Error::last_os_error();
            if n < 0 && err.kind() == ErrorKind::Interrupted {
                continue;
            }
            if !(n < 0 && err.kind() == ErrorKind::WouldBlock) {
                // 0 or EIO: every slave fd is closed.
                self.pty_eof = true;
                self.flush_data(true);
            }
            return;
        }
    }

    /// Output goes out at once after a quiet spell or a small frame (a
    /// keystroke's echo is a few bytes); while output streams, it gathers
    /// for up to `BATCH_WINDOW` or `READ_CHUNK` bytes. A PTY hands out as little as 1 KB per read
    /// (macOS), and each frame costs the daemon a decode, an emulator write
    /// and a broadcast, so this keeps frames as few as pty-subprocess.js's.
    fn after_read(&mut self) {
        if self.pending.len() >= READ_CHUNK {
            self.flush_data(false);
            return;
        }
        if self.flush_at.is_some() {
            return;
        }
        let now = Instant::now();
        match self.last_flush {
            Some((t, bytes)) if bytes >= STREAMING_FRAME && now.duration_since(t) < BATCH_WINDOW => {
                self.flush_at = Some(t + BATCH_WINDOW)
            }
            _ => self.flush_data(false),
        }
    }

    /// Frame `pending` as DATA, holding back an unfinished UTF-8 sequence
    /// unless `all` (the PTY is done).
    fn flush_data(&mut self, all: bool) {
        self.flush_at = None;
        if self.pending.is_empty() {
            return;
        }
        let hold = if all { 0 } else { utf8::incomplete_tail(&self.pending) };
        let send = self.pending.len() - hold;
        if send > 0 {
            frame::encode_into(&mut self.out, frame::DATA, &self.pending[..send]);
            self.pending.drain(..send);
            self.last_flush = Some((Instant::now(), send));
        }
    }

    fn flush_if_due(&mut self) {
        if self.flush_at.is_some_and(|t| Instant::now() >= t) {
            self.flush_data(false);
        }
    }

    /// Bytes read from the PTY that the daemon hasn't taken yet.
    fn queued(&self) -> usize {
        self.out_pending() + self.pending.len()
    }

    fn write_pty(&mut self) {
        let Some(fd) = self.child.as_ref().and_then(pty::Child::fd) else {
            self.pty_in.clear();
            return;
        };
        while !self.pty_in.is_empty() {
            // SAFETY: writing our buffer to our fd.
            let n = unsafe { libc::write(fd, self.pty_in.as_ptr().cast(), self.pty_in.len()) };
            if n > 0 {
                self.pty_in.drain(..n as usize);
                continue;
            }
            let err = std::io::Error::last_os_error();
            if err.kind() == ErrorKind::Interrupted {
                continue;
            }
            if err.kind() != ErrorKind::WouldBlock {
                self.pty_in.clear(); // the pty is gone; drop the input as node-pty would
            }
            return;
        }
    }

    fn write_stdout(&mut self) {
        while self.out_pending() > 0 {
            // SAFETY: writing our buffer to stdout.
            let n = unsafe { libc::write(1, self.out[self.out_off..].as_ptr().cast(), self.out_pending()) };
            if n > 0 {
                self.out_off += n as usize;
                continue;
            }
            let err = std::io::Error::last_os_error();
            if err.kind() == ErrorKind::Interrupted {
                continue;
            }
            if err.kind() == ErrorKind::WouldBlock {
                break;
            }
            // The daemon is gone.
            self.dispose();
        }
        if self.out_off == self.out.len() {
            self.out.clear();
            self.out_off = 0;
            if self.out.capacity() > 4 * OUT_HIGH_WATER {
                self.out.shrink_to(OUT_HIGH_WATER);
            }
        } else if self.out_off > OUT_HIGH_WATER {
            self.out.drain(..self.out_off);
            self.out_off = 0;
        }
    }

    fn read_stdin(&mut self) {
        let mut buf = [0u8; 64 * 1024];
        loop {
            // SAFETY: reading stdin into our buffer.
            let n = unsafe { libc::read(0, buf.as_mut_ptr().cast(), buf.len()) };
            if n > 0 {
                self.decoder.push(&buf[..n as usize]);
                while let Some((kind, payload)) = self.decoder.next_frame() {
                    self.handle_frame(kind, &payload);
                }
                continue;
            }
            let err = std::io::Error::last_os_error();
            if n < 0 && err.kind() == ErrorKind::Interrupted {
                continue;
            }
            if n < 0 && err.kind() == ErrorKind::WouldBlock {
                return;
            }
            // EOF: the daemon closed our stdin.
            self.stdin_open = false;
            self.dispose();
        }
    }

    fn reap(&mut self) {
        let Some(child) = &self.child else { return };
        if self.exited {
            return;
        }
        let mut status = 0;
        // SAFETY: non-blocking wait for our child.
        let r = unsafe { libc::waitpid(child.pid, &mut status, libc::WNOHANG) };
        if r != child.pid {
            return;
        }
        self.exited = true;
        // As node-pty: the exit status if it exited, 0 if a signal ended it.
        let code = if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else {
            0
        };
        // Like node-pty, EXIT waits until the PTY is drained, or 200 ms if
        // a leftover background job still holds it; then the PTY closes, so
        // nothing follows EXIT and those jobs are hung up.
        self.exit_code = Some(code);
        self.exit_by = Some(Instant::now() + EXIT_DRAIN);
        self.kill_deadline = None;
        self.sampler = None;
    }

    fn finish_exit(&mut self) {
        let (Some(code), Some(by)) = (self.exit_code, self.exit_by) else {
            return;
        };
        if !self.pty_eof && Instant::now() < by {
            return;
        }
        self.exit_by = None;
        self.pty_eof = true;
        self.flush_data(true);
        json_frame(&mut self.out, frame::EXIT, serde_json::json!({ "exitCode": code }));
        if let Some(child) = &mut self.child {
            child.master = None; // closes the PTY
        }
        self.pty_in.clear();
    }

    fn check_kill_deadline(&mut self) {
        if let (Some(deadline), Some(child)) = (self.kill_deadline, &self.child)
            && Instant::now() >= deadline
        {
            self.kill_deadline = None;
            if !self.exited && procs::alive(child.pid) {
                let _ = procs::kill_tree(child.pid, libc::SIGKILL);
            }
        }
    }

    /// End the pane: hang up the shell (node-pty's `kill()`) and exit.
    fn dispose(&mut self) -> ! {
        if let Some(child) = &self.child
            && !self.exited
        {
            // SAFETY: plain syscall.
            unsafe { libc::kill(child.pid, libc::SIGHUP) };
        }
        std::process::exit(0);
    }

    fn sample_foreground(&mut self) {
        let (Some(sampler), Some(fd)) = (&mut self.sampler, self.child.as_ref().and_then(pty::Child::fd)) else {
            return;
        };
        if Instant::now() < sampler.next_at {
            return;
        }
        if let Some(name) = sampler.sample(fd) {
            json_frame(&mut self.out, frame::FGPROC, serde_json::json!({ "name": name }));
        }
    }

    fn timeout_ms(&self) -> i32 {
        let sample = self.sampler.as_ref().map(|s| s.next_at);
        match [self.kill_deadline, sample, self.exit_by, self.flush_at]
            .into_iter()
            .flatten()
            .min()
        {
            None => -1,
            // Round up so a sub-millisecond wait doesn't poll with 0 and spin.
            Some(d) => d
                .saturating_duration_since(Instant::now())
                .as_micros()
                .div_ceil(1000)
                .min(i32::MAX as u128) as i32,
        }
    }
}

fn main() {
    let sig_r = install_signals();
    pty::set_nonblocking(0);
    pty::set_nonblocking(1);
    let mut h = Helper::new();

    loop {
        h.write_stdout();

        let mut fds: Vec<libc::pollfd> = Vec::with_capacity(4);
        let mut slot_stdin = None;
        let mut slot_master = None;
        let mut slot_stdout = None;
        fds.push(libc::pollfd {
            fd: sig_r,
            events: libc::POLLIN,
            revents: 0,
        });
        if h.stdin_open {
            slot_stdin = Some(fds.len());
            fds.push(libc::pollfd {
                fd: 0,
                events: libc::POLLIN,
                revents: 0,
            });
        }
        if let Some(master) = h.child.as_ref().and_then(pty::Child::fd) {
            let mut events = 0;
            if h.may_read_pty() {
                events |= libc::POLLIN;
            }
            if !h.pty_in.is_empty() && !h.pty_eof {
                events |= libc::POLLOUT;
            }
            if events != 0 {
                slot_master = Some(fds.len());
                fds.push(libc::pollfd {
                    fd: master,
                    events,
                    revents: 0,
                });
            }
        }
        if h.out_pending() > 0 {
            slot_stdout = Some(fds.len());
            fds.push(libc::pollfd {
                fd: 1,
                events: libc::POLLOUT,
                revents: 0,
            });
        }

        let r = wait::wait(&mut fds, h.timeout_ms());
        if r < 0 {
            if std::io::Error::last_os_error().kind() == ErrorKind::Interrupted {
                continue;
            }
            std::process::exit(1);
        }

        if fds[0].revents != 0 {
            let mut buf = [0u8; 64];
            let mut stop = false;
            loop {
                // SAFETY: draining the signal pipe.
                let n = unsafe { libc::read(sig_r, buf.as_mut_ptr().cast(), buf.len()) };
                if n <= 0 {
                    break;
                }
                for &s in &buf[..n as usize] {
                    let s = s as i32;
                    if s == libc::SIGTERM || s == libc::SIGINT || s == libc::SIGHUP {
                        stop = true;
                    }
                }
            }
            if stop {
                h.dispose();
            }
            h.reap();
        }
        if let Some(i) = slot_stdin
            && fds[i].revents != 0
        {
            h.read_stdin();
        }
        if let Some(i) = slot_master {
            let rev = fds[i].revents;
            if rev & libc::POLLOUT != 0 {
                h.write_pty();
            }
            if rev & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                h.read_pty();
            }
        }
        if let Some(i) = slot_stdout
            && fds[i].revents & (libc::POLLERR | libc::POLLHUP) != 0
        {
            h.dispose();
        }
        // Input that arrived this round goes to the PTY straight away.
        if !h.pty_in.is_empty() {
            h.write_pty();
        }
        h.check_kill_deadline();
        h.flush_if_due();
        h.finish_exit();
        h.sample_foreground();
    }
}
