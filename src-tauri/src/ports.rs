use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivePort {
    pub port: u16,
    pub process_name: String,
    pub pid: u32,
    pub workspace_path: Option<String>,
}

pub struct PortScannerState {
    pub workspace_paths: Mutex<Vec<String>>,
    stop_tx: Mutex<Option<std::sync::mpsc::Sender<()>>>,
}

impl Default for PortScannerState {
    fn default() -> Self {
        Self {
            workspace_paths: Mutex::new(vec![]),
            stop_tx: Mutex::new(None),
        }
    }
}

#[tauri::command]
pub fn start_port_scanner(app: AppHandle, state: State<'_, PortScannerState>) {
    // Stop existing scanner if any
    if let Some(tx) = state.stop_tx.lock().unwrap().take() {
        let _ = tx.send(());
    }

    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    *state.stop_tx.lock().unwrap() = Some(stop_tx);

    let workspace_paths = state.workspace_paths.lock().unwrap().clone();

    std::thread::spawn(move || {
        let mut last_ports: Vec<ActivePort> = vec![];
        loop {
            // Check for stop signal
            if stop_rx.try_recv().is_ok() {
                break;
            }

            let ports = scan_ports(&workspace_paths);
            if ports != last_ports {
                let _ = app.emit("ports-changed", &ports);
                last_ports = ports;
            }

            std::thread::sleep(std::time::Duration::from_secs(3));
        }
    });
}

#[tauri::command]
pub fn stop_port_scanner(state: State<'_, PortScannerState>) {
    if let Some(tx) = state.stop_tx.lock().unwrap().take() {
        let _ = tx.send(());
    }
}

#[tauri::command]
pub fn update_workspace_paths(state: State<'_, PortScannerState>, paths: Vec<String>) {
    *state.workspace_paths.lock().unwrap() = paths;
}

#[tauri::command]
pub fn scan_ports_now(state: State<'_, PortScannerState>) -> Vec<ActivePort> {
    let paths = state.workspace_paths.lock().unwrap().clone();
    scan_ports(&paths)
}

fn scan_ports(workspace_paths: &[String]) -> Vec<ActivePort> {
    let uid = unsafe { libc::getuid() };

    let output = Command::new("/usr/sbin/lsof")
        .args([
            "-a",
            "-iTCP",
            "-sTCP:LISTEN",
            "-nP",
            "-F",
            "pcn",
            "-u",
            &uid.to_string(),
        ])
        .output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return vec![],
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results = parse_lsof_ports(&stdout);

    // Resolve workspace paths via CWD lookup
    if !workspace_paths.is_empty() && !results.is_empty() {
        let pids: Vec<u32> = results.iter().map(|p| p.pid).collect();
        let cwds = cwds_by_pid(&pids);
        let home = dirs::home_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        for port in &mut results {
            if let Some(cwd) = cwds.get(&port.pid) {
                // Find best matching workspace (longest prefix match)
                let best = workspace_paths
                    .iter()
                    .filter(|ws| cwd.starts_with(ws.as_str()))
                    .max_by_key(|ws| ws.len());
                if let Some(best) = best {
                    if *best != home {
                        port.workspace_path = Some(best.clone());
                    }
                }
            }
        }
    }

    // Only keep ports associated with a workspace
    results.retain(|p| p.workspace_path.is_some());
    results.sort_by_key(|p| p.port);
    results
}

fn parse_lsof_ports(output: &str) -> Vec<ActivePort> {
    let mut results = Vec::new();
    let mut seen_ports = HashSet::new();
    let mut current_pid: u32 = 0;
    let mut current_cmd = String::new();

    for line in output.lines() {
        if line.is_empty() {
            continue;
        }
        let (prefix, value) = line.split_at(1);
        match prefix {
            "p" => current_pid = value.parse().unwrap_or(0),
            "c" => current_cmd = value.to_string(),
            "n" => {
                // Format: "*:3000" or "127.0.0.1:3000" or "[::1]:3000"
                if let Some(colon_idx) = value.rfind(':') {
                    if let Ok(port) = value[colon_idx + 1..].parse::<u16>() {
                        if !seen_ports.contains(&port) {
                            seen_ports.insert(port);
                            results.push(ActivePort {
                                port,
                                process_name: current_cmd.clone(),
                                pid: current_pid,
                                workspace_path: None,
                            });
                        }
                    }
                }
            }
            _ => {}
        }
    }

    results
}

fn cwds_by_pid(pids: &[u32]) -> HashMap<u32, String> {
    if pids.is_empty() {
        return HashMap::new();
    }

    let pid_list = pids
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let output = Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &pid_list, "-d", "cwd", "-nP", "-F", "pn"])
        .output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return HashMap::new(),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut result = HashMap::new();
    let mut current_pid: u32 = 0;

    for line in stdout.lines() {
        if line.is_empty() {
            continue;
        }
        let (prefix, value) = line.split_at(1);
        match prefix {
            "p" => current_pid = value.parse().unwrap_or(0),
            "n" => {
                if current_pid != 0 {
                    result.insert(current_pid, value.to_string());
                }
            }
            _ => {}
        }
    }

    result
}
