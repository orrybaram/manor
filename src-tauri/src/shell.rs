use std::fs;
use std::path::PathBuf;

fn manor_data_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library/Application Support")
    });
    base.join("Manor")
}

pub fn sessions_dir() -> PathBuf {
    manor_data_dir().join("sessions")
}

pub fn zdotdir() -> PathBuf {
    manor_data_dir().join("zdotdir")
}

pub fn history_file_for(pane_id: &str) -> PathBuf {
    sessions_dir().join(format!("{}.history", pane_id))
}

/// Create ZDOTDIR wrapper scripts that source the user's real dotfiles,
/// then override HISTFILE with Manor's per-pane history file.
pub fn setup_zdotdir() -> PathBuf {
    let dir = zdotdir();
    let _ = fs::create_dir_all(&dir);

    let files: &[(&str, &str)] = &[
        (
            ".zshenv",
            r#"[[ -f "${REAL_ZDOTDIR:-$HOME}/.zshenv" ]] && source "${REAL_ZDOTDIR:-$HOME}/.zshenv"
"#,
        ),
        (
            ".zprofile",
            r#"[[ -f "${REAL_ZDOTDIR:-$HOME}/.zprofile" ]] && source "${REAL_ZDOTDIR:-$HOME}/.zprofile"
"#,
        ),
        (
            ".zshrc",
            r#"[[ -f "${REAL_ZDOTDIR:-$HOME}/.zshrc" ]] && source "${REAL_ZDOTDIR:-$HOME}/.zshrc"
[[ -n $MANOR_HISTFILE ]] && HISTFILE=$MANOR_HISTFILE
setopt INC_APPEND_HISTORY

# Emit OSC 7 (CWD reporting) on each prompt so Manor can track the working directory
__manor_osc7_precmd() {
  printf '\e]7;file://%s%s\e\\' "${HOST}" "${PWD}"
}
[[ -z ${precmd_functions+x} ]] && precmd_functions=()
precmd_functions+=(__manor_osc7_precmd)
"#,
        ),
        (
            ".zlogin",
            r#"[[ -f "${REAL_ZDOTDIR:-$HOME}/.zlogin" ]] && source "${REAL_ZDOTDIR:-$HOME}/.zlogin"
"#,
        ),
    ];

    for (name, body) in files {
        let _ = fs::write(dir.join(name), body);
    }

    dir
}
