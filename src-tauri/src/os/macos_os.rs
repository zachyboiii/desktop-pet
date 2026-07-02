// macOS-specific OS integration, mirroring windows_os.rs:
//   * read_desktop_icons()    — Finder desktop icon rects via AppleScript
//   * work_area_bottom()      — top of the Dock (NSScreen visibleFrame)
//   * install_mouse_hook()    — global listen-only CGEventTap
//   * is_desktop_foreground() — no normal app windows on screen (CGWindowList)
//
// Coordinate contract (must match the Windows backend): everything is emitted
// in PHYSICAL pixels — AppKit/CoreGraphics report points, so multiply by the
// screen's backing scale factor. The frontend divides by devicePixelRatio.
//
// Permissions this backend needs (both prompted/granted per-app):
//   * Automation → Finder (NSAppleEventsUsageDescription in Info.plist) for
//     the icon scanner; denied = no icon platforms, everything else works.
//   * Accessibility / Input Monitoring for the CGEventTap; denied = the tap
//     fails to install and the pet is watch-only (no click/drag).
#![cfg(target_os = "macos")]

use crate::IconRect;
use std::cell::Cell;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use core_foundation::base::TCFType;
use core_foundation::number::CFNumber;
use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
use core_foundation::string::CFString;
use core_foundation_sys::dictionary::{CFDictionaryGetValueIfPresent, CFDictionaryRef};
use core_foundation_sys::number::CFNumberRef;
use core_graphics::event::{
    CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
};
use core_graphics::geometry::CGRect;
use core_graphics::window::{
    self, kCGNullWindowID, kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly,
};
use objc::runtime::Object;
use objc::{class, msg_send, sel, sel_impl};

// ---------------------------------------------------------------------------
// Screen metrics. NSScreen geometry getters are plain reads and safe to call
// off the main thread (the scanner thread polls work_area_bottom).
// ---------------------------------------------------------------------------
fn main_screen() -> Option<(CGRect /* frame */, CGRect /* visible */, f64 /* scale */)> {
    unsafe {
        let screen: *mut Object = msg_send![class!(NSScreen), mainScreen];
        if screen.is_null() {
            return None;
        }
        let frame: CGRect = msg_send![screen, frame];
        let visible: CGRect = msg_send![screen, visibleFrame];
        let scale: f64 = msg_send![screen, backingScaleFactor];
        Some((frame, visible, scale))
    }
}

fn backing_scale() -> f64 {
    main_screen().map(|(_, _, s)| s).unwrap_or(1.0)
}

// ---------------------------------------------------------------------------
// Dock floor: bottom of the visible frame, converted to top-left origin.
// ---------------------------------------------------------------------------
pub fn work_area_bottom() -> i32 {
    let Some((frame, visible, scale)) = main_screen() else {
        return 0;
    };
    // AppKit uses a bottom-left origin: visibleFrame.origin.y is the height of
    // a bottom Dock (0 when hidden or docked to a side). Convert to "distance
    // from the top of the screen", i.e. where the pet's floor is.
    let bottom_pts = frame.size.height - visible.origin.y;
    (bottom_pts * scale) as i32
}

// ---------------------------------------------------------------------------
// Icon scanner: ask Finder for every desktop icon's position + the icon size.
// One osascript round-trip per scan; output is "size|x,y|x,y|...".
// ---------------------------------------------------------------------------
const ICON_SCRIPT: &str = r#"
tell application "Finder"
    set sz to icon size of icon view options of window of desktop
    set out to sz as text
    repeat with it in (get every item of desktop)
        set p to position of it
        set out to out & "|" & (item 1 of p) & "," & (item 2 of p)
    end repeat
    return out
end tell"#;

// Approximate height of the filename label under the icon, in points. Included
// so "obstacle" boxes cover the whole clickable icon like on Windows.
const LABEL_PTS: f64 = 18.0;

