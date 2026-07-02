// gen_icon.mjs — pixel-art paw print app icon.
// Draws on a 32x32 logical grid, scales up nearest-neighbor to 1024x1024, and
// writes src-tauri/icons/app-icon.png. Feed that to `npm run tauri icon` to
// regenerate every platform icon size. Same zero-dependency PNG writer as
// generate_sprites.mjs.
import { deflateSync } from "zlib";
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src-tauri", "icons", "app-icon.png");

const GRID = 32; // logical pixels
const SCALE = 32; // 32 * 32 = 1024px output

// ---------------------------------------------------------------------------
// Minimal PNG writer (RGBA8)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = 1 + w * 4;
  const raw = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 32x32 paint helpers
// ---------------------------------------------------------------------------
const hex = (s) => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
  255,
];
const grid = new Array(GRID * GRID).fill(null); // color tuple or null

function set(x, y, c) {
  if (x >= 0 && x < GRID && y >= 0 && y < GRID) grid[y * GRID + x] = c;
}
function fillEllipse(cx, cy, rx, ry, c) {
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) set(x, y, c);
    }
  }
}
// Rounded-rect membership test (used for the icon plate + its outline).
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  const px = x + 0.5;
  const py = y + 0.5;
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const nx = Math.max(x0 + r, Math.min(px, x1 - r));
  const ny = Math.max(y0 + r, Math.min(py, y1 - r));
  const dx = px - nx;
  const dy = py - ny;
  return dx * dx + dy * dy <= r * r;
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const PLATE = hex("#f2a65a"); // warm orange plate
const PLATE_LIGHT = hex("#f8c184"); // top sheen
const PLATE_DARK = hex("#d9853f"); // bottom shade
const OUTLINE = hex("#7c4520"); // plate border
const PAW = hex("#3d2817"); // big paw print
const PAW_HI = hex("#5c3d24"); // pad highlight
const PAW_SMALL = hex("#8a5530"); // faded trailing print

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------
// Plate: rounded square with a 1px outline, light top band, shaded bottom.
for (let y = 0; y < GRID; y++) {
  for (let x = 0; x < GRID; x++) {
    if (!inRoundedRect(x, y, 1, 1, 31, 31, 7)) continue;
    const inner = inRoundedRect(x, y, 2, 2, 30, 30, 6);
    if (!inner) set(x, y, OUTLINE);
    else if (y <= 6) set(x, y, PLATE_LIGHT);
    else if (y >= 27) set(x, y, PLATE_DARK);
    else set(x, y, PLATE);
  }
}

// Small trailing paw print, top-left (walking away). Keep the toes clearly
// separated from the pad — at this size touching blobs merge into mush.
fillEllipse(7.2, 10.8, 2.2, 1.7, PAW_SMALL); // pad
fillEllipse(4.4, 7.0, 1.1, 1.1, PAW_SMALL); // toes
fillEllipse(7.2, 5.9, 1.1, 1.1, PAW_SMALL);
fillEllipse(10.0, 7.0, 1.1, 1.1, PAW_SMALL);

// Big paw print, bottom-right.
// Toes: four rounded pads fanned above the main pad.
fillEllipse(11.4, 15.2, 1.9, 2.4, PAW); // outer left
fillEllipse(16.2, 12.9, 2.0, 2.5, PAW); // inner left
fillEllipse(21.8, 12.9, 2.0, 2.5, PAW); // inner right
fillEllipse(26.6, 15.2, 1.9, 2.4, PAW); // outer right
// Main pad: wide blob with two bottom lobes (heart-ish).
fillEllipse(19, 22.4, 5.8, 3.9, PAW);
fillEllipse(15.9, 24.6, 2.7, 2.4, PAW);
fillEllipse(22.1, 24.6, 2.7, 2.4, PAW);
// Pixel-art highlight on the main pad.
fillEllipse(16.4, 20.8, 1.6, 1.1, PAW_HI);

// ---------------------------------------------------------------------------
// Scale up nearest-neighbor and write
// ---------------------------------------------------------------------------
const W = GRID * SCALE;
const rgba = Buffer.alloc(W * W * 4); // zero = transparent corners
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const c = grid[Math.floor(y / SCALE) * GRID + Math.floor(x / SCALE)];
    if (!c) continue;
    const i = (y * W + x) * 4;
    rgba[i] = c[0];
    rgba[i + 1] = c[1];
    rgba[i + 2] = c[2];
    rgba[i + 3] = c[3];
  }
}
writeFileSync(OUT, encodePNG(W, W, rgba));
console.log("wrote", OUT);
