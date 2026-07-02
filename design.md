# Comprehensive Desktop Pet System Architecture

**Cost:** $0 to build, deploy, and run locally. (100% Free and Open Source Stack)
**Technology Stack:** Tauri (Rust Backend) + React.js & Tailwind CSS (Frontend)

This document combines the high-level system design and deep technical mechanics required to build a cross-platform (Windows & Mac) desktop pet application. Using React and Tailwind CSS for the frontend ensures rapid UI development, while Tauri handles the heavy lifting of OS-level window management with virtually no overhead.

**Signature Feature — Icons as Playground:** The pet treats the user's real desktop icons as physical level geometry. Each icon becomes a *platform* (the pet can stand, walk, and jump onto its top edge) or an *obstacle* (the pet path-finds around it). The Rust backend reads live icon positions from the OS and streams them to the canvas as collision rectangles, so the playground is literally the user's own desktop layout — and it re-adapts whenever icons are moved.

**Pet Behaviors at a Glance:**

| # | Behavior | Where it lives |
|---|----------|----------------|
| 1 | **Launch on startup** (toggle in Settings) | §3.D Autostart, §2.A Settings |
| 2 | **Click to "look" + speech bubble** of preset text | §2.C Interaction, §3.E Click forwarding |
| 3 | **Random AI** — walk left/right, jump onto icons, sleep | §2.D Behavior State Machine |
| 4 | **Taskbar top is the floor** (lowest walkable level) | §3.F Taskbar Floor, §2.B `world.screenFloor` |

---

## 1. Core Architecture & IPC Strategy

The application relies on Tauri's lightweight webview engine. There are two completely separate React windows that communicate exclusively through the Rust backend via Inter-Process Communication (IPC).

1. **The Settings Dashboard (Standard Window):** A standard React/Tailwind application where the user configures pet settings (animal type, count, colors, and whether icons act as platforms).
2. **The Transparent Canvas (Frameless Window):** A hidden, full-screen webview where the pets render and where the icon collision geometry is consumed by the physics engine.
3. **The Rust Backend:** Acts as the bridge. When the Dashboard updates settings, it invokes a Rust command. Rust saves the data locally and broadcasts an event to the Transparent Canvas to spawn or update the pets. **Additionally, the backend runs an "Icon Scanner" that polls the OS for live desktop-icon rectangles and emits them to the canvas as the world's platform/obstacle geometry (see §3.C).**

### Data Flow for the Playground

```text
                    ┌─────────────────────┐
                    │   OS Desktop Shell   │
                    │ (real icon positions)│
                    └──────────┬───────────┘
                               │ poll (Win32 / AppleScript)
                               ▼
   ┌──────────────┐   icon rects   ┌────────────────────────┐
   │  Dashboard   │───settings────▶│      Rust Backend       │
   │  (window)    │                │  Icon Scanner + Bridge  │
   └──────────────┘                └───────────┬────────────┘
                                                │ emit("icons_updated", rects[])
                                                │ emit("settings_updated", cfg)
                                                ▼
                                   ┌────────────────────────┐
                                   │   Transparent Canvas    │
                                   │  Physics + Render Loop  │
                                   │  (pets collide w/ rects)│
                                   └────────────────────────┘
```

---

## 2. Frontend Architecture (React + Tailwind CSS)

### A. The Settings Dashboard

- **Routing/State:** Minimal state management (standard React `useState`) to track dropdowns and sliders.
- **UI Components:** Styled rapidly using Tailwind CSS.
- **Functionality:** Calls `invoke('update_settings', { newSettings })` when a user applies changes.
- **Playground Controls:** Expose toggles for the icon-platform behavior, for example:
  - `useIconsAsPlatforms` (bool) — master switch for treating icons as level geometry.
  - `iconRole` (`"platform" | "obstacle" | "mixed"`) — whether the pet lands on icon tops, avoids them, or both (top = platform, sides = obstacle).
  - `iconScanIntervalMs` (number) — how often the backend re-polls icon positions (default ~1500 ms; see §3.C for why polling is needed).
  - A **"Re-scan Icons Now"** button that invokes `invoke('rescan_icons')` for an immediate refresh after the user rearranges their desktop.
