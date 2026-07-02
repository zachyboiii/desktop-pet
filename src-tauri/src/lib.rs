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
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())
    } else {
        mgr.disable().map_err(|e| e.to_string())
    }
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
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(move |app| {
            let handle = app.handle().clone();

            // Load persisted settings into shared state.
            let loaded = settings::load(&handle);
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