pub fn read_desktop_icons() -> Vec<IconRect> {
    let Ok(out) = Command::new("osascript").arg("-e").arg(ICON_SCRIPT).output() else {
        return Vec::new();
    };
    if !out.status.success() {
        // Most likely the user declined the Automation → Finder permission.
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.trim().split('|');
    let Some(size_pts) = parts.next().and_then(|s| s.trim().parse::<f64>().ok()) else {
        return Vec::new();
    };
    let scale = backing_scale();

    let mut icons = Vec::new();
    for (i, pair) in parts.enumerate() {
        let mut nums = pair.split(',').map(|n| n.trim().parse::<f64>());
        let (Some(Ok(cx)), Some(Ok(cy))) = (nums.next(), nums.next()) else {
            continue;
        };
        // Finder reports the icon's center in points, top-left origin, global
        // to the desktop window (which spans the whole screen).
        icons.push(IconRect {
            x: ((cx - size_pts / 2.0) * scale) as i32,
            y: ((cy - size_pts / 2.0) * scale) as i32,
            w: (size_pts * scale) as i32,
            h: ((size_pts + LABEL_PTS) * scale) as i32,
            label: format!("icon_{i}"),
        });
    }
    icons
}

// ---------------------------------------------------------------------------
// Desktop visibility — same semantics as Windows: the desktop is "active"
// only when no normal app window is open on screen. On macOS, normal app
// windows sit at CGWindowLayer 0; the menu bar, Dock, and desktop icons all
// live on other layers (and desktop elements are excluded outright).
// ---------------------------------------------------------------------------
unsafe fn dict_i64(dict: CFDictionaryRef, key: &str) -> Option<i64> {
    let key = CFString::new(key);
    let mut value: *const std::ffi::c_void = std::ptr::null();
    if CFDictionaryGetValueIfPresent(dict, key.as_concrete_TypeRef() as *const _, &mut value) == 0
        || value.is_null()
    {
        return None;
    }
    CFNumber::wrap_under_get_rule(value as CFNumberRef).to_i64()
}

pub fn is_desktop_foreground() -> bool {
    unsafe {
        let opts = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
        let Some(list) = window::copy_window_info(opts, kCGNullWindowID) else {
            return true;
        };
        let my_pid = std::process::id() as i64;
        for item in list.iter() {
            let dict = *item as CFDictionaryRef;
            if dict.is_null() {
                continue;
            }
            let layer = dict_i64(dict, "kCGWindowLayer").unwrap_or(-1);
            let pid = dict_i64(dict, "kCGWindowOwnerPID").unwrap_or(-1);
            // Our own windows (pet overlay, dashboard) never hide the icons.
            if layer == 0 && pid != my_pid {
                return false;
            }
        }
        true
    }
}

// ---------------------------------------------------------------------------
// Global mouse hook: a listen-only CGEventTap on its own thread + run loop.
// Same design as the Windows WH_MOUSE_LL hook — it only observes and forwards
// events (never swallows them); the frontend decides click-vs-drag itself.
// ---------------------------------------------------------------------------
struct HookState {
    app: AppHandle,
    bounds: Arc<Mutex<Vec<IconRect>>>,
}
static HOOK_STATE: Mutex<Option<HookState>> = Mutex::new(None);
// True between a mouse-down on a pet and the matching mouse-up.
static DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);
static WINDOW_INTERACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
struct ClickPos {
    x: i32,
    y: i32,
}

fn emit_mouse(event: &str, x: i32, y: i32) {
    if let Ok(guard) = HOOK_STATE.lock() {
        if let Some(state) = guard.as_ref() {
            let _ = state.app.emit(event, ClickPos { x, y });
        }
    }
}

// Same margins as the Windows hook: tiny inflation for the one-frame lag on
// enter, larger hysteresis band on leave so the boundary never flaps.
const HIT_MARGIN: i32 = 2;
const LEAVE_MARGIN: i32 = 12;

fn hits_pet_within(x: i32, y: i32, margin: i32) -> bool {
    if let Ok(guard) = HOOK_STATE.lock() {
        if let Some(state) = guard.as_ref() {
            if let Ok(rects) = state.bounds.lock() {
                return rects.iter().any(|r| {
                    x >= r.x - margin
                        && x <= r.x + r.w + margin
                        && y >= r.y - margin
                        && y <= r.y + r.h + margin
                });
            }
        }
    }
    false
}

fn hits_pet(x: i32, y: i32) -> bool {
    hits_pet_within(x, y, HIT_MARGIN)
}

