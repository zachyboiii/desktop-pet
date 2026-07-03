import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Available sprites in public/sprites/ ({type}_{color}.png). Each entry maps to
// a real file, so the dropdown can never produce a missing-sprite combo.
const PETS = [
  { type: "cat", color: "orange", label: "Cat (orange)" },
  { type: "cat", color: "gray", label: "Cat (gray)" },
  { type: "cat", color: "yellow", label: "Cat (yellow, collar)" },
  { type: "dog", color: "darkbrown", label: "Dog (shepherd)" },
  { type: "dog", color: "brown", label: "Dog (shiba)" },
  { type: "dog", color: "cream", label: "Dog (cream puppy)" },
  { type: "dog", color: "husky", label: "Dog (husky)" },
  { type: "slime", color: "green", label: "Slime (green)" },
  { type: "bunny", color: "white", label: "Bunny (white & grey)" },
  { type: "sparky", color: "terracotta", label: "Sparky (Claude mascot)" },
];
const ICON_ROLES = [
  { value: "mixed", label: "Mixed (stand on tops, blocked by sides)" },
  { value: "platform", label: "Platform (stand on icon tops)" },
  { value: "obstacle", label: "Obstacle (walk around icons)" },
];
const CLICK_ACTIONS = [
  { value: "say", label: "Say something" },
  { value: "app", label: "Open an app" },
];
const MAX_PETS = 8;

// Per-type click-action defaults. Sparky ships wired to launch Claude Code in
// a terminal; everyone else chatters.
function actionDefaultsFor(type) {
  if (type === "sparky") {
    return {
      clickAction: "claude",
      phrase: "Launching Claude Code! 🚀",
      appCommand: "",
    };
  }
  return { clickAction: "say", phrase: "", appCommand: "" };
}

