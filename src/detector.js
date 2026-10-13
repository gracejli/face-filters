// MediaPipe Face Landmarker, running inside the content script.
//
// MediaPipe normally loads its WASM glue (vision_wasm_internal.js) by adding a
// <script> tag to the page. In a content script that would run in the page's
// main world (and be subject to the page's CSP), so the glue would never be
// visible to us. Instead the background worker injects that same file into our
// isolated world with chrome.scripting, which defines `self.ModuleFactory`,
// and we hand MediaPipe an empty wasmLoaderPath so it skips its own loader.

import { FaceLandmarker } from '@mediapipe/tasks-vision';

const MAX_FACES = 4;
// Detection cost grows with input size and faces are fine at this resolution.
const MAX_DETECT_DIM = 1024;

let landmarkerPromise = null;

export function getLandmarker() {
  landmarkerPromise ??= createLandmarker().catch((err) => {
    landmarkerPromise = null;
    throw err;
  });
  return landmarkerPromise;
}

async function createLandmarker() {
  if (!self.ModuleFactory) {
    const res = await chrome.runtime.sendMessage({ type: 'load-mediapipe' });
    if (!res?.ok || !self.ModuleFactory) throw new Error(`could not load MediaPipe: ${res?.error ?? 'unknown'}`);
  }
  // MediaPipe clears self.ModuleFactory after using it. Keep a reference so we
  // can retry on CPU if the GPU delegate fails to initialise.
  const factory = self.ModuleFactory;
  const fileset = {
    wasmLoaderPath: '',
    wasmBinaryPath: chrome.runtime.getURL('wasm/vision_wasm_internal.wasm'),
  };
  const modelAssetPath = chrome.runtime.getURL('models/face_landmarker.task');

  let lastErr;
  for (const delegate of ['GPU', 'CPU']) {
    self.ModuleFactory = factory;
    try {
      return await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath, delegate },
        runningMode: 'IMAGE',
        numFaces: MAX_FACES,
      });
    } catch (err) {
      lastErr = err;
      console.debug(`[face-filters] ${delegate} delegate failed`, err);
    }
  }
  throw lastErr;
}

/**
 * Run detection on any ImageSource. Returns normalized [0..1] landmarks, one
 * array of {x, y} per face. Throws on tainted sources (SecurityError).
 */
export async function detectFaces(source) {
  const landmarker = await getLandmarker();
  const result = landmarker.detect(source);
  return result.faceLandmarks.map((face) => face.map(({ x, y }) => ({ x, y })));
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
