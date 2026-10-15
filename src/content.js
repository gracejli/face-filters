// Finds <img>/<video> elements, detects faces in the visible ones and draws
// the selected filter on a canvas overlaid on each element.

import { DEFAULT_SETTINGS } from './settings.js';
import { FILTERS, amountKey, amountOf, faceAndNeckPath, faceFrame, kindOf, stickerScale } from './filters.js';
import { detectFaces, detectFacesInImage, loadBitmap, segmentPeople } from './detector.js';
import { renderWarp } from './warp.js';
import { drawDefaultAd } from './ad.js';
import { drawDefaultCard } from './card.js';

const MIN_SIZE = 64;
const VIDEO_FPS = 15;
const CACHE_LIMIT = 300;
// Warps show real pixels, so keep more resolution than detection needs.
const WARP_MAX_DIM = 2048;
const MAX_WARP_OUTPUT = 4096;
// Person segmentation input size (DeepLab runs at 257px internally).
const SEGMENT_DIM = 512;
const MASK_CACHE_LIMIT = 40;

let settings = { ...DEFAULT_SETTINGS };

/** @type {Map<Element, MediaState>} */
const tracked = new Map();
/** src -> Promise<faces[]>; failures resolve to [] so we don't refetch them. */
const resultCache = new Map();
/** src -> Promise<PeopleMask|null> for the body filter. */
const maskCache = new Map();

// ---------- Overlay canvases ----------
//
// Each overlay is a <canvas> inserted right after its image, so it lives in the
// same stacking context, scroll container and clipping as the image. Popups,
// sticky headers and carousels that cover or clip the image do the same to the
// filter. Styles are inline and !important so page CSS can't move it.

const CANVAS_STYLE = {
  position: 'absolute',
  display: 'none',
  margin: '0',
  padding: '0',
  border: '0',
  'max-width': 'none',
  'max-height': 'none',
  'min-width': '0',
  'min-height': '0',
  'pointer-events': 'none',
  'transform-origin': '50% 50%',
  background: 'none',
  opacity: '1',
};

function setStyle(el, prop, value) {
  el.style.setProperty(prop, value, 'important');
}

/** Insert after <picture> rather than inside it. */
const anchorOf = (el) => (el.parentElement instanceof HTMLPictureElement ? el.parentElement : el);

// ---------- Per-element state ----------

/**
 * @typedef {object} MediaState
 * @property {HTMLImageElement|HTMLVideoElement} el
 * @property {HTMLCanvasElement} canvas
 * @property {boolean} visible     from IntersectionObserver
 * @property {string|null} src     src the current faces belong to
 * @property {Array|null} faces    normalized landmarks per face
 * @property {number} natW
 * @property {number} natH
 * @property {string} sizeKey      last canvas size, to know when to redraw
 * @property {number} posX         canvas left/top in its containing block
 * @property {number} posY
 * @property {boolean} videoRunning
 * @property {number} videoHandle
 * @property {number} lastRun
 * @property {boolean} busy
 * @property {boolean} unusable    e.g. cross-origin video without CORS
 * @property {PeopleMask|null} mask  where people are, for the body filter
 * @property {string|null} maskSrc   src the current mask belongs to
 * @property {ImageBitmap|null} bitmap  untainted pixels for pixel filters (images only)
 * @property {boolean} bitmapLoading
 */

function track(el) {
  if (tracked.has(el)) return;
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.dataset.faceHack = '';
  for (const [prop, value] of Object.entries(CANVAS_STYLE)) setStyle(canvas, prop, value);
  const state = {
    el, canvas, visible: false, src: null, faces: null, natW: 0, natH: 0, sizeKey: '', posX: 0, posY: 0,
    videoRunning: false, videoHandle: 0, lastRun: 0, busy: false, unusable: false,
    bitmap: null, bitmapLoading: false, mask: null, maskSrc: null,
  };
  tracked.set(el, state);
  intersection.observe(el);
  resize.observe(el);
  if (el instanceof HTMLVideoElement) {
    el.addEventListener('emptied', () => resetFaces(state));
    el.addEventListener('loadeddata', () => update(state));
  } else {
    el.addEventListener('load', () => update(state));
  }
}

function untrack(el) {
  const state = tracked.get(el);
  if (!state) return;
  stopVideo(state);
  releaseBitmap(state);
  intersection.unobserve(el);
  resize.unobserve(el);
  state.canvas.remove();
  tracked.delete(el);
}

