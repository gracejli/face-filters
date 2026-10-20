// Filters are drawn procedurally with Canvas 2D paths, so they stay sharp at
// any size and need no image assets.
//
// Every sticker is drawn in a face-local frame: the origin sits on an anchor
// landmark, the x axis runs along the eye line, and 1 unit = the distance
// between the outer eye corners (landmarks 33 and 263). Negative y is "up"
// the face. That makes all the numbers below independent of image size,
// face size and head roll.

// MediaPipe Face Mesh landmark indices.
export const LM = {
  rightEyeOuter: 33, // subject's right eye, appears on the image's left
  leftEyeOuter: 263,
  forehead: 10,
  noseTip: 1,
  upperLipInner: 13,
  lowerLipInner: 14,
  betweenEyes: 168,
  rightIris: 468,
  leftIris: 473,
  chin: 152,
  jawLeft: 172,
  jawRight: 397,
};

// Face outline, in order around the face (MediaPipe FACEMESH_FACE_OVAL).
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
];

/** Scale, roll and anchors for one face, from pixel-space landmarks. */
export function faceFrame(pts) {
  const r = pts[LM.rightEyeOuter];
  const l = pts[LM.leftEyeOuter];
  const dx = l.x - r.x;
  const dy = l.y - r.y;
  const eyeDist = Math.hypot(dx, dy);
  const mouthOpen = Math.hypot(pts[LM.lowerLipInner].x - pts[LM.upperLipInner].x, pts[LM.lowerLipInner].y - pts[LM.upperLipInner].y) / (eyeDist || 1);
  return {
    eyeDist,
    angle: Math.atan2(dy, dx),
    eyeMid: { x: (r.x + l.x) / 2, y: (r.y + l.y) / 2 },
    forehead: pts[LM.forehead],
    noseTip: pts[LM.noseTip],
    lowerLip: pts[LM.lowerLipInner],
    mouthOpen,
  };
}

function inFrame(ctx, anchor, face, draw) {
  ctx.save();
  ctx.translate(anchor.x, anchor.y);
  ctx.rotate(face.angle);
  ctx.scale(face.eyeDist, face.eyeDist);
  draw();
  ctx.restore();
}

// ---------- Dog ----------

function dogEar(ctx, side) {
  ctx.save();
  // Sit above and outside the forehead, tilted outward.
  ctx.translate(side * 0.72, -0.42);
  ctx.rotate(side * 0.45);

  const outer = new Path2D();
  outer.moveTo(0, -0.62);
  outer.bezierCurveTo(side * 0.42, -0.6, side * 0.48, 0.05, side * 0.26, 0.42);
  outer.bezierCurveTo(side * 0.12, 0.62, -side * 0.2, 0.55, -side * 0.24, 0.18);
  outer.bezierCurveTo(-side * 0.28, -0.2, -side * 0.24, -0.62, 0, -0.62);
  const g = ctx.createLinearGradient(0, -0.6, 0, 0.6);
  g.addColorStop(0, '#a0673a');
  g.addColorStop(1, '#6b3f1d');
  ctx.fillStyle = g;
  ctx.fill(outer);
  ctx.lineWidth = 0.03;
  ctx.strokeStyle = 'rgba(40, 20, 5, 0.6)';
  ctx.stroke(outer);

  ctx.save();
  ctx.translate(side * 0.02, 0.02);
  ctx.scale(0.58, 0.68);
  ctx.fillStyle = '#e9a3a3';
  ctx.fill(outer);
  ctx.restore();
  ctx.restore();
}

function dogNose(ctx) {
  ctx.beginPath();
  ctx.moveTo(-0.26, -0.1);
  ctx.bezierCurveTo(-0.26, -0.24, 0.26, -0.24, 0.26, -0.1);
  ctx.bezierCurveTo(0.26, 0.04, 0.09, 0.17, 0, 0.17);
  ctx.bezierCurveTo(-0.09, 0.17, -0.26, 0.04, -0.26, -0.1);
  ctx.fillStyle = '#1d1a1a';
  ctx.fill();

  ctx.beginPath();
  ctx.ellipse(-0.09, -0.11, 0.08, 0.04, -0.2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.fill();
}

function dogTongue(ctx, open) {
  const len = Math.min(0.9, 0.25 + open * 2.2);
  ctx.beginPath();
  ctx.moveTo(-0.17, 0);
  ctx.lineTo(-0.17, len - 0.17);
  ctx.arc(0, len - 0.17, 0.17, Math.PI, 0, true);
  ctx.lineTo(0.17, 0);
  ctx.closePath();
  ctx.fillStyle = '#ec6f86';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, 0.05);
  ctx.lineTo(0, len - 0.15);
  ctx.lineWidth = 0.025;
  ctx.strokeStyle = '#c24c63';
  ctx.stroke();
}