function newPet(type = "dog", color = "brown") {
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? `pet-${crypto.randomUUID()}`
      : `pet-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return { id, petType: type, petColor: color, ...actionDefaultsFor(type) };
}

const DEFAULTS = {
  pets: [],
  speed: 1.5,
  width: 80,
  height: 80,
  useIconsAsPlatforms: true,
  iconRole: "mixed",
  iconScanIntervalMs: 1500,
  launchOnStartup: false,
};

function Field({ label, children, hint }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-gray-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  );
}

// One roster entry: collapsible card with sprite, on-click action, and the
// action's inputs.
function PetRow({ pet, index, apps, expanded, onToggle, onChange, onRemove, canRemove }) {
  const spriteValue = `${pet.petType}_${pet.petColor}`;
  const spriteLabel =
    PETS.find((p) => p.type === pet.petType && p.color === pet.petColor)?.label ??
    spriteValue;
  // Sparky's click action is hardcoded to launching Claude Code — no choice.
  const isSparky = pet.petType === "sparky";
  // Keep a stale/custom command visible in the dropdown instead of silently
  // showing the wrong selection.
  const knownApp = apps.some((a) => a.path === pet.appCommand);

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={onToggle}
          className="flex flex-1 items-center gap-2 text-left text-sm font-semibold text-gray-700"
        >
          <span className="text-xs text-gray-400">{expanded ? "▾" : "▸"}</span>
          Pet #{index + 1}
          <span className="font-normal text-gray-400">— {spriteLabel}</span>
        </button>
        <button
          onClick={onRemove}
          disabled={!canRemove}
          className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-gray-300"
        >
          Remove
        </button>
      </div>

      {expanded && (
        <div className="grid grid-cols-1 gap-3 border-t border-gray-100 p-4 sm:grid-cols-2">
          <Field label="Sprite">
            <select
              className="w-full rounded border border-gray-300 p-2"
              value={spriteValue}
              onChange={(e) => {
                const [type, color] = e.target.value.split("_");
                const patch = { petType: type, petColor: color };
                // Sparky always gets its hardcoded Claude action; other types
                // adopt their defaults unless the user already customized
                // this pet's interaction.
                const untouched =
                  (pet.clickAction === "say" && !pet.phrase && !pet.appCommand) ||
                  pet.petType === "sparky";
                onChange(
                  type === "sparky" || untouched
                    ? { ...patch, ...actionDefaultsFor(type) }
                    : patch,
                );
              }}
            >
              {PETS.map((p) => (
                <option key={`${p.type}_${p.color}`} value={`${p.type}_${p.color}`}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>

          {isSparky ? (
            <Field label="On click">
              <div className="w-full rounded border border-gray-200 bg-gray-50 p-2 text-sm text-gray-600">
                Launches Claude Code in a terminal ✨
              </div>
            </Field>
          ) : (
            <Field label="On click">
              <select
                className="w-full rounded border border-gray-300 p-2"
                value={pet.clickAction}
                onChange={(e) => onChange({ clickAction: e.target.value })}
              >
                {CLICK_ACTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {!isSparky && pet.clickAction === "app" && (
            <Field label="App" hint="Apps from your Start Menu.">
              <select
                className="w-full rounded border border-gray-300 p-2"
                value={pet.appCommand}
                onChange={(e) => onChange({ appCommand: e.target.value })}
              >
                <option value="" disabled>
                  — choose an app —
                </option>
                {!knownApp && pet.appCommand && (
                  <option value={pet.appCommand}>Custom: {pet.appCommand}</option>
                )}
                {apps.map((a) => (
                  <option key={a.path} value={a.path}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field
            label={pet.clickAction === "say" ? "Phrase" : "Says while opening (optional)"}
            hint={
              pet.clickAction === "say"
                ? "Leave empty for a random phrase each click."
                : undefined
            }
          >
            <input
              type="text"
              className="w-full rounded border border-gray-300 p-2"
              value={pet.phrase}
              placeholder={pet.clickAction === "say" ? "Random phrase" : "On it! 🚀"}
              onChange={(e) => onChange({ phrase: e.target.value })}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [launchOnStartup, setLaunchOnStartup] = useState(false);
  const [petVisible, setPetVisible] = useState(true);
  const [status, setStatus] = useState("");
  const [apps, setApps] = useState([]);
  const [expandedIds, setExpandedIds] = useState(() => new Set());

  useEffect(() => {
    invoke("get_settings")
      .then((cfg) => cfg && setSettings((s) => ({ ...s, ...cfg })))
      .catch(() => {});
    // Installed apps (Start Menu shortcuts) for the per-pet app dropdown.
    invoke("list_apps")
      .then((list) => setApps(list || []))
      .catch(() => {});
    // Behavior #1: read true autostart state from the OS, not just JSON.
    invoke("is_autostart_enabled")
      .then((enabled) => {
        setLaunchOnStartup(enabled);
        // Mirror into settings so Apply never writes a stale flag to disk.
        setSettings((s) => ({ ...s, launchOnStartup: enabled }));
      })
      .catch(() => {});

    // The backend is the single source of truth for the roster: whenever any
    // settings view applies changes, every open view re-syncs to the same
    // state (so no view can re-spawn pets that already exist).
    const unlisten = listen("settings_updated", ({ payload }) => {
      if (payload) setSettings((s) => ({ ...s, ...payload }));
    });
    return () => {
      unlisten.then((u) => u()).catch(() => {});
    };
  }, []);

  const update = (patch) => setSettings((s) => ({ ...s, ...patch }));

  const updatePet = (id, patch) =>
    setSettings((s) => ({
      ...s,
      pets: s.pets.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));

  const toggleExpanded = (id) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const addPet = () =>
    setSettings((s) => {
      if (s.pets.length >= MAX_PETS) return s;
      const pet = newPet();
      // Open the new pet's card so it's immediately editable.
      setExpandedIds((prev) => new Set(prev).add(pet.id));
      return { ...s, pets: [...s.pets, pet] };
    });

  const removePet = (id) =>
    setSettings((s) => ({ ...s, pets: s.pets.filter((p) => p.id !== id) }));

  async function apply() {
    try {
      await invoke("update_settings", { newSettings: settings });
      flash("Settings applied ✓");
    } catch (e) {
      flash("Error: " + e);
    }
  }

  async function toggleStartup(enabled) {
    try {
      await invoke("set_autostart", { enabled });
      setLaunchOnStartup(enabled);
      update({ launchOnStartup: enabled });
      flash(enabled ? "Will launch on startup ✓" : "Startup launch disabled");
    } catch (e) {
      flash("Error: " + e);
    }
  }

  function flash(msg) {
    setStatus(msg);
    setTimeout(() => setStatus(""), 2500);
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6 text-gray-900">
      <h1 className="mb-1 text-2xl font-bold">🐾 Desktop Pet</h1>
      <p className="mb-6 text-sm text-gray-500">Configure your companions.</p>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          Your pets <span className="text-sm font-normal text-gray-400">({settings.pets.length}/{MAX_PETS})</span>
        </h2>
        <button
          onClick={addPet}
          disabled={settings.pets.length >= MAX_PETS}
          className="rounded bg-indigo-100 px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-200 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
        >
          + Add pet
        </button>
      </div>

      <div className="space-y-3">
        {settings.pets.length === 0 && (
          <p className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-400">
            No pets yet — add one!
          </p>
        )}
        {settings.pets.map((pet, i) => (
          <PetRow
            key={pet.id}
            pet={pet}
            index={i}
            apps={apps}
            expanded={expandedIds.has(pet.id)}
            onToggle={() => toggleExpanded(pet.id)}
            canRemove={settings.pets.length > 1}
            onChange={(patch) => updatePet(pet.id, patch)}
            onRemove={() => removePet(pet.id)}
          />
        ))}
      </div>

      <h2 className="mb-3 mt-6 text-lg font-semibold">World settings</h2>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field label={`Walk speed: ${settings.speed.toFixed(1)}`}>
          <input
            type="range"
            min="0.5"
            max="5"
            step="0.5"
            value={settings.speed}
            onChange={(e) => update({ speed: Number(e.target.value) })}
            className="w-full"
          />
        </Field>

        <Field label={`Pet size: ${settings.width}px`}>
          <input
            type="range"
            min="48"
            max="160"
            step="8"
            value={settings.width}
            onChange={(e) =>
              update({ width: Number(e.target.value), height: Number(e.target.value) })
            }
            className="w-full"
          />
        </Field>

        <Field label="Icon behavior" hint="How the pets treat your desktop icons.">
          <select
            className="w-full rounded border border-gray-300 p-2"
            value={settings.iconRole}
            onChange={(e) => update({ iconRole: e.target.value })}
          >
            {ICON_ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-5 space-y-3 rounded-lg border border-gray-200 bg-white p-4">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={settings.useIconsAsPlatforms}
            onChange={(e) => update({ useIconsAsPlatforms: e.target.checked })}
          />
          <span className="text-sm">Use desktop icons as platforms</span>
        </label>

        {/* Behavior #1 */}
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={launchOnStartup}
            onChange={(e) => toggleStartup(e.target.checked)}
          />
          <span className="text-sm">Launch when my computer starts</span>
        </label>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          onClick={apply}
          className="rounded bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-700"
        >
          Apply
        </button>
        <button
          onClick={() => invoke("rescan_icons").then(() => flash("Icons re-scanned ✓"))}
          className="rounded border border-gray-300 px-4 py-2 font-medium hover:bg-gray-100"
        >
          Re-scan Icons Now
        </button>
        <button
          onClick={() => {
            const next = !petVisible;
            invoke(next ? "show_pet" : "hide_pet")
              .then(() => setPetVisible(next))
              .catch((e) => flash("Error: " + e));
          }}
          className={`rounded px-4 py-2 font-medium transition-colors ${
            petVisible
              ? "bg-red-100 text-red-700 hover:bg-red-200"
              : "bg-green-100 text-green-700 hover:bg-green-200"
          }`}
        >
          {petVisible ? "Hide Pets" : "Show Pets"}
        </button>
        <span className="text-sm text-green-600">{status}</span>
      </div>
    </div>
  );
}
