import { DEFAULT_SETTINGS } from './settings.js';
import { FILTERS } from './filters.js';
import paw from '@tabler/icons/outline/paw.svg';
import cat from '@tabler/icons/outline/cat.svg';
import sunglasses from '@tabler/icons/outline/sunglasses.svg';
import lensConvex from '@tabler/icons/outline/lens-convex.svg';
import eye from '@tabler/icons/outline/eye.svg';
import lensConcave from '@tabler/icons/outline/lens-concave.svg';
import grain from '@tabler/icons/outline/grain.svg';

const ICONS = { dog: paw, cat, glasses: sunglasses, fisheye: lensConvex, bigEyes: eye, pinch: lensConcave, mesh: grain };

const enabledInput = document.getElementById('enabled');
const filtersBox = document.getElementById('filters');
const amountBox = document.getElementById('amount');
const amountLabel = document.getElementById('amount-label');
const amountInput = document.getElementById('amount-input');

let settings = { ...DEFAULT_SETTINGS };

for (const [id, { label }] of Object.entries(FILTERS)) {
  const tile = document.createElement('label');
  tile.className = 'tile';
  tile.innerHTML = `<input type="radio" name="filter"><span>${ICONS[id] ?? ''}<b></b></span>`;
  tile.querySelector('input').value = id;
  // Plain text, so the label can't inject markup.
  const name = tile.querySelector('b');
  name.textContent = label;
  name.style.fontWeight = 'inherit';
  tile.querySelector('svg')?.setAttribute('aria-hidden', 'true');
  filtersBox.appendChild(tile);
}

function showAmount() {
  const amount = FILTERS[settings.filter]?.amount;
  amountBox.hidden = !amount || !settings.enabled;
  if (!amount) return;
  amountLabel.textContent = amount.label;
  const value = settings.amounts?.[settings.filter] ?? amount.default;
  amountInput.value = value;
  amountInput.style.setProperty('--fill', `${value}%`);
}

chrome.storage.local.get(DEFAULT_SETTINGS).then((stored) => {
  settings = stored;
  enabledInput.checked = settings.enabled;
  filtersBox.disabled = !settings.enabled;
  const selected = filtersBox.querySelector(`input[value="${settings.filter}"]`);
  if (selected) selected.checked = true;
  showAmount();
});

enabledInput.addEventListener('change', () => {
  settings.enabled = enabledInput.checked;
  filtersBox.disabled = !settings.enabled;
  chrome.storage.local.set({ enabled: settings.enabled });
  showAmount();
});

filtersBox.addEventListener('change', (e) => {
  if (e.target.name !== 'filter') return;
  settings.filter = e.target.value;
  chrome.storage.local.set({ filter: settings.filter });
  showAmount();
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
