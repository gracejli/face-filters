// Lets the user pick an image for the body filter's "Image" style. The image
// is shrunk, re-encoded and stored in chrome.storage.local; it never leaves
// the browser.
import { defaultAdURL } from './ad.js';

const MAX_DIM = 1200;
// chrome.storage.local holds 10 MB in total; leave plenty of room.
const MAX_BYTES = 3 * 1024 * 1024;

const preview = document.getElementById('preview');
const fileInput = document.getElementById('file');
const status = document.getElementById('status');

let defaultAd = '';

async function showCurrent() {
  const { bodyImage } = await chrome.storage.local.get({ bodyImage: null });
  if (bodyImage) {
    preview.src = bodyImage;
  } else {
    defaultAd ||= await defaultAdURL();
    preview.src = defaultAd;
  }
}

function toDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  status.textContent = 'Saving…';
  try {
    const bitmap = await createImageBitmap(file);
    const k = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * k), Math.round(bitmap.height * k));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    // WebP keeps transparency (handy for cut-out logos) and stays small.
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 });
    if (blob.size > MAX_BYTES) throw new Error('That image is too large, even after shrinking. Try a smaller one.');
    await chrome.storage.local.set({ bodyImage: await toDataURL(blob) });
    status.textContent = 'Saved. Pick Body blur › Image in the toolbar popup to use it.';
    showCurrent();
  } catch (err) {
    status.textContent = err?.message?.startsWith('That image') ? err.message : "Couldn't read that file. Try a JPEG, PNG or WebP image.";
  }
});

document.getElementById('reset').addEventListener('click', async () => {
  await chrome.storage.local.set({ bodyImage: null });
  status.textContent = 'Using “YOUR AD HERE”.';
  showCurrent();
});

showCurrent();
