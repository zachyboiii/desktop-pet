// generate_sprites.mjs — deterministic pixel-art sprite sheet generator.
//
// Produces Stardew-Valley-flavored pets as 8-column x 6-row sheets of 64x64
// frames (drawn on a 32x32 logical grid, scaled 2x, nearest neighbor).
// Every frame of a species shares the same feet baseline and horizontal
// anchor, so animation never "swims" — the smoothness problem with the old
// hand-made sheets.
//
// Row layout (must match DEFAULT_ANIM in src/pet-canvas/PetEngine.js):
//   row 0: idle   (8 frames)  breathing, tail sway, ear twitch, blink
//   row 1: walk   (8 frames)  4-beat leg cycle + body bob
//   row 2: sit    (8 frames)  sitting, tail sway, blink
//   row 3: sleep  (8 frames)  lying down, slow breathing, floating Z's
//   row 4: jump   (8 frames)  crouch -> launch -> tuck -> fall -> land
//   row 5: look   (8 frames)  front-facing "hi!" pose, tail wag (click react)
//
// Usage: node tools/generate_sprites.mjs

import { deflateSync } from "zlib";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "sprites");

// ---------------------------------------------------------------------------
// Minimal PNG writer (RGBA8, no external deps)
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
// 32x32 palette-indexed drawing surface
// ---------------------------------------------------------------------------
const G = 32; // logical grid size
const SCALE = 2; // output pixels per logical pixel -> 64x64 frames
const COLS = 8;
const ROWS = 6;

// palette slot names (index into each species' palette array)
const T = 0; // transparent
const OUT = 1; // outline
const BODY = 2;
const LIGHT = 3; // belly / muzzle / inner ear
const SHADE = 4;
const DARK = 5; // eyes / nose
const WHITE = 6; // eye glint
const PINK = 7; // blush / tongue
const ZZZ = 8; // sleep Z's
const COLLAR = 9; // collar band (Stardew-style pets)

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 255];

function grid() {
  return new Uint8Array(G * G);
}
function px(g, x, y, c) {
  x = Math.round(x);
  y = Math.round(y);
  if (x >= 0 && x < G && y >= 0 && y < G) g[y * G + x] = c;
}
function at(g, x, y) {
  if (x < 0 || x >= G || y < 0 || y >= G) return T;
  return g[y * G + x];
}
function fillRect(g, x, y, w, h, c) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(g, x + i, y + j, c);
}
function fillEllipse(g, cx, cy, rx, ry, c) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const nx = (x - cx) / (rx + 0.5);
      const ny = (y - cy) / (ry + 0.5);
      if (nx * nx + ny * ny <= 1) px(g, x, y, c);
    }
  }
}
// Paint only over already-solid body pixels (interior patches never break outline).
function paintOver(g, cx, cy, rx, ry, c) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const nx = (x - cx) / (rx + 0.5);
      const ny = (y - cy) / (ry + 0.5);
      if (nx * nx + ny * ny <= 1) {
        const cur = at(g, x, y);
        if (cur === BODY || cur === SHADE) px(g, x, y, c);
      }
    }
  }
}
// Silhouette pixels touching transparency become the outline.
function outlinePass(g) {
  const src = g.slice();
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      const c = src[y * G + x];
      if (c === T || c === OUT) continue;
      const edge =
        (x === 0 || src[y * G + x - 1] === T) ||
        (x === G - 1 || src[y * G + x + 1] === T) ||
        (y === 0 || src[(y - 1) * G + x] === T) ||
        (y === G - 1 || src[(y + 1) * G + x] === T);
      if (edge) g[y * G + x] = OUT;
    }
  }
}
// Soft bottom shading: body pixels sitting directly on the outline get darker.
function shadePass(g) {
  for (let y = 0; y < G - 1; y++) {
    for (let x = 0; x < G; x++) {
      if (g[y * G + x] === BODY && g[(y + 1) * G + x] === OUT) g[y * G + x] = SHADE;
    }
  }
}
// Thick 2x2 dot — used to draw tails as chains of blobs.
function blob(g, x, y, c) {
  fillRect(g, Math.round(x), Math.round(y), 2, 2, c);
}
// Continuous 2px-thick line of blobs — tails, so they never break into dots.
function thickLine(g, x0, y0, x1, y1, c) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    blob(g, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, c);
  }
}
// Quadratic-curve tail through three control points.
function tailCurve(g, p0, p1, p2, c) {
  let prev = p0;
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    const a = 1 - t;
    const x = a * a * p0[0] + 2 * a * t * p1[0] + t * t * p2[0];
    const y = a * a * p0[1] + 2 * a * t * p1[1] + t * t * p2[1];
    thickLine(g, prev[0], prev[1], x, y, c);
    prev = [x, y];
  }
}
// Recolor a rect of existing sprite pixels (skips transparency and outline) —
// used to lay a collar band over the neck without changing the silhouette.
function bandOver(g, x, y, w, h, c) {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const cur = at(g, Math.round(x + i), Math.round(y + j));
      if (cur !== T && cur !== OUT) px(g, x + i, y + j, c);
    }
  }
}
// Floating "Z z" for sleep frames (drawn last; intentionally no outline).
function drawZs(g, phase) {
  const zs = [
    { x: 25, y: 8 - phase, s: 3 },
    { x: 28, y: 4 - phase, s: 2 },
  ];
  for (const z of zs) {
    if (z.y < 1) continue;
    fillRect(g, z.x, z.y, z.s, 1, ZZZ);
    fillRect(g, z.x, z.y + z.s - 1, z.s, 1, ZZZ);
    for (let i = 0; i < z.s - 2; i++) px(g, z.x + z.s - 2 - i, z.y + 1 + i, ZZZ);
  }
}