function resetFaces(state) {
  state.faces = null;
  state.src = null;
  state.mask = null;
  state.maskSrc = null;
  state.unusable = false;
  releaseBitmap(state);
  render(state);
}

// ---------- Observers ----------

const intersection = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const state = tracked.get(entry.target);
    if (!state) continue;
    state.visible = entry.isIntersecting;
    update(state);
  }
});

const resize = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const state = tracked.get(entry.target);
    if (state?.visible) layout(state);
  }
});

const mutations = new MutationObserver((records) => {
  let removed = false;
  for (const rec of records) {
    if (rec.type === 'attributes') {
      const state = tracked.get(rec.target);
      if (state) {
        resetFaces(state);
        update(state);
      }
      continue;
    }
    for (const node of rec.addedNodes) scan(node);
    if (rec.removedNodes.length) removed = true;
  }
  if (removed) {
    // Nodes are often moved rather than removed, so check connectivity instead
    // of trusting removedNodes.
    for (const el of tracked.keys()) if (!el.isConnected) untrack(el);
  }
});

function scan(root) {
  if (!(root instanceof Element)) return;
  if (root instanceof HTMLImageElement || root instanceof HTMLVideoElement) track(root);
  for (const el of root.querySelectorAll('img, video')) track(el);
}

// ---------- Processing ----------

function update(state) {
  if (!settings.enabled || !state.visible) {
    stopVideo(state);
    releaseBitmap(state);
    layout(state);
    return;
  }
  layout(state);
  if (state.el instanceof HTMLVideoElement) startVideo(state);
  else processImage(state);
}

async function processImage(state) {
  const img = state.el;
  const src = img.currentSrc || img.src;
  if (!src) return;
  if (!img.complete || !img.naturalWidth) return; // the load listener retries
  if (img.naturalWidth < MIN_SIZE || img.naturalHeight < MIN_SIZE) return;
  const box = img.getBoundingClientRect();
  if (box.width < MIN_SIZE || box.height < MIN_SIZE) return;
  state.natW = img.naturalWidth;
  state.natH = img.naturalHeight;

  if (currentKind() === 'body') {
    if (src === state.maskSrc) return;
    state.maskSrc = src;
    const mask = await cachedSegment(img, src);
    if (state.maskSrc !== src) return; // src changed while we were busy
    state.mask = mask;
  } else {
    if (src === state.src) return;
    state.src = src;
    const faces = await cachedDetect(img, src);
    if (state.src !== src) return;
    state.faces = faces;
  }
  render(state);
}

function cachedSegment(img, src) {
  let p = maskCache.get(src);
  if (p) {
    maskCache.delete(src);
    maskCache.set(src, p);
    return p;
  }
  p = (async () => {
    const bitmap = await loadBitmap(img, src, SEGMENT_DIM);
    try {
      return toPeopleMask(await segmentPeople(bitmap));
    } finally {
      bitmap.close();
    }
  })().catch((err) => {
    console.debug('[face-hack] segmentation skipped', src.slice(0, 120), err?.message ?? err);
    return null;
  });
  maskCache.set(src, p);
  if (maskCache.size > MASK_CACHE_LIMIT) maskCache.delete(maskCache.keys().next().value);
  return p;
}

/**
 * @typedef {object} PeopleMask
 * @property {OffscreenCanvas} canvas  white, alpha = person (soft edges)
 * @property {Array<{x0:number,y0:number,x1:number,y1:number}>} boxes  one per
 *   separate person blob, normalized 0..1, for fitting an image into each
 */
function toPeopleMask(seg) {
  if (!seg) return null;
  const { width: w, height: h, alpha } = seg;
  const canvas = new OffscreenCanvas(w, h);
  const data = new ImageData(w, h);
  for (let i = 0; i < alpha.length; i++) {
    data.data[i * 4] = data.data[i * 4 + 1] = data.data[i * 4 + 2] = 255;
    data.data[i * 4 + 3] = alpha[i];
  }
  canvas.getContext('2d').putImageData(data, 0, 0);
  return { canvas, boxes: personBoxes(alpha, w, h) };
}

