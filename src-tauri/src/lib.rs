mod os;
mod settings;

use settings::Settings;
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

// Shared payload for both desktop icons and pet hit-boxes.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct IconRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    #[serde(default)]
    pub label: String,
}

#[derive(Clone, serde::Serialize)]
struct FloorPayload {
    taskbar_top: i32,
}

#[derive(Clone, serde::Serialize)]
pub(crate) struct DesktopStatePayload {
    pub(crate) active: bool,
}

// App-wide shared state.
struct AppState {
    settings: Mutex<Settings>,
    pet_bounds: Arc<Mutex<Vec<IconRect>>>, // shared with the mouse hook thread
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------
#[tauri::command]
fn get_settings(state: tauri::State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn update_settings(
    new_settings: Settings,
    app: AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    {
        let mut s = state.settings.lock().unwrap();
        *s = new_settings.clone();
    }
    settings::save(&app, &new_settings)?;
    app.emit("settings_updated", &new_settings).ok();
    Ok(())
}

#[tauri::command]
fn rescan_icons(app: AppHandle) {
    let icons = os::read_desktop_icons();
    app.emit("icons_updated", &icons).ok();
}

#[tauri::command]
fn rescan_floor(app: AppHandle) {
    emit_floor(&app);
}

#[tauri::command]
fn update_pet_bounds(rects: Vec<IconRect>, state: tauri::State<AppState>) {
    *state.pet_bounds.lock().unwrap() = rects;
}

// Initial snapshot for the frontend; live changes arrive via the watcher event.
#[tauri::command]
fn is_desktop_active() -> bool {
    os::is_desktop_foreground()
}

#[tauri::command]
fn set_autostart(
    app: AppHandle,
    state: tauri::State<AppState>,
    enabled: bool,
) -> Result<(), String> {
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())?;
    } else {
        mgr.disable().map_err(|e| e.to_string())?;
    }
    // Persist the choice so startup can self-heal the OS entry (see setup).
    let snapshot = {
        let mut s = state.settings.lock().unwrap();
        s.launch_on_startup = enabled;
        s.clone()
    };
    settings::save(&app, &snapshot)
}

#[tauri::command]
fn is_autostart_enabled(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn show_dashboard(app: AppHandle) {
    if let Some(w) = app.get_webview_window("dashboard") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn show_pet(app: AppHandle) {
    if let Some(w) = app.get_webview_window("pet-window") {
        let _ = w.show();
    }
}

#[tauri::command]
fn hide_pet(app: AppHandle) {
    if let Some(w) = app.get_webview_window("pet-window") {
        let _ = w.hide();
    }
}

// One launchable app the user can pick for a pet's "open an app" action.
#[derive(Clone, serde::Serialize)]
struct AppEntry {
    name: String,
    path: String,
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000; // hide helper cmd/where consoles

// Recursively collect Start Menu .lnk shortcuts — the canonical "installed
// apps" list on Windows. Launching the .lnk (not the target) preserves the
// shortcut's working dir / args, so store & desktop apps both work.
#[cfg(windows)]
fn collect_lnks(dir: &std::path::Path, out: &mut Vec<AppEntry>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_lnks(&path, out);
        } else if path
            .extension()
            .map(|e| e.eq_ignore_ascii_case("lnk"))
            .unwrap_or(false)
        {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                let lower = stem.to_lowercase();
                if lower.contains("uninstall") {
                    continue;
                }
                out.push(AppEntry {
                    name: stem.to_string(),
                    path: path.to_string_lossy().into_owned(),
                });
            }
        }
    }
}

// Apps available on this machine, for the dashboard's app dropdown.
#[tauri::command]
fn list_apps() -> Vec<AppEntry> {
    let mut apps = Vec::new();
    #[cfg(windows)]
    {
        const SUFFIX: &str = r"Microsoft\Windows\Start Menu\Programs";
        for base in ["APPDATA", "PROGRAMDATA"] {
            if let Ok(dir) = std::env::var(base) {
                collect_lnks(&std::path::Path::new(&dir).join(SUFFIX), &mut apps);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(entries) = std::fs::read_dir("/Applications") {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map(|e| e == "app").unwrap_or(false) {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        apps.push(AppEntry {
                            name: stem.to_string(),
                            path: path.to_string_lossy().into_owned(),
                        });
                    }
                }
            }
        }
    }
    // Dedup by name (user Start Menu wins over the system one), then sort.
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps.dedup_by(|a, b| a.name.eq_ignore_ascii_case(&b.name));
    apps
}

// Launch an app picked from list_apps (or a legacy free-text command),
// detached, via the OS shell — the per-pet "open an app" click action.
#[tauri::command]
fn open_app(command: String) -> Result<(), String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("no app configured".into());
    }
    // Paths from the app picker need quoting or `start` splits them on spaces.
    let is_path = std::path::Path::new(&command).exists();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let target = if is_path { format!("\"{command}\"") } else { command };
        std::process::Command::new("cmd")
            .arg("/C")
            .raw_arg(format!("start \"\" {target}"))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let shell_cmd = if is_path {
            format!("open \"{command}\"")
        } else {
            command
        };
        std::process::Command::new("sh")
            .arg("-c")
            .arg(&shell_cmd)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// Hardcoded Sparky feature: open Claude Code in a terminal. Resolves the real
