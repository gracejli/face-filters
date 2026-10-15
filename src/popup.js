import { DEFAULT_SETTINGS } from './settings.js';
import { BODY_COLORS, FILTERS, amountDef, amountKey } from './filters.js';
import { defaultAdURL } from './ad.js';
import { defaultCardURL } from './card.js';
import paw from '@tabler/icons/outline/paw.svg';
import cat from '@tabler/icons/outline/cat.svg';
import sunglasses from '@tabler/icons/outline/sunglasses.svg';
import lensConvex from '@tabler/icons/outline/lens-convex.svg';
import eye from '@tabler/icons/outline/eye.svg';
import lensConcave from '@tabler/icons/outline/lens-concave.svg';
import grain from '@tabler/icons/outline/grain.svg';
import faceBlur from './popup-icons/face-blur.svg';
import bodyBlur from './popup-icons/body-blur.svg';
import headband from './popup-icons/headband.svg';

const ICONS = {
  dog: paw,
  cat,
  glasses: sunglasses,
  headband,
  fisheye: lensConvex,
  bigEyes: eye,
  pinch: lensConcave,
  faceBlur,
  body: bodyBlur,
  mesh: grain,
};

const $ = (id) => document.getElementById(id);
const enabledInput = $('enabled');
const filtersBox = $('filters');
const bodyBox = $('body-options');
const stylesBox = $('body-styles');
const swatchesBox = $('swatches');
const imageRow = $('image-row');
const imageThumb = $('image-thumb');
const cardRow = $('card-row');
const cardThumb = $('card-thumb');
const amountBox = $('amount');
const amountLabel = $('amount-label');
const amountInput = $('amount-input');

let settings = structuredClone(DEFAULT_SETTINGS);
let defaultAd = '';
defaultAdURL().then((url) => {
  defaultAd = url;
  show();
});
let defaultCard = '';
defaultCardURL().then((url) => {
  defaultCard = url;
  show();
});

// ---------- Build the controls ----------

for (const [id, { label }] of Object.entries(FILTERS)) {
  const tile = document.createElement('label');
  tile.className = 'tile';
  tile.innerHTML = `<input type="radio" name="filter"><span>${ICONS[id] ?? ''}<b></b></span>`;
  tile.querySelector('input').value = id;
  // Plain text, so the label can't inject markup.
  tile.querySelector('b').textContent = label;
  tile.querySelector('svg')?.setAttribute('aria-hidden', 'true');
  filtersBox.appendChild(tile);
}

for (const [style, { label }] of Object.entries(FILTERS.body.styles)) {
  const option = document.createElement('label');
  option.className = 'segment';
  option.innerHTML = '<input type="radio" name="body-style"><span></span>';
  option.querySelector('input').value = style;
  option.querySelector('span').textContent = label;
  stylesBox.appendChild(option);
}

for (const color of BODY_COLORS) {
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'swatch';
  swatch.style.background = color;
  swatch.dataset.color = color;
  swatch.setAttribute('aria-label', `Color ${color}`);
  swatchesBox.appendChild(swatch);
}

// ---------- Reflect settings ----------

function show() {
  enabledInput.checked = settings.enabled;
  filtersBox.disabled = !settings.enabled;
  const selected = filtersBox.querySelector(`input[value="${settings.filter}"]`);
  if (selected) selected.checked = true;

  const isBody = settings.filter === 'body';
  const style = settings.body.style;
  bodyBox.hidden = !isBody || !settings.enabled;
  stylesBox.querySelector(`input[value="${style}"]`).checked = true;
  swatchesBox.hidden = style !== 'color';
  for (const s of swatchesBox.children) s.setAttribute('aria-pressed', String(s.dataset.color === settings.body.color));
  imageRow.hidden = style !== 'image';
  const thumb = settings.bodyImage || defaultAd;
  if (thumb) imageThumb.src = thumb;

  cardRow.hidden = settings.filter !== 'headband' || !settings.enabled;
  const card = settings.headbandImage || defaultCard;
  if (card) cardThumb.src = card;

  const key = amountKey(settings.filter, style);
  const def = amountDef(key);
  amountBox.hidden = !def || !settings.enabled;
  if (def) {
    amountLabel.textContent = def.label;
    const value = settings.amounts?.[key] ?? def.default;
    amountInput.value = value;
    amountInput.style.setProperty('--fill', `${value}%`);
  }
}

chrome.storage.local.get(DEFAULT_SETTINGS).then((stored) => {
  settings = { ...settings, ...stored, body: { ...DEFAULT_SETTINGS.body, ...stored.body } };
  show();
});

// Another tab (the upload page) can change the image while we're open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of ['bodyImage', 'headbandImage']) {
    if (key in changes) settings[key] = changes[key].newValue ?? null;
  }
  show();
});

// ---------- Handle input ----------

enabledInput.addEventListener('change', () => {
  settings.enabled = enabledInput.checked;
  chrome.storage.local.set({ enabled: settings.enabled });
  show();
});

filtersBox.addEventListener('change', (e) => {
  if (e.target.name !== 'filter') return;
  settings.filter = e.target.value;
  chrome.storage.local.set({ filter: settings.filter });
  show();
});

stylesBox.addEventListener('change', (e) => {
  settings.body = { ...settings.body, style: e.target.value };
  chrome.storage.local.set({ body: settings.body });
  show();
});

swatchesBox.addEventListener('click', (e) => {
  const color = e.target.dataset?.color;
  if (!color) return;
  settings.body = { ...settings.body, color };
  chrome.storage.local.set({ body: settings.body });
  show();
});

// File pickers can close the popup before the file arrives, so uploading
// happens on its own page in a tab.
$('upload').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('upload.html?for=body') });
});
$('card-upload').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('upload.html?for=headband') });
});

// Save at most once per frame while dragging; every person or face on the
// page redraws on each save.
let pending = false;
amountInput.addEventListener('input', () => {
  const value = Number(amountInput.value);
  amountInput.style.setProperty('--fill', `${value}%`);
  const key = amountKey(settings.filter, settings.body.style);
  settings.amounts = { ...settings.amounts, [key]: value };
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    chrome.storage.local.set({ amounts: settings.amounts });
  });
});