/** Bounding boxes of separate people: connected blobs on a coarse grid. */
function personBoxes(alpha, w, h) {
  const step = Math.max(1, Math.ceil(Math.max(w, h) / 96));
  const gw = Math.ceil(w / step);
  const gh = Math.ceil(h / step);
  const on = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) on[gy * gw + gx] = alpha[Math.min(h - 1, gy * step) * w + Math.min(w - 1, gx * step)] > 127 ? 1 : 0;
  }
  const seen = new Uint8Array(gw * gh);
  const minCells = Math.max(4, gw * gh * 0.002);
  const boxes = [];
  for (let start = 0; start < on.length; start++) {
    if (!on[start] || seen[start]) continue;
    let x0 = gw, y0 = gh, x1 = 0, y1 = 0, n = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % gw;
      const y = (i / gw) | 0;
      n++;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const j of [i - 1, i + 1, i - gw, i + gw]) {
        if (j < 0 || j >= on.length || seen[j] || !on[j]) continue;
        if ((j === i - 1 || j === i + 1) && ((j / gw) | 0) !== y) continue; // no row wrap
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (n >= minCells) boxes.push({ x0: x0 / gw, y0: y0 / gh, x1: (x1 + 1) / gw, y1: (y1 + 1) / gh });
  }
  return boxes;
}

function cachedDetect(img, src) {
  let p = resultCache.get(src);
  if (p) {
    // Refresh LRU position.
    resultCache.delete(src);
    resultCache.set(src, p);
    return p;
  }
  p = (async () => {
    const bitmap = await loadBitmap(img, src);
    try {
      return await detectFacesInImage(bitmap);
    } finally {
      bitmap.close();
    }
  })().catch((err) => {
    console.debug('[face-hack] skipped', src.slice(0, 120), err?.message ?? err);
    return [];
  });
  resultCache.set(src, p);
  if (resultCache.size > CACHE_LIMIT) resultCache.delete(resultCache.keys().next().value);
  return p;
}

function startVideo(state) {
  if (state.videoRunning || state.unusable) return;
  state.videoRunning = true;
  const video = state.el;
  const interval = 1000 / VIDEO_FPS;
  const tick = (now) => {
    if (!state.videoRunning) return;
    state.videoHandle = video.requestVideoFrameCallback(tick);
    // Filters that show the video's own pixels (warps, blurs) redraw every
    // frame, reusing the latest landmarks/mask, or they'd stutter at
    // detection rate.
    if (needsLivePixels() && hasContent(state)) render(state);
    if (state.busy || now - state.lastRun < interval) return;
    state.lastRun = now;
    detectVideoFrame(state);
  };
  state.videoHandle = video.requestVideoFrameCallback(tick);
  // A paused video won't produce frames; run once so it still gets a filter.
  if (video.readyState >= 2) detectVideoFrame(state);
}

function stopVideo(state) {
  if (!state.videoRunning) return;
  state.videoRunning = false;
  state.el.cancelVideoFrameCallback(state.videoHandle);
}

async function detectVideoFrame(state) {
  const video = state.el;
  if (video.readyState < 2 || video.videoWidth < MIN_SIZE || video.videoHeight < MIN_SIZE) return;
  state.busy = true;
  try {
    if (currentKind() === 'body') {
      const mask = toPeopleMask(await segmentPeople(videoFrameForSegmentation(video)));
      if (!state.videoRunning) return;
      state.mask = mask;
    } else {
      const faces = await detectFaces(video);
      if (!state.videoRunning) return;
      state.faces = faces;
    }
    state.natW = video.videoWidth;
    state.natH = video.videoHeight;
    render(state);
  } catch (err) {
    // Cross-origin video without CORS: pixels can't be read, so give up on it.
    if (err?.name === 'SecurityError' || /taint|cross-origin/i.test(String(err?.message))) {
      state.unusable = true;
      stopVideo(state);
    }
    console.debug('[face-hack] video frame failed', err);
  } finally {
    state.busy = false;
  }
}

