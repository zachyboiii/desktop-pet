// Reusable pixel-art sprite-sheet generator.
//
// Produces clean 4x4 sheets like test_yellow: small native frames scaled up with
// nearest-neighbor, with a CONSTANT feet baseline so animation never jitters.
//
// Usage:
//   node tools/gen_sprite.mjs <name> <bodyColor> [earColor] [cheekColor]
//   node tools/gen_sprite.mjs all          # regenerate the built-in palette set
//
// <name> becomes public/sprites/<name>.png  (use "type_color", e.g. cat_black)
// Colors are hex like "f7d02c" or a named entry from PALETTE below.
//
// Layout (matches DEFAULT_ANIM in src/pet-canvas/PetEngine.js):
//   Row 0 idle | Row 1 walk | Row 2 sit(0-1)+sleep(2-3) | Row 3 celebrate

import zlib from "zlib";
import fs from "fs";
import path from "path";

const F = 32; // native frame size in px (kept small for crisp upscaling)
const COLS = 4;
const ROWS = 4;
const W = F * COLS;
const H = F * ROWS;

// ---- named palettes: { body, ear, cheek } as hex ----
const PALETTE = {
  yellow: { body: "f7d02c", ear: "3c2d0a", cheek: "f07878" },
  pink: { body: "f7a8c0", ear: "7a3b50", cheek: "ff6f91" },
  blue: { body: "6fb7f0", ear: "1c4a78", cheek: "ff9aa2" },
  green: { body: "7ad07a", ear: "2f6b2f", cheek: "ffb3b3" },
  purple: { body: "b78cf0", ear: "4a2d78", cheek: "ffa0c0" },
  gray: { body: "c9c9c9", ear: "4a4a4a", cheek: "ffb0b0" },
  orange: { body: "f5a02c", ear: "7a4012", cheek: "ff8a5c" },
  black: { body: "4a4a55", ear: "1a1a20", cheek: "ff7a7a" },
};

const hex = (h) => [
  parseInt(h.slice(0, 2), 16),
  parseInt(h.slice(2, 4), 16),
  parseInt(h.slice(4, 6), 16),
];

