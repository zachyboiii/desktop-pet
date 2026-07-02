// gen-sprites.mjs — procedurally generates the pet sprite sheets.
//
// Every frame of an animation is drawn from the SAME parametric rig (only the
// pose parameters change between frames), so body parts never drift or resize
// between frames — that's what makes the animation smooth.
//
// Sheet layout (consumed by src/pet-canvas/PetEngine.js):
//   8 columns x 5 rows, 64x64 px frames (drawn at 32x32, upscaled 2x)
//   row 0: idle   row 1: walk   row 2: sleep   row 3: jump   row 4: look
//
// Usage: node scripts/gen-sprites.mjs

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LW = 32; // logical frame size (pixels we actually draw)
const SCALE = 2; // upscale factor -> 64x64 output frames
const COLS = 8;
const ROWS = 5;
const TAU = Math.PI * 2;

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "sprites");

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA, no deps — zlib is built into Node)
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

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // Prepend filter byte 0 to each scanline.
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Frame drawing surface (32x32 logical pixels)
// ---------------------------------------------------------------------------
class Frame {
  constructor() {
    this.d = new Uint8Array(LW * LW * 4);
  }
  px(x, y, c) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= LW || y >= LW) return;
    const i = (y * LW + x) * 4;
    this.d[i] = c[0];
    this.d[i + 1] = c[1];
    this.d[i + 2] = c[2];
    this.d[i + 3] = c.length > 3 ? c[3] : 255;
  }
  alphaAt(x, y) {
    if (x < 0 || y < 0 || x >= LW || y >= LW) return 0;
    return this.d[(y * LW + x) * 4 + 3];
  }
  rect(x, y, w, h, c) {
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) this.px(x + xx, y + yy, c);
  }
  ellipse(cx, cy, rx, ry, c) {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1.02) this.px(x, y, c);
      }
    }
  }
  // 1px auto-outline: any empty pixel touching a filled one becomes `color`.
  outline(color) {
    const before = this.d.slice();
    const a = (x, y) => (x < 0 || y < 0 || x >= LW || y >= LW ? 0 : before[(y * LW + x) * 4 + 3]);
    for (let y = 0; y < LW; y++) {
      for (let x = 0; x < LW; x++) {
        if (a(x, y) > 0) continue;
        if (a(x - 1, y) || a(x + 1, y) || a(x, y - 1) || a(x, y + 1)) this.px(x, y, color);
      }
    }
  }
}

