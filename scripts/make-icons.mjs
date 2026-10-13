// Renders the extension icon (a wide-eyed smiley seen through a fisheye lens)
// to src/icons/icon{16,32,48,128}.png. Pure Node, no dependencies:
// every output pixel is supersampled, each sample is pushed through the same
// bulge formula the Fisheye filter uses (src/warp.js), and the vector face is
// evaluated at the resulting point.
//
// Usage: npm run icons

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src', 'icons');
const SIZES = [16, 32, 48, 128];

// All geometry is in a 100×100 design space.
const LENS = { x: 50, y: 47, r: 50, s: 0.55 };
const FACE_SCALE = 0.84; // keeps the bulged outline inside the canvas

const BROWN = [107, 61, 0];

// ---------- Small vector helpers ----------

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a + (b - a) * t;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function gradient(stops, t) {
  t = clamp01(t);
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    const [t0, c0] = stops[i - 1];
    if (t <= t1) {
      const k = (t - t0) / (t1 - t0 || 1);
      return c0.map((v, j) => lerp(v, c1[j], k));
    }
  }
  return stops.at(-1)[1];
}

function quadPoints(p0, p1, p2, n = 24) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
  return pts;
}

function distToPolyline(x, y, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const dx = bx - ax;
    const dy = by - ay;
    const t = clamp01(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

// Normalized ellipse "radius": < 1 inside, 1 on the outline.
const ellipseR = (x, y, cx, cy, rx, ry) => Math.hypot((x - cx) / rx, (y - cy) / ry);

// ---------- The face ----------

const BODY = [
  [0, hex('#fff3a6')],
  [0.45, hex('#ffd43b')],
  [0.85, hex('#f6a800')],
  [1, hex('#e08a00')],
];
const BROWS = [quadPoints([19, 24], [28, 15], [39, 17]), quadPoints([61, 17], [72, 15], [81, 24])];
const MOUTH = quadPoints([43, 77], [50, 76], [57, 77]);
const EYES = [
  { x: 31, pupil: 26 },
  { x: 69, pupil: 74 },
];

/** Paint `color` with `alpha` over the running [r, g, b, a] (straight alpha). */
function over(dst, color, alpha) {
  if (alpha <= 0) return;
  const a = alpha + dst[3] * (1 - alpha);
  for (let i = 0; i < 3; i++) dst[i] = (color[i] * alpha + dst[i] * dst[3] * (1 - alpha)) / a;
  dst[3] = a;
}

/** Colour of the unwarped face at design-space point (x, y). */
function face(x, y) {
  const px = [0, 0, 0, 0];
  if (Math.hypot(x - 50, y - 50) > 46) return px;

  // Glossy body: light from the upper left.
  over(px, gradient(BODY, Math.hypot(x - 42, y - 35) / 58), 1);
  // Blush.
  for (const cx of [26, 74]) over(px, [255, 120, 80], 0.35 * clamp01(1 - Math.hypot(x - cx, y - 70) / 14));
  // Raised brows.
  for (const brow of BROWS) if (distToPolyline(x, y, brow) < 1.6) over(px, BROWN, 1);
  // Wide eyes with a soft rim and small pupils glancing apart.
  for (const eye of EYES) {
    const e = ellipseR(x, y, eye.x, 44, 14, 15);
    if (e < 1) over(px, [255, 255, 255], 1);
    if (Math.abs(e - 1) * 14.5 < 0.8) over(px, [110, 80, 20], 0.55);
    if (ellipseR(x, y, eye.pupil, 46, 4.2, 5.6) < 1) over(px, [17, 17, 17], 1);
  }
  // Small flat mouth.
  if (distToPolyline(x, y, MOUTH) < 1.5) over(px, BROWN, 1);
  return px;
}

/** Same bulge as the warp shader: where an output point samples from. */
function unlens(x, y) {
  let dx = x - LENS.x;
  let dy = y - LENS.y;
  const d = Math.hypot(dx, dy) / LENS.r;
  if (d < 1) {
    const f = 1 - d * d;
    const k = 1 - LENS.s * f * f;
    dx *= k;
    dy *= k;
  }
  return [LENS.x + dx, LENS.y + dy];
}

/** Final icon colour at output point (x, y): lensed face plus a glass glint. */
function icon(x, y) {
  const [lx, ly] = unlens(x, y);
  const px = face(50 + (lx - 50) / FACE_SCALE, 50 + (ly - 50) / FACE_SCALE);
  if (px[3] > 0) {
    // Glint, rotated ellipse at (35, 18).
    const c = Math.cos(0.35);
    const s = Math.sin(0.35);
    const gx = (x - 35) * c - (y - 18) * s;
    const gy = (x - 35) * s + (y - 18) * c;
    if (ellipseR(gx, gy, 0, 0, 13, 6) < 1) over(px, [255, 255, 255], 0.75 * clamp01(1 - Math.hypot(x - 35, y - 18) / 14));
  }
  return px;
}

// ---------- Rasterise ----------

function render(size) {
  const ss = Math.max(4, Math.ceil(256 / size)); // samples per axis
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Average in premultiplied space so edges don't pick up dark fringes.
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = icon(((px + (sx + 0.5) / ss) / size) * 100, ((py + (sy + 0.5) / ss) / size) * 100);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const o = (py * size + px) * 4;
      if (a > 0) {
        rgba[o] = Math.round(r / a);
        rgba[o + 1] = Math.round(g / a);
        rgba[o + 2] = Math.round(b / a);
      }
      rgba[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return rgba;
}

// ---------- PNG encoding ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, png(size, render(size)));
  console.log(`wrote ${path.relative(root, file)}`);
}
