use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// Extract the path from an OSC 7 payload like "file://hostname/path/to/dir"
/// and emit it as a CWD change event.
fn extract_osc7_cwd(payload: &[u8], event_name: &str, app: &AppHandle) {
    if let Ok(s) = std::str::from_utf8(payload) {
        // Format: file://hostname/path or file:///path
        if let Some(rest) = s.strip_prefix("file://") {
            // Skip hostname (everything up to the first '/' after "file://")
            let path = if let Some(idx) = rest.find('/') {
                &rest[idx..]
            } else {
                rest
            };
            // URL-decode percent-encoded characters
            let decoded = percent_decode(path);
            let _ = app.emit(event_name, decoded);
        }
    }
}

/// Simple percent-decoding for file paths (handles %20, %2F, etc.)
fn percent_decode(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let hi = chars.next();
            let lo = chars.next();
            if let (Some(h), Some(l)) = (hi, lo) {
                if let Ok(byte) = u8::from_str_radix(
                    &format!("{}{}", h as char, l as char),
                    16,
                ) {
                    result.push(byte as char);
                    continue;
                }
            }
            result.push('%');
        } else {
            result.push(b as char);
        }
    }
    result
}

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

#[derive(Default)]
pub struct PtyState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PtyOutput {
    pub data: String,
}

#[tauri::command]
pub fn pty_create(
    app: AppHandle,
    state: State<'_, PtyState>,
    pane_id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // Set up shell integration (ZDOTDIR, per-pane history)
    let zdotdir = crate::shell::setup_zdotdir();
    let histfile = crate::shell::history_file_for(&pane_id);
    let _ = std::fs::create_dir_all(crate::shell::sessions_dir());

    let mut cmd = CommandBuilder::new_default_prog();
    if let Some(ref dir) = cwd {
        cmd.cwd(dir);
    }
    cmd.env("MANOR_PANE_ID", &pane_id);
    cmd.env("TERM", "xterm-256color");
    cmd.env("ZDOTDIR", zdotdir.to_string_lossy().as_ref());
    cmd.env(
        "REAL_ZDOTDIR",
        std::env::var("ZDOTDIR")
            .unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().to_string_lossy().into()),
    );
    cmd.env("MANOR_HISTFILE", histfile.to_string_lossy().as_ref());

    pair.slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    // Drop slave — we only need the master side
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| e.to_string())?;

    // Reader thread: PTY output → frontend event
    // Also scans for OSC 7 sequences to track CWD changes.
    let event_name = format!("pty-output-{}", pane_id);
    let cwd_event_name = format!("pty-cwd-{}", pane_id);
    let pid = pane_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut osc_buf = Vec::new();
        let mut in_osc7 = false;

        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = app.emit(&format!("pty-exit-{}", pid), ());
                    break;
                }
                Ok(n) => {
                    let data = &buf[..n];

                    // Scan for OSC 7 sequences: \x1b]7;...\x1b\\ or \x1b]7;...\x07
                    for &byte in data {
                        if in_osc7 {
                            if byte == 0x07 {
                                // BEL terminator
                                extract_osc7_cwd(&osc_buf, &cwd_event_name, &app);
                                osc_buf.clear();
                                in_osc7 = false;
                            } else if byte == 0x1b {
                                // Could be ST (\x1b\\) — next byte will be '\\'
                                // For simplicity, treat ESC as end if osc_buf is non-empty
                                // (the \\ will just be harmlessly ignored)
                                extract_osc7_cwd(&osc_buf, &cwd_event_name, &app);
                                osc_buf.clear();
                                in_osc7 = false;
                            } else {
                                osc_buf.push(byte);
                                // Safety limit
                                if osc_buf.len() > 4096 {
                                    osc_buf.clear();
                                    in_osc7 = false;
                                }
                            }
                        } else if byte == 0x1b {
                            // Check if next bytes are ]7;
                            // We need a small lookahead state machine
                            osc_buf.clear();
                            osc_buf.push(byte);
                        } else if osc_buf.len() == 1 && osc_buf[0] == 0x1b && byte == b']' {
                            osc_buf.push(byte);
                        } else if osc_buf.len() == 2 && byte == b'7' {
                            osc_buf.push(byte);
                        } else if osc_buf.len() == 3 && byte == b';' {
                            // We've matched \x1b]7; — now collect the URL
                            osc_buf.clear();
                            in_osc7 = true;
                        } else {
                            osc_buf.clear();
                        }
                    }

                    let out = String::from_utf8_lossy(data).to_string();
                    let _ = app.emit(&event_name, PtyOutput { data: out });
                }
            }
        }
    });

    state
        .sessions
        .lock()
        .unwrap()
        .insert(pane_id, PtySession { writer, master: pair.master });

    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, pane_id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get_mut(&pane_id) {
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        session.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    if let Some(session) = sessions.get(&pane_id) {
        session
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_close(state: State<'_, PtyState>, pane_id: String) {
    state.sessions.lock().unwrap().remove(&pane_id);
}
