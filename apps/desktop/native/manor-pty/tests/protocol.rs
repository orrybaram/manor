//! Drive the real binary over the frame protocol, the way the daemon does.

use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

const SPAWN: u8 = 0x01;
const WRITE: u8 = 0x02;
const RESIZE: u8 = 0x03;
const KILL: u8 = 0x04;
const SIGNAL: u8 = 0x05;
const DISPOSE: u8 = 0x06;
const PAUSE: u8 = 0x07;
const RESUME: u8 = 0x08;
const READY: u8 = 0x11;
const SPAWNED: u8 = 0x12;
const DATA: u8 = 0x13;
const EXIT: u8 = 0x14;
const ERROR: u8 = 0x15;
const RESIZED: u8 = 0x17;

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    frames: Receiver<(u8, Vec<u8>)>,
}

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut f = vec![kind];
    f.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    f.extend_from_slice(payload);
    f
}

impl Helper {
    fn start() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_manor-pty"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            let mut header = [0u8; 5];
            while stdout.read_exact(&mut header).is_ok() {
                let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
                let mut payload = vec![0; len];
                if stdout.read_exact(&mut payload).is_err() {
                    break;
                }
                if tx.send((header[0], payload)).is_err() {
                    break;
                }
            }
        });
        let stdin = child.stdin.take();
        let h = Helper {
            child,
            stdin,
            frames: rx,
        };
        assert_eq!(h.next().0, READY);
        h
    }

    fn spawn_sh(&mut self, script: &str) -> i32 {
        let env: serde_json::Map<String, serde_json::Value> = std::env::vars().map(|(k, v)| (k, v.into())).collect();
        let payload = serde_json::json!({
            "shell": "/bin/sh", "args": ["-c", script], "cwd": "/tmp", "cols": 80, "rows": 24, "env": env,
        });
        self.send(SPAWN, payload.to_string().as_bytes());
        let (kind, p) = self.next();
        assert_eq!(kind, SPAWNED, "{}", String::from_utf8_lossy(&p));
        serde_json::from_slice::<serde_json::Value>(&p).unwrap()["pid"]
            .as_i64()
            .unwrap() as i32
    }

    fn send(&mut self, kind: u8, payload: &[u8]) {
        self.stdin.as_mut().unwrap().write_all(&frame(kind, payload)).unwrap();
    }

    fn next(&self) -> (u8, Vec<u8>) {
        self.frames
            .recv_timeout(Duration::from_secs(10))
            .expect("no frame within 10 s")
    }

    /// Output until `needle` shows up; panics after 10 s.
    fn output_until(&self, needle: &str) -> String {
        let mut out = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !out.contains(needle) {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.frames.recv_timeout(left) {
                Ok((DATA, p)) => out.push_str(&String::from_utf8(p).unwrap()),
                Ok(_) => {}
                Err(_) => panic!("never saw {needle:?}; got {out:?}"),
            }
        }
        out
    }

    fn exit_code(&self) -> i64 {
        loop {
            let (kind, p) = self.next();
            if kind == EXIT {
                return serde_json::from_slice::<serde_json::Value>(&p).unwrap()["exitCode"]
                    .as_i64()
                    .unwrap();
            }
        }
    }

    fn wait_exit(&mut self) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s;
            }
            assert!(Instant::now() < deadline, "helper still running");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

#[test]
fn echoes_input_and_reports_exit_code() {
    let mut h = Helper::start();
    h.spawn_sh("read line; echo got:$line; exit 7");
    h.send(WRITE, b"hello\r");
    h.output_until("got:hello");
    assert_eq!(h.exit_code(), 7);
}

#[test]
fn a_signalled_shell_exits_with_code_zero_like_node_pty() {
    let mut h = Helper::start();
    h.spawn_sh("echo up; kill -9 $$");
    h.output_until("up");
    assert_eq!(h.exit_code(), 0);
}

#[test]
fn a_missing_shell_is_an_error_frame() {
    let mut h = Helper::start();
    let payload =
        serde_json::json!({ "shell": "/no/such/shell", "args": [], "cwd": "/tmp", "cols": 80, "rows": 24, "env": {} });
    h.send(SPAWN, payload.to_string().as_bytes());
    let (kind, p) = h.next();
    assert_eq!(kind, ERROR);
    assert!(String::from_utf8_lossy(&p).contains("/no/such/shell"));
}

