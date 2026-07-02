use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    #[serde(rename = "petType")]
    pub pet_type: String,
    #[serde(rename = "petColor")]
    pub pet_color: String,
    pub count: u32,
    pub speed: f32,
    pub width: u32,
    pub height: u32,
    #[serde(rename = "useIconsAsPlatforms")]
    pub use_icons_as_platforms: bool,
    #[serde(rename = "iconRole")]
    pub icon_role: String,
    #[serde(rename = "iconScanIntervalMs")]
    pub icon_scan_interval_ms: u64,
    #[serde(rename = "launchOnStartup")]
    pub launch_on_startup: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            pet_type: "dog".into(),
            pet_color: "brown".into(),
            count: 1,
            speed: 1.5,
            width: 80,
            height: 80,
            use_icons_as_platforms: true,
            icon_role: "mixed".into(),
            icon_scan_interval_ms: 1500,
            launch_on_startup: false,
        }
    }
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    if let Some(path) = settings_path(app) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(s) = serde_json::from_str::<Settings>(&text) {
                return s;
            }
        }
    }
    Settings::default()
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app).ok_or("no config dir")?;
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}
