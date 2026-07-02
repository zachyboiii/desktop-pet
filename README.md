# 🐾 Desktop Pet

A transparent desktop companion (Tauri + React) that walks on your real desktop
icons, sleeps, and chats when clicked. See [design.md](design.md) for the full
architecture.

## Features

1. **Launch on startup** — toggle in the Settings dashboard.
2. **Click to interact** — click the pet; it stops, looks at you, and shows a
   random speech bubble (edit `public/phrases.json`).
3. **Random AI** — wanders left/right, jumps onto desktop icons, and sleeps.
4. **Taskbar-top floor** — the pet never walks below the top of the taskbar.

> **Windows** and **macOS** are fully supported (icon scanner, taskbar/Dock
> floor, click forwarding). **Linux** runs, but the pet walks on the screen
> floor without icon platforms.

## Getting started

### 1. Prerequisites (all platforms)

- **Git** — https://git-scm.com
- **Node.js** ≥ 18 — https://nodejs.org (check with `node --version`)
- **Rust** (stable) — https://rustup.rs (check with `cargo --version`)

**Windows additionally needs:**

- **Microsoft C++ Build Tools** — install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  and select the **"Desktop development with C++"** workload.
- **WebView2** — preinstalled on Windows 11 and updated Windows 10; otherwise it
  is downloaded automatically by the installer.

**macOS additionally needs:**

- **Xcode Command Line Tools** — run `xcode-select --install` in Terminal.

### 2. Clone and run in dev mode

```bash
git clone <REPO_URL>        # or unzip the project folder you were sent
cd desktop-pet
npm install
npm run tauri dev
```

The first run compiles the Rust side and takes a few minutes; later runs are
fast. The pet appears on your desktop and a Settings window opens.

**macOS first-run permissions** (both are per-app and remembered):

1. macOS asks *"Desktop Pet wants to control Finder"* — click **Allow**, or the
   pet gets no icon platforms and just walks on the Dock floor.
2. Grant **System Settings → Privacy & Security → Accessibility** (and, if
   listed, **Input Monitoring**) to the app, then relaunch — without it the
   global mouse hook can't install and the pet is watch-only (no click/drag).

## Build a distributable installer

One command on both platforms:

```bash
npm run tauri build
```

You must build **on the OS you're targeting** — Windows builds can't produce a
`.dmg` and Macs can't produce an `.exe` (Apple's toolchain only runs on macOS).

### Windows → `.exe`

Output lands in `src-tauri\target\release\bundle\`:

| File | What it is |
|---|---|
| `nsis\Desktop Pet_<version>_x64-setup.exe` | **Share this one.** Installer; creates a desktop shortcut + Start Menu entry. |
| `msi\Desktop Pet_<version>_x64_en-US.msi` | Alternative MSI installer (same app). |

Since the installer is unsigned, SmartScreen shows *"Windows protected your
PC"* on first run — click **More info → Run anyway**. The raw
`src-tauri\target\release\desktop-pet.exe` is not shareable on its own; always
send the `-setup.exe`.

### macOS → `.dmg`

Output lands in `src-tauri/target/release/bundle/`:

| File | What it is |
|---|---|
| `dmg/Desktop Pet_<version>_<arch>.dmg` | **Share this one.** Drag-to-Applications disk image. |
| `macos/Desktop Pet.app` | The raw app bundle inside the dmg. |

Since the app is unsigned/un-notarized, Gatekeeper blocks the first launch —
**right-click the app → Open → Open** (only needed once). A `.dmg` built on an
Apple Silicon Mac runs on Apple Silicon; build on an Intel Mac (or set up a
universal build) for Intel Macs.

## Generate sprites

Make clean, jitter-free pixel sprites (the smooth "test" look) with the bundled
generator:

```bash
# named palette
node tools/gen_sprite.mjs cat_pink pink

# custom hex: <name> <bodyHex> [earHex] [cheekHex]
node tools/gen_sprite.mjs robot_teal 33c9c9 145a5a ff8a8a

# regenerate the whole palette set (cat_yellow, cat_blue, ...)
node tools/gen_sprite.mjs all
```

Each call writes `public/sprites/<name>.png` as a 128×128, 4×4 sheet with a
**constant feet baseline** (no animation jitter) and small native pixels that
stay crisp when the engine upscales them with nearest-neighbor.

Built-in palettes: `yellow, pink, blue, green, purple, gray, orange, black`.

To show a new sprite in the dropdown, name it `type_color.png` and add one line
to the `PETS` array in [src/dashboard/Dashboard.jsx](src/dashboard/Dashboard.jsx).

### Using your own hand-drawn art instead

Drop a real **4×4 sheet** (rows: idle / walk / sit+sleep / celebrate) named
`type_color.png`. For smooth animation, draw every frame with the creature's
**feet on the same row** and **centered horizontally** — that consistency is what
makes the generated sprites look smooth. See design.md §6.