#[test]
fn finds_the_shell_on_the_spawn_envs_path() {
    let mut h = Helper::start();
    let env: serde_json::Map<String, serde_json::Value> = std::env::vars().map(|(k, v)| (k, v.into())).collect();
    let payload = serde_json::json!({ "shell": "sh", "args": ["-c", "echo found"], "cwd": "/tmp", "cols": 80, "rows": 24, "env": env });
    h.send(SPAWN, payload.to_string().as_bytes());
    assert_eq!(h.next().0, SPAWNED);
    h.output_until("found");
}

#[test]
fn resize_lands_before_resized_and_the_shell_sees_it() {
    let mut h = Helper::start();
    h.spawn_sh("read _; stty size");
    h.send(RESIZE, br#"{"cols":132,"rows":50}"#);
    loop {
        if h.next().0 == RESIZED {
            break;
        }
    }
    h.send(WRITE, b"\r");
    h.output_until("50 132");
}

#[test]
fn pause_stops_output_and_resume_brings_it_back() {
    let mut h = Helper::start();
    h.spawn_sh("read _; while :; do echo tick; sleep 0.05; done");
    h.send(PAUSE, b"");
    h.send(WRITE, b"\r");
    // Drain whatever was read before Pause took effect, then expect silence.
    std::thread::sleep(Duration::from_millis(300));
    while h.frames.try_recv().is_ok() {}
    match h.frames.recv_timeout(Duration::from_millis(500)) {
        Err(RecvTimeoutError::Timeout) => {}
        other => panic!("output while paused: {other:?}"),
    }
    h.send(RESUME, b"");
    h.output_until("tick");
    h.send(DISPOSE, b"");
}

#[test]
fn dispose_hangs_up_the_shell_and_exits() {
    let mut h = Helper::start();
    let pid = h.spawn_sh("echo ready; sleep 1000");
    h.output_until("ready");
    h.send(DISPOSE, b"");
    assert!(h.wait_exit().success());
    std::thread::sleep(Duration::from_millis(200));
    assert!(!alive(pid), "shell outlived dispose");
}

#[test]
fn closing_stdin_disposes() {
    let mut h = Helper::start();
    h.spawn_sh("sleep 1000");
    drop(h.stdin.take());
    assert!(h.wait_exit().success());
}

#[test]
fn kill_terminates_the_whole_tree() {
    let mut h = Helper::start();
    // A child that ignores nothing, under a shell: both must go.
    let pid = h.spawn_sh("sleep 1000 & echo child:$!; wait");
    let out = h.output_until("\n");
    let child: i32 = out.trim().trim_start_matches("child:").trim().parse().unwrap();
    h.send(KILL, b"");
    h.exit_code();
    std::thread::sleep(Duration::from_millis(200));
    assert!(!alive(pid));
    assert!(!alive(child), "grandchild survived Kill");
    h.send(DISPOSE, b"");
}

#[test]
fn signal_by_name_reaches_the_shell() {
    let mut h = Helper::start();
    h.spawn_sh("trap 'echo usr1; exit 3' USR1; echo ready; while :; do sleep 0.05; done");
    h.output_until("ready");
    h.send(SIGNAL, br#"{"signal":"SIGUSR1"}"#);
    h.output_until("usr1");
    assert_eq!(h.exit_code(), 3);
}

#[test]
fn a_multibyte_flood_never_splits_a_character() {
    let mut h = Helper::start();
    h.spawn_sh("i=0; while [ $i -lt 3000 ]; do printf '终端🦀é'; i=$((i+1)); done; echo; echo done");
    let mut bytes = Vec::new();
    loop {
        let (kind, p) = h.next();
        match kind {
            DATA => {
                assert!(std::str::from_utf8(&p).is_ok(), "frame split a character");
                bytes.extend_from_slice(&p);
            }
            EXIT => break,
            _ => {}
        }
    }
    let text = String::from_utf8(bytes).unwrap();
    assert_eq!(text.matches("终端🦀é").count(), 3000);
}
