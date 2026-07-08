// Windows-specific OS integration:
//   * read_desktop_icons() — enumerate SysListView32 icon rects (design.md §3.C)
//   * work_area_bottom()   — top of the taskbar (design.md §3.F)
//   * install_mouse_hook() — global low-level mouse hook (design.md §3.E)
#![cfg(windows)]

use crate::IconRect;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, BOOL, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM,
};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
};
use windows::Win32::System::Memory::{
    VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, PAGE_READWRITE,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, PROCESS_VM_OPERATION, PROCESS_VM_READ, PROCESS_VM_WRITE,
};
use windows::Win32::System::Diagnostics::Debug::{ReadProcessMemory, WriteProcessMemory};
use windows::Win32::UI::Controls::{LVM_GETITEMCOUNT, LVM_GETITEMRECT, LVIR_BOUNDS};
use windows::Win32::UI::WindowsAndMessaging::*;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn find_window(class: &str, title: Option<&str>) -> HWND {
    let c = wide(class);
    match title {
        Some(t) => {
            let tw = wide(t);
            FindWindowW(PCWSTR(c.as_ptr()), PCWSTR(tw.as_ptr())).unwrap_or_default()
        }
        None => FindWindowW(PCWSTR(c.as_ptr()), PCWSTR::null()).unwrap_or_default(),
    }
}

unsafe fn find_child(parent: HWND, class: &str) -> HWND {
    let c = wide(class);
    FindWindowExW(parent, HWND::default(), PCWSTR(c.as_ptr()), PCWSTR::null())
        .unwrap_or_default()
}

// Locate the desktop's SysListView32, handling the WorkerW wallpaper fallback.
unsafe fn find_desktop_listview() -> Option<HWND> {
    let progman = find_window("Progman", Some("Program Manager"));
    if !progman.0.is_null() {
        let defview = find_child(progman, "SHELLDLL_DefView");
        if !defview.0.is_null() {
            let lv = find_child(defview, "SysListView32");
            if !lv.0.is_null() {
                return Some(lv);
            }
        }
    }

    // Wallpaper / active-desktop case: SHELLDLL_DefView lives under a WorkerW.
    let mut result: Option<HWND> = None;
    unsafe extern "system" fn enum_proc(top: HWND, lparam: LPARAM) -> BOOL {
        let defview = FindWindowExW(top, HWND::default(), PCWSTR(wide("SHELLDLL_DefView").as_ptr()), PCWSTR::null())
            .unwrap_or_default();
        if !defview.0.is_null() {
            let lv = FindWindowExW(defview, HWND::default(), PCWSTR(wide("SysListView32").as_ptr()), PCWSTR::null())
                .unwrap_or_default();
            if !lv.0.is_null() {
                let out = &mut *(lparam.0 as *mut Option<HWND>);
                *out = Some(lv);
                return BOOL(0); // stop
            }
        }
        BOOL(1)
    }
    let _ = EnumWindows(Some(enum_proc), LPARAM(&mut result as *mut _ as isize));
    result
}

// ---------------------------------------------------------------------------
// Icon scanner
// ---------------------------------------------------------------------------
pub fn read_desktop_icons() -> Vec<IconRect> {
    let mut out = Vec::new();
    unsafe {
        let Some(hlist) = find_desktop_listview() else {
            return out;
        };

        let count = SendMessageW(hlist, LVM_GETITEMCOUNT, WPARAM(0), LPARAM(0)).0 as i32;
        if count <= 0 {
            return out;
        }

        // The ListView belongs to Explorer; we must read its RECTs out of that
        // process's address space.
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hlist, Some(&mut pid));
        let Ok(proc) = OpenProcess(
            PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE,
            false,
            pid,
        ) else {
            return out;
        };

        let remote = VirtualAllocEx(
            proc,
            None,
            std::mem::size_of::<RECT>(),
            MEM_COMMIT,
            PAGE_READWRITE,
        );
        if remote.is_null() {
            let _ = CloseHandle(proc);
            return out;
        }

        for i in 0..count {
            // LVM_GETITEMRECT reads rect.left as the "which rect" code, so seed it.
            let seed = RECT {
                left: LVIR_BOUNDS as i32,
                top: 0,
                right: 0,
                bottom: 0,
            };
            let mut written = 0usize;
            let _ = WriteProcessMemory(
                proc,
                remote,
                &seed as *const _ as *const _,
                std::mem::size_of::<RECT>(),
                Some(&mut written),
            );

            let ok = SendMessageW(hlist, LVM_GETITEMRECT, WPARAM(i as usize), LPARAM(remote as isize));
            if ok.0 == 0 {
                continue;
            }

            let mut rect = RECT::default();
            let mut read = 0usize;
            let _ = ReadProcessMemory(
                proc,
                remote,
                &mut rect as *mut _ as *mut _,
                std::mem::size_of::<RECT>(),
                Some(&mut read),
            );

            // ListView rects are client-relative; convert to screen coords.
            let mut tl = POINT { x: rect.left, y: rect.top };
            let mut br = POINT { x: rect.right, y: rect.bottom };
            let _ = ClientToScreen(hlist, &mut tl);
            let _ = ClientToScreen(hlist, &mut br);

            let w = br.x - tl.x;
            let h = br.y - tl.y;
            if w > 0 && h > 0 {
                out.push(IconRect {
                    x: tl.x,
                    y: tl.y,
                    w,
                    h,
                    label: format!("icon_{i}"),
                });
            }
        }

        let _ = VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
        let _ = CloseHandle(proc);
    }
    out
}

