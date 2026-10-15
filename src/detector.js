// MediaPipe tasks, running inside the content script: the Face Landmarker
// (face filters) and an Image Segmenter that finds people (body filters).
//
// MediaPipe normally loads its WASM glue (vision_wasm_internal.js) by adding a
// <script> tag to the page. In a content script that would run in the page's
// main world (and be subject to the page's CSP), so the glue would never be
// visible to us. Instead the background worker injects that same file into our
// isolated world with chrome.scripting, which defines `self.ModuleFactory`,
// and we hand MediaPipe an empty wasmLoaderPath so it skips its own loader.

import { FaceLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision';

const MAX_FACES = 4;
// Detection cost grows with input size and faces are fine at this resolution.
const MAX_DETECT_DIM = 1024;

let factoryPromise = null;
let landmarkerPromise = null;
let segmenterPromise = null;

/** The WASM module factory. MediaPipe clears self.ModuleFactory after each use, so keep our own reference. */
function loadFactory() {
  factoryPromise ??= (async () => {
    if (!self.ModuleFactory) {
      const res = await chrome.runtime.sendMessage({ type: 'load-mediapipe' });
      if (!res?.ok || !self.ModuleFactory) throw new Error(`could not load MediaPipe: ${res?.error ?? 'unknown'}`);
    }
    return self.ModuleFactory;
  })().catch((err) => {
    factoryPromise = null;
    throw err;
  });
  return factoryPromise;
}

/** Create a task on the GPU, falling back to CPU. */
async function createTask(TaskClass, options) {
  const factory = await loadFactory();
  const fileset = {
    wasmLoaderPath: '',
    wasmBinaryPath: chrome.runtime.getURL('wasm/vision_wasm_internal.wasm'),
  };
  let lastErr;
  for (const delegate of ['GPU', 'CPU']) {
    self.ModuleFactory = factory;
    try {
      return await TaskClass.createFromOptions(fileset, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate },
      });
    } catch (err) {
      lastErr = err;
      console.debug(`[face-hack] ${TaskClass.name} ${delegate} delegate failed`, err);
    }
  }
  throw lastErr;
}

function once(get, set, create) {
  if (!get()) set(create().catch((err) => {
    set(null);
    throw err;
  }));
  return get();
}

export function getLandmarker() {
  return once(() => landmarkerPromise, (p) => (landmarkerPromise = p), () =>
    createTask(FaceLandmarker, {
      baseOptions: { modelAssetPath: chrome.runtime.getURL('models/face_landmarker.task') },
      runningMode: 'IMAGE',
      numFaces: MAX_FACES,
    }));
}

function getSegmenter() {
  return once(() => segmenterPromise, (p) => (segmenterPromise = p), async () => {
    const segmenter = await createTask(ImageSegmenter, {
      baseOptions: { modelAssetPath: chrome.runtime.getURL('models/deeplab_v3.tflite') },
      runningMode: 'IMAGE',
      outputCategoryMask: false,
      outputConfidenceMasks: true,
    });
    const person = segmenter.getLabels().indexOf('person');
    return { segmenter, person: person >= 0 ? person : 15 };
  });
}

/**
 * Find people in any ImageSource. Returns a soft mask at the source's
 * resolution: {width, height, alpha} where alpha is 0..255 per pixel, or null
 * when nobody is there. Pass a small source (≤512px): DeepLab works at 257px
 * anyway and the mask is upscaled smoothly when drawn.
 */
export async function segmentPeople(source) {
  const { segmenter, person } = await getSegmenter();
  const result = segmenter.segment(source);
  try {
    const mask = result.confidenceMasks?.[person];
    if (!mask) return null;
    const conf = mask.getAsFloat32Array();
    const alpha = new Uint8ClampedArray(conf.length);
    let covered = 0;
    for (let i = 0; i < conf.length; i++) {
      // Soft threshold: fully in above 0.6, fully out below 0.3.
      const a = Math.min(1, Math.max(0, (conf[i] - 0.3) / 0.3));
      alpha[i] = a * 255;
      if (a > 0.5) covered++;
    }
    // Ignore specks: less than 0.3% of the image is noise, not a person.
    if (covered < conf.length * 0.003) return null;
    return { width: mask.width, height: mask.height, alpha };
  } finally {
    result.close();
  }
}

/**
 * Run detection on any ImageSource (one pass; used for video frames).
 * Returns normalized [0..1] landmarks, one array of {x, y} per face. Throws on
 * tainted sources (SecurityError).
 */
export async function detectFaces(source) {
  const landmarker = await getLandmarker();
  return toFaces(landmarker.detect(source));
}

const toFaces = (result) => result.faceLandmarks.map((face) => face.map(({ x, y }) => ({ x, y })));

/**
 * Detection for still images: the whole image, plus four overlapping
 * quarters. The face finder works at low resolution, so faces that are small
 * relative to the image (group photos) are often only found in a crop.
 * Duplicates (the same face found twice) are dropped.
 */
export async function detectFacesInImage(bitmap) {
  const landmarker = await getLandmarker();
  const W = bitmap.width;
  const H = bitmap.height;
  const faces = toFaces(landmarker.detect(bitmap));
  if (Math.max(W, H) < 300) return faces;

  const TILE = 0.6;
  for (const fx of [0, 1 - TILE]) {
    for (const fy of [0, 1 - TILE]) {
      const crop = await createImageBitmap(bitmap, fx * W, fy * H, TILE * W, TILE * H);
      let found;
      try {
        found = toFaces(landmarker.detect(crop));
      } finally {
        crop.close();
      }
      for (const face of found) {
        const mapped = face.map(({ x, y }) => ({ x: fx + x * TILE, y: fy + y * TILE }));
        if (!faces.some((f) => sameFace(f, mapped, W, H))) faces.push(mapped);
      }
    }
  }
  return faces.slice(0, MAX_FACES * 2);
}

/** Two detections are the same face if their eye midpoints nearly coincide. */
function sameFace(a, b, W, H) {
  const mid = (f) => ({ x: ((f[33].x + f[263].x) / 2) * W, y: ((f[33].y + f[263].y) / 2) * H });
  const eyes = Math.hypot((a[263].x - a[33].x) * W, (a[263].y - a[33].y) * H);
  const ma = mid(a);
  const mb = mid(b);
  return Math.hypot(ma.x - mb.x, ma.y - mb.y) < eyes * 0.6;
}

/**
 * Get an untainted, possibly downscaled ImageBitmap for an <img>.
 * Same-origin, data: and blob: images are read directly; everything else is
 * fetched by the background worker (which has host permissions) and decoded
 * from the returned bytes, so the pixels are never cross-origin.
 */
export async function loadBitmap(img, src, maxDim = MAX_DETECT_DIM) {
  const opts = resizeOptions(img.naturalWidth, img.naturalHeight, maxDim);
  const url = new URL(src, location.href);
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === location.origin) {
    return createImageBitmap(img, opts);
  }
  const res = await chrome.runtime.sendMessage({ type: 'fetch-image', url: url.href });
  if (!res?.ok) throw new Error(`fetch failed: ${res?.error ?? 'unknown'}`);
  const bytes = Uint8Array.from(atob(res.data), (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: res.type }), opts);
}

function resizeOptions(w, h, maxDim) {
  const scale = maxDim / Math.max(w, h);
  if (!(scale < 1)) return undefined;
  return { resizeWidth: Math.round(w * scale), resizeHeight: Math.round(h * scale), resizeQuality: 'medium' };
}
