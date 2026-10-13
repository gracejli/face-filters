import { DEFAULT_SETTINGS } from './settings.js';
import { FILTERS } from './filters.js';

const enabledInput = document.getElementById('enabled');
const filtersBox = document.getElementById('filters');

for (const [id, { label }] of Object.entries(FILTERS)) {
  const option = document.createElement('label');
  option.className = 'option';
  option.innerHTML = `<input type="radio" name="filter"><span></span>`;
  option.querySelector('input').value = id;
  option.querySelector('span').textContent = label;
  filtersBox.appendChild(option);
}

chrome.storage.local.get(DEFAULT_SETTINGS).then((settings) => {
  enabledInput.checked = settings.enabled;
  filtersBox.disabled = !settings.enabled;
  const selected = filtersBox.querySelector(`input[value="${settings.filter}"]`);
  if (selected) selected.checked = true;
});

enabledInput.addEventListener('change', () => {
  filtersBox.disabled = !enabledInput.checked;
  chrome.storage.local.set({ enabled: enabledInput.checked });
});
filtersBox.addEventListener('change', (e) => {
  if (e.target.name === 'filter') chrome.storage.local.set({ filter: e.target.value });
});