// ---------------------------------------------------------------------------
// Desktop visibility: are the icons actually what the user sees?
// Focus alone isn't enough — clicking the wallpaper while a browser is open
// would count as "on the desktop" even though windows cover the icons. So
// instead: the desktop is active only when no real app window is open on
// screen (minimized windows are fine, they don't cover anything).
// ---------------------------------------------------------------------------

// Shell surfaces that are always present and never "cover" the desktop.
const SHELL_CLASSES: &[&str] = &[
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "Windows.UI.Core.CoreWindow",
    "XamlExplorerHostIslandWindow",
    "NotifyIconOverflowWindow",
];

unsafe fn is_open_app_window(hwnd: HWND) -> bool {
    if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return false;
    }

    // Skip our own windows (pet overlay, settings dashboard) — they overlay
    // the desktop but never hide the icons.
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == GetCurrentProcessId() {
        return false;
    }

    // Tool windows and untitled helper windows aren't user-facing "pages".
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
    if ex & WS_EX_TOOLWINDOW.0 != 0 {
        return false;
    }
    if GetWindowTextLengthW(hwnd) == 0 {
        return false;
    }

    let mut buf = [0u16; 64];
    let len = GetClassNameW(hwnd, &mut buf) as usize;
    let class = String::from_utf16_lossy(&buf[..len.min(buf.len())]);
    if SHELL_CLASSES.iter().any(|c| *c == class) {
        return false;
    }

    // UWP/system windows often stay "visible" but DWM-cloaked (e.g. suspended
    // Store apps, virtual-desktop leftovers). Cloaked = not really on screen.
    let mut cloaked: u32 = 0;
    if DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut _ as *mut _,
        std::mem::size_of::<u32>() as u32,
    )
    .is_ok()
        && cloaked != 0
    {
        return false;
    }

    // Zero-area windows can't cover anything.
    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_ok()
        && (rect.right <= rect.left || rect.bottom <= rect.top)
    {
        return false;
    }

    true
}

pub fn is_desktop_foreground() -> bool {
    unsafe {
        let mut blocked = false;
        unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
            if is_open_app_window(hwnd) {
                *(lparam.0 as *mut bool) = true;
                return BOOL(0); // found one — stop, desktop is covered
            }
            BOOL(1)
        }
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut blocked as *mut _ as isize));
        !blocked
    }
}

// ---------------------------------------------------------------------------
// Taskbar floor: bottom of the primary monitor's work area.
// ---------------------------------------------------------------------------
pub fn work_area_bottom() -> i32 {
    unsafe {
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            return info.rcWork.bottom;
        }
    }
    // Fallback: assume a ~48px taskbar.
    unsafe { GetSystemMetrics(SM_CYSCREEN) - 48 }
}

// Full (non-work-area) bounds of the primary monitor, in physical pixels:
// (left, top, width, height). The pet window is explicitly positioned/sized
// to this rect at startup so the webview's CSS-pixel origin (0,0) always
// lines up with screen (0,0) — Tauri's `maximized: true` config flag alone
// doesn't guarantee that alignment across dev vs. packaged builds.
pub fn primary_monitor_rect() -> (i32, i32, i32, i32) {
    unsafe {
        let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            let r = info.rcMonitor;
            return (r.left, r.top, r.right - r.left, r.bottom - r.top);
        }
        (0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN))
    }
}

// ---------------------------------------------------------------------------
// Global low-level mouse hook -> forward presses/drags that land on a pet.
//
// IMPORTANT: WH_MOUSE_LL hooks must always call CallNextHookEx and must never
// return a nonzero value to "swallow" input — that's undefined behavior for
// this hook type (unlike WH_KEYBOARD_LL) and in practice corrupts Windows'
// internal button-state tracking, so the very next click/drag silently stops
// being delivered. So this hook only *observes* and forwards events; it never
// blocks them. The frontend decides click-vs-drag itself from the deltas.
// ---------------------------------------------------------------------------
use std::sync::atomic::{AtomicBool, Ordering};