function buildSheet({ body, ear, cheek }) {
  const px = Buffer.alloc(W * H * 4, 0);
  const YEL = hex(body);
  const EAR = hex(ear);
  const CHK = hex(cheek);
  const DRK = [40, 30, 20];
  const WHT = [255, 255, 255];

  const set = (x, y, c) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = 255;
  };

  // Draw one creature into cell (col,row). The feet baseline is ALWAYS the same
  // pixel row, which is what removes vertical jitter between frames.
  function creature(col, row, opts = {}) {
    const { legPhase = 0, eye = "open", bodyBob = 0, arms = 0, sleepZ = 0, sit = false } = opts;
    const ox = col * F;
    const oy = row * F;
    const cx = ox + 16;
    const baseY = oy + 29; // CONSTANT feet line
    const by = baseY - 9 - bodyBob; // body center

    // body blob
    for (let y = -8; y <= 8; y++)
      for (let x = -9; x <= 9; x++) {
        if ((x * x) / 81 + (y * y) / 64 <= 1) set(cx + x, by + y, YEL);
      }

    if (!sit) {
      for (let y = 0; y < 5; y++) {
        const dl = legPhase > 0 ? 1 : 0;
        const dr = legPhase < 0 ? 1 : 0;
        set(cx - 4, by + 8 + y - dl, YEL);
        set(cx - 3, by + 8 + y - dl, YEL);
        set(cx + 4, by + 8 + y - dr, YEL);
        set(cx + 5, by + 8 + y - dr, YEL);
      }
    } else {
      for (let y = 0; y < 4; y++) for (let x = -7; x <= 7; x++) set(cx + x, by + 7 + y, YEL);
    }

    // ears
    for (let i = 0; i < 7; i++) {
      set(cx - 6, by - 8 - i, YEL);
      set(cx - 5, by - 8 - i, YEL);
      set(cx + 6, by - 8 - i, YEL);
      set(cx + 5, by - 8 - i, YEL);
      if (i > 3) {
        set(cx - 6, by - 8 - i, EAR);
        set(cx + 6, by - 8 - i, EAR);
      }
    }

    // cheeks
    for (const s of [-1, 1]) {
      set(cx + s * 7, by + 1, CHK);
      set(cx + s * 6, by + 1, CHK);
      set(cx + s * 7, by + 2, CHK);
    }

    // eyes
    if (eye === "open") {
      set(cx - 4, by - 2, DRK);
      set(cx - 4, by - 3, DRK);
      set(cx - 3, by - 3, WHT);
      set(cx + 4, by - 2, DRK);
      set(cx + 4, by - 3, DRK);
      set(cx + 5, by - 3, WHT);
    } else {
      for (let x = -1; x <= 1; x++) {
        set(cx - 4 + x, by - 2, DRK);
        set(cx + 4 + x, by - 2, DRK);
      }
    }

    // mouth
    set(cx, by + 2, DRK);
    set(cx - 1, by + 3, DRK);
    set(cx + 1, by + 3, DRK);

    // arms (celebrate)
    if (arms) for (let i = 0; i < 5; i++) {
      set(cx - 9 - i * 0.4, by - 2 - i, YEL);
      set(cx + 9 + i * 0.4, by - 2 - i, YEL);
    }

    // Zzz (sleep)
    if (sleepZ) {
      const zx = ox + 22;
      const zy = oy + 6;
      for (let k = 0; k < sleepZ; k++) {
        const s = zx + k * 3;
        const t = zy - k * 2;
        for (const [a, b] of [[0,0],[1,0],[2,0],[0,1],[2,1],[0,2],[1,2],[2,2]]) set(s + a, t + b, DRK);
      }
    }
  }

  // Row 0 idle (breathe + blink)
  creature(0, 0, { bodyBob: 0 });
  creature(1, 0, { bodyBob: 1 });
  creature(2, 0, { bodyBob: 1 });
  creature(3, 0, { eye: "closed" });
  // Row 1 walk (leg cycle, baseline fixed)
  creature(0, 1, { legPhase: 1 });
  creature(1, 1, { legPhase: 0 });
  creature(2, 1, { legPhase: -1 });
  creature(3, 1, { legPhase: 0 });
  // Row 2 sit (0-1) + sleep (2-3)
  creature(0, 2, { sit: true });
  creature(1, 2, { sit: true });
  creature(2, 2, { sit: true, eye: "closed", sleepZ: 2 });
  creature(3, 2, { sit: true, eye: "closed", sleepZ: 3 });
  // Row 3 celebrate (arms up, hop)
  creature(0, 3, { arms: 1, bodyBob: 0 });
  creature(1, 3, { arms: 1, bodyBob: 2 });
  creature(2, 3, { arms: 1, bodyBob: 3 });
  creature(3, 3, { arms: 1, bodyBob: 2 });

  return encodePng(px);
}

function encodePng(px) {
  const crc32 = (b) => {
    let c = ~0;
    for (let i = 0; i < b.length; i++) {
      c ^= b[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (t, d) => {
    const ty = Buffer.from(t);
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const cr = Buffer.alloc(4);
    cr.writeUInt32BE(crc32(Buffer.concat([ty, d])));
    return Buffer.concat([l, ty, d, cr]);
  };
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0;
    px.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function resolveColors(bodyArg, earArg, cheekArg) {
  // If bodyArg is a palette name, use the whole palette; allow overrides.
  const base = PALETTE[bodyArg] || { body: bodyArg, ear: earArg || "333333", cheek: cheekArg || "ff8a8a" };
  return {
    body: base.body,
    ear: earArg || base.ear,
    cheek: cheekArg || base.cheek,
  };
}

function write(name, colors) {
  const dir = path.resolve("public/sprites");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${name}.png`);
  fs.writeFileSync(out, buildSheet(colors));
  console.log(`wrote ${out}  (${W}x${H})`);
}

// ---- CLI ----
const [, , arg1, arg2, arg3, arg4] = process.argv;

if (!arg1) {
  console.log(
    "Usage:\n" +
      "  node tools/gen_sprite.mjs <name> <bodyColor|paletteName> [earHex] [cheekHex]\n" +
      "  node tools/gen_sprite.mjs all\n\n" +
      "Palettes: " +
      Object.keys(PALETTE).join(", "),
  );
  process.exit(0);
}

if (arg1 === "all") {
  // Generate one sprite per palette, named cat_<palette>.png as examples.
  for (const [name, colors] of Object.entries(PALETTE)) {
    write(`cat_${name}`, colors);
  }
} else {
  write(arg1, resolveColors(arg2 || "yellow", arg3, arg4));
}