- **Startup Control (Behavior #1):** A single toggle, **"Launch when my computer starts"**, bound to a `launchOnStartup` (bool) setting. Flipping it calls a Rust command that registers/unregisters the app with the OS autostart mechanism (see §3.D). The toggle's initial state is read from the OS on dashboard load so it always reflects reality, not just the saved JSON.

```jsx
// Dashboard.jsx — startup toggle
const [launchOnStartup, setLaunchOnStartup] = useState(false);

useEffect(() => {
  invoke("is_autostart_enabled").then(setLaunchOnStartup); // truth from the OS
}, []);

async function toggleStartup(enabled) {
  await invoke("set_autostart", { enabled }); // registers/unregisters with the OS
  setLaunchOnStartup(enabled);
}
```

### B. The Transparent Canvas & Animation Engine

To maintain a smooth 60FPS without excessive memory usage, **do not use React state (`useEffect`/`useState`) to drive the pet animations.** React's reconciliation cycle is too heavy for real-time rendering.

Instead, use a single full-screen HTML5 `<canvas>` inside a React component, driven by a vanilla JavaScript game loop.

The engine maintains a shared **world** object holding the platform geometry derived from desktop icons. The icon rectangles arrive from Rust via a Tauri event and are stored once; every pet reads from the same array each frame (no per-pet copies).

```javascript
// Shared world state, updated by the "icons_updated" Tauri event (see §3.C).
// Each rect: { x, y, w, h } in screen pixels. `y` is the TOP of the icon.
const world = {
  // Behavior #4: the lowest level the pet may walk on is the TOP of the taskbar.
  // Rust measures the real work-area / taskbar rect and sends it; we fall back to
  // a small inset only until that first event arrives.
  screenFloor: window.innerHeight - 48,
  platforms: [], // Icon tops the pet can stand on
  obstacles: [], // Full icon boxes the pet must not walk through
};

// Bound once during canvas setup:
// import { listen } from '@tauri-apps/api/event';
// listen('icons_updated', ({ payload }) => world.platforms = buildPlatforms(payload));
//
// Behavior #4 — the floor follows the real taskbar (see §3.F):
// listen('floor_updated', ({ payload }) => { world.screenFloor = payload.taskbarTop; });
```

```javascript
// Example Core Game Loop logic (Vanilla JS inside the React Canvas component)
class DesktopPet {
  constructor(x, y, spriteSheet, settings) {
    this.x = x;
    this.y = y;
    this.w = settings.width;
    this.h = settings.height;
    this.vy = 0; // Vertical velocity (gravity-driven)
    this.gravity = 0.6;
    this.state = "FALLING"; // FALLING, IDLE, WALKING_LEFT, WALKING_RIGHT, JUMPING
    this.frameX = 0;
    this.frameY = 0;
    this.speed = settings.speed;
  }

  // Find the highest platform top directly beneath the pet's feet that the
  // pet would land on this frame. Falls back to the screen floor.
  groundBeneath(nextY) {
    const feetX = this.x + this.w / 2;
    let ground = world.screenFloor;
    for (const p of world.platforms) {
      const overTop = feetX >= p.x && feetX <= p.x + p.w;
      const landing = this.y + this.h <= p.y && nextY + this.h >= p.y;
      if (overTop && landing && p.y < ground) ground = p.y;
    }
    return ground;
  }

  // Block horizontal movement into the sides of icons treated as obstacles.
  blockedHorizontally(nextX) {
    for (const o of world.obstacles) {
      const vOverlap = this.y + this.h > o.y && this.y < o.y + o.h;
      const willEnter = nextX + this.w > o.x && nextX < o.x + o.w;
      const wasOutside = this.x + this.w <= o.x || this.x >= o.x + o.w;
      if (vOverlap && willEnter && wasOutside) return true;
    }
    return false;
  }

  update() {
    if (this.state === "FALLING" || this.state === "JUMPING") {
      this.vy += this.gravity;
      const nextY = this.y + this.vy;
      const ground = this.groundBeneath(nextY);
      if (this.vy > 0 && nextY + this.h >= ground) {
        this.y = ground - this.h; // Land on icon top (or floor)
        this.vy = 0;
        this.state = "IDLE";
      } else {
        this.y = nextY;
      }
    } else if (this.state === "WALKING_LEFT" || this.state === "WALKING_RIGHT") {
      const dir = this.state === "WALKING_LEFT" ? -1 : 1;
      const nextX = this.x + dir * this.speed;
      this.frameY = 1;

      if (this.blockedHorizontally(nextX)) {
        // Hit the side of an icon: jump to try to climb onto it, or turn around.
        this.tryJumpOrTurn(dir);
      } else {
        this.x = nextX;
        // Walked off the edge of a platform? Start falling.
        if (this.y + this.h < this.groundBeneath(this.y + 1)) {
          this.state = "FALLING";
        }
      }
      if (this.x < 0) this.state = "WALKING_RIGHT";
      if (this.x + this.w > window.innerWidth) this.state = "WALKING_LEFT";
    }
  }

  tryJumpOrTurn(dir) {
    // Simple AI: hop to mount a platform that's within jump height,
    // otherwise reverse direction to treat the icon as a wall.
    this.vy = -10; // Jump impulse
    this.state = "JUMPING";
  }

  draw(context) {
    context.drawImage(
      this.spriteSheet,
      this.frameX * spriteWidth,
      this.frameY * spriteHeight,
      spriteWidth,
      spriteHeight,
      this.x,
      this.y,
      this.w,
      this.h,
    );
  }
}

function animate() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  pets.forEach((pet) => {
    pet.update();
    pet.draw(ctx);
  });
  requestAnimationFrame(animate);
}
```

> **Note:** The pet now has gravity (`vy`) instead of a single hardcoded `floor`. Standing, walking, and jumping are all resolved against `world.platforms`, so the icons *are* the level. Building `world.platforms`/`world.obstacles` from the raw icon rects is covered in §3.C.

### C. Click-to-Look & Speech Bubble (Behavior #2)

When the user clicks the pet, it should **stop**, turn to *face the cursor* ("look at the user"), and pop a speech bubble with a random line from a preset list.

The challenge: the canvas runs with `set_ignore_cursor_events(true)` so clicks pass through to the real desktop. To still catch clicks *on the pet*, the Rust backend installs a global mouse-click listener and, when a click lands inside a pet's current bounding box, emits a `pet_clicked` event with the cursor position. (See §3.E for the Rust side.) This keeps full click-through everywhere except the few pixels the pet occupies.

```javascript
// Preset lines — edit freely. Stored in public/phrases.json so users can customize.
const PRESET_PHRASES = [
  "Hi there! 👋",
  "Need a break?",
  "I'm just vibing.",
  "Don't forget to drink water!",
  "Click my icons, I'll hop on them!",
  "Zzz... oh, you're back!",
];

// listen('pet_clicked', ({ payload }) => handleClick(payload.x, payload.y));
function handleClick(cursorX, cursorY) {
  const pet = petHitTest(cursorX, cursorY); // which pet was clicked
  if (!pet) return;
  pet.lookAt(cursorX);                 // face the cursor
  pet.say(pickRandom(PRESET_PHRASES)); // show bubble for a few seconds
}

// On the DesktopPet class:
lookAt(cursorX) {
  this.state = "LOOKING";
  this.vx = 0;                                   // stop moving
  this.facing = cursorX < this.x ? -1 : 1;       // turn toward the user
  this.lookUntil = performance.now() + 2500;     // resume AI after a beat
}

say(text) {
  this.bubble = { text, expires: performance.now() + 3500 };
}
```

The speech bubble itself is **not** drawn on the canvas — render it as a normal absolutely-positioned `<div>` in the React tree, tracking the pet's `x/y` each frame. HTML gives you free text wrapping, fonts, and rounded "tail" styling via Tailwind, and it sits above the canvas:

```jsx
{pets.map((p) => p.bubble && p.bubble.expires > now && (
  <div key={p.id}
    className="absolute bg-white text-sm px-3 py-2 rounded-2xl shadow-lg max-w-[180px]
               after:content-[''] after:absolute after:left-4 after:-bottom-2
               after:border-8 after:border-transparent after:border-t-white"
    style={{ left: p.x, top: p.y - 56 }}>
    {p.bubble.text}
  </div>
))}
```

### D. Behavior State Machine — Random AI (Behavior #3)

Left to itself, the pet picks a new action at random intervals: **walk left**, **walk right**, **jump** (which lets it hop onto icon tops), **idle**, or **sleep**. This is a lightweight "AI brain" layered on top of the physics in §2.B — physics still owns gravity, landing, and obstacle collision; the brain only chooses *intent*.

```javascript
const ACTIONS = ["WALKING_LEFT", "WALKING_RIGHT", "JUMPING", "IDLE", "SLEEP"];
// Weights bias toward calm wandering; sleep is rarer and longer.
const ACTION_WEIGHTS = { WALKING_LEFT: 3, WALKING_RIGHT: 3, JUMPING: 1, IDLE: 2, SLEEP: 1 };

class DesktopPet {
  // ...existing physics fields...
  decideNextAction(now) {
    // Don't interrupt LOOKING (user clicked) or an in-air JUMPING/FALLING.
    if (this.state === "LOOKING" && now < this.lookUntil) return;
    if (this.state === "FALLING" || this.state === "JUMPING") return;
    if (now < this.nextDecisionAt) return;

    const next = weightedRandom(ACTION_WEIGHTS);
    this.state = next;
    if (next === "JUMPING") this.vy = -12;        // hop — may land on an icon top
    if (next === "WALKING_LEFT") this.facing = -1;
    if (next === "WALKING_RIGHT") this.facing = 1;

    // Sleep lingers; everything else is a short burst.
    const dwell = next === "SLEEP" ? rand(6000, 12000) : rand(1200, 4000);
    this.nextDecisionAt = now + dwell;
  }
}
```

- **Walk left / right** → drives the existing `WALKING_*` branch in `update()`; the pet still falls off platform edges and is blocked by obstacle sides.
- **Jump onto icons** → a `JUMPING` impulse plus horizontal drift means a hop near an icon naturally lands the pet on that icon's top platform (resolved by `groundBeneath`). The `tryJumpOrTurn` helper already hops when it walks into an icon side, so the pet *also* climbs icons opportunistically.
- **Sleep** → sets `state="SLEEP"`, zeroes velocity, and plays the `sleep` animation row (§6) until the dwell timer expires. A click (Behavior #2) wakes it early via `lookAt`.
- The animation row shown is derived from `state`: `WALKING_* → walk`, `JUMPING/FALLING → idle (or a jump row if you draw one)`, `IDLE → idle`, `SLEEP → sleep`, `LOOKING → idle` while facing the cursor.

---

## 3. Backend Architecture & OS Configuration (Rust/Tauri)

### A. Window Configuration (`tauri.conf.json`)

You must configure the webviews to allow transparency and remove OS borders.

```json
"windows": [
  {
    "label": "pet-window",
    "url": "pet.html",
    "transparent": true,
    "decorations": false,
    "alwaysOnTop": true,
    "skipTaskbar": true,
    "visible": false
  },
  {
    "label": "dashboard",
    "url": "index.html",
    "title": "Pet Settings",
    "width": 600,
    "height": 500
  }
]
```

### B. The Rust Bridge (`main.rs`)

Rust handles the specific OS APIs needed for a seamless experience:

1. **Click-Through:** A transparent window still blocks mouse clicks by default. In your Rust initialization, apply `window.set_ignore_cursor_events(true)` to the `pet-window`. This makes the canvas "ghostly," allowing users to click their actual desktop icons underneath.
2. **Event Broadcasting:**

```rust
#[tauri::command]
fn save_settings(settings: SettingsPayload, app_handle: tauri::AppHandle) {
    // Write to local disk using std::fs
    // Broadcast to the frontend canvas
    app_handle.emit_all("settings_updated", settings).unwrap();
}
```

### C. The Icon Scanner (Reading Desktop Icon Positions)

This is the core of the "Icons as Playground" feature. The transparent canvas has **no knowledge of where the real desktop icons sit** — that information lives in the OS shell. The Rust backend is responsible for querying it and streaming it to the canvas.

#### Shared Payload Shape

Rust normalizes every platform's result into one struct so the frontend never has to branch on OS:

```rust
#[derive(Clone, serde::Serialize)]
struct IconRect {
    x: i32,      // Left, in screen pixels (must match canvas coordinate space)
    y: i32,      // Top
    w: i32,      // Icon cell width
    h: i32,      // Icon cell height
    label: String, // Optional: icon name, useful for debugging / fun captions
}
```

#### Windows — Enumerate the Desktop ListView (`SysListView32`)

On Windows the desktop icons live inside a `SysListView32` control hosted by the `Progman`/`WorkerW` window. You read each icon's bounding box with `LVM_GETITEMRECT`. Because the ListView belongs to Explorer (another process), the coordinates must be marshalled across the process boundary with shared memory (`VirtualAllocEx` + `WriteProcessMemory`/`ReadProcessMemory`). Use the `windows` crate:

```rust
// Pseudocode outline — see the `windows` crate for exact signatures.
// 1. FindWindow("Progman", "Program Manager") -> find child "SHELLDLL_DefView"
//    -> find child "SysListView32"  (handle the WorkerW fallback for active wallpaper)
// 2. count = SendMessage(hList, LVM_GETITEMCOUNT, 0, 0)
// 3. Open Explorer's process, allocate a RECT in ITS address space.
// 4. For each i in 0..count:
//      write RECT{left: LVIR_BOUNDS} into remote memory
//      SendMessage(hList, LVM_GETITEMRECT, i, remote_rect_ptr)
//      ReadProcessMemory -> local RECT
//      (optionally LVM_GETITEMTEXT for the label)
// 5. Convert client coords to screen coords (ClientToScreen) and push IconRect.
```

> Coordinate gotcha: ListView rects are client-relative. Convert with `ClientToScreen`, and on multi-monitor / high-DPI setups make the process **Per-Monitor DPI aware** so icon pixels line up 1:1 with the canvas (which is also a per-monitor-aware Tauri window).

#### macOS — Query Finder via AppleScript / Apple Events

macOS has no public icon-geometry API, but Finder exposes `desktop` icon positions through its scripting dictionary. Run an AppleScript (via `osascript` as a child process, or the `objc`/`cocoa` crates) and parse the result:

```applescript
tell application "Finder"
  set out to ""
  repeat with f in (get items of desktop)
    set p to desktop position of f       -- {x, y} of the icon's center/anchor
    set out to out & (name of f) & "," & (item 1 of p) & "," & (item 2 of p) & "\n"
  end repeat
  return out
end tell
```

Finder reports the icon **anchor**, not a full rect, so add the standard icon-grid cell size (icon size + label gutter, e.g. ~80×96 at default settings) to synthesize `w`/`h`. The result still needs translation from Finder's desktop coordinate origin into global screen coordinates.

#### Why Polling (and an Event-Driven Refresh)

Neither OS gives a reliable "an icon moved" notification, so the scanner runs on a timer in a background thread and only emits when the set actually changes (diff against the last snapshot to avoid waking the canvas needlessly). The dashboard's **"Re-scan Icons Now"** button and an OS resolution-change listener force an immediate refresh.

```rust
// Spawn once at startup. Honors `iconScanIntervalMs` from settings.
fn start_icon_scanner(app_handle: tauri::AppHandle, interval_ms: u64) {
    std::thread::spawn(move || {
        let mut last: Vec<IconRect> = Vec::new();
        loop {
            let icons = read_desktop_icons(); // Win or Mac impl above
            if icons != last {
                app_handle.emit_all("icons_updated", &icons).unwrap();
                last = icons;
            }
            std::thread::sleep(std::time::Duration::from_millis(interval_ms));
        }
    });
}

#[tauri::command]
fn rescan_icons(app_handle: tauri::AppHandle) {
    let icons = read_desktop_icons();
    app_handle.emit_all("icons_updated", &icons).unwrap();
}
```

#### Frontend: Building the Playground from Raw Rects

The canvas turns each `IconRect` into collision geometry according to the user's `iconRole` setting:

```javascript
function buildPlatforms(iconRects) {
  world.platforms = [];
  world.obstacles = [];
  for (const r of iconRects) {
    if (settings.iconRole !== "obstacle") {
      // The TOP edge is a thin standable platform.
      world.platforms.push({ x: r.x, y: r.y, w: r.w, h: 4 });
    }
    if (settings.iconRole !== "platform") {
      // The full box blocks horizontal movement.
      world.obstacles.push({ x: r.x, y: r.y, w: r.w, h: r.h });
    }
  }
}
```

Because the canvas window is full-screen, transparent, and aligned to the same screen origin as the OS desktop, an `IconRect` at `(x, y)` lands exactly on top of the real icon the user sees — the pet appears to physically stand on it.

### D. Autostart — Launch on Startup (Behavior #1)

Don't hand-roll registry edits — Tauri ships an official plugin, **`tauri-plugin-autostart`**, that does the right thing per OS:

- **Windows:** writes a value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
- **macOS:** registers a Launch Agent.
- **Linux:** drops a `.desktop` file in `~/.config/autostart`.

```rust
// Cargo.toml:  tauri-plugin-autostart = "2"
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]), // launch silently into the tray on boot
        ))
        .invoke_handler(tauri::generate_handler![
            set_autostart, is_autostart_enabled, /* ...other commands... */
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    if enabled { mgr.enable() } else { mgr.disable() }.map_err(|e| e.to_string())
}

#[tauri::command]
fn is_autostart_enabled(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}
```

When launched with `--minimized` on boot, skip showing the dashboard — only spawn the transparent pet window and a tray icon, so the pet just "appears" without a window popping up in the user's face.

### E. Forwarding Clicks on the Pet (Behavior #2)

Because the canvas uses `set_ignore_cursor_events(true)`, the webview never receives clicks. Catch them at the OS level and forward only the ones that hit a pet:

1. The canvas tells Rust where each pet currently is via a throttled `invoke('update_pet_bounds', { rects })` (a few times per second is plenty — these are coarse hit-boxes, not per-frame).
2. Rust runs a lightweight global mouse hook (Windows `SetWindowsHookEx`/`WH_MOUSE_LL`, macOS `CGEventTap`).
3. On a left-click whose screen coords fall inside a stored pet rect, Rust emits `pet_clicked { x, y }` to the canvas — which runs `handleClick` from §2.C.

```rust
// Outline. Keep the hook callback tiny; do real work on a channel.
#[tauri::command]
fn update_pet_bounds(rects: Vec<IconRect>, state: tauri::State<PetBounds>) {
    *state.0.lock().unwrap() = rects; // shared with the mouse-hook thread
}
// In the hook: if click ∈ any rect -> app_handle.emit_all("pet_clicked", Pos{x,y})
```

> Alternative (simpler) approach: instead of a global hook, briefly toggle `set_ignore_cursor_events(false)` only over the pet's bounding box. This is fiddlier to keep in sync at 60 FPS, so the global-hook route above is recommended.

### F. Taskbar Floor — Lowest Walkable Level (Behavior #4)

The pet must never walk *below the top of the taskbar*. The reliable cross-platform measure is the monitor's **work area** (the screen minus taskbar/dock/panels). Its bottom edge is exactly the taskbar top.

- **Windows:** `SystemParametersInfo(SPI_GETWORKAREA, ...)` returns the work-area RECT; `work_area.bottom` is the taskbar top. (Or `SHAppBarMessage(ABM_GETTASKBARPOS)` for the taskbar rect directly.)
- **macOS:** `NSScreen.visibleFrame` excludes the Dock and menu bar.
- **Cross-platform shortcut:** Tauri's `Monitor` exposes size and position; combine with the work-area call above for the inset.

Emit it to the canvas (and re-emit on resolution / taskbar changes), so `world.screenFloor` always tracks the real taskbar:

```rust
#[derive(Clone, serde::Serialize)]
struct FloorPayload { taskbar_top: i32 }

fn emit_floor(app: &tauri::AppHandle) {
    let taskbar_top = work_area_bottom(); // SPI_GETWORKAREA on Windows, visibleFrame on mac
    app.emit_all("floor_updated", FloorPayload { taskbar_top }).unwrap();
}
```

The frontend already listens for `floor_updated` (§2.B) and clamps `world.screenFloor` to `taskbar_top`. `groundBeneath` returns this value when no icon platform is under the pet, so plain ground-walking happens on the taskbar's top edge — never lower.

---

## 4. Memory Management and Scaling

- **Sprite Caching:** Load the `.png` sprite sheet into memory exactly once. Pass the same `Image` reference to every instance of the `DesktopPet` class.
- **Garbage Collection:** If a user reduces the pet count from 5 to 2, splice the removed pets entirely out of your JavaScript array so the garbage collector clears them from RAM.
- **Suspend on Fullscreen:** Consider checking screen bounds to pause the `requestAnimationFrame` loop if the user opens a full-screen game over your pets, saving CPU cycles. (Also pause the Icon Scanner thread while suspended.)
- **Icon Snapshot, Not Per-Frame Queries:** Never query the OS for icon positions inside the render loop — that would tank performance and hammer Explorer/Finder. The scanner caches a single snapshot in `world.platforms`/`world.obstacles` and the loop only reads it. The OS is touched at most once per `iconScanIntervalMs`.
- **Diff Before Emit:** The scanner compares each new scan against the previous snapshot and emits `icons_updated` only on change, so a static desktop produces zero IPC traffic.
- **Click-Through Stays Intact:** Even though pets now interact with icons, the canvas keeps `set_ignore_cursor_events(true)`. The pet's "collision" with an icon is purely visual/physics inside the canvas — the user can still click straight through to the real icon underneath.

---

## 5. File Structure

Your project tree should look like this:

```text
my-desktop-pet/
├── src-tauri/                 # Rust backend code (Tauri)
│   ├── tauri.conf.json        # Window settings (transparent, alwaysOnTop)
│   └── src/
│       └── main.rs            # Rust entry point (handles OS click-through)
│
├── public/                    # 🟢 STATIC ASSETS (Served at the root '/')
│   ├── sprites/               # Put all your transparent PNGs here
│   │   ├── cat_calico.png
│   │   ├── dog_golden.png
│   │   └── fox_autumn.png
│   ├── phrases.json           # Preset speech-bubble lines (Behavior #2)
│   └── default_settings.json  # Fallback settings (incl. launchOnStartup) 
│
├── src/                       # 🔵 FRONTEND CODE (React + Tailwind)
│   ├── dashboard/             # The Settings UI Application
│   │   ├── Dashboard.jsx      # Main layout (Dropdowns, sliders)
│   │   └── Dashboard.css      # Tailwind imports
│   │
│   ├── pet-canvas/            # The Transparent Overlay Application
│   │   ├── CanvasApp.jsx      # Full-screen transparent React container
│   │   └── PetEngine.js       # Pure JS class that draws on the <canvas>
│   │
│   ├── index.html             # Entry point for the Dashboard window
│   └── pet.html               # Entry point for the Transparent Canvas window
│
├── package.json               # Node dependencies
└── vite.config.js             # Frontend bundler configuration

```

### Why use the `public` folder?

If you place your images in the `src/assets` folder, React bundlers (like Vite or Webpack) will hash the filenames for caching (e.g., `cat_calico.8f7d6a.png`), which makes it very difficult to dynamically load the right image when a user selects a new pet from a dropdown.

By placing them in the `public/sprites/` folder, the paths remain static. In your React code or JavaScript engine, you can reference them predictably:

```javascript
// Example: Creating a new pet instance based on user settings
const userSelectedAnimal = "cat";
const userSelectedColor = "calico";

// Because it is in the public folder, the path is straightforward:
const spriteSheetUrl = `/sprites/${userSelectedAnimal}_${userSelectedColor}.png`;

const spriteImage = new Image();
spriteImage.src = spriteSheetUrl;

// Wait for the image to load before starting the animation loop
spriteImage.onload = () => {
  const myPet = new DesktopPet(startX, startY, spriteImage, petSettings);
  // start animation loop...
};
```

This structure cleanly separates your customization UI (`dashboard`), your core animation logic (`pet-canvas`), and your static visual assets (`public`), making it highly scalable as you add more animals and features.

---

## 6. Animating Sprites

In game development, you keep this as **one single PNG file** (after removing the green background). Your animation engine will dynamically "slice" the image on the fly using pixel coordinates.

Here is exactly how to set up your files and write the code so your desktop pet knows exactly what action to perform.

---

### 1. Map Out the Sprite Sheet Grid

Because the sprite sheets are a perfect **4x4 grid**, the math becomes incredibly simple.

First, look at the properties of your saved transparent PNG:

- **Total Width:** Let's assume it is 400 pixels wide.
- **Total Height:** Let's assume it is 400 pixels wide.
- **Frame Width:** $400 \text{ pixels} / 4 \text{ columns} = 100 \text{ pixels}$ per frame.
- **Frame Height:** $400 \text{ pixels} / 4 \text{ rows} = 100 \text{ pixels}$ per frame.

Next, we assign each row to an **Action Index** (starting from 0):

- **Row 0 (Top):** `IDLE` (Frames 0 to 3)
- **Row 1:** `WALK` (Frames 0 to 3)
- **Row 2:** `SPECIAL` / `SLEEP` (Frames 0 to 1 = Sitting, Frames 2 to 3 = Sleeping)
- **Row 3 (Bottom):** `CELEBRATE` (Frames 0 to 3)

---

### 2. Structure Your Animation Configuration

In your frontend code, you will define an "Animation Map" configuration object. This tells your engine exactly which row to look at and how many frames exist for that specific action.

```javascript
const BUNNY_ANIM_MAP = {
  idle: { row: 0, totalFrames: 4, loop: true },
  walk: { row: 1, totalFrames: 4, loop: true },
  sit: { row: 2, totalFrames: 2, loop: false },
  sleep: { row: 2, totalFrames: 2, startFrame: 2, loop: true }, // Starts at frame index 2
  celebrate: { row: 3, totalFrames: 4, loop: false },
};
```

---

### 3. The Canvas Slicing Math

When using the HTML5 Canvas API inside your `PetEngine.js`, the `ctx.drawImage()` method allows you to pass 9 parameters. The first 4 parameters dictate the "Source Crop" (where on your sprite sheet to cut), and the next 4 dictate the "Destination" (where on the computer screen to draw it).

```javascript
ctx.drawImage(
  image,
  sourceX,
  sourceY,
  sourceWidth,
  sourceHeight, // Where to cut from the sheet
  destX,
  destY,
  destWidth,
  destHeight, // Where to draw on the desktop
);
```

To calculate `sourceX` and `sourceY` automatically based on the pet's current state, you use this formula:

- **`sourceX = currentFrameIndex * frameWidth`**
- **`sourceY = rowOfCurrentAction * frameHeight`**

---

### 4. Putting It Together in the Pet Class

Here is how your `DesktopPet` JavaScript class manages this state machine dynamically:

```javascript
class DesktopPet {
  constructor(imgElement) {
    this.img = imgElement; // The loaded transparent PNG
    this.frameWidth = 100; // Adjust based on your actual image size / 4
    this.frameHeight = 100;

    // State management
    this.currentAction = "walk";
    this.currentFrame = 0;

    // Screen position
    this.x = 200;
    this.y = window.innerHeight - this.frameHeight;

    // Frame switching timer
    this.tick = 0;
    this.speed = 8; // How many game loops to wait before changing frames
  }

  update() {
    this.tick++;

    // Get the rules for the current action
    const config = BUNNY_ANIM_MAP[this.currentAction];

    // Cycle the animation frame
    if (this.tick >= this.speed) {
      this.tick = 0;
      this.currentFrame++;

      if (this.currentFrame >= config.totalFrames) {
        if (config.loop) {
          this.currentFrame = 0;
        } else {
          // If the action shouldn't loop (like jumping), return to idle
          this.currentAction = "idle";
          this.currentFrame = 0;
        }
      }
    }

    // Move the pet across the screen if walking
    if (this.currentAction === "walk") {
      this.x += 1; // Move right
    }
  }

  draw(context) {
    const config = BUNNY_ANIM_MAP[this.currentAction];

    // Determine the offset if an action doesn't start at column 0 (like sleeping)
    const startOffset = config.startFrame || 0;

    // Calculate exact pixel cutouts
    const sourceX = (this.currentFrame + startOffset) * this.frameWidth;
    const sourceY = config.row * this.frameHeight;

    context.drawImage(
      this.img,
      sourceX,
      sourceY,
      this.frameWidth,
      this.frameHeight, // Source crop
      this.x,
      this.y,
      this.frameWidth,
      this.frameHeight, // Screen position
    );
  }
}
```

#### Pro-Tip for Walk Reversing:

Notice that the walking frames only point **Right**. You do not need to generate a "Walk Left" row!

When your bunny decides to wander left, you can use Canvas utility features directly in your draw loop to flip the image horizontally before rendering it:

```javascript
// To face left:
context.save();
context.translate(this.x + this.frameWidth, this.y);
context.scale(-1, 1); // Flips the context canvas horizontally
context.drawImage(
  this.img,
  sourceX,
  sourceY,
  this.frameWidth,
  this.frameHeight,
  0,
  0,
  this.frameWidth,
  this.frameHeight,
);
context.restore();
```

---

## 7. Local Development & Testing

### Prerequisites (one-time setup)

| Tool | Why | Install |
|------|-----|---------|
| **Node.js** (LTS, ≥18) | Frontend tooling / Vite | https://nodejs.org |
| **Rust** (stable) | Tauri backend | https://rustup.rs |
| **Tauri prerequisites** | OS webview + build tools | See below per-OS |

**Windows prerequisites:**
- **Microsoft C++ Build Tools** (the "Desktop development with C++" workload) — required to compile Rust.
- **WebView2 Runtime** — preinstalled on Windows 11. Tauri uses it instead of bundling a browser.

**macOS prerequisites:**
- **Xcode Command Line Tools:** `xcode-select --install`

> Sanity check after install: `node -v`, `rustc --version`, and `cargo --version` should all print versions.

### First-time project setup

```bash
# From the project root (my-desktop-pet/)
npm install                       # install React, Tailwind, Vite, @tauri-apps/api
cargo install tauri-cli           # or use the bundled `npm run tauri` script
```

Make sure `src-tauri/Cargo.toml` includes the plugins this design uses:

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-autostart = "2"      # Behavior #1
windows = "0.x"                   # Win32: icon scanner, work area, mouse hook (Windows only)
```

### Run in dev mode (hot reload)

```bash
npm run tauri dev
```

This launches Vite for the React frontend **and** compiles/runs the Rust backend, with hot-reload on frontend changes. The transparent pet window and the dashboard both open.

### Testing tips specific to this app

- **Transparency / click-through:** Verify you can still click real desktop icons *through* the pet. If clicks are blocked, `set_ignore_cursor_events(true)` isn't being applied to `pet-window`.
- **Icons-as-platforms:** Move a desktop icon, hit **"Re-scan Icons Now"**, and confirm the pet lands on its new position. Toggle `iconRole` between platform/obstacle/mixed.
- **Taskbar floor (Behavior #4):** Move the taskbar to the top/side of the screen, or auto-hide it, then confirm `floor_updated` re-fires and the pet's lowest walk line follows. Test at 125%/150% display scaling (DPI) — icon and floor pixels must line up.
- **Click + speech bubble (Behavior #2):** Click directly on the pet; it should stop, face the cursor, and show a bubble. Click empty desktop; nothing should trigger.
- **Random AI (Behavior #3):** Leave it running a few minutes — you should see it walk, hop onto icons, idle, and occasionally sleep.
- **Autostart (Behavior #1):** Toggle "Launch on startup", then check the OS:
  - Windows: `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run"` — your app should appear/disappear.
  - macOS: look in System Settings → General → Login Items.
  Then reboot to confirm it actually launches minimized.
- **Multi-monitor:** Drag the pet window across monitors; confirm icon coords and floor stay correct (per-monitor DPI awareness must be on).
- **Debugging the canvas:** Right-click the pet window → Inspect (dev builds enable the webview devtools) to see console logs from the game loop.

---

## 8. Building & Distributing the `.exe`

### Build a production installer

```bash
npm run tauri build
```

Tauri compiles an optimized release binary and packages OS-native installers. Output lands in:

```text
src-tauri/target/release/
├── desktop-pet.exe                         # the raw standalone executable
└── bundle/
    ├── msi/   desktop-pet_1.0.0_x64_en-US.msi    # Windows MSI installer
    └── nsis/  desktop-pet_1.0.0_x64-setup.exe    # Windows NSIS setup .exe
```

> The **raw `desktop-pet.exe`** in `target/release/` is what most people mean by "send the .exe" — it runs on its own (the user needs the WebView2 runtime, which is already on Windows 10/11). The **NSIS `*-setup.exe`** is the friendlier choice for a real install: it adds a Start-menu entry, supports uninstall, and can wire up autostart cleanly.

Configure which bundles to produce and metadata (name, version, icons) in `src-tauri/tauri.conf.json`:

```json
{
  "productName": "Desktop Pet",
  "version": "1.0.0",
  "bundle": {
    "active": true,
    "targets": ["nsis", "msi"],
    "icon": ["icons/icon.ico", "icons/icon.png"],
    "windows": {
      "webviewInstallMode": { "type": "downloadBootstrapper" }
    }
  }
}
```

`downloadBootstrapper` makes the installer fetch WebView2 automatically on the rare machine that lacks it, so recipients never hit a "missing runtime" error.

### Two ways to give it to people

**A. Send the file directly (simplest)**
- Hand someone the **`*-setup.exe`** (NSIS) — double-click installs it.
- Or send the **raw `desktop-pet.exe`** for a no-install, run-it-anywhere copy.
- ⚠️ **SmartScreen warning:** Unsigned executables trigger Windows "Unknown publisher" / SmartScreen prompts. Users click *More info → Run anyway*. To remove the warning you need a **code-signing certificate** (a paid yearly cert from a CA); sign with `signtool` and set `bundle.windows.certificateThumbprint` in the config. Optional for friends, expected for a public release.

**B. Make it downloadable from a website**
1. **GitHub Releases (free, recommended):** tag a release and upload the `.msi`/`setup.exe`. GitHub gives you a permanent download URL you can link with a "Download for Windows" button.
   - You can automate this with **GitHub Actions** — the official `tauri-apps/tauri-action` builds the installers on a Windows runner and attaches them to the release on every tag, so you never build manually. (It can also cross-build macOS `.dmg` / Linux `.AppImage`/`.deb` from the same workflow.)
2. **Your own site:** host the installer file (or link to the GitHub Release asset) behind a download button:
   ```html
   <a href="https://github.com/<you>/desktop-pet/releases/latest/download/desktop-pet_1.0.0_x64-setup.exe"
      class="download-btn">⬇️ Download for Windows</a>
   ```
3. **Auto-updates (optional, nice-to-have):** Tauri's **updater plugin** can check a JSON manifest you host (e.g. on the same GitHub Release) and self-update installed copies — worth adding before a wide release so users aren't stuck on old versions.

### Cross-platform note
You can only build a Windows `.exe` **on Windows** (and a macOS `.dmg` on macOS, signed with an Apple Developer cert for distribution). The GitHub Actions route in **B.1** is the clean way to produce installers for every OS without owning every machine.

### Release checklist
- [ ] App icon set (`src-tauri/icons/`) — run `npm run tauri icon path/to/logo.png` to generate all sizes.
- [ ] `productName`, `version`, and `identifier` set in `tauri.conf.json`.
- [ ] `npm run tauri build` succeeds and the installer launches on a clean machine.
- [ ] Autostart toggle verified after install (Behavior #1).
- [ ] (Public release) Code signing configured to avoid SmartScreen.
- [ ] Download link points at the GitHub Release asset (or your CDN).