// The overlay is click-through by default. While hovering/dragging a pet we
// make it interactive so it owns the cursor and pet clicks don't fall through
// to whatever is underneath. Unlike Windows (where toggling via Tauri visibly
// flickers), NSWindow.ignoresMouseEvents is a cheap flag, and Tauri window
// methods proxy to the main thread, so this is safe from the tap thread.
fn set_window_interactive(on: bool) {
    if WINDOW_INTERACTIVE.swap(on, Ordering::SeqCst) == on {
        return; // no change
    }
    if let Ok(guard) = HOOK_STATE.lock() {
        if let Some(state) = guard.as_ref() {
            if let Some(w) = state.app.get_webview_window("pet-window") {
                let _ = w.set_ignore_cursor_events(!on);
            }
        }
    }
}

// Mirror of the Windows activate_desktop(): push a fresh desktop-state
// snapshot immediately on pet grab instead of waiting for the 300ms poll.
fn emit_desktop_snapshot() {
    let active = is_desktop_foreground();
    if let Ok(guard) = HOOK_STATE.lock() {
        if let Some(state) = guard.as_ref() {
            let _ = state.app.emit(
                "desktop_state_updated",
                crate::DesktopStatePayload { active },
            );
        }
    }
}

pub fn install_mouse_hook(app: AppHandle, bounds: Arc<Mutex<Vec<IconRect>>>) {
    *HOOK_STATE.lock().unwrap() = Some(HookState { app, bounds });
    std::thread::spawn(|| {
        let scale = backing_scale();
        // Move events are throttled (trackpads report fast); last emit time.
        let last_move = Cell::new(Instant::now() - Duration::from_secs(1));

        let tap = CGEventTap::new(
            CGEventTapLocation::Session,
            CGEventTapPlacement::HeadInsertEventTap,
            CGEventTapOptions::ListenOnly,
            vec![
                CGEventType::LeftMouseDown,
                CGEventType::LeftMouseUp,
                CGEventType::MouseMoved,
                CGEventType::LeftMouseDragged,
            ],
            move |_proxy, etype, event| {
                // CGEvent.location is in points, global, top-left origin —
                // scale to physical px to match the Windows contract.
                let loc = event.location();
                let x = (loc.x * scale) as i32;
                let y = (loc.y * scale) as i32;
                match etype {
                    CGEventType::LeftMouseDown => {
                        if hits_pet(x, y) {
                            DRAG_ACTIVE.store(true, Ordering::SeqCst);
                            set_window_interactive(true);
                            emit_desktop_snapshot();
                            emit_mouse("pet_mouse_down", x, y);
                        }
                    }
                    CGEventType::MouseMoved | CGEventType::LeftMouseDragged => {
                        let desired = if DRAG_ACTIVE.load(Ordering::SeqCst) {
                            true
                        } else if WINDOW_INTERACTIVE.load(Ordering::SeqCst) {
                            hits_pet_within(x, y, LEAVE_MARGIN)
                        } else {
                            hits_pet(x, y)
                        };
                        set_window_interactive(desired);
                        if last_move.get().elapsed() >= Duration::from_millis(8) {
                            last_move.set(Instant::now());
                            emit_mouse("pet_mouse_move", x, y);
                        }
                    }
                    CGEventType::LeftMouseUp => {
                        if DRAG_ACTIVE.swap(false, Ordering::SeqCst) {
                            emit_mouse("pet_mouse_up", x, y);
                            set_window_interactive(hits_pet(x, y));
                        }
                    }
                    _ => {}
                }
                None // listen-only: never modify/swallow the event
            },
        );

        let Ok(tap) = tap else {
            eprintln!(
                "desktop-pet: mouse tap failed — grant Accessibility/Input Monitoring \
                 permission in System Settings > Privacy & Security, then relaunch."
            );
            return;
        };
        let Ok(source) = tap.mach_port.create_runloop_source(0) else {
            return;
        };
        let run_loop = CFRunLoop::get_current();
        unsafe {
            run_loop.add_source(&source, kCFRunLoopCommonModes);
        }
        tap.enable();
        CFRunLoop::run_current();
    });
}
