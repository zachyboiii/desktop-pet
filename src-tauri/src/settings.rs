use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

// One roaming pet. Each pet picks its own sprite and its own on-click action,
// so different kinds can be out at once (design change 2026-07).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PetConfig {
    pub id: String,
    #[serde(rename = "petType")]
    pub pet_type: String,
    #[serde(rename = "petColor")]
    pub pet_color: String,
    /// "say" -> speech bubble, "app" -> launch app_command,
    /// "claude" -> hardcoded: open Claude Code in a terminal.
    #[serde(rename = "clickAction", default = "default_click_action")]
    pub click_action: String,
    /// Custom phrase for "say" (empty = random preset phrase).
    #[serde(default)]
    pub phrase: String,
    /// Shell command for "app", launched detached via the OS shell.
    #[serde(rename = "appCommand", default)]
    pub app_command: String,
}

fn default_click_action() -> String {
    "say".into()
}

impl PetConfig {
    pub fn new(pet_type: &str, pet_color: &str, idx: usize) -> Self {
        // The Claude mascot ships wired to launch Claude Code in a terminal.
        let (click_action, phrase, app_command) = if pet_type == "sparky" {
            (
                "claude".to_string(),
                "Launching Claude Code! 🚀".to_string(),
                String::new(),
            )
        } else {
            ("say".to_string(), String::new(), String::new())
        };
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        PetConfig {
            id: format!("pet-{nanos}-{idx}"),
            pet_type: pet_type.into(),
            pet_color: pet_color.into(),
            click_action,
            phrase,
            app_command,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub pets: Vec<PetConfig>,
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
            pets: vec![PetConfig::new("dog", "brown", 0)],
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

// Pre-roster settings.json shape ("petType" + "count" at the top level).
// Converted once on load into the per-pet list.
#[derive(Deserialize)]
struct LegacySettings {
    #[serde(rename = "petType")]
    pet_type: String,
    #[serde(rename = "petColor")]
    pet_color: String,
    count: u32,
    speed: f32,
    width: u32,
    height: u32,
    #[serde(rename = "useIconsAsPlatforms")]
    use_icons_as_platforms: bool,
    #[serde(rename = "iconRole")]
    icon_role: String,
    #[serde(rename = "iconScanIntervalMs")]
    icon_scan_interval_ms: u64,
    #[serde(rename = "launchOnStartup", default)]
    launch_on_startup: bool,
}

impl From<LegacySettings> for Settings {
    fn from(old: LegacySettings) -> Self {
        let count = old.count.clamp(1, 8) as usize;
        Settings {
            pets: (0..count)
                .map(|i| PetConfig::new(&old.pet_type, &old.pet_color, i))
                .collect(),
            speed: old.speed,
            width: old.width,
            height: old.height,
            use_icons_as_platforms: old.use_icons_as_platforms,
            icon_role: old.icon_role,
            icon_scan_interval_ms: old.icon_scan_interval_ms,
            launch_on_startup: old.launch_on_startup,
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
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if value.get("pets").is_some() {
                    if let Ok(s) = serde_json::from_value::<Settings>(value) {
                        return s;
                    }
                } else if let Ok(old) = serde_json::from_value::<LegacySettings>(value) {
                    let migrated: Settings = old.into();
                    let _ = save(app, &migrated);
                    return migrated;
                }
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