/** A small copy of the current video frame (segmentation doesn't need more). */
let frameCanvas = null;
function videoFrameForSegmentation(video) {
  const k = Math.min(1, SEGMENT_DIM / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.max(1, Math.round(video.videoWidth * k));
  const h = Math.max(1, Math.round(video.videoHeight * k));
  frameCanvas ??= new OffscreenCanvas(w, h);
  if (frameCanvas.width !== w || frameCanvas.height !== h) {
    frameCanvas.width = w;
    frameCanvas.height = h;
  }
  frameCanvas.getContext('2d').drawImage(video, 0, 0, w, h);
  return frameCanvas;
}

const currentKind = () => kindOf(currentFilter());

/** Whether the current filter has something to draw for this element. */
const hasContent = (state) => (currentKind() === 'body' ? !!state.mask : !!state.faces?.length);

/** Whether the current filter draws the media's own pixels (so needs them, and redraws per video frame). */
function needsLivePixels() {
  const kind = currentKind();
  if (kind === 'warp' || kind === 'faceBlur') return true;
  return kind === 'body' && settings.body?.style === 'pixel';
}

// ---------- Layout & drawing ----------

/**
 * Position the canvas over the element's content box; redraw if resized.
 *
 * The canvas shares the image's ancestors, so their transforms, scrolling and
 * clipping apply to both. It copies the image's own transform, and its left/top
 * are corrected by measuring: the centre of a transformed box is the centre of
 * its bounding rect, so we compare the canvas's centre with where the content
 * box's centre should be and map the difference back through the ancestors'
 * linear transform. That's exact for any 2D transforms and doesn't depend on
 * which element the browser picks as the containing block.
 */
function layout(state) {
  const { el, canvas } = state;
  if (!el.isConnected) return untrack(el);
  if (!settings.enabled || !state.visible || !hasContent(state)) {
    setStyle(canvas, 'display', 'none');
    return;
  }
  const cs = getComputedStyle(el);
  const px = (v) => parseFloat(v) || 0;
  const W = el.offsetWidth;
  const H = el.offsetHeight;
  const left = px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const right = px(cs.borderRightWidth) + px(cs.paddingRight);
  const top = px(cs.borderTopWidth) + px(cs.paddingTop);
  const bottom = px(cs.borderBottomWidth) + px(cs.paddingBottom);
  const w = W - left - right;
  const h = H - top - bottom;
  if (w < 1 || h < 1 || cs.visibility === 'hidden') {
    setStyle(canvas, 'display', 'none');
    return;
  }

  // Stickers (ears, the headband's card) stick out past the top of the head,
  // which is often the top of the photo, so their canvas extends beyond the
  // image. Everything else is a patch of the image and stays inside it.
  const pad = currentKind() === 'sticker' ? stickerPad(w, h) : NO_PAD;
  state.pad = pad;

  // Frameworks sometimes re-render a parent and drop nodes they don't own.
  const anchor = anchorOf(el);
  if (anchor.nextSibling !== canvas) {
    anchor.after(canvas);
    state.posX = el.offsetLeft + left - pad.l;
    state.posY = el.offsetTop + top - pad.t;
  }

  const own = ownTransform(el, cs);
  const parentM = el.parentElement ? linearTransform(el.parentElement) : new DOMMatrix();
  const m = parentM.multiply(own);
  setStyle(canvas, 'display', 'block');
  const cw = w + pad.l + pad.r;
  const ch = h + pad.t + pad.b;
  setStyle(canvas, 'width', `${cw}px`);
  setStyle(canvas, 'height', `${ch}px`);
  setStyle(canvas, 'transform', own.isIdentity ? 'none' : `matrix(${own.a}, ${own.b}, ${own.c}, ${own.d}, 0, 0)`);
  // Paint above the image even when the image has its own z-index.
  setStyle(canvas, 'z-index', cs.zIndex === 'auto' ? 'auto' : cs.zIndex);
  setStyle(canvas, 'left', `${state.posX}px`);
  setStyle(canvas, 'top', `${state.posY}px`);

  const er = el.getBoundingClientRect();
  const cr = canvas.getBoundingClientRect();
  // Where the canvas's centre should be (the content box's centre, shifted by
  // any uneven padding), in viewport pixels.
  const off = m.transformPoint(new DOMPoint((left - right + pad.r - pad.l) / 2, (top - bottom + pad.b - pad.t) / 2));
  const dx = er.left + er.width / 2 + off.x - (cr.left + cr.width / 2);
  const dy = er.top + er.height / 2 + off.y - (cr.top + cr.height / 2);
  if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) {
    const fix = parentM.inverse().transformPoint(new DOMPoint(dx, dy));
    state.posX += fix.x;
    state.posY += fix.y;
    setStyle(canvas, 'left', `${state.posX}px`);
    setStyle(canvas, 'top', `${state.posY}px`);
  }

  const scale = (window.devicePixelRatio || 1) * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  const sizeKey = `${w}x${h}+${pad.l},${pad.t},${pad.r},${pad.b}@${scale.toFixed(3)}|${cs.objectFit}|${cs.objectPosition}`;
  if (sizeKey !== state.sizeKey) {
    state.sizeKey = sizeKey;
    canvas.width = Math.max(1, Math.round(cw * scale));
    canvas.height = Math.max(1, Math.round(ch * scale));
    draw(state, w, h, cs, scale);
  }
}

