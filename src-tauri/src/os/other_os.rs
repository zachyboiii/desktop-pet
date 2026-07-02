// Fallback OS integration for platforms without a native backend (currently
// Linux — Windows and macOS have real implementations). The app still runs;
// the pet just walks on the screen floor with no icon platforms.
#![cfg(not(any(windows, target_os = "macos")))]

use crate::IconRect;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

pub fn read_desktop_icons() -> Vec<IconRect> {
    Vec::new()
}

pub fn work_area_bottom() -> i32 {
    // No reliable cross-platform call here without extra deps; let the frontend
    // fall back to its window-height inset.
    0
}

pub fn install_mouse_hook(_app: AppHandle, _bounds: Arc<Mutex<Vec<IconRect>>>) {
    // Not implemented on this platform yet.
}

pub fn is_desktop_foreground() -> bool {
    // No icon scanning here anyway, so the answer doesn't matter; true keeps
    // the frontend's default behavior.
    true
}