function drawDog(ctx, face) {
  inFrame(ctx, face.forehead, face, () => {
    dogEar(ctx, -1);
    dogEar(ctx, 1);
  });
  // Tongue first so the nose never ends up underneath it.
  if (face.mouthOpen > 0.12) inFrame(ctx, face.lowerLip, face, () => dogTongue(ctx, face.mouthOpen));
  inFrame(ctx, face.noseTip, face, () => dogNose(ctx));
}

// ---------- Cat ----------

function catEar(ctx, side) {
  ctx.save();
  ctx.translate(side * 0.6, -0.38);
  ctx.rotate(side * 0.3);
  ctx.beginPath();
  ctx.moveTo(-0.28, 0.2);
  ctx.quadraticCurveTo(-0.08, -0.4, 0, -0.62);
  ctx.quadraticCurveTo(0.08, -0.4, 0.28, 0.2);
  ctx.closePath();
  ctx.fillStyle = '#3a3a3f';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-0.15, 0.14);
  ctx.quadraticCurveTo(-0.04, -0.25, 0, -0.42);
  ctx.quadraticCurveTo(0.04, -0.25, 0.15, 0.14);
  ctx.closePath();
  ctx.fillStyle = '#f2a7bb';
  ctx.fill();
  ctx.restore();
}

function catNose(ctx) {
  ctx.beginPath();
  ctx.moveTo(-0.11, -0.06);
  ctx.quadraticCurveTo(0, -0.11, 0.11, -0.06);
  ctx.quadraticCurveTo(0.04, 0.06, 0, 0.07);
  ctx.quadraticCurveTo(-0.04, 0.06, -0.11, -0.06);
  ctx.fillStyle = '#f07a9a';
  ctx.fill();

  ctx.lineWidth = 0.018;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(30, 30, 30, 0.85)';
  for (const side of [-1, 1]) {
    for (const [dy, tilt] of [[0.02, -0.12], [0.08, 0], [0.14, 0.12]]) {
      ctx.beginPath();
      ctx.moveTo(side * 0.18, dy);
      ctx.quadraticCurveTo(side * 0.45, dy + tilt * 0.4, side * 0.72, dy + tilt);
      ctx.stroke();
    }
  }
}

function drawCat(ctx, face) {
  inFrame(ctx, face.forehead, face, () => {
    catEar(ctx, -1);
    catEar(ctx, 1);
  });
  inFrame(ctx, face.noseTip, face, () => catNose(ctx));
}

// ---------- Sunglasses ----------

function drawGlasses(ctx, face) {
  inFrame(ctx, face.eyeMid, face, () => {
    const lens = new Path2D();
    lens.roundRect(-0.27, -0.17, 0.54, 0.36, [0.06, 0.06, 0.16, 0.16]);
    const g = ctx.createLinearGradient(0, -0.17, 0, 0.19);
    g.addColorStop(0, '#2b2b33');
    g.addColorStop(1, '#0c0c10');
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(side * 0.34, 0.02);
      ctx.fillStyle = g;
      ctx.fill(lens);
      ctx.lineWidth = 0.04;
      ctx.strokeStyle = '#111';
      ctx.stroke(lens);
      ctx.beginPath();
      ctx.moveTo(-0.18, -0.08);
      ctx.lineTo(-0.05, -0.12);
      ctx.lineWidth = 0.03;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.stroke();
      ctx.restore();
    }
    ctx.beginPath();
    ctx.moveTo(-0.08, -0.06);
    ctx.quadraticCurveTo(0, -0.12, 0.08, -0.06);
    ctx.lineWidth = 0.045;
    ctx.strokeStyle = '#111';
    ctx.stroke();
  });
}

// ---------- Face blur ----------

/**
 * The face outline grown a little (to cover the hairline and ears' edges)
 * plus a neck hanging below the jaw, as one path in pixel space.
 */
export function faceAndNeckPath(pts, face) {
  const path = new Path2D();
  const cx = FACE_OVAL.reduce((s, i) => s + pts[i].x, 0) / FACE_OVAL.length;
  const cy = FACE_OVAL.reduce((s, i) => s + pts[i].y, 0) / FACE_OVAL.length;
  FACE_OVAL.forEach((i, k) => {
    const x = cx + (pts[i].x - cx) * 1.12;
    const y = cy + (pts[i].y - cy) * 1.12;
    if (k) path.lineTo(x, y);
    else path.moveTo(x, y);
  });
  path.closePath();

  // Neck: from the lower jaw, straight "down" the face (perpendicular to the
  // eye line), about as long as the face is tall.
  const down = { x: -Math.sin(face.angle), y: Math.cos(face.angle) };
  const faceH = Math.hypot(pts[LM.chin].x - pts[LM.forehead].x, pts[LM.chin].y - pts[LM.forehead].y);
  const len = faceH * 0.95;
  const pull = (p) => ({ x: p.x + (cx - p.x) * 0.18, y: p.y + (cy - p.y) * 0.18 });
  const l = pull(pts[LM.jawLeft]);
  const rr = pull(pts[LM.jawRight]);
  path.moveTo(l.x, l.y);
  path.lineTo(rr.x, rr.y);
  path.lineTo(rr.x + down.x * len, rr.y + down.y * len);
  path.lineTo(l.x + down.x * len, l.y + down.y * len);
  path.closePath();
  return path;
}

