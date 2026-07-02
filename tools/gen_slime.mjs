// Minecraft-style slime sprite sheet generator.
//
// A semi-isometric green cube with a light top face, two side faces (front
// lighter, side darker), a face (eyes + mouth dots), and squash/stretch frames
// so it BOUNCES instead of walking. Feet baseline stays constant -> no jitter.
//
//   node tools/gen_slime.mjs            -> public/sprites/slime_green.png
//   node tools/gen_slime.mjs <name>     -> public/sprites/<name>.png
//
// Layout matches DEFAULT_ANIM (Row0 idle, Row1 walk/bounce, Row2 sit+sleep,
// Row3 celebrate). For slimes every row is a bounce variation.

import zlib from "zlib";
import fs from "fs";
import path from "path";

const F = 32;
const COLS = 4;
const ROWS = 4;
const W = F * COLS;
const H = F * ROWS;

// Minecraft slime greens.
const TOP = [0x8c, 0xd9, 0x6f]; // light top face
const FRONT = [0x6a, 0xbf, 0x4f]; // front face
const SIDE = [0x55, 0xa0, 0x3e]; // darker right side
const EDGE = [0x44, 0x82, 0x32]; // outline / deep shade
const SPOT = [0x4e, 0x91, 0x3a]; // blotches
const FACE = [0x2f, 0x5a, 0x24]; // eyes / mouth

function buildSheet() {
  const px = Buffer.alloc(W * H * 4, 0);
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

  // Draw a cube of width w / height h whose BOTTOM sits on baseY, centered at cx.
  // depth = how far the iso top/side is offset. squash<1 = flatter & wider.
  function cube(col, row, { squash = 1, face = "open" } = {}) {
    const ox = col * F;
    const oy = row * F;
    const cx = ox + 16;
    const baseY = oy + 30; // CONSTANT bottom line

    // Base cube footprint, then squash: wider when flat, taller when stretched.
    const w = Math.round(18 / squash); // front-face width
    const h = Math.round(16 * squash); // front-face height
    const d = Math.round(6 * Math.min(1, squash)); // iso depth

    const left = cx - Math.round(w / 2);
    const right = left + w;
    const top = baseY - h; // top of the FRONT face
    // ---- front face ----
    for (let y = top; y < baseY; y++)
      for (let x = left; x < right; x++) set(x, y, FRONT);

    // ---- right side face (parallelogram going up-right) ----
    for (let x = 0; x < d; x++) {
      const yShift = Math.round(((x + 1) / d) * d);
      for (let y = top - yShift; y < baseY - yShift; y++) set(right + x, y, SIDE);
    }

    // ---- top face (parallelogram) ----
    for (let y = 0; y < d; y++) {
      const xShift = Math.round(((y + 1) / d) * d);
      for (let x = left + xShift; x < right + xShift; x++) set(x, top - 1 - y, TOP);
    }

    // ---- outline / edges ----
    for (let y = top; y < baseY; y++) {
      set(left, y, EDGE);
      set(right - 1, y, EDGE);
    }
    for (let x = left; x < right; x++) set(x, baseY - 1, EDGE);

    // ---- random-ish blotches on the front (fixed, for the slime texture) ----
    const blots = [
      [0.3, 0.35],
      [0.62, 0.5],
      [0.45, 0.7],
      [0.72, 0.28],
    ];
    for (const [bx, by] of blots) {
      const sxp = left + Math.round(bx * w);
      const syp = top + Math.round(by * h);
      set(sxp, syp, SPOT);
      set(sxp + 1, syp, SPOT);
      set(sxp, syp + 1, SPOT);
    }

    // ---- face (two eyes + small mouth), Minecraft slime style ----
    const fcx = left + Math.round(w * 0.42);
    const fcy = top + Math.round(h * 0.45);
    if (face !== "none") {
      const closed = face === "closed";
      // eyes
      if (closed) {
        set(fcx - 3, fcy, FACE);
        set(fcx - 2, fcy, FACE);
        set(fcx + 2, fcy, FACE);
        set(fcx + 3, fcy, FACE);
      } else {
        set(fcx - 3, fcy, FACE);
        set(fcx - 3, fcy + 1, FACE);
        set(fcx - 2, fcy + 1, FACE);
        set(fcx + 3, fcy, FACE);
        set(fcx + 3, fcy + 1, FACE);
        set(fcx + 2, fcy + 1, FACE);
      }
      // mouth dots
      set(fcx, fcy + 4, FACE);
      set(fcx - 1, fcy + 5, FACE);
      set(fcx + 1, fcy + 5, FACE);
    }
  }

  // Row 0 idle: gentle breathing squash.
  cube(0, 0, { squash: 1.0 });
  cube(1, 0, { squash: 0.97 });
  cube(2, 0, { squash: 1.0 });
  cube(3, 0, { squash: 1.03 });
  // Row 1 "walk" = full bounce cycle (squash -> stretch -> squash).
  cube(0, 1, { squash: 0.78 }); // flattened landing
  cube(1, 1, { squash: 1.0 });
  cube(2, 1, { squash: 1.18 }); // stretched at peak
  cube(3, 1, { squash: 1.0 });
  // Row 2 sit (0-1) + sleep (2-3): squat, eyes closed.
  cube(0, 2, { squash: 0.85 });
  cube(1, 2, { squash: 0.85 });
  cube(2, 2, { squash: 0.82, face: "closed" });
  cube(3, 2, { squash: 0.8, face: "closed" });
  // Row 3 celebrate: big bouncy stretch.
  cube(0, 3, { squash: 0.8 });
  cube(1, 3, { squash: 1.2 });
  cube(2, 3, { squash: 1.3 });
  cube(3, 3, { squash: 1.1 });

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

const name = process.argv[2] || "slime_green";
const dir = path.resolve("public/sprites");
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `${name}.png`);
fs.writeFileSync(out, buildSheet());
console.log(`wrote ${out}  (${W}x${H})`);
