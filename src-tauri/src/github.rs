use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    pub number: u64,
    pub state: String,
    pub title: String,
    pub url: String,
}

/// Fetch PR info for a branch using the `gh` CLI.
/// Returns None if gh is not installed, not authenticated, or no PR exists.
#[tauri::command]
pub fn get_pr_for_branch(repo_path: String, branch: String) -> Option<PrInfo> {
    let output = Command::new("gh")
        .args([
            "pr", "list",
            "--head", &branch,
            "--json", "number,state,title,url",
            "--limit", "1",
        ])
        .current_dir(&repo_path)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let prs: Vec<serde_json::Value> = serde_json::from_str(&stdout).ok()?;
    let pr = prs.first()?;

    Some(PrInfo {
        number: pr["number"].as_u64()?,
        state: pr["state"].as_str()?.to_lowercase(),
        title: pr["title"].as_str()?.to_string(),
        url: pr["url"].as_str()?.to_string(),
    })
}

/// Fetch PR info for multiple branches at once (batch).
#[tauri::command]
pub fn get_prs_for_branches(
    repo_path: String,
    branches: Vec<String>,
) -> Vec<(String, Option<PrInfo>)> {
    branches
        .into_iter()
        .map(|branch| {
            let pr = get_pr_for_branch_inner(&repo_path, &branch);
            (branch, pr)
        })
        .collect()
}

fn get_pr_for_branch_inner(repo_path: &str, branch: &str) -> Option<PrInfo> {
    let output = Command::new("gh")
        .args([
            "pr", "list",
            "--head", branch,
            "--json", "number,state,title,url",
            "--limit", "1",
        ])
        .current_dir(repo_path)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let prs: Vec<serde_json::Value> = serde_json::from_str(&stdout).ok()?;
    let pr = prs.first()?;

    Some(PrInfo {
        number: pr["number"].as_u64()?,
        state: pr["state"].as_str()?.to_lowercase(),
        title: pr["title"].as_str()?.to_string(),
        url: pr["url"].as_str()?.to_string(),
    })
}