const NO_PAD = { l: 0, t: 0, r: 0, b: 0 };

/**
 * Extra room around the image for stickers, in CSS px: mostly above (ears,
 * the headband card), some at the sides, a little below. Capped so huge
 * images don't get huge canvases.
 */
function stickerPad(w, h) {
  const side = Math.round(Math.min(w * 0.25, 300));
  return { l: side, r: side, t: Math.round(Math.min(h * 0.6, 600)), b: Math.round(Math.min(h * 0.1, 100)) };
}

/** 2D linear part of one element's own transform (transform, rotate, scale). */
function ownTransform(node, cs = getComputedStyle(node)) {
  let own = new DOMMatrix();
  if (cs.transform === 'none' && cs.rotate === 'none' && cs.scale === 'none') return own;
  // Individual properties apply before `transform`: translate, rotate, scale, transform.
  const rot = /^(-?[\d.]+)deg$/.exec(cs.rotate);
  if (rot) own = own.rotate(parseFloat(rot[1]));
  if (cs.scale !== 'none') {
    const [sx, sy = sx] = cs.scale.split(' ').map(parseFloat);
    own = own.scale(sx, sy);
  }
  if (cs.transform !== 'none') own = own.multiply(new DOMMatrix(cs.transform));
  return new DOMMatrix([own.a, own.b, own.c, own.d, 0, 0]);
}

/** Product of the 2D linear parts of all CSS transforms from el up to the root. */
function linearTransform(el) {
  let m = new DOMMatrix();
  for (let node = el; node instanceof Element; node = node.parentElement ?? node.getRootNode()?.host) {
    m = ownTransform(node).multiply(m);
  }
  return m;
}

/** Force a redraw at the next layout, then lay out now. */
function render(state) {
  state.sizeKey = '';
  layout(state);
}

function draw(state, w, h, cs, scale) {
  const { canvas } = state;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.natW) return;
  const filter = currentFilter();
  const kind = kindOf(filter);
  const t = amountOf(amountKey(settings.filter, settings.body?.style), settings.amounts);
  const rect = contentRect(w, h, state.natW, state.natH, cs.objectFit, cs.objectPosition);

  // Draw in content-box coordinates; the canvas may have padding around it.
  const pad = state.pad ?? NO_PAD;
  ctx.setTransform(scale, 0, 0, scale, pad.l * scale, pad.t * scale);
  if (kind === 'body') return drawBody(state, ctx, rect, scale, w, h, cs, t);
  if (kind === 'faceBlur') return drawFaceBlur(state, ctx, rect, scale, w, h, cs, t);
  if (kind === 'warp') return drawWarp(state, ctx, filter, rect, scale, w, h, cs, t);
  for (const face of state.faces) {
    const pts = face.map((p) => ({ x: rect.x + p.x * rect.w, y: rect.y + p.y * rect.h }));
    const frame = faceFrame(pts);
    // Stickers are drawn in eye-distance units, so scaling it scales the sticker.
    if (filter.amount) frame.eyeDist *= stickerScale(t);
    filter.draw(ctx, frame, pts, filter.image ? { image: imageSlots[filter.image].get() } : undefined);
  }
}

function currentFilter() {
  return FILTERS[settings.filter] ?? FILTERS.dog;
}

/**
 * Re-render the image (or current video frame) with the filter's bulges and
 * paste just the affected region over the element. Outside the bulges the
 * warp is the identity, so the patch blends into the original.
 */
