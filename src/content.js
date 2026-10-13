// Finds <img>/<video> elements, detects faces in the visible ones and draws
// the selected filter on a canvas overlaid on each element.

import { DEFAULT_SETTINGS } from './settings.js';
import { FILTERS, faceFrame } from './filters.js';
import { detectFaces, loadBitmap } from './detector.js';
import { renderWarp } from './warp.js';

const MIN_SIZE = 64;
const VIDEO_FPS = 15;
const CACHE_LIMIT = 300;
// Warps show real pixels, so keep more resolution than detection needs.
const WARP_MAX_DIM = 2048;
const MAX_WARP_OUTPUT = 4096;

let settings = { ...DEFAULT_SETTINGS };

/** @type {Map<Element, MediaState>} */
const tracked = new Map();
/** src -> Promise<faces[]>; failures resolve to [] so we don't refetch them. */
const resultCache = new Map();

// ---------- Overlay layer ----------

// One fixed-position host in a closed shadow root, so page CSS can't touch the
// canvases and page scripts querying the DOM don't find them.
const host = document.createElement('face-filters-overlay');
host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;z-index:2147483647;';
const layer = host.attachShadow({ mode: 'closed' });

function mountHost() {
  // In element fullscreen only the fullscreen element's subtree is rendered.
  const fs = document.fullscreenElement;
  const parent = fs && !(fs instanceof HTMLVideoElement) && !(fs instanceof HTMLImageElement) ? fs : document.documentElement;
  if (host.parentNode !== parent) parent.appendChild(host);
}

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
 * @property {boolean} videoRunning
 * @property {number} videoHandle
 * @property {number} lastRun
 * @property {boolean} busy
 * @property {boolean} unusable    e.g. cross-origin video without CORS
 * @property {ImageBitmap|null} bitmap  untainted pixels for warp filters (images only)
 * @property {boolean} bitmapLoading
 */

function track(el) {
  if (tracked.has(el)) return;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;left:0;top:0;display:none;pointer-events:none;';
  layer.appendChild(canvas);
  const state = {
    el, canvas, visible: false, src: null, faces: null, natW: 0, natH: 0, sizeKey: '',
    videoRunning: false, videoHandle: 0, lastRun: 0, busy: false, unusable: false,
    bitmap: null, bitmapLoading: false,
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
  if (!src || src === state.src) return;
  if (!img.complete || !img.naturalWidth) return; // the load listener retries
  if (img.naturalWidth < MIN_SIZE || img.naturalHeight < MIN_SIZE) return;
  const box = img.getBoundingClientRect();
  if (box.width < MIN_SIZE || box.height < MIN_SIZE) return;

  state.src = src;
  state.natW = img.naturalWidth;
  state.natH = img.naturalHeight;
  const faces = await cachedDetect(img, src);
  if (state.src !== src) return; // src changed while we were busy
  state.faces = faces;
  render(state);
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
      return await detectFaces(bitmap);
    } finally {
      bitmap.close();
    }
  })().catch((err) => {
    console.debug('[face-filters] skipped', src.slice(0, 120), err?.message ?? err);
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
    // Warps show the video's own pixels, so redraw every frame (reusing the
    // latest landmarks) or the warped patch would stutter at detection rate.
    if (currentFilter().warp && state.faces?.length) render(state);
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
    const faces = await detectFaces(video);
    if (!state.videoRunning) return;
    state.natW = video.videoWidth;
    state.natH = video.videoHeight;
    state.faces = faces;
    render(state);
  } catch (err) {
    // Cross-origin video without CORS: pixels can't be read, so give up on it.
    if (err?.name === 'SecurityError' || /taint|cross-origin/i.test(String(err?.message))) {
      state.unusable = true;
      stopVideo(state);
    }
    console.debug('[face-filters] video frame failed', err);
  } finally {
    state.busy = false;
  }
}

// ---------- Layout & drawing ----------

/**
 * Position the canvas over the element's content box; redraw if resized.
 *
 * Works in the element's own (untransformed) layout box and re-applies the
 * linear part of every CSS transform between it and the viewport, so rotated
 * or scaled images line up too. The translation comes for free: the centre of
 * a transformed box is always the centre of its bounding rect.
 */