// `claude` shim up front (via where.exe) instead of re-resolving inside a
// nested cmd, and keeps the terminal open (/K) so any launch error is visible.
#[tauri::command]
fn launch_claude() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("where")
            .arg("claude")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout);
        let mut candidates: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        if candidates.is_empty() {
            return Err("Claude Code (`claude`) was not found on PATH".into());
        }
        // Prefer what cmd can execute directly: .exe, then .cmd/.bat, then rest.
        candidates.sort_by_key(|p| {
            let l = p.to_lowercase();
            if l.ends_with(".exe") {
                0
            } else if l.ends_with(".cmd") || l.ends_with(".bat") {
                1
            } else {
                2
            }
        });
        let path = candidates[0];
        // Start the session in the user's home directory, not wherever the
        // pet app happens to run from.
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C")
            .raw_arg(format!("start \"Claude Code\" cmd /K \"{path}\""))
            .creation_flags(CREATE_NO_WINDOW);
        cmd.current_dir(&home);
        cmd.spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("osascript")
            .args([
                "-e",
                "tell application \"Terminal\" to do script \"cd ~ && claude\"",
                "-e",
                "tell application \"Terminal\" to activate",
            ])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let mut cmd = std::process::Command::new("x-terminal-emulator");
        cmd.args(["-e", "claude"]);
        if let Some(home) = std::env::var_os("HOME") {
            cmd.current_dir(home);
        }
        cmd.spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
fn emit_floor(app: &AppHandle) {
    let taskbar_top = os::work_area_bottom();
    if taskbar_top > 0 {
        app.emit("floor_updated", FloorPayload { taskbar_top }).ok();
    }
}

// Background scanner: poll icons + floor, emit only on change (design.md §3.C).
fn start_scanner(app: AppHandle, interval_ms: u64) {
    std::thread::spawn(move || {
        let mut last_icons: Vec<IconRect> = Vec::new();
        let mut last_floor: i32 = -1;
        loop {
            let icons = os::read_desktop_icons();
            if icons != last_icons {
                app.emit("icons_updated", &icons).ok();
                last_icons = icons;
            }
            let floor = os::work_area_bottom();
            if floor != last_floor && floor > 0 {
                app.emit("floor_updated", FloorPayload { taskbar_top: floor }).ok();
                last_floor = floor;
            }
            std::thread::sleep(std::time::Duration::from_millis(interval_ms.max(500)));
        }
    });
}

// Foreground watcher: the pet only interacts with desktop icons while the
// desktop itself is the foreground "page"; otherwise it walks the taskbar.
// Emits desktop_state_updated only on change.
fn start_desktop_watcher(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last: Option<bool> = None;
        loop {
            let active = os::is_desktop_foreground();
            if last != Some(active) {
                app.emit("desktop_state_updated", DesktopStatePayload { active }).ok();
                last = Some(active);
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
    });
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let settings_item = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    let toggle_item = MenuItem::with_id(app, "toggle_pet", "Hide Pet", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&settings_item, &toggle_item, &quit_item])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Desktop Pet")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "settings" => {
                if let Some(w) = app.get_webview_window("dashboard") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "toggle_pet" => {
                if let Some(w) = app.get_webview_window("pet-window") {
                    if w.is_visible().unwrap_or(true) {
                        let _ = w.hide();
                    } else {
                        let _ = w.show();
                    }
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
pub fn run() {
    let started_minimized = std::env::args().any(|a| a == "--minimized");

    tauri::Builder::default()
        // Launching the exe again must NOT create a second app (and second
        // pet); just surface the existing settings window instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("dashboard") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(move |app| {
            let handle = app.handle().clone();

            // Load persisted settings into shared state.
            let loaded = settings::load(&handle);

            // Self-heal "launch on startup": re-registering rewrites the OS
            // entry to point at THIS exe, so a stale path (e.g. registered by
            // a dev build, or the app moved) can't boot a broken app. Release
            // only — a dev build must never hijack the entry back to itself.
            #[cfg(not(debug_assertions))]
            if loaded.launch_on_startup {
                let _ = app.autolaunch().enable();
            }

            let interval = loaded.icon_scan_interval_ms;
            let pet_bounds = Arc::new(Mutex::new(Vec::<IconRect>::new()));
            app.manage(AppState {
                settings: Mutex::new(loaded),
                pet_bounds: pet_bounds.clone(),
            });

            // Make the pet overlay click-through (design.md §3.B). The mouse
            // hook flips WS_EX_TRANSPARENT on this HWND while a pet is hovered
            // or dragged so the overlay can own the cursor.
            if let Some(pet) = app.get_webview_window("pet-window") {
                let _ = pet.set_ignore_cursor_events(true);
                #[cfg(windows)]
                if let Ok(hwnd) = pet.hwnd() {
                    os::set_pet_hwnd(hwnd.0 as isize);
                }
                let _ = pet.show();
            }

            // On boot via autostart, don't pop the dashboard in the user's face.
            if started_minimized {
                if let Some(dash) = app.get_webview_window("dashboard") {
                    let _ = dash.hide();
                }
            }

            build_tray(&handle)?;
            os::install_mouse_hook(handle.clone(), pet_bounds);
            start_scanner(handle.clone(), interval);
            start_desktop_watcher(handle.clone());
            emit_floor(&handle);

            Ok(())
        })
        // Closing the settings window only hides it. The same window (and its
        // state) is re-shown by the tray or a relaunch, so every "new" settings
        // view tracks the same pets instead of starting from scratch.
        .on_window_event(|window, event| {
            if window.label() == "dashboard" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            rescan_icons,
            rescan_floor,
            update_pet_bounds,
            is_desktop_active,
            set_autostart,
            is_autostart_enabled,
            show_dashboard,
            show_pet,
            hide_pet,
            open_app,
            list_apps,
            launch_claude,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