function drawWarp(state, ctx, filter, rect, scale, w, h, cs, t) {
  const isVideo = state.el instanceof HTMLVideoElement;
  const source = isVideo ? state.el : state.bitmap;
  if (!source) return void ensureBitmap(state);
  const { natW, natH } = state;

  const bulges = state.faces.flatMap((face) => {
    const pts = face.map((p) => ({ x: p.x * natW, y: p.y * natH }));
    return filter.warp(faceFrame(pts), pts, t);
  });
  if (!bulges.length) return;

  // Union of the bulges' bounding squares, normalized to the source.
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const b of bulges) {
    x0 = Math.min(x0, (b.x - b.r) / natW);
    y0 = Math.min(y0, (b.y - b.r) / natH);
    x1 = Math.max(x1, (b.x + b.r) / natW);
    y1 = Math.max(y1, (b.y + b.r) / natH);
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(1, x1); y1 = Math.min(1, y1);
  if (x1 <= x0 || y1 <= y0) return;

  const k = Math.min(1, MAX_WARP_OUTPUT / Math.max(rect.w * scale, rect.h * scale));
  const outW = Math.max(1, Math.round(rect.w * scale * k));
  const outH = Math.max(1, Math.round(rect.h * scale * k));
  let out;
  try {
    out = renderWarp(source, natW, natH, outW, outH, bulges);
  } catch (err) {
    console.debug('[face-hack] warp failed', err);
    if (isVideo && err?.name === 'SecurityError') {
      state.unusable = true;
      stopVideo(state);
    }
    return;
  }
  if (!out) return;
  // Stickers may poke out of the image (that's the point of ears), but a warp
  // is a patch of the image itself, so respect rounded corners like avatars.
  ctx.save();
  const radii = contentRadii(cs, w, h);
  if (radii) {
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, radii);
    ctx.clip();
  }
  ctx.drawImage(
    out,
    x0 * outW, y0 * outH, (x1 - x0) * outW, (y1 - y0) * outH,
    rect.x + x0 * rect.w, rect.y + y0 * rect.h, (x1 - x0) * rect.w, (y1 - y0) * rect.h,
  );
  ctx.restore();
}

// Scratch canvases for compositing. Drawing is synchronous, so one set is
// shared by every overlay.
const scratchA = new OffscreenCanvas(1, 1);
const scratchB = new OffscreenCanvas(1, 1);
function scratch(canvas, w, h) {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const c = canvas.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.filter = 'none';
  c.imageSmoothingEnabled = true;
  c.clearRect(0, 0, w, h);
  return c;
}

/** The pixels to blur/pixelate: the playing video, or the decoded image. */
function pixelSource(state) {
  if (state.el instanceof HTMLVideoElement) return state.el;
  if (!state.bitmap) ensureBitmap(state);
  return state.bitmap;
}

/** Paste a finished scratch layer onto the overlay, honouring rounded corners. */
function pasteLayer(ctx, layer, w, h, cs, alpha = 1) {
  ctx.save();
  const radii = contentRadii(cs, w, h);
  if (radii) {
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, radii);
    ctx.clip();
  }
  ctx.globalAlpha = alpha;
  ctx.drawImage(layer, 0, 0, w, h);
  ctx.restore();
}

/** Face blur: a blurred copy of the image, cut to the face and neck with a soft edge. */
function drawFaceBlur(state, ctx, rect, scale, w, h, cs, t) {
  const source = pixelSource(state);
  if (!source) return;
  const W = Math.max(1, Math.round(w * scale));
  const H = Math.max(1, Math.round(h * scale));
  for (const face of state.faces) {
    const pts = face.map((p) => ({ x: rect.x + p.x * rect.w, y: rect.y + p.y * rect.h }));
    const frame = faceFrame(pts);
    const layer = scratch(scratchA, W, H);
    layer.setTransform(scale, 0, 0, scale, 0, 0);
    // Canvas filter lengths are in canvas pixels, so scale them by hand.
    // Light at 0, unrecognisable from ~50, a smear at 100.
    layer.filter = `blur(${frame.eyeDist * (0.03 + 0.7 * t * t) * scale}px)`;
    layer.drawImage(source, rect.x, rect.y, rect.w, rect.h);
    layer.filter = `blur(${frame.eyeDist * 0.08 * scale}px)`;
    layer.globalCompositeOperation = 'destination-in';
    layer.fillStyle = '#000';
    layer.fill(faceAndNeckPath(pts, frame));
    pasteLayer(ctx, scratchA, w, h, cs);
  }
}

