use crate::models::{PersistedProject, PersistedState};
use std::fs;
use std::path::PathBuf;

fn data_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library/Application Support")
    });
    base.join("Manor")
}

fn projects_file() -> PathBuf {
    data_dir().join("projects.json")
}

pub fn load_state() -> Option<PersistedState> {
    let path = projects_file();
    let data = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

pub fn save_state(state: &PersistedState) -> Result<(), String> {
    let path = projects_file();
    let dir = path.parent().unwrap();
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

// Tauri commands

use crate::models::{ProjectInfo, WorktreeInfo};
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
pub struct ProjectState {
    pub state: Mutex<PersistedState>,
}

impl ProjectState {
    pub fn load() -> Self {
        let state = load_state().unwrap_or_else(|| PersistedState {
            projects: vec![],
            selected_project_index: 0,
        });
        Self {
            state: Mutex::new(state),
        }
    }
}

#[tauri::command]
pub fn get_projects(state: State<'_, ProjectState>) -> Vec<ProjectInfo> {
    let s = state.state.lock().unwrap();
    s.projects
        .iter()
        .map(|p| {
            let worktrees = list_git_worktrees(&p.path).unwrap_or_else(|| {
                vec![WorktreeInfo {
                    path: p.path.clone(),
                    branch: p.default_branch.clone(),
                    is_main: true,
                }]
            });
            ProjectInfo {
                id: p.id.to_string(),
                name: p.name.clone(),
                path: p.path.clone(),
                default_branch: p.default_branch.clone(),
                worktrees,
                selected_worktree_index: p.selected_worktree_index,
                setup_script: p.setup_script.clone(),
                teardown_script: p.teardown_script.clone(),
                default_run_command: p.default_run_command.clone(),
            }
        })
        .collect()
}

#[tauri::command]
pub fn get_selected_project_index(state: State<'_, ProjectState>) -> i32 {
    state.state.lock().unwrap().selected_project_index
}

#[tauri::command]
pub fn select_project(state: State<'_, ProjectState>, index: i32) {
    let mut s = state.state.lock().unwrap();
    s.selected_project_index = index;
    let _ = save_state(&s);
}

#[tauri::command]
pub fn add_project(state: State<'_, ProjectState>, name: String, path: String) -> ProjectInfo {
    let mut s = state.state.lock().unwrap();
    let id = uuid::Uuid::new_v4();
    let project = PersistedProject {
        id,
        name: name.clone(),
        path: path.clone(),
        selected_worktree_index: 0,
        worktrees: vec![],
        default_branch: "main".to_string(),
        setup_script: None,
        teardown_script: None,
        default_run_command: None,
    };
    s.projects.push(project);
    s.selected_project_index = (s.projects.len() - 1) as i32;
    let _ = save_state(&s);

    let worktrees = list_git_worktrees(&path).unwrap_or_else(|| {
        vec![WorktreeInfo {
            path: path.clone(),
            branch: "main".to_string(),
            is_main: true,
        }]
    });

    ProjectInfo {
        id: id.to_string(),
        name,
        path,
        default_branch: "main".to_string(),
        worktrees,
        selected_worktree_index: 0,
        setup_script: None,
        teardown_script: None,
        default_run_command: None,
    }
}

#[tauri::command]
pub fn remove_project(state: State<'_, ProjectState>, project_id: String) {
    let mut s = state.state.lock().unwrap();
    s.projects.retain(|p| p.id.to_string() != project_id);
    if s.selected_project_index >= s.projects.len() as i32 {
        s.selected_project_index = s.projects.len().saturating_sub(1) as i32;
    }
    let _ = save_state(&s);
}

#[tauri::command]
pub fn select_worktree(
    state: State<'_, ProjectState>,
    project_id: String,
    worktree_index: i32,
) {
    let mut s = state.state.lock().unwrap();
    if let Some(p) = s.projects.iter_mut().find(|p| p.id.to_string() == project_id) {
        p.selected_worktree_index = worktree_index;
    }
    let _ = save_state(&s);
}

// Git worktree helpers

fn list_git_worktrees(path: &str) -> Option<Vec<WorktreeInfo>> {
    let output = std::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(path)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut worktrees = Vec::new();
    let mut current_path = String::new();
    let mut current_branch = String::new();
    let mut is_first = true;

    for line in stdout.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if !current_path.is_empty() {
                worktrees.push(WorktreeInfo {
                    path: current_path.clone(),
                    branch: current_branch.clone(),
                    is_main: is_first,
                });
                is_first = false;
            }
            current_path = p.to_string();
            current_branch = String::new();
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            current_branch = b.to_string();
        } else if line.is_empty() && !current_path.is_empty() {
            worktrees.push(WorktreeInfo {
                path: current_path.clone(),
                branch: current_branch.clone(),
                is_main: is_first,
            });
            is_first = false;
            current_path.clear();
            current_branch.clear();
        }
    }

    if !current_path.is_empty() {
        worktrees.push(WorktreeInfo {
            path: current_path,
            branch: current_branch,
            is_main: is_first,
        });
    }

    if worktrees.is_empty() {
        None
    } else {
        Some(worktrees)
    }
}
