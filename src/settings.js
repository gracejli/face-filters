// Settings live in chrome.storage.local (not .sync) so they never leave the machine.
//   amounts:   slider key (filter id, or body.<style>) -> 0..100; missing keys use defaults
//   body:      style ('color' | 'pixel' | 'image') and fill colour for the body filter
//   bodyImage: data: URL of the user's uploaded image for the body filter, or null
//   headbandImage: data: URL of the user's uploaded picture for the headband card, or null
export const DEFAULT_SETTINGS = {
  enabled: true,
  filter: 'dog',
  amounts: {},
  body: { style: 'color', color: '#ee6f9a' },
  bodyImage: null,
  headbandImage: null,
};
