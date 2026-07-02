import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  PetEngine,
  buildPlatforms,
  rebuildPlatforms,
  setFloor,
  setDesktopActive,
  setSettings,
  getSettings,
} from "./PetEngine.js";

// Fallback phrases if public/phrases.json is missing.
const FALLBACK_PHRASES = [
  "Hi there! 👋",
  "Need a break?",
  "I'm just vibing.",
  "Don't forget to drink water!",
  "Click my icons, I'll hop on them!",
  "Zzz... oh, you're back!",
];

export default function CanvasApp() {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const lastBoundsSent = useRef("");
  const lastCursorRef = useRef(null);
  // Speech bubbles rendered as HTML, refreshed each frame via onFrame.
  const [bubbles, setBubbles] = useState([]);

  useEffect(() => {
    const engine = new PetEngine(canvasRef.current);
    engineRef.current = engine;
    engine.resize();
    const windowHandle = getCurrentWindow();
    const setCursor = async (cursor) => {
      if (lastCursorRef.current === cursor) return;
      lastCursorRef.current = cursor;
      // WebView2 picks the cursor from the hovered DOM element, so the CSS
      // cursor is what actually shows; setCursorIcon is kept as a fallback.
      document.body.style.cursor = cursor;
      try {
        await windowHandle.setCursorIcon(cursor);
      } catch {
      }
    };

    // Each frame: collect active bubbles + throttle pet-bounds to Rust.
    engine.onFrame = (pets, now) => {
      const active = pets
        .filter((p) => p.bubble && p.bubble.expires > now)
        .map((p) => ({ id: p.id, text: p.bubble.text, x: p.x, y: p.y }));
      setBubbles((prev) => {
        // Avoid re-render churn when nothing relevant changed.
        if (prev.length === 0 && active.length === 0) return prev;
        return active;
      });

      // Report hit-boxes to Rust every frame they change (Behavior #2,
      // design.md §3.E). visibleRect() hugs the drawn pixels of the current
      // frame, so only the sprite itself responds to the cursor — not the
      // transparent padding of the sheet cell.
      // The mouse hook compares against PHYSICAL cursor pixels, so convert
      // from CSS pixels here or clicks miss the pet at 125%/150% DPI scaling.
      const dpr = window.devicePixelRatio || 1;
      const rects = pets.map((p) => {
        const r = p.visibleRect();
        return {
          x: Math.round(r.x * dpr),
          y: Math.round(r.y * dpr),
          w: Math.round(r.w * dpr),
          h: Math.round(r.h * dpr),
          label: "pet",
        };
      });
      const boundsKey = JSON.stringify(rects);
      if (boundsKey !== lastBoundsSent.current) {
        lastBoundsSent.current = boundsKey;
        invoke("update_pet_bounds", { rects }).catch(() => {});
      }
    };

    // Load preset phrases.
    fetch("/phrases.json")
      .then((r) => r.json())
      .then((list) => engine.setPhrases(list))
      .catch(() => engine.setPhrases(FALLBACK_PHRASES));

    // Load current settings, then spawn pets and start the loop.
    invoke("get_settings")
      .then((cfg) => {
        if (cfg) setSettings(cfg);
      })
      .catch(() => {})
      .finally(() => {
        engine.syncPets(getSettings().count || 1);
        engine.start();
        // Ask backend for an initial icon + floor snapshot.
        invoke("rescan_icons").catch(() => {});
        invoke("rescan_floor").catch(() => {});
        invoke("is_desktop_active")
          .then(setDesktopActive)
          .catch(() => {});
      });

    // ---- Tauri event wiring ----
    // Keep the *promises*, not just resolved unlisten fns: with StrictMode's
    // mount→cleanup→mount cycle, listen() resolves after the first cleanup
    // has already run, which used to leak ghost listeners bound to a dead
    // engine (they fought the live one over the cursor).
    const listenerPromises = [];

    // Drag & drop / click, driven by the Rust mouse hook. Hook coords are
    // physical pixels; the engine works in CSS pixels.
    const toCss = (payload) => {
      const dpr = window.devicePixelRatio || 1;
      return [payload.x / dpr, payload.y / dpr];
    };
    listenerPromises.push(
      listen("icons_updated", ({ payload }) => {
        buildPlatforms(payload || []);
      }),
      listen("floor_updated", ({ payload }) => {
        setFloor(payload?.taskbar_top ?? payload?.taskbarTop);
      }),
      listen("desktop_state_updated", ({ payload }) => {
        setDesktopActive(payload?.active ?? true);
      }),
      listen("settings_updated", ({ payload }) => {
        setSettings(payload);
        engine.syncPets(getSettings().count || 1);
        rebuildPlatforms(); // iconRole / useIconsAsPlatforms may have changed
      }),
      listen("pet_mouse_down", ({ payload }) => {
        const [cx, cy] = toCss(payload);
        if (engine.handleMouseDown(cx, cy)) {
          setCursor("grabbing");
        } else {
          setCursor(engine.getCursorForPoint(cx, cy));
        }
      }),
      listen("pet_mouse_move", ({ payload }) => {
        const [cx, cy] = toCss(payload);
        engine.handleMouseMove(cx, cy);
        setCursor(engine.getCursorForPoint(cx, cy));
      }),
      listen("pet_mouse_up", ({ payload }) => {
        const [cx, cy] = toCss(payload);
        engine.handleMouseUp(cx, cy);
        setCursor(engine.getCursorForPoint(cx, cy));
      }),
    );

    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);

    return () => {
      engine.stop();
      window.removeEventListener("resize", onResize);
      setCursor("default");
      // Unlisten once each registration resolves, even if cleanup runs first.
      listenerPromises.forEach((p) => p.then((u) => u()).catch(() => {}));
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 select-none">
      <canvas
        ref={canvasRef}
        className="fixed inset-0"
        style={{ imageRendering: "pixelated" }}
      />
      {bubbles.map((b) => (
        <div
          key={b.id}
          className="absolute rounded-2xl bg-white px-3 py-2 text-sm text-gray-800 shadow-lg
                     max-w-[180px] after:absolute after:left-4 after:-bottom-2 after:border-8
                     after:border-transparent after:border-t-white after:content-['']"
          style={{
            left: Math.max(4, Math.min(b.x, window.innerWidth - 190)),
            top: Math.max(4, b.y - 56),
          }}
        >
          {b.text}
        </div>
      ))}
    </div>
  );
}