/** Body: cover every person in the mask with a colour, pixels, or an image. */
function drawBody(state, ctx, rect, scale, w, h, cs, t) {
  const { mask } = state;
  const style = settings.body?.style ?? 'color';
  const W = Math.max(1, Math.round(w * scale));
  const H = Math.max(1, Math.round(h * scale));
  const layer = scratch(scratchA, W, H);
  layer.setTransform(scale, 0, 0, scale, 0, 0);

  if (style === 'pixel') {
    const source = pixelSource(state);
    if (!source) return;
    // Pixelate by shrinking then scaling back up without smoothing, then wash
    // it out toward white like a censored crowd shot.
    const block = Math.max(3, (0.005 + 0.05 * t) * Math.max(rect.w, rect.h));
    const sw = Math.max(1, Math.round(rect.w / block));
    const sh = Math.max(1, Math.round(rect.h / block));
    const small = scratch(scratchB, sw, sh);
    small.drawImage(source, 0, 0, sw, sh);
    layer.imageSmoothingEnabled = false;
    layer.drawImage(scratchB, 0, 0, sw, sh, rect.x, rect.y, rect.w, rect.h);
    layer.imageSmoothingEnabled = true;
    layer.fillStyle = 'rgba(255, 255, 255, 0.45)';
    layer.fillRect(rect.x, rect.y, rect.w, rect.h);
  } else if (style === 'image') {
    const fill = imageSlots.bodyImage.get();
    if (!fill) return;
    const boxes = mask.boxes.length ? mask.boxes : [{ x0: 0, y0: 0, x1: 1, y1: 1 }];
    if (!settings.bodyImage) {
      // The default "YOUR AD HERE" is a repeating pattern, so it reads inside
      // any silhouette. Size the text to the people in the image.
      const tallest = Math.max(...boxes.map((b) => (b.y1 - b.y0) * rect.h));
      const k = Math.max(0.05, tallest / 7 / fill.height);
      const pattern = layer.createPattern(fill, 'repeat');
      pattern.setTransform(new DOMMatrix().translateSelf(rect.x, rect.y).scaleSelf(k, k));
      layer.fillStyle = pattern;
      layer.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    for (const b of settings.bodyImage ? boxes : []) {
      // Cover-fit the image into each person's bounding box.
      const bx = rect.x + b.x0 * rect.w;
      const by = rect.y + b.y0 * rect.h;
      const bw = (b.x1 - b.x0) * rect.w;
      const bh = (b.y1 - b.y0) * rect.h;
      const k = Math.max(bw / fill.width, bh / fill.height);
      const fw = fill.width * k;
      const fh = fill.height * k;
      layer.drawImage(fill, bx + (bw - fw) / 2, by + (bh - fh) / 2, fw, fh);
    }
  } else {
    layer.fillStyle = settings.body?.color ?? '#ee6f9a';
    layer.fillRect(rect.x, rect.y, rect.w, rect.h);
  }

  // Keep only the people. The mask is low-res, so smoothing it up gives soft edges.
  layer.globalCompositeOperation = 'destination-in';
  layer.drawImage(mask.canvas, rect.x, rect.y, rect.w, rect.h);
  pasteLayer(ctx, scratchA, w, h, cs, style === 'pixel' ? 1 : Math.max(0.05, t));
}

// ---------- User images (body fill, headband card) ----------

/**
 * An image the user can upload (stored as a data: URL in settings[key]),
 * with a built-in fallback. get() returns the ImageBitmap, or null while it's
 * loading; everything redraws once it's ready.
 */
function imageSlot(key, drawFallback) {
  let image = null;
  let madeFrom;
  let loading = false;

  async function load() {
    loading = true;
    const want = settings[key];
    try {
      let bitmap = null;
      if (want) {
        try {
          // Decode the data: URL by hand; fetching it could trip the page's CSP.
          const [head, b64] = want.split(',');
          const type = /data:([^;]+)/.exec(head)?.[1] ?? 'image/png';
          const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
          bitmap = await createImageBitmap(new Blob([bytes], { type }));
        } catch (err) {
          console.debug(`[face-hack] uploaded ${key} unreadable`, err);
        }
      }
      bitmap ??= (await drawFallback()).transferToImageBitmap();
      image?.close?.();
      image = bitmap;
      madeFrom = want;
    } finally {
      loading = false;
    }
    if (settings[key] !== want) return load();
    redrawAll();
  }

  return {
    get() {
      if (madeFrom === settings[key] && image) return image;
      if (!loading) load();
      return null;
    },
  };
}

const imageSlots = {
  bodyImage: imageSlot('bodyImage', drawDefaultAd),
  headbandImage: imageSlot('headbandImage', drawDefaultCard),
};

/**
 * The element's border-radius as inner (content-box) corner radii for
 * roundRect, or null when there's no rounding. Per CSS, the inner radius is the
 * outer radius minus the border and padding on that side.
 */
function contentRadii(cs, w, h) {
  const px = (v) => parseFloat(v) || 0;
  const bl = px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const br = px(cs.borderRightWidth) + px(cs.paddingRight);
  const bt = px(cs.borderTopWidth) + px(cs.paddingTop);
  const bb = px(cs.borderBottomWidth) + px(cs.paddingBottom);
  const outerW = w + bl + br;
  const outerH = h + bt + bb;
  const resolve = (v, size) => (v.endsWith('%') ? (parseFloat(v) / 100) * size : px(v));
  const corner = (value, sideX, sideY) => {
    const [rx, ry = rx] = value.split(' ');
    return { x: Math.max(0, resolve(rx, outerW) - sideX), y: Math.max(0, resolve(ry, outerH) - sideY) };
  };
  const radii = [
    corner(cs.borderTopLeftRadius, bl, bt),
    corner(cs.borderTopRightRadius, br, bt),
    corner(cs.borderBottomRightRadius, br, bb),
    corner(cs.borderBottomLeftRadius, bl, bb),
  ];
  return radii.some((r) => r.x > 0 && r.y > 0) ? radii : null;
}

/** Images only: decode an untainted copy of the pixels for warps and blurs. */
async function ensureBitmap(state) {
  const img = state.el;
  const src = img.currentSrc || img.src;
  if (state.bitmap || state.bitmapLoading || !src) return;
  state.bitmapLoading = true;
  try {
    const bitmap = await loadBitmap(img, src, WARP_MAX_DIM);
    if ((img.currentSrc || img.src) !== src || !state.visible || !tracked.has(img)) return bitmap.close();
    state.bitmap = bitmap;
    render(state);
  } catch (err) {
    console.debug('[face-hack] could not load pixels', err?.message ?? err);
  } finally {
    state.bitmapLoading = false;
  }
}

function releaseBitmap(state) {
  state.bitmap?.close();
  state.bitmap = null;
}

/** Where the media's pixels land inside a w×h box, honouring object-fit/position. */
function contentRect(w, h, natW, natH, fit, position) {
  let sx = w / natW;
  let sy = h / natH;
  if (fit !== 'fill') {
    const contain = Math.min(sx, sy);
    const s = fit === 'cover' ? Math.max(sx, sy) : fit === 'none' ? 1 : fit === 'scale-down' ? Math.min(1, contain) : contain;
    sx = sy = s;
  }
  const cw = natW * sx;
  const ch = natH * sy;
  const [posX = '50%', posY = '50%'] = (position || '').split(/\s+/);
  const offset = (v, free) => (v.endsWith('%') ? (free * parseFloat(v)) / 100 : v.endsWith('px') ? parseFloat(v) : free / 2);
  return { x: offset(posX, w - cw), y: offset(posY, h - ch), w: cw, h: ch };
}

let layoutQueued = false;
function layoutAllSoon() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    for (const state of tracked.values()) if (state.visible) layout(state);
  });
}

function redrawAll() {
  for (const state of tracked.values()) {
    state.sizeKey = '';
    update(state);
  }
}

// ---------- Boot ----------

async function init() {
  settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  scan(document.documentElement);
  mutations.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset'],
  });
  // Scroll in any container (capture) and window resizes move elements around
  // without resizing them, so ResizeObserver alone isn't enough.
  addEventListener('scroll', layoutAllSoon, { capture: true, passive: true });
  addEventListener('resize', layoutAllSoon, { passive: true });
  document.addEventListener('fullscreenchange', layoutAllSoon);
  // Catch layout shifts nothing else tells us about (carousels, transitions).
  setInterval(layoutAllSoon, 500);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) if (key in settings) settings[key] = newValue;
    for (const key of Object.keys(imageSlots)) if (key in changes) imageSlots[key].get();
    redrawAll();
  });
}

init();
