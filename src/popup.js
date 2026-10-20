import { DEFAULT_SETTINGS } from './settings.js';
import { FILTERS, visibleFilters } from './filters.js';
import paw from '@tabler/icons/outline/paw.svg';
import cat from '@tabler/icons/outline/cat.svg';
import sunglasses from '@tabler/icons/outline/sunglasses.svg';
import lensConvex from '@tabler/icons/outline/lens-convex.svg';
import eye from '@tabler/icons/outline/eye.svg';
import lensConcave from '@tabler/icons/outline/lens-concave.svg';
import grain from '@tabler/icons/outline/grain.svg';
import faceBlur from './popup-icons/face-blur.svg';

const ICONS = {
  dog: paw,
  cat,
  glasses: sunglasses,
  fisheye: lensConvex,
  bigEyes: eye,
  pinch: lensConcave,
  faceBlur,
  mesh: grain,
};

const $ = (id) => document.getElementById(id);
const enabledInput = $('enabled');
const filtersBox = $('filters');
const amountBox = $('amount');
const amountLabel = $('amount-label');
const amountInput = $('amount-input');

let settings = structuredClone(DEFAULT_SETTINGS);

// ---------- Build the controls ----------

// The Landmarks debug tile only exists in an unpacked (developer) install.
const filters = visibleFilters();
for (const [id, { label }] of filters) {
  const tile = document.createElement('label');
  tile.className = 'tile';
  tile.innerHTML = `<input type="radio" name="filter"><span>${ICONS[id] ?? ''}<b></b></span>`;
  tile.querySelector('input').value = id;
  // Plain text, so the label can't inject markup.
  tile.querySelector('b').textContent = label;
  tile.querySelector('svg')?.setAttribute('aria-hidden', 'true');
  filtersBox.appendChild(tile);
}

// ---------- Reflect settings ----------

function show() {
  // A saved filter that isn't offered (removed, or debug-only) shows as the default.
  if (!filters.some(([id]) => id === settings.filter)) settings.filter = DEFAULT_SETTINGS.filter;
  enabledInput.checked = settings.enabled;
  filtersBox.disabled = !settings.enabled;
  filtersBox.querySelector(`input[value="${settings.filter}"]`).checked = true;

  const def = FILTERS[settings.filter]?.amount;
  amountBox.hidden = !def || !settings.enabled;
  if (def) {
    amountLabel.textContent = def.label;
    const value = settings.amounts?.[settings.filter] ?? def.default;
    amountInput.value = value;
    amountInput.style.setProperty('--fill', `${value}%`);
  }
}

chrome.storage.local.get(DEFAULT_SETTINGS).then((stored) => {
  settings = { ...settings, ...stored };
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

// Save at most once per frame while dragging; every face on the page redraws
// on each save.
let pending = false;
amountInput.addEventListener('input', () => {
  const value = Number(amountInput.value);
  amountInput.style.setProperty('--fill', `${value}%`);
  settings.amounts = { ...settings.amounts, [settings.filter]: value };
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    chrome.storage.local.set({ amounts: settings.amounts });
  });
});