// ---------- Debug mesh ----------

function drawMesh(ctx, face, pts) {
  const r = Math.max(0.8, face.eyeDist / 120);
  ctx.fillStyle = 'rgba(0, 255, 200, 0.85)';
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#ff3b6b';
  for (const i of [LM.rightEyeOuter, LM.leftEyeOuter, LM.forehead, LM.noseTip]) {
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, r * 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- Warps ----------
// Warp filters return bulges ({x, y, r, s} in source pixels, see warp.js)
// instead of drawing. s > 0 magnifies, s < 0 shrinks. `t` is the slider
// amount in 0..1. Strength stays below 1 so the warp never folds over itself.

const fisheye = (face, pts, t) => [
  { x: face.noseTip.x, y: face.noseTip.y, r: face.eyeDist * (1.2 + 0.6 * t), s: 0.95 * t },
];

const bigEyes = (face, pts, t) =>
  [pts[LM.rightIris], pts[LM.leftIris]].map((c) => ({ x: c.x, y: c.y, r: face.eyeDist * (0.4 + 0.2 * t), s: 0.95 * t }));

// Big mouth: like Photo Booth's Chipmunk, the whole lower face (cheeks, mouth
// and jaw) swells as one. A single bulge centred
// between the nose tip and the chin; two separate cheek bulges would stretch
// the mouth apart and pinch the middle of the face.
const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
const bigMouth = (face, pts, t) => {
  const c = lerp(face.noseTip, pts[LM.chin], 0.45);
  return [{ x: c.x, y: c.y, r: face.eyeDist * (1.3 + 0.3 * t), s: 0.8 * t }];
};

const pinch = (face, pts, t) => [{ x: face.noseTip.x, y: face.noseTip.y, r: face.eyeDist * 1.6, s: -t }];

// `amount` filters get a slider in the popup. For stickers it scales the
// sticker (50 = normal size, 0 = half, 100 = double); for warps it's strength.
// Defaults reproduce the original look.
const SIZE = { label: 'Size', default: 50 };

export const FILTERS = {
  dog: { label: 'Dog', draw: drawDog, amount: SIZE },
  cat: { label: 'Cat', draw: drawCat, amount: SIZE },
  glasses: { label: 'Sunglasses', draw: drawGlasses, amount: SIZE },
  fisheye: { label: 'Fisheye', warp: fisheye, amount: { label: 'Strength', default: 58 } },
  bigEyes: { label: 'Big eyes', warp: bigEyes, amount: { label: 'Strength', default: 63 } },
  bigMouth: { label: 'Big mouth', warp: bigMouth, amount: { label: 'Strength', default: 90 } },
  pinch: { label: 'Tiny face', warp: pinch, amount: { label: 'Strength', default: 50 } },
  faceBlur: { label: 'Face blur', kind: 'faceBlur', amount: { label: 'Blur', default: 50 } },
  // Debug view of the raw landmarks; only offered in an unpacked install (see isDevBuild).
  mesh: { label: 'Landmarks', draw: drawMesh, dev: true },
};

/** 'sticker' | 'warp' | 'faceBlur' */
export const kindOf = (filter) => filter?.kind ?? (filter?.warp ? 'warp' : 'sticker');

/** Slider amount for a filter as 0..1 (the saved value, else its default). */
export function amountOf(id, amounts) {
  const def = FILTERS[id]?.amount;
  if (!def) return 0.5;
  const v = amounts?.[id];
  return (typeof v === 'number' ? v : def.default) / 100;
}

/**
 * True when the extension is loaded unpacked (Developer mode), i.e. only on
 * the developer's machine. Store installs always have an update_url.
 */
export function isDevBuild() {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.getManifest && !('update_url' in chrome.runtime.getManifest());
}

/** Filters to offer: everything, minus debug-only ones outside a dev build. */
export const visibleFilters = () => Object.entries(FILTERS).filter(([, f]) => !f.dev || isDevBuild());

/** Sticker scale for amount t: 0.5x at 0, 1x at 0.5, 2x at 1. */
export const stickerScale = (t) => 2 ** ((t - 0.5) * 2);