struct HookState {
    app: AppHandle,
    bounds: std::sync::Arc<Mutex<Vec<IconRect>>>,
}
static HOOK_STATE: Mutex<Option<HookState>> = Mutex::new(None);
// True between an LBUTTONDOWN on a pet and the matching LBUTTONUP.
static DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);
// Move events are throttled (mice report at up to 1000 Hz); ms of the last emit.
static LAST_MOVE_MS: Mutex<u32> = Mutex::new(0);

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

// Small inflation absorbs the one-frame lag between where the frontend last
// reported the pet and where it's actually drawn when the click lands. Keep
// this tiny: the frontend does the authoritative (tight) hit-test, this only
// gates whether events are forwarded at all.
const HIT_MARGIN: i32 = 2;
// Once interactive, require the cursor to move this far off the pet before
// going back to click-through — hysteresis so the boundary never flaps while
// the pet animates under the cursor.
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

// The overlay is click-through by default so it never blocks the desktop.
// While the cursor is over a pet (or a drag is in progress) we flip it to
// interactive so the window owns the cursor (pointer/grabbing works) and the
// click can't fall through and select desktop icons underneath the pet.
//
// Tauri's set_ignore_cursor_events() rewrites WS_EX_TRANSPARENT *and*
// WS_EX_LAYERED and forces a frame-change, which visibly flickers the
// transparent overlay on every toggle. Hit-testing is controlled by
// WS_EX_TRANSPARENT alone, so flip just that bit directly — no repaint,
// no frame change, safe to call from the hook thread.
static WINDOW_INTERACTIVE: AtomicBool = AtomicBool::new(false);
static PET_HWND: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

pub fn set_pet_hwnd(hwnd: isize) {
    PET_HWND.store(hwnd, Ordering::SeqCst);
}

fn set_window_interactive(on: bool) {
    if WINDOW_INTERACTIVE.swap(on, Ordering::SeqCst) == on {
        return; // no change
    }
    let raw = PET_HWND.load(Ordering::SeqCst);
    if raw == 0 {
        return;
    }
    unsafe {
        let hwnd = HWND(raw as *mut core::ffi::c_void);
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let transparent = WS_EX_TRANSPARENT.0 as isize;
        let new = if on { ex & !transparent } else { ex | transparent };
        if new != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new);
        }
    }
}

// Clicking the pet used to fall through the click-through overlay and land on
// the desktop, activating it. Now that the overlay swallows pet clicks, bring
// the desktop forward explicitly so grabbing the pet doesn't leave some app
// window focused, and push the frontend a fresh desktop-state snapshot right
// away rather than waiting for the 300ms poll. The state is computed, not
// assumed true: with visibility-based semantics, clicking the pet while other
// windows are open must NOT re-enable the icon platforms.
fn activate_desktop() {
    unsafe {
        let progman = find_window("Progman", Some("Program Manager"));
        if !progman.0.is_null() {
            let _ = SetForegroundWindow(progman);
        }
    }
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

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        let (x, y) = (info.pt.x, info.pt.y);
        match wparam.0 as u32 {
            WM_LBUTTONDOWN => {
                if hits_pet(x, y) {
                    DRAG_ACTIVE.store(true, Ordering::SeqCst);
                    set_window_interactive(true);
                    activate_desktop();
                    emit_mouse("pet_mouse_down", x, y);
                }
            }
            WM_MOUSEMOVE => {
                // Keep the overlay interactive while hovering a pet or mid-drag
                // so it owns the cursor; click-through everywhere else. Enter
                // on the tight box, leave only past LEAVE_MARGIN (hysteresis).
                let desired = if DRAG_ACTIVE.load(Ordering::SeqCst) {
                    true
                } else if WINDOW_INTERACTIVE.load(Ordering::SeqCst) {
                    hits_pet_within(x, y, LEAVE_MARGIN)
                } else {
                    hits_pet(x, y)
                };
                set_window_interactive(desired);
                // Always tell the frontend where the cursor is (cheap hit-test
                // there) so it can show a pointer cursor while hovering, plus
                // drive the drag if one is active.
                let now = info.time;
                let mut last = LAST_MOVE_MS.lock().unwrap();
                if now.wrapping_sub(*last) >= 8 {
                    *last = now;
                    drop(last);
                    emit_mouse("pet_mouse_move", x, y);
                }
            }
            WM_LBUTTONUP => {
                if DRAG_ACTIVE.swap(false, Ordering::SeqCst) {
                    emit_mouse("pet_mouse_up", x, y);
                    // Back to click-through unless still hovering the pet.
                    set_window_interactive(hits_pet(x, y));
                }
            }
            _ => {}
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

// Runs the hook on its own thread with a message pump (required for WH_MOUSE_LL).
pub fn install_mouse_hook(app: AppHandle, bounds: std::sync::Arc<Mutex<Vec<IconRect>>>) {
    *HOOK_STATE.lock().unwrap() = Some(HookState { app, bounds });
    std::thread::spawn(|| unsafe {
        let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), HINSTANCE::default(), 0);
        if hook.is_err() {
            return;
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}