function layout(state) {
  const { el, canvas } = state;
  if (!el.isConnected) return untrack(el);
  if (!settings.enabled || !state.visible || !state.faces?.length) {
    canvas.style.display = 'none';
    return;
  }
  const cs = getComputedStyle(el);
  const px = (v) => parseFloat(v) || 0;
  const W = el.offsetWidth;
  const H = el.offsetHeight;
  const left = px(cs.borderLeftWidth) + px(cs.paddingLeft);
  const top = px(cs.borderTopWidth) + px(cs.paddingTop);
  const w = W - left - px(cs.borderRightWidth) - px(cs.paddingRight);
  const h = H - top - px(cs.borderBottomWidth) - px(cs.paddingBottom);
  if (w < 1 || h < 1 || cs.visibility === 'hidden') {
    canvas.style.display = 'none';
    return;
  }
  const r = el.getBoundingClientRect();
  const m = linearTransform(el);
  canvas.style.display = 'block';
  canvas.style.transformOrigin = '0 0';
  canvas.style.transform =
    `translate(${r.left + r.width / 2}px, ${r.top + r.height / 2}px) ` +
    `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, 0, 0) ` +
    `translate(${left - W / 2}px, ${top - H / 2}px)`;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const scale = (window.devicePixelRatio || 1) * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  const sizeKey = `${w}x${h}@${scale.toFixed(3)}|${cs.objectFit}|${cs.objectPosition}`;
  if (sizeKey !== state.sizeKey) {
    state.sizeKey = sizeKey;
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    draw(state, w, h, cs, scale);
  }
}

/** Product of the 2D linear parts of all CSS transforms from el up to the root. */
function linearTransform(el) {
  let m = new DOMMatrix();
  for (let node = el; node instanceof Element; node = node.parentElement ?? node.getRootNode()?.host) {
    const cs = getComputedStyle(node);
    if (cs.transform === 'none' && cs.rotate === 'none' && cs.scale === 'none') continue;
    // Individual properties apply before `transform`: translate, rotate, scale, transform.
    let own = new DOMMatrix();
    const rot = /^(-?[\d.]+)deg$/.exec(cs.rotate);
    if (rot) own = own.rotate(parseFloat(rot[1]));
    if (cs.scale !== 'none') {
      const [sx, sy = sx] = cs.scale.split(' ').map(parseFloat);
      own = own.scale(sx, sy);
    }
    if (cs.transform !== 'none') own = own.multiply(new DOMMatrix(cs.transform));
    m = own.multiply(m);
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
  const rect = contentRect(w, h, state.natW, state.natH, cs.objectFit, cs.objectPosition);

  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  if (filter.warp) return drawWarp(state, ctx, filter, rect, scale, w, h, cs);
  for (const face of state.faces) {
    const pts = face.map((p) => ({ x: rect.x + p.x * rect.w, y: rect.y + p.y * rect.h }));
    filter.draw(ctx, faceFrame(pts), pts);
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
function drawWarp(state, ctx, filter, rect, scale, w, h, cs) {
  const isVideo = state.el instanceof HTMLVideoElement;
  const source = isVideo ? state.el : state.bitmap;
  if (!source) return void ensureBitmap(state);
  const { natW, natH } = state;

  const bulges = state.faces.flatMap((face) => {
    const pts = face.map((p) => ({ x: p.x * natW, y: p.y * natH }));
    return filter.warp(faceFrame(pts), pts);
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
    console.debug('[face-filters] warp failed', err);
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

/** Images only: decode an untainted copy of the pixels for warping. */
async function ensureBitmap(state) {
  if (state.bitmap || state.bitmapLoading || !state.src) return;
  const src = state.src;
  state.bitmapLoading = true;
  try {
    const bitmap = await loadBitmap(state.el, src, WARP_MAX_DIM);
    if (state.src !== src || !state.visible || !tracked.has(state.el)) return bitmap.close();
    state.bitmap = bitmap;
    render(state);
  } catch (err) {
    console.debug('[face-filters] could not load pixels for warp', err?.message ?? err);
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
  mountHost();
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
  document.addEventListener('fullscreenchange', () => {
    mountHost();
    layoutAllSoon();
  });
  // Catch layout shifts nothing else tells us about (carousels, transitions).
  setInterval(layoutAllSoon, 500);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) if (key in settings) settings[key] = newValue;
    redrawAll();
  });
}

init();
