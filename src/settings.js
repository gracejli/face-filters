// Settings live in chrome.storage.local (not .sync) so they never leave the machine.
// amounts: filter id -> 0..100 slider value; filters without an entry use their default.
export const DEFAULT_SETTINGS = { enabled: true, filter: 'dog', amounts: {} };
