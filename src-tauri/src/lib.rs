mod github;
mod models;
mod persistence;
mod ports;
mod pty;
mod shell;
mod theme;

use persistence::ProjectState;
use ports::PortScannerState;
use pty::PtyState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyState::default())
        .manage(ProjectState::load())
        .manage(PortScannerState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_create,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            persistence::get_projects,
            persistence::get_selected_project_index,
            persistence::select_project,
            persistence::add_project,
            persistence::remove_project,
            persistence::select_worktree,
            theme::get_theme,
            ports::start_port_scanner,
            ports::stop_port_scanner,
            ports::update_worktree_paths,
            ports::scan_ports_now,
            github::get_pr_for_branch,
            github::get_prs_for_branches,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
