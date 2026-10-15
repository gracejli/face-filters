// Lets the user pick an image for a filter: the body filter's "Image" style
// (?for=body) or the headband's card (?for=headband). The image is shrunk,
// re-encoded and stored in chrome.storage.local; it never leaves the browser.
import { defaultAdURL } from './ad.js';
import { defaultCardURL } from './card.js';

const TARGETS = {
  body: {
    key: 'bodyImage',
    title: 'Body image',
    blurb: "This image fills every person when the Body blur filter is set to Image. It's saved only in this browser.",
    reset: 'Use “YOUR AD HERE”',
    resetDone: 'Using “YOUR AD HERE”.',
    saved: 'Saved. Pick Body blur › Image in the toolbar popup to use it.',
    fallbackURL: defaultAdURL,
  },
  headband: {
    key: 'headbandImage',
    title: 'Headband picture',
    blurb: "This picture goes on the card in everyone's headband. It's saved only in this browser.",
    reset: 'Use the question mark',
    resetDone: 'Using the question mark.',
    saved: 'Saved. Pick Headband in the toolbar popup to see it.',
    fallbackURL: defaultCardURL,
  },
};
const target = TARGETS[new URLSearchParams(location.search).get('for')] ?? TARGETS.body;

const MAX_DIM = 1200;
// chrome.storage.local holds 10 MB in total; leave plenty of room.
const MAX_BYTES = 3 * 1024 * 1024;

const preview = document.getElementById('preview');
const fileInput = document.getElementById('file');
const status = document.getElementById('status');
const reset = document.getElementById('reset');

document.title = `Face Hack: ${target.title.toLowerCase()}`;
document.getElementById('title').textContent = target.title;
document.getElementById('blurb').textContent = target.blurb;
reset.textContent = target.reset;

let fallback = '';

async function showCurrent() {
  const { [target.key]: image } = await chrome.storage.local.get({ [target.key]: null });
  if (image) {
    preview.src = image;
  } else {
    fallback ||= await target.fallbackURL();
    preview.src = fallback;
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
    await chrome.storage.local.set({ [target.key]: await toDataURL(blob) });
    status.textContent = target.saved;
    showCurrent();
  } catch (err) {
    status.textContent = err?.message?.startsWith('That image') ? err.message : "Couldn't read that file. Try a JPEG, PNG or WebP image.";
  }
});

reset.addEventListener('click', async () => {
  await chrome.storage.local.set({ [target.key]: null });
  status.textContent = target.resetDone;
  showCurrent();
});

showCurrent();
