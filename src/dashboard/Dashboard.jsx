import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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
];
const ICON_ROLES = [
  { value: "mixed", label: "Mixed (stand on tops, blocked by sides)" },
  { value: "platform", label: "Platform (stand on icon tops)" },
  { value: "obstacle", label: "Obstacle (walk around icons)" },
];

const DEFAULTS = {
  petType: "dog",
  petColor: "brown",
  count: 1,
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

export default function Dashboard() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [launchOnStartup, setLaunchOnStartup] = useState(false);
  const [petVisible, setPetVisible] = useState(true);
  const [status, setStatus] = useState("");

  useEffect(() => {
    invoke("get_settings")
      .then((cfg) => cfg && setSettings((s) => ({ ...s, ...cfg })))
      .catch(() => {});
    // Behavior #1: read true autostart state from the OS, not just JSON.
    invoke("is_autostart_enabled")
      .then(setLaunchOnStartup)
      .catch(() => {});
  }, []);

  const update = (patch) => setSettings((s) => ({ ...s, ...patch }));

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
      <p className="mb-6 text-sm text-gray-500">Configure your companion.</p>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field label="Pet">
          <select
            className="w-full rounded border border-gray-300 p-2"
            value={`${settings.petType}_${settings.petColor}`}
            onChange={(e) => {
              const [type, color] = e.target.value.split("_");
              update({ petType: type, petColor: color });
            }}
          >
            {PETS.map((p) => (
              <option key={`${p.type}_${p.color}`} value={`${p.type}_${p.color}`}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label={`Number of pets: ${settings.count}`}>
          <input
            type="range"
            min="1"
            max="5"
            value={settings.count}
            onChange={(e) => update({ count: Number(e.target.value) })}
            className="w-full"
          />
        </Field>

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

        <Field label="Icon behavior" hint="How the pet treats your desktop icons.">
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
          {petVisible ? "Hide Pet" : "Show Pet"}
        </button>
        <span className="text-sm text-green-600">{status}</span>
      </div>
    </div>
  );
}
