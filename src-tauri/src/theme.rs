use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub cursor_accent: String,
    pub selection_background: String,
    pub selection_foreground: String,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

impl Default for Theme {
    fn default() -> Self {
        // Catppuccin Mocha fallback
        Self {
            background: "#1e1e2e".into(),
            foreground: "#cdd6f4".into(),
            cursor: "#f5e0dc".into(),
            cursor_accent: "#1e1e2e".into(),
            selection_background: "#585b70".into(),
            selection_foreground: "#cdd6f4".into(),
            black: "#45475a".into(),
            red: "#f38ba8".into(),
            green: "#a6e3a1".into(),
            yellow: "#f9e2af".into(),
            blue: "#89b4fa".into(),
            magenta: "#f5c2e7".into(),
            cyan: "#94e2d5".into(),
            white: "#a6adc8".into(),
            bright_black: "#585b70".into(),
            bright_red: "#f37799".into(),
            bright_green: "#89d88b".into(),
            bright_yellow: "#ebd391".into(),
            bright_blue: "#74a8fc".into(),
            bright_magenta: "#f2aede".into(),
            bright_cyan: "#6bd7ca".into(),
            bright_white: "#bac2de".into(),
        }
    }
}

fn ghostty_config_path() -> Option<PathBuf> {
    // macOS: ~/Library/Application Support/com.mitchellh.ghostty/config
    if let Some(data) = dirs::data_dir() {
        let p = data.join("com.mitchellh.ghostty/config");
        if p.exists() {
            return Some(p);
        }
    }
    // XDG: ~/.config/ghostty/config
    if let Some(config) = dirs::config_dir() {
        let p = config.join("ghostty/config");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

fn ghostty_themes_dir() -> Option<PathBuf> {
    // Check app bundle first (macOS)
    let app_themes =
        PathBuf::from("/Applications/Ghostty.app/Contents/Resources/ghostty/themes");
    if app_themes.is_dir() {
        return Some(app_themes);
    }
    // XDG data dirs
    if let Some(data) = dirs::data_dir() {
        let p = data.join("ghostty/themes");
        if p.is_dir() {
            return Some(p);
        }
    }
    None
}

fn load_theme_from_config(config: &HashMap<String, String>) -> Theme {
    let mut theme = Theme::default();

    if let Some(bg) = config.get("background") {
        theme.background = bg.clone();
        theme.cursor_accent = bg.clone();
    }
    if let Some(fg) = config.get("foreground") {
        theme.foreground = fg.clone();
        theme.selection_foreground = fg.clone();
    }
    if let Some(c) = config.get("cursor-color") {
        theme.cursor = c.clone();
    }
    if let Some(c) = config.get("cursor-text") {
        theme.cursor_accent = c.clone();
    }
    if let Some(c) = config.get("selection-background") {
        theme.selection_background = c.clone();
    }
    if let Some(c) = config.get("selection-foreground") {
        theme.selection_foreground = c.clone();
    }

    theme
}

fn parse_ghostty_file_multivalue(content: &str) -> (HashMap<String, String>, HashMap<u8, String>) {
    let mut config = HashMap::new();
    let mut palette = HashMap::new();

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim();
            let value = value.trim();
            if key == "palette" {
                // value is like "0=#45475a"
                if let Some((idx_str, color)) = value.split_once('=') {
                    if let Ok(idx) = idx_str.trim().parse::<u8>() {
                        palette.insert(idx, color.trim().to_string());
                    }
                }
            } else {
                config.insert(key.to_string(), value.to_string());
            }
        }
    }

    (config, palette)
}

pub fn load_theme() -> Theme {
    let config_path = match ghostty_config_path() {
        Some(p) => p,
        None => return Theme::default(),
    };

    let config_content = match fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return Theme::default(),
    };

    let (config, _palette) = parse_ghostty_file_multivalue(&config_content);

    // If a theme name is specified, load the theme file
    if let Some(theme_name) = config.get("theme") {
        if let Some(themes_dir) = ghostty_themes_dir() {
            let theme_path = themes_dir.join(theme_name);
            if let Ok(theme_content) = fs::read_to_string(&theme_path) {
                let (mut theme_config, theme_palette) =
                    parse_ghostty_file_multivalue(&theme_content);

                // Config file overrides theme file for explicit settings
                // But only for non-theme, non-palette keys that the user explicitly set
                for (key, value) in &config {
                    if key != "theme" {
                        theme_config.insert(key.clone(), value.clone());
                    }
                }

                return build_theme(&theme_config, &theme_palette);
            }
        }
    }

    // No theme reference, parse config directly
    let (config, palette) = parse_ghostty_file_multivalue(&config_content);
    build_theme(&config, &palette)
}

fn build_theme(config: &HashMap<String, String>, palette: &HashMap<u8, String>) -> Theme {
    let mut theme = load_theme_from_config(config);

    let palette_map: [(u8, &mut String); 16] = [
        (0, &mut theme.black),
        (1, &mut theme.red),
        (2, &mut theme.green),
        (3, &mut theme.yellow),
        (4, &mut theme.blue),
        (5, &mut theme.magenta),
        (6, &mut theme.cyan),
        (7, &mut theme.white),
        (8, &mut theme.bright_black),
        (9, &mut theme.bright_red),
        (10, &mut theme.bright_green),
        (11, &mut theme.bright_yellow),
        (12, &mut theme.bright_blue),
        (13, &mut theme.bright_magenta),
        (14, &mut theme.bright_cyan),
        (15, &mut theme.bright_white),
    ];

    for (idx, target) in palette_map {
        if let Some(color) = palette.get(&idx) {
            *target = color.clone();
        }
    }

    theme
}

#[tauri::command]
pub fn get_theme() -> Theme {
    load_theme()
}
