# desktop-pet

Transparent desktop companion built with Tauri 2 + React 18 + Tailwind. The pet walks on real desktop icons, sleeps, and shows speech bubbles when clicked. Full architecture in `design.md`.

## Stack & layout
- Frontend: React 18, Vite, Tailwind 3 (`src/`, `index.html`, `pet.html`).
- Native shell: Tauri 2 (`src-tauri/` — Rust; icon scanner, taskbar floor, click forwarding).
- `public/phrases.json` — editable speech-bubble phrases.
- `scripts/`, `tools/` — build/asset helpers (jimp for image processing).

## Commands
- `npm run dev` — Vite dev server (web preview only).
- `npm run tauri dev` — run the actual desktop app (requires Rust stable).
- `npm run tauri build` — production bundle.

## Working notes
- Global working principles apply from `~/.claude/CLAUDE.md`.
- Platform behavior differs: Windows/macOS support icon platforms and taskbar/Dock floor; Linux falls back to screen-floor only. Guard platform-specific code accordingly.
- Read `design.md` before changing pet behavior/state-machine logic — the animation and physics rules are specified there.
- Changes to window transparency, click-through, or always-on-top live in `src-tauri/` config, not React.