// Small "z" glyph for the sleep animation.
function drawZ(f, x, y, c) {
  f.px(x, y, c);
  f.px(x + 1, y, c);
  f.px(x + 2, y, c);
  f.px(x + 1, y + 1, c);
  f.px(x, y + 2, c);
  f.px(x + 1, y + 2, c);
  f.px(x + 2, y + 2, c);
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------
const DOG = {
  body: [201, 141, 92],
  dark: [150, 96, 58], // ears / patches
  cream: [246, 231, 200], // muzzle / belly / paws
  outline: [92, 55, 34],
  eye: [43, 27, 18],
  nose: [61, 36, 23],
  blush: [235, 152, 152],
  tongue: [238, 128, 128],
  z: [140, 160, 220],
};

const CAT = {
  body: [182, 190, 205],
  dark: [126, 133, 150], // stripes / ear backs
  cream: [245, 242, 236], // muzzle / belly
  innerEar: [240, 178, 194],
  outline: [70, 74, 92],
  eye: [52, 48, 66],
  nose: [226, 135, 155],
  blush: [240, 165, 170],
  tongue: [238, 128, 128],
  z: [140, 160, 220],
};

const SLIME = {
  body: [126, 214, 100],
  dark: [86, 168, 66],
  light: [196, 240, 160],
  outline: [52, 110, 44],
  eye: [42, 66, 34],
  blush: [250, 170, 190],
  z: [140, 160, 220],
};

// ===========================================================================
// DOG (also reused for the cat via `kind`)
// ===========================================================================
// Shared quadruped rig. `pose` fields:
//   bounce   vertical body offset (px, up is negative applied to parts)
//   legLift  [backA, backB, frontA, frontB] leg lift in px (0 = planted)
//   tail     tail sway -1..1
//   blink    true = eyes closed
//   earFlop  0..1 extra ear droop/lift
function drawQuadruped(f, P, kind, pose) {
  const {
    bounce = 0,
    legLift = [0, 0, 0, 0],
    tail = 0,
    blink = false,
    earFlop = 0,
  } = pose;
  const GY = 30; // ground line
  const by = 24 + bounce; // body center y

  // --- tail (behind body) ---
  if (kind === "dog") {
    // Short wagging tail poking up from the rump.
    const t = Math.round(tail * 2);
    f.px(6, by - 3, P.dark);
    f.px(5 + t * 0.5, by - 4, P.dark);
    f.px(5 + t, by - 5, P.dark);
    f.px(5 + t, by - 6, P.dark);
  } else {
    // Long cat tail curling up behind.
    const t = tail; // -1..1
    f.px(6, by - 2, P.dark);
    f.px(5, by - 3, P.dark);
    f.px(4 + Math.round(t), by - 4, P.dark);
    f.px(4 + Math.round(t * 1.5), by - 5, P.dark);
    f.px(4 + Math.round(t * 2), by - 6, P.dark);
    f.px(5 + Math.round(t * 2), by - 7, P.dark);
  }

  // --- legs (drawn before body so the body overlaps their tops) ---
  // Far pair drawn in the dark shade, near pair in body color.
  const legs = [
    { x: 9, lift: legLift[0], c: P.dark }, // back far
    { x: 12, lift: legLift[1], c: P.body }, // back near
    { x: 15, lift: legLift[2], c: P.dark }, // front far
    { x: 18, lift: legLift[3], c: P.body }, // front near
  ];
  for (const leg of legs) {
    const top = by + 2;
    const bottom = GY - leg.lift;
    for (let y = top; y <= bottom; y++) f.rect(leg.x, y, 2, 1, leg.c);
    // paw
    f.rect(leg.x, bottom, 2, 1, P.cream);
  }

  // --- body ---
  f.ellipse(13, by, 6.5, 4.5, P.body);
  f.ellipse(13, by + 2, 4.5, 2.2, P.cream); // belly

  // --- head (big = cute) ---
  const hx = 21;
  const hy = 13.5 + bounce;
  f.ellipse(hx, hy, 6.8, 6.2, P.body);

  // --- ears ---
  if (kind === "dog") {
    // Floppy ears hanging at the sides of the head; flop lifts them slightly.
    const lift = Math.round(earFlop * 2);
    f.ellipse(hx - 5.5, hy - 3 + 2 - lift, 1.8, 3.4, P.dark);
    f.ellipse(hx + 5.5, hy - 3 + 2 - lift, 1.8, 3.4, P.dark);
  } else {
    // Pointy cat ears on top of the head.
    const lift = Math.round(earFlop);
    for (let i = 0; i < 4; i++) {
      // left ear triangle
      f.rect(hx - 6 + i, hy - 4 - i - lift, 4 - i, 1, P.body);
      // right ear triangle
      f.rect(hx + 3, hy - 4 - i - lift, 4 - i, 1, P.body);
    }
    f.px(hx - 4, hy - 5 - lift, P.innerEar);
    f.px(hx + 5, hy - 5 - lift, P.innerEar);
  }

  // --- face ---
  const ey = hy - 0.5;
  if (blink) {
    f.rect(hx - 4, ey + 1, 2, 1, P.eye);
    f.rect(hx + 3, ey + 1, 2, 1, P.eye);
  } else {
    f.rect(hx - 4, ey, 2, 2, P.eye);
    f.rect(hx + 3, ey, 2, 2, P.eye);
    // eye sparkle
    f.px(hx - 3, ey, [255, 255, 255]);
    f.px(hx + 4, ey, [255, 255, 255]);
  }
  // muzzle + nose
  f.ellipse(hx + 0.5, hy + 3.5, 2.8, 2, P.cream);
  f.rect(hx, hy + 2.5, 2, 1, P.nose);
  // blush
  f.px(hx - 5, hy + 3, P.blush);
  f.px(hx + 6, hy + 3, P.blush);
  // cat whiskers
  if (kind === "cat") {
    f.px(hx - 7, hy + 2, P.dark);
    f.px(hx + 8, hy + 2, P.dark);
  }
}

// Curled-up sleeping pose (own rig — but identical across its 8 frames except
// for the breathing parameter, so it stays perfectly smooth).
function drawQuadrupedSleep(f, P, kind, t) {
  const breath = Math.sin(t * TAU); // -1..1
  const ry = 4.2 + breath * 0.55;
  const GY = 30;
  // curled body
  f.ellipse(15, GY - ry + 0.5, 8.5, ry, P.body);
  // head resting on the near side
  const hy = GY - 3.5 - breath * 0.4;
  f.ellipse(21, hy, 5, 4, P.body);
  if (kind === "dog") {
    f.ellipse(17, hy - 1, 1.6, 2.8, P.dark);
    f.ellipse(25, hy - 1, 1.6, 2.8, P.dark);
  } else {
    for (let i = 0; i < 3; i++) {
      f.rect(17 - i * 0 + 0, hy - 4 - i + 2, 3 - i, 1, P.body);
      f.rect(24, hy - 4 - i + 2, 3 - i, 1, P.body);
    }
    // tail wrapped around the front
    f.ellipse(10, GY - 1.5, 4, 1.4, P.dark);
  }
  // closed eyes
  f.rect(19, hy, 2, 1, P.eye);
  f.rect(24, hy, 2, 1, P.eye);
  // muzzle
  f.ellipse(22, hy + 2, 2.2, 1.5, P.cream);
  // z's drift up-right and loop
  const zt = t % 1;
  drawZ(f, 26, 12 - Math.round(zt * 6), P.z);
  if (zt > 0.45) drawZ(f, 28, 18 - Math.round((zt - 0.45) * 6), P.z);
}

// Front-facing "look at the user" pose for the click interaction.
function drawQuadrupedLook(f, P, kind, t) {
  const bounce = Math.round(Math.abs(Math.sin(t * TAU)) * -1); // little hop of joy
  const GY = 30;
  const by = 25 + bounce;
  // small front-facing body
  f.ellipse(16, by, 5.5, 4, P.body);
  f.ellipse(16, by + 1.5, 3.5, 2.2, P.cream);
  // front paws
  f.rect(13, GY - 1, 2, 1, P.cream);
  f.rect(17, GY - 1, 2, 1, P.cream);
  // big head facing the viewer
  const hy = 13 + bounce;
  f.ellipse(16, hy, 7.5, 6.8, P.body);
  if (kind === "dog") {
    const flap = Math.round(Math.sin(t * TAU) * 1);
    f.ellipse(9.5, hy - 1 + flap * 0.5, 2, 3.8, P.dark);
    f.ellipse(22.5, hy - 1 - flap * 0.5, 2, 3.8, P.dark);
  } else {
    for (let i = 0; i < 4; i++) {
      f.rect(10 + i, hy - 6 - i, 4 - i, 1, P.body);
      f.rect(18, hy - 6 - i, 4 - i, 1, P.body);
    }
    f.px(12, hy - 7, P.innerEar);
    f.px(19, hy - 7, P.innerEar);
  }
  // sparkly happy eyes (blink once per loop)
  const blink = t > 0.68 && t < 0.8;
  if (blink) {
    f.rect(11, hy - 1, 3, 1, P.eye);
    f.rect(18, hy - 1, 3, 1, P.eye);
  } else {
    f.rect(11, hy - 2, 3, 3, P.eye);
    f.rect(18, hy - 2, 3, 3, P.eye);
    f.px(12, hy - 2, [255, 255, 255]);
    f.px(19, hy - 2, [255, 255, 255]);
    f.px(11, hy - 1, [255, 255, 255, 140]);
    f.px(18, hy - 1, [255, 255, 255, 140]);
  }
  // open happy mouth + tongue
  f.ellipse(16, hy + 3.5, 2.4, 1.8, P.cream);
  f.rect(15, hy + 3, 2, 1, P.nose);
  f.rect(15, hy + 4.5, 2, 1, P.tongue);
  // blush
  f.rect(9, hy + 2, 2, 1, P.blush);
  f.rect(21, hy + 2, 2, 1, P.blush);
  // wagging tail peeking out the side
  const wag = Math.round(Math.sin(t * TAU * 2) * 2);
  f.px(23 + wag * 0.5, by - 1, P.dark);
  f.px(24 + wag, by - 2, P.dark);
  if (kind === "cat") f.px(24 + wag, by - 3, P.dark);
  // whiskers
  if (kind === "cat") {
    f.px(7, hy + 1, P.dark);
    f.px(24, hy + 1, P.dark);
  }
}

// Mid-air poses for the jump row (plays once: crouch -> launch -> tuck -> fall).
function drawQuadrupedJump(f, P, kind, i) {
  // i: 0..7
  if (i === 0 || i === 1) {
    // crouch: squashed body, bent legs
    drawQuadruped(f, P, kind, {
      bounce: i === 0 ? 2 : 1,
      legLift: [0, 0, 0, 0],
      tail: -0.5,
      earFlop: 0,
    });
  } else if (i === 2 || i === 3) {
    // launch: stretched up, legs extended back/front, ears up
    drawQuadruped(f, P, kind, {
      bounce: -2,
      legLift: [3, 2, 3, 2],
      tail: 1,
      earFlop: 1,
    });
  } else if (i === 4 || i === 5) {
    // tucked airborne
    drawQuadruped(f, P, kind, {
      bounce: -1,
      legLift: [4, 4, 4, 4],
      tail: 0.5,
      earFlop: 1,
    });
  } else {
    // falling: legs reaching for the ground, ears floating up
    drawQuadruped(f, P, kind, {
      bounce: 0,
      legLift: [1, 0, 1, 0],
      tail: 0,
      earFlop: 0.6,
    });
  }
}

function quadrupedRows(P, kind) {
  return {
    // row 0: idle — gentle breathing bounce, tail sway, blink near the end
    idle: (f, i, t) =>
      drawQuadruped(f, P, kind, {
        bounce: Math.round(Math.sin(t * TAU) * -0.9),
        tail: Math.sin(t * TAU) * 0.8,
        blink: i === 6,
        earFlop: 0,
      }),
    // row 1: walk — 8-frame leg cycle with body bob
    walk: (f, i, t) => {
      const lift = (ph) => Math.max(0, Math.sin(t * TAU + ph)) * 2.2;
      drawQuadruped(f, P, kind, {
        bounce: Math.round(Math.abs(Math.sin(t * TAU * 2)) * -1),
        // diagonal gait: back-far with front-near, back-near with front-far
        legLift: [lift(0), lift(Math.PI), lift(Math.PI), lift(0)],
        tail: Math.sin(t * TAU * 2) * 0.7,
        earFlop: Math.abs(Math.sin(t * TAU * 2)) * 0.5,
      });
    },
    // row 2: sleep
    sleep: (f, i, t) => drawQuadrupedSleep(f, P, kind, t),
    // row 3: jump (non-looping)
    jump: (f, i) => drawQuadrupedJump(f, P, kind, i),
    // row 4: look (click reaction)
    look: (f, i, t) => drawQuadrupedLook(f, P, kind, t),
  };
}

// ===========================================================================
// SLIME — squash & stretch is inherently smooth
// ===========================================================================
function drawSlimeBody(f, P, squash, yOff = 0, faceY = 0, happy = false, blink = false) {
  const GY = 30;
  // squash > 0 = flatter+wider, squash < 0 = taller+narrower
  const ry = 6.5 - squash * 1.8;
  const rx = 7.5 + squash * 1.8;
  const cy = GY - ry + yOff;
  f.ellipse(16, cy, rx, ry, P.body);
  // top highlight
  f.ellipse(13, cy - ry * 0.45, rx * 0.3, ry * 0.28, P.light);
  // face
  const ey = cy - 0.5 + faceY;
  if (blink) {
    f.rect(12, ey + 1, 2, 1, P.eye);
    f.rect(18, ey + 1, 2, 1, P.eye);
  } else {
    f.rect(12, ey, 2, 2, P.eye);
    f.rect(18, ey, 2, 2, P.eye);
    f.px(13, ey, [255, 255, 255]);
    f.px(19, ey, [255, 255, 255]);
  }
  if (happy) {
    // open smile
    f.rect(14, ey + 3, 4, 1, P.eye);
    f.rect(15, ey + 4, 2, 1, P.eye);
  } else {
    f.rect(15, ey + 3, 2, 1, P.eye);
  }
  f.px(10, ey + 2, P.blush);
  f.px(21, ey + 2, P.blush);
}

const SLIME_ROWS = {
  idle: (f, i, t) => {
    const s = Math.sin(t * TAU) * 0.35;
    drawSlimeBody(f, SLIME, s, 0, 0, false, i === 6);
  },
  // walk: little forward-leaning hops
  walk: (f, i, t) => {
    const hop = Math.max(0, Math.sin(t * TAU));
    const squash = hop > 0.1 ? -0.5 * hop : 0.6; // stretch in air, squash on floor
    drawSlimeBody(f, SLIME, squash, Math.round(-hop * 3), 0, false, false);
  },
  sleep: (f, i, t) => {
    const breath = Math.sin(t * TAU) * 0.25;
    drawSlimeBody(f, SLIME, 0.9 + breath, 0, 1, false, true);
    const zt = t % 1;
    drawZ(f, 25, 14 - Math.round(zt * 6), SLIME.z);
    if (zt > 0.45) drawZ(f, 27, 20 - Math.round((zt - 0.45) * 6), SLIME.z);
  },
  jump: (f, i) => {
    const squash = [1.1, 0.7, -0.9, -1.1, -0.5, -0.2, 0.2, 0.5][i];
    drawSlimeBody(f, SLIME, squash, 0, 0, false, false);
  },
  look: (f, i, t) => {
    const s = Math.abs(Math.sin(t * TAU)) * -0.6; // excited bouncing
    drawSlimeBody(f, SLIME, s, 0, -1, true, t > 0.68 && t < 0.8);
    // sparkle
    const sx = 25;
    const sy = 12 + Math.round(Math.sin(t * TAU) * 1);
    f.px(sx, sy, [255, 240, 150]);
    f.px(sx - 1, sy, [255, 240, 150, 160]);
    f.px(sx + 1, sy, [255, 240, 150, 160]);
    f.px(sx, sy - 1, [255, 240, 150, 160]);
    f.px(sx, sy + 1, [255, 240, 150, 160]);
  },
};

// ===========================================================================
// Sheet assembly
// ===========================================================================
const ROW_ORDER = ["idle", "walk", "sleep", "jump", "look"];

function buildSheet(rows, outlineColor) {
  const W = COLS * LW * SCALE;
  const H = ROWS * LW * SCALE;
  const sheet = Buffer.alloc(W * H * 4);
  ROW_ORDER.forEach((key, row) => {
    for (let col = 0; col < COLS; col++) {
      const frame = new Frame();
      rows[key](frame, col, col / COLS);
      frame.outline(outlineColor);
      // blit with SCALE-x nearest-neighbor upscale
      for (let y = 0; y < LW; y++) {
        for (let x = 0; x < LW; x++) {
          const si = (y * LW + x) * 4;
          if (frame.d[si + 3] === 0) continue;
          for (let dy = 0; dy < SCALE; dy++) {
            for (let dx = 0; dx < SCALE; dx++) {
              const ox = col * LW * SCALE + x * SCALE + dx;
              const oy = row * LW * SCALE + y * SCALE + dy;
              const di = (oy * W + ox) * 4;
              sheet[di] = frame.d[si];
              sheet[di + 1] = frame.d[si + 1];
              sheet[di + 2] = frame.d[si + 2];
              sheet[di + 3] = frame.d[si + 3];
            }
          }
        }
      }
    }
  });
  return encodePNG(W, H, sheet);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const SHEETS = {
  "dog_brown.png": () => buildSheet(quadrupedRows(DOG, "dog"), DOG.outline),
  "cat_gray.png": () => buildSheet(quadrupedRows(CAT, "cat"), CAT.outline),
  "slime_green.png": () => buildSheet(SLIME_ROWS, SLIME.outline),
};

for (const [name, build] of Object.entries(SHEETS)) {
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, build());
  console.log("wrote", file);
}
