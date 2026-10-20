// Service worker. Two jobs:
//  1. Fetch cross-origin images for the content script so it can decode them
//     without tainting a canvas. Only URLs the page already references are
//     requested, and only with GET. Nothing is ever sent anywhere.
//  2. Inject MediaPipe's WASM loader into the content script's isolated world
//     on demand, so pages that never show a face don't pay for parsing it.

import { DEFAULT_SETTINGS, REMOVED_SETTINGS } from './settings.js';
import { FILTERS } from './filters.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

chrome.runtime.onInstalled.addListener(async () => {
  // Drop settings (and any uploaded images) left over from removed filters.
  await chrome.storage.local.remove(REMOVED_SETTINGS);
  const current = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (!(current.filter in FILTERS)) current.filter = DEFAULT_SETTINGS.filter;
  await chrome.storage.local.set(current);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'fetch-image') {
    fetchImage(msg.url).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
    return true;
  }
  if (msg?.type === 'load-mediapipe') {
    if (!sender.tab?.id) {
      sendResponse({ ok: false, error: 'no tab' });
      return false;
    }
    chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
        files: ['wasm/vision_wasm_internal.js'],
      })
      .then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
      );
    return true;
  }
  return false;
});

async function fetchImage(url) {
  const { protocol } = new URL(url);
  if (protocol !== 'http:' && protocol !== 'https:') throw new Error(`unsupported protocol ${protocol}`);

  // force-cache: the page almost certainly just loaded this image, so reuse the
  // HTTP cache instead of hitting the network again. No cookies are attached.
  const res = await fetch(url, { credentials: 'omit', cache: 'force-cache', referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (type && !type.startsWith('image/')) throw new Error(`not an image: ${type}`);
  if (type.startsWith('image/svg')) throw new Error('svg not supported');

  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error('image too large');
  // runtime messaging is JSON-only, so the blob travels as base64.
  return { ok: true, type, data: toBase64(new Uint8Array(buf)) };
}

function toBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