// ---------------------------------------------------------------------------
// Dog (side view, faces right; front view for "look")
// ---------------------------------------------------------------------------
// Palette layout: [T, OUT, BODY, LIGHT, SHADE, DARK, WHITE, PINK, ZZZ, COLLAR]
const makePalette = (outline, body, light, shade, collar) => [
  [0, 0, 0, 0],
  hex(outline),
  hex(body),
  hex(light),
  hex(shade),
  hex("#2b1810"), // eyes / nose
  hex("#ffffff"),
  hex("#e78a80"), // blush / tongue
  hex("#8fb7e8"), // Z's
  hex(collar),
];

function dogSide(g, o) {
  // o: { bob, headBob, tail: [dx,dy], legs: [dx,lift]x4, earFlop, blink,
  //      lying, crouch, tuck, stretch }
  const bob = o.bob || 0;
  const headBob = o.headBob ?? bob;

  if (o.lying) {
    // Sleeping: one long low loaf. Bottom edge pinned to y=29.
    const ry = 4 + (o.breath || 0);
    fillEllipse(g, 15, 29 - ry, 9, ry, BODY); // body
    fillEllipse(g, 24, 25, 5, 4, BODY); // head resting on paws
    fillEllipse(g, 21, 21, 2, 3, BODY); // ear flopped over
    fillRect(g, 26, 27, 4, 3, BODY); // front paws stretched out
    if (o.curlTail) fillEllipse(g, 6, 25, 2.2, 2.2, BODY);
    else thickLine(g, 7, 26, 4, 24 + (o.breath || 0), BODY); // tail curled round
    outlinePass(g);
    shadePass(g);
    if (o.saddle) paintOver(g, 14, 24, 6, 2, SHADE); // dark back marking
    paintOver(g, 24, 26, 3, 2, LIGHT); // muzzle
    fillRect(g, 26, 23, 2, 1, DARK); // closed eye
    px(g, 29, 24, DARK); // nose
    return;
  }

  // Low-slung body with short stubby legs like the reference dogs — the pet
  // reads as a dog (not a deer) when the torso fills the lower half.
  const bodyCy = 22 + bob + (o.crouch ? 2 : 0) + (o.tuck ? -1 : 0);
  const bodyRy = 4.5 - (o.crouch ? 1 : 0) + (o.stretch ? 1 : 0);
  const headCy = 14 + headBob + (o.crouch ? 3 : 0) + (o.tuck ? -1 : 0);

  // tail: spitz curl resting on the back, or a swaying curve
  if (o.curlTail) {
    fillEllipse(g, 8, bodyCy - 5.5, 2.5, 2.5, BODY);
  } else {
    const [tdx, tdy] = o.tail || [0, 0];
    tailCurve(g, [8, bodyCy - 2], [5, bodyCy - 5], [4 + tdx, bodyCy - 8 + tdy], BODY);
  }

  // stubby 3px-wide legs (2px would be all outline and render as black sticks)
  const legX = [7, 11, 16, 20];
  const legs = o.legs || [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  const legTop = bodyCy + 2;
  const feet = [];
  for (let i = 0; i < 4; i++) {
    const [dx, lift] = legs[i];
    const bottom = o.tuck ? legTop + 3 : 29 - lift;
    fillRect(g, legX[i] + dx, legTop, 3, Math.max(2, bottom - legTop + 1), BODY);
    feet.push([legX[i] + dx, bottom]);
  }

  // longer, flatter torso with a raised chest — less blob, more dog
  fillEllipse(g, 13, bodyCy, 6.5, bodyRy, BODY);
  fillEllipse(g, 18.5, bodyCy - 1, 3.5, bodyRy, BODY);

  // head with a real protruding snout (big chibi head like the references)
  fillEllipse(g, 22, headCy, 5.5, 5.5, BODY);
  fillRect(g, 26, headCy + 1, 4, 3, BODY); // snout
  if (o.pointyEars) {
    // short upright ears overlapping the head top (shepherd / shiba / husky)
    catEar(g, 19, headCy - 8, headCy - 5, -1);
    catEar(g, 25, headCy - 8, headCy - 5, 1);
  } else {
    // floppy ears hang off the sides of the head, clearly outside its silhouette
    fillEllipse(g, 17.5, headCy - 1 + (o.earFlop || 0), 1.7, 3.4, BODY); // back ear
    fillEllipse(g, 26.5, headCy - 2.5 + (o.earFlop || 0), 1.7, 3.2, BODY); // front ear
  }

  outlinePass(g);
  shadePass(g);

  // markings (post-outline so they stay inside the silhouette)
  if (o.curlTail) paintOver(g, 8, bodyCy - 5.5, 1.1, 1.1, LIGHT); // cream curl center
  if (o.saddle) paintOver(g, 12.5, bodyCy - 2.5, 5.5, 2, SHADE); // dark back
  paintOver(g, 12.5, bodyCy + 2, 4, 1.8, LIGHT); // belly
  paintOver(g, 19, bodyCy, 1.8, 2.4, LIGHT); // chest
  paintOver(g, 27.5, headCy + 3, 2, 1, LIGHT); // under-snout
  if (o.mask) paintOver(g, 24, headCy + 2, 3, 1.8, LIGHT); // light lower face
  if (o.darkEars) {
    if (o.pointyEars) {
      paintOver(g, 20.5, headCy - 6, 1.5, 1.6, SHADE);
      paintOver(g, 24, headCy - 6, 1.5, 1.6, SHADE);
    } else {
      paintOver(g, 17.5, headCy - 1 + (o.earFlop || 0), 1.7, 3.2, SHADE);
      paintOver(g, 26.5, headCy - 2.5 + (o.earFlop || 0), 1.7, 3, SHADE);
    }
  }
  if (o.socks) for (const [fx, fy] of feet) bandOver(g, fx, fy - 1, 3, 1, LIGHT);
  if (o.collar) bandOver(g, 18, headCy + 4, 5, 2, COLLAR);

  if (o.blink) {
    fillRect(g, 22, headCy - 1, 2, 1, DARK);
  } else {
    fillRect(g, 22, headCy - 2, 2, 2, DARK);
    px(g, 22, headCy - 2, WHITE);
  }
  fillRect(g, 28, headCy + 1, 2, 2, DARK); // nose at the snout tip
}

function dogSit(g, o) {
  // haunches + upright chest + head high
  const sitHb = o.headBob || 0;
  if (o.curlTail) fillEllipse(g, 6, 20.5, 2.4, 2.4, BODY); // curl beside the haunch
  else thickLine(g, 8, 26, 4.5 + (o.tailSway || 0), 24, BODY); // tail wagging on the ground
  fillEllipse(g, 12, 23.5, 5.5, 5.5, BODY); // haunch
  fillEllipse(g, 17, 21, 4.5, 6.5, BODY); // chest
  fillRect(g, 14, 24, 3, 6, BODY); // front legs
  fillRect(g, 19, 24, 3, 6, BODY);
  fillEllipse(g, 20, 12 + sitHb, 5.5, 5.5, BODY); // head low on the shoulders
  fillRect(g, 24, 12 + sitHb, 3, 3, BODY); // snout
  if (o.pointyEars) {
    catEar(g, 16, 3 + sitHb, 7 + sitHb, -1);
    catEar(g, 23, 3 + sitHb, 7 + sitHb, 1);
  } else {
    fillEllipse(g, 16, 8 + sitHb, 2, 3, BODY); // ears
    fillEllipse(g, 24, 8.5 + sitHb, 2, 3, BODY);
  }
  outlinePass(g);
  shadePass(g);
  if (o.curlTail) paintOver(g, 6, 20.5, 1.1, 1.1, LIGHT); // cream curl center
  if (o.saddle) paintOver(g, 10.5, 22.5, 3, 3.5, SHADE); // dark along the back
  paintOver(g, 17, 22.5, 2.5, 3, LIGHT); // chest patch
  if (o.mask) paintOver(g, 22, 14 + sitHb, 2.6, 1.8, LIGHT); // light lower face
  if (o.darkEars) {
    if (o.pointyEars) {
      paintOver(g, 17.5, 5 + sitHb, 1.5, 1.6, SHADE);
      paintOver(g, 22, 5 + sitHb, 1.5, 1.6, SHADE);
    } else {
      paintOver(g, 16, 8 + sitHb, 2, 2.8, SHADE);
      paintOver(g, 24, 8.5 + sitHb, 2, 2.8, SHADE);
    }
  }
  if (o.socks) {
    bandOver(g, 14, 28, 3, 1, LIGHT);
    bandOver(g, 19, 28, 3, 1, LIGHT);
  }
  if (o.collar) bandOver(g, 16, 17 + sitHb, 7, 2, COLLAR);
  const ey = 10 + sitHb;
  if (o.blink) fillRect(g, 20, ey + 1, 2, 1, DARK);
  else {
    fillRect(g, 20, ey, 2, 2, DARK);
    px(g, 20, ey, WHITE);
  }
  fillRect(g, 25, 12 + sitHb, 2, 2, DARK); // nose at the snout tip
}

function dogFront(g, o) {
  // "look at you" pose — big head, both eyes, wagging tail peeking out
  const wag = o.wag || 0;
  const hb = o.headBob || 0;
  if (o.curlTail) fillEllipse(g, 23.5, 20 + (wag > 0 ? 0 : 1), 2.2, 2.2, BODY);
  else tailCurve(g, [21, 24], [24, 22], [24.5 + wag, 18.5], BODY); // wagging tail peeks out
  fillEllipse(g, 16, 23, 6.5, 5.5, BODY); // body
  fillRect(g, 11, 26, 3, 4, BODY); // front paws
  fillRect(g, 18, 26, 3, 4, BODY);
  fillEllipse(g, 16, 12 + hb, 7, 7, BODY); // head
  if (o.pointyEars) {
    catEar(g, 11, 2 + hb, 6, -1);
    catEar(g, 21, 2 + hb, 6, 1);
  } else {
    fillEllipse(g, 9.5, 9 + hb, 2, 3.5, BODY); // floppy ears
    fillEllipse(g, 22.5, 9 + hb, 2, 3.5, BODY);
  }
  outlinePass(g);
  shadePass(g);
  const hy = 12 + hb;
  paintOver(g, 16, hy + 3, 3, 2.4, LIGHT); // muzzle
  if (o.mask) {
    // husky-style light face: wide lower cheeks + blaze up the forehead
    paintOver(g, 16, hy + 2.5, 4.5, 2.8, LIGHT);
    paintOver(g, 16, hy - 4, 1.2, 2.4, LIGHT);
  }
  paintOver(g, 16, 24, 3.5, 2.5, LIGHT); // belly
  if (o.darkEars) {
    if (o.pointyEars) {
      paintOver(g, 12, hy - 8, 1.5, 1.8, SHADE);
      paintOver(g, 20, hy - 8, 1.5, 1.8, SHADE);
    } else {
      paintOver(g, 9.5, hy - 3, 2, 3.2, SHADE);
      paintOver(g, 22.5, hy - 3, 2, 3.2, SHADE);
    }
  }
  if (o.socks) {
    bandOver(g, 11, 28, 3, 1, LIGHT);
    bandOver(g, 18, 28, 3, 1, LIGHT);
  }
  if (o.collar) bandOver(g, 12, hy + 6, 9, 2, COLLAR);
  if (o.blink) {
    fillRect(g, 12, hy - 1, 2, 1, DARK);
    fillRect(g, 19, hy - 1, 2, 1, DARK);
  } else {
    fillRect(g, 12, hy - 2, 2, 2, DARK);
    fillRect(g, 19, hy - 2, 2, 2, DARK);
    px(g, 12, hy - 2, WHITE);
    px(g, 19, hy - 2, WHITE);
  }
  fillRect(g, 15, hy + 2, 2, 2, DARK); // nose
  px(g, 16, hy + 4, PINK); // tongue
  px(g, 10, hy + 2, PINK); // blush
  px(g, 21, hy + 2, PINK);
}

// ---------------------------------------------------------------------------
// Cat — pointier, slimmer, long expressive tail, whiskers
// ---------------------------------------------------------------------------

function catEar(g, tipX, tipY, baseY, dir) {
  // pointy triangle ear, widening 1px per row from the tip down
  for (let i = 0; i <= 3; i++) {
    const w = 1 + i;
    const x = dir > 0 ? tipX - i : tipX;
    fillRect(g, x, tipY + i, w, 1, BODY);
  }
  void baseY;
}

function catSide(g, o) {
  const bob = o.bob || 0;
  const headBob = o.headBob ?? bob;

  if (o.lying) {
    const ry = 4 + (o.breath || 0);
    fillEllipse(g, 15, 29 - ry, 9, ry, BODY);
    fillEllipse(g, 23, 25, 4.5, 3.5, BODY); // head tucked
    catEar(g, 21, 19, 22, -1);
    catEar(g, 26, 19, 22, 1);
    // tail wrapped around front
    thickLine(g, 6, 26, 13, 28, BODY);
    outlinePass(g);
    shadePass(g);
    fillRect(g, 25, 24, 2, 1, DARK); // closed eye
    px(g, 27.5, 25, PINK);
    return;
  }

  const bodyCy = 21.5 + bob + (o.crouch ? 2 : 0) + (o.tuck ? -1 : 0);
  const bodyRy = 4.5 - (o.crouch ? 1 : 0) + (o.stretch ? 1 : 0);
  const headCy = 13 + headBob + (o.crouch ? 3 : 0) + (o.tuck ? -1 : 0);

  // long curved tail: continuous S-curve from rump upward, tip swaying
  const sway = o.tailSway || 0;
  tailCurve(g, [8.5, 20 + bob], [4.5, 16 + bob], [5.5 + sway, 9.5 + bob], BODY);

  const legX = [9, 12, 16, 19];
  const legs = o.legs || [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  const legTop = bodyCy + 2;
  for (let i = 0; i < 4; i++) {
    const [dx, lift] = legs[i];
    const bottom = o.tuck ? legTop + 3 : 29 - lift;
    fillRect(g, legX[i] + dx, legTop, 2, Math.max(2, bottom - legTop + 1), BODY);
  }

  fillEllipse(g, 14, bodyCy, 6.5, bodyRy, BODY);
  fillEllipse(g, 22, headCy, 5.5, 5, BODY);
  catEar(g, 19, headCy - 8 - (o.earTwitch || 0), headCy - 5, -1);
  catEar(g, 25, headCy - 8, headCy - 5, 1);

  outlinePass(g);
  shadePass(g);

  paintOver(g, 13, bodyCy + 2, 3.5, 1.6, LIGHT);
  paintOver(g, 25, headCy + 2, 2, 1.6, LIGHT);
  if (o.blink) fillRect(g, 22, headCy - 1, 2, 1, DARK);
  else {
    fillRect(g, 22, headCy - 1.5, 2, 2, DARK);
    px(g, 22, headCy - 1.5, WHITE);
  }
  px(g, 27, headCy + 1, PINK); // nose
  // whiskers
  px(g, 28, headCy + 2, OUT);
  px(g, 24, headCy + 3, OUT);
  if (o.collar) bandOver(g, 18, headCy + 3, 6, 2, COLLAR);
}

function catSit(g, o) {
  // classic upright cat silhouette
  const sway = o.tailSway || 0;
  tailCurve(g, [10, 28], [5.5, 27.5], [5 + sway, 23], BODY); // tail swishing on the ground
  fillEllipse(g, 14, 23.5, 5.5, 5, BODY); // haunch
  fillEllipse(g, 18, 18.5, 4, 7.5, BODY); // upright chest
  fillRect(g, 16, 24, 2, 6, BODY);
  fillRect(g, 20, 24, 2, 6, BODY);
  const hb = o.headBob || 0;
  fillEllipse(g, 20, 9.5 + hb, 5.5, 5, BODY);
  catEar(g, 17, 1.5 + hb, 4.5 + hb, -1);
  catEar(g, 23, 1.5 + hb, 4.5 + hb, 1);
  outlinePass(g);
  shadePass(g);
  paintOver(g, 18, 20, 2, 3.5, LIGHT); // chest
  if (o.blink) fillRect(g, 20, 8.5 + hb, 2, 1, DARK);
  else {
    fillRect(g, 20, 8 + hb, 2, 2, DARK);
    px(g, 20, 8 + hb, WHITE);
  }
  px(g, 25, 10.5 + hb, PINK);
  px(g, 26, 11.5 + hb, OUT); // whisker
  if (o.collar) bandOver(g, 16, 14 + hb, 8, 2, COLLAR);
}

function catFront(g, o) {
  const wag = o.wag || 0;
  // tail curls up beside the body
  tailCurve(g, [22, 26], [26.5, 23], [25 + wag, 17], BODY);
  fillEllipse(g, 16, 23.5, 6, 5, BODY);
  fillRect(g, 12, 26, 2, 4, BODY);
  fillRect(g, 18, 26, 2, 4, BODY);
  const hb = o.headBob || 0;
  fillEllipse(g, 16, 12 + hb, 6.5, 6, BODY);
  catEar(g, 12, 3 + hb, 7 + hb, -1);
  catEar(g, 20, 3 + hb, 7 + hb, 1);
  outlinePass(g);
  shadePass(g);
  const hy = 12 + hb;
  paintOver(g, 16, hy + 3, 2.6, 2, LIGHT);
  paintOver(g, 16, 24.5, 3, 2.2, LIGHT);
  if (o.blink) {
    fillRect(g, 12.5, hy - 1, 2, 1, DARK);
    fillRect(g, 18.5, hy - 1, 2, 1, DARK);
  } else {
    fillRect(g, 12.5, hy - 1.5, 2, 2, DARK);
    fillRect(g, 18.5, hy - 1.5, 2, 2, DARK);
    px(g, 12.5, hy - 1.5, WHITE);
    px(g, 18.5, hy - 1.5, WHITE);
  }
  px(g, 16, hy + 1.5, PINK); // nose
  px(g, 15, hy + 3, DARK); // mouth
  px(g, 17, hy + 3, DARK);
  px(g, 10.5, hy + 1.5, PINK); // blush
  px(g, 21.5, hy + 1.5, PINK);
  // whiskers
  px(g, 9, hy + 2.5, OUT);
  px(g, 23, hy + 2.5, OUT);
  if (o.collar) bandOver(g, 12, hy + 5, 9, 2, COLLAR);
}

// ---------------------------------------------------------------------------
// Slime (green) — squash & stretch blob, always front-facing
// ---------------------------------------------------------------------------
const SLIME_PALETTE = [
  [0, 0, 0, 0],
  hex("#2c6b32"), // outline
  hex("#6fce5a"), // body
  hex("#b6ef92"), // highlight
  hex("#4ba041"), // shade
  hex("#1d3f1f"), // eyes / mouth
  hex("#ffffff"),
  hex("#e8a3ab"),
  hex("#8fb7e8"),
];

function slimePaint(g, o) {
  // rx/ry squash-and-stretch; bottom pinned to 29 + rise (rise>0 = airborne)
  const rx = o.rx ?? 8;
  const ry = o.ry ?? 6;
  const rise = o.rise || 0;
  const cy = 29 - ry - rise;
  fillEllipse(g, 16, cy, rx, ry, BODY);
  // little peak on top (slime drip shape)
  fillRect(g, 15 + (o.peakDx || 0), cy - ry - 1, 2, 2, BODY);
  outlinePass(g);
  shadePass(g);
  paintOver(g, 16 - rx * 0.45, cy - ry * 0.4, rx * 0.28, ry * 0.28, LIGHT); // glossy highlight
  const ey = cy - 1;
  if (o.blink) {
    fillRect(g, 12, ey, 2, 1, DARK);
    fillRect(g, 18, ey, 2, 1, DARK);
  } else {
    fillRect(g, 12, ey - 1, 2, 2, DARK);
    fillRect(g, 18, ey - 1, 2, 2, DARK);
    px(g, 12, ey - 1, WHITE);
    px(g, 18, ey - 1, WHITE);
  }
  if (o.mouth === "open") fillRect(g, 15, ey + 2, 2, 2, DARK);
  else if (o.mouth === "sleep") fillRect(g, 15, ey + 2, 2, 1, DARK);
  else {
    px(g, 15, ey + 2, DARK);
    px(g, 16, ey + 2, DARK);
  }
  px(g, 10, ey + 1, PINK);
  px(g, 21, ey + 1, PINK);
}

// ---------------------------------------------------------------------------
// Frame tables — 8 frames per animation, all anchored to the same baseline
// ---------------------------------------------------------------------------
const S8 = (fn) => Array.from({ length: 8 }, (_, i) => fn(i));
const wave = (i, amp, phase = 0) => Math.round(amp * Math.sin((i / 8) * Math.PI * 2 + phase));

function sideFrames(draw, sitDraw, frontDraw) {
  return {
    idle: S8((i) =>
      draw({
        bob: i >= 3 && i <= 6 ? 1 : 0,
        tail: [wave(i, 1), wave(i, 1, 1)],
        tailSway: wave(i, 1.4),
        earFlop: i === 2 ? 1 : 0,
        earTwitch: i === 2 ? 1 : 0,
        blink: i === 6,
      }),
    ),
    walk: S8((i) => {
      const p = (i / 8) * Math.PI * 2;
      // diagonal leg pairs move in anti-phase, feet lift on the forward swing
      const swing = (ph) => {
        const s = Math.sin(p + ph);
        return [Math.round(2.2 * s), s > 0.35 ? 1 : 0];
      };
      return draw({
        bob: Math.abs(wave(i, 1, Math.PI / 2)),
        legs: [swing(0), swing(Math.PI), swing(Math.PI), swing(0)],
        tail: [wave(i, 1, 1), 0],
        tailSway: wave(i, 1),
      });
    }),
    sit: S8((i) =>
      sitDraw({
        tailSway: wave(i, 1.6),
        headBob: i >= 4 ? 1 : 0,
        blink: i === 5,
      }),
    ),
    sleep: S8((i) =>
      draw({
        lying: true,
        breath: i >= 4 ? 1 : 0,
      }),
    ),
    jump: [
      draw({ crouch: true }), // 0 wind up
      draw({ stretch: true, headBob: -1 }), // 1 launch
      draw({ tuck: true }), // 2 rising
      draw({ tuck: true, tail: [1, -1] }), // 3 rising
      draw({ tuck: true, tail: [1, 0] }), // 4 peak
      draw({ stretch: true }), // 5 falling, legs reaching
      draw({ stretch: true }), // 6 falling
      draw({ crouch: true }), // 7 landing squash
    ],
    look: S8((i) =>
      frontDraw({
        wag: i % 2 === 0 ? 1 : -1,
        headBob: i >= 4 ? 1 : 0,
        blink: i === 6,
      }),
    ),
  };
}

// Sleep frames need the Z's overlaid after drawing.
function withSleepZs(frames) {
  frames.sleep = frames.sleep.map((g, i) => {
    drawZs(g, Math.floor(i / 2) % 3);
    return g;
  });
  return frames;
}

function slimeFrames() {
  const idlePose = (i) => {
    const s = wave(i, 1, 0); // -1..1 squash cycle
    return slime({ rx: 8 + Math.max(0, s), ry: 6 - Math.max(0, s), blink: i === 6, peakDx: wave(i, 1, 1) });
  };
  const hop = [
    slime({ rx: 9, ry: 5 }), // squash before hop
    slime({ rx: 7, ry: 7 }), // stretch up
    slime({ rx: 7, ry: 7, rise: 2 }), // rising
    slime({ rx: 7.5, ry: 6.5, rise: 3 }), // peak
    slime({ rx: 7.5, ry: 6.5, rise: 2 }), // falling
    slime({ rx: 9, ry: 5 }), // land squash
    slime({ rx: 8.5, ry: 5.5 }), // recover
    slime({ rx: 8, ry: 6 }), // rest
  ];
  return {
    idle: S8(idlePose),
    walk: hop,
    sit: S8((i) => slime({ rx: 9, ry: 5, blink: i === 5, peakDx: wave(i, 1) })),
    sleep: withSleepZsSlime(
      S8((i) => slime({ rx: 10, ry: 4 + (i >= 4 ? 1 : 0), blink: true, mouth: "sleep" })),
    ),
    jump: [
      slime({ rx: 10, ry: 4 }), // deep squash
      slime({ rx: 6.5, ry: 8 }), // big stretch
      slime({ rx: 6.5, ry: 8, rise: 2 }),
      slime({ rx: 7, ry: 7, rise: 3 }),
      slime({ rx: 7, ry: 7, rise: 3 }),
      slime({ rx: 7, ry: 7.5, rise: 2 }),
      slime({ rx: 10, ry: 4 }), // land splat
      slime({ rx: 8.5, ry: 5.5 }),
    ],
    look: S8((i) => slime({ rx: 8, ry: 6 + (i % 2), mouth: "open", peakDx: wave(i, 1) })),
  };
}
function withSleepZsSlime(frames) {
  return frames.map((g, i) => {
    drawZs(g, Math.floor(i / 2) % 3);
    return g;
  });
}

// ---------------------------------------------------------------------------
// Sheet assembly
// ---------------------------------------------------------------------------
const ROW_ORDER = ["idle", "walk", "sit", "sleep", "jump", "look"];

function composeSheet(frames, palette) {
  const W = COLS * G * SCALE;
  const H = ROWS * G * SCALE;
  const rgba = Buffer.alloc(W * H * 4); // zero = transparent
  ROW_ORDER.forEach((anim, row) => {
    const list = frames[anim];
    for (let col = 0; col < COLS; col++) {
      const g = list[col % list.length];
      for (let y = 0; y < G; y++) {
        for (let x = 0; x < G; x++) {
          const c = g[y * G + x];
          if (c === T) continue;
          const [r, gg, b, a] = palette[c];
          for (let sy = 0; sy < SCALE; sy++) {
            for (let sx = 0; sx < SCALE; sx++) {
              const ox = (col * G + x) * SCALE + sx;
              const oy = (row * G + y) * SCALE + sy;
              const idx = (oy * W + ox) * 4;
              rgba[idx] = r;
              rgba[idx + 1] = gg;
              rgba[idx + 2] = b;
              rgba[idx + 3] = a;
            }
          }
        }
      }
    }
  });
  return encodePNG(W, H, rgba);
}

// Turn a painter fn(g, opts) into fn(opts) -> grid, with a baked-in per-variant
// style (collar, ear shape) merged under the per-frame opts.
const wrap = (painter, style = {}) => (o = {}) => {
  const g = grid();
  painter(g, { ...style, ...o });
  return g;
};
const slime = wrap(slimePaint);

mkdirSync(OUT_DIR, { recursive: true });

// The six Stardew-style pets (see reference image): three cats, three dogs.
// Palette: outline, body, light (chest/muzzle), shade, collar.
const VARIANTS = [
  {
    file: "cat_orange.png",
    kind: "cat",
    style: {},
    palette: makePalette("#6b2a12", "#e0862e", "#f8e3b8", "#a84c16", "#c8281e"),
  },
  {
    file: "cat_gray.png",
    kind: "cat",
    style: {},
    palette: makePalette("#3a332e", "#8b8071", "#ece2d0", "#5e564b", "#c8281e"),
  },
  {
    file: "cat_yellow.png",
    kind: "cat",
    style: { collar: true },
    palette: makePalette("#7a4a10", "#edb44a", "#f9e6ae", "#c07c22", "#7a4fc0"),
  },
  {
    // German shepherd: tan coat, dark saddle back + ear tips, red collar
    file: "dog_darkbrown.png",
    kind: "dog",
    style: { collar: true, pointyEars: true, saddle: true, darkEars: true },
    palette: makePalette("#1f1006", "#9a6a33", "#d9ae67", "#46280e", "#c8281e"),
  },
  {
    // Shiba: orange coat, cream chest/belly/socks, curled tail, blue collar
    file: "dog_brown.png",
    kind: "dog",
    style: { collar: true, pointyEars: true, curlTail: true, socks: true },
    palette: makePalette("#33190a", "#de8a33", "#f6e7c8", "#b05e14", "#3b55c9"),
  },
  {
    // Golden puppy: cream coat, brown floppy ears, white socks, red collar
    file: "dog_cream.png",
    kind: "dog",
    style: { collar: true, darkEars: true, socks: true },
    palette: makePalette("#2b1a0a", "#e9cb95", "#f8eed6", "#96662f", "#cf2f2a"),
  },
  {
    // Husky: gray coat, white face mask/chest/paws, dark saddle, curled tail
    file: "dog_husky.png",
    kind: "dog",
    style: { pointyEars: true, curlTail: true, saddle: true, mask: true, socks: true, darkEars: true },
    palette: makePalette("#16151c", "#9aa2b0", "#eef1f5", "#5f6674", "#3b7bc9"),
  },
];

const PAINTERS = {
  cat: [catSide, catSit, catFront],
  dog: [dogSide, dogSit, dogFront],
};

for (const v of VARIANTS) {
  const [side, sit, front] = PAINTERS[v.kind];
  const frames = withSleepZs(
    sideFrames(wrap(side, v.style), wrap(sit, v.style), wrap(front, v.style)),
  );
  writeFileSync(join(OUT_DIR, v.file), composeSheet(frames, v.palette));
}

// slime uses its own frame table; adapt slime() to painter form first
writeFileSync(join(OUT_DIR, "slime_green.png"), composeSheet(slimeFrames(), SLIME_PALETTE));

console.log(
  "Wrote",
  [...VARIANTS.map((v) => v.file), "slime_green.png"].join(", "),
  "to",
  OUT_DIR,
);
