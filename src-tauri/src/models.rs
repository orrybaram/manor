use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SplitDirection {
    #[serde(rename = "horizontal")]
    Horizontal,
    #[serde(rename = "vertical")]
    Vertical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PaneNode {
    #[serde(rename = "leaf")]
    Leaf {
        #[serde(rename = "paneId")]
        pane_id: String,
    },
    #[serde(rename = "split")]
    Split {
        direction: SplitDirection,
        ratio: f64,
        first: Box<PaneNode>,
        second: Box<PaneNode>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModel {
    pub id: Uuid,
    pub title: String,
    pub root_node: PaneNode,
    pub focused_pane_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedPaneSession {
    pub last_cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedWorkspace {
    pub path: String,
    pub sessions: Vec<SessionModel>,
    pub selected_session_index: i32,
    pub display_name: Option<String>,
    pub run_command: Option<String>,
    #[serde(default)]
    pub pane_sessions: std::collections::HashMap<String, PersistedPaneSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedProject {
    pub id: Uuid,
    pub name: String,
    pub path: String,
    pub selected_workspace_index: i32,
    pub workspaces: Vec<PersistedWorkspace>,
    #[serde(default = "default_branch")]
    pub default_branch: String,
    pub setup_script: Option<String>,
    pub teardown_script: Option<String>,
    pub default_run_command: Option<String>,
}

fn default_branch() -> String {
    "main".to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedState {
    pub projects: Vec<PersistedProject>,
    pub selected_project_index: i32,
}

// Frontend-facing models (what we send to the UI)

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub branch: String,
    pub is_main: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub default_branch: String,
    pub workspaces: Vec<WorkspaceInfo>,
    pub selected_workspace_index: i32,
    pub setup_script: Option<String>,
    pub teardown_script: Option<String>,
    pub default_run_command: Option<String>,
}
