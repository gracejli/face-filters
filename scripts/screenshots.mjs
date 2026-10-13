// Generates the plain website and Chrome Web Store images:
//   docs/examples/<filter>.png   store/obama.jpg with each filter, rendered by
//                                the real extension (dist/) in Chrome for Testing
//   docs/index.html              plain HTML page showing those examples
//   docs/icon128.png             copy of the icon for the site
//   store/screenshots/screenshot-1280x800.png   capture of docs/index.html
//   store/screenshots/promo-tile-440x280.png
//
// Usage: npm run build && npm run screenshots
// The first run downloads Chrome for Testing into .cache/ (~150 MB).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { Browser, detectBrowserPlatform, install } from '@puppeteer/browsers';
import { FILTERS } from '../src/filters.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const docs = path.join(root, 'docs');
const examplesDir = path.join(docs, 'examples');
const storeDir = path.join(root, 'store', 'screenshots');
const SOURCE = path.join(root, 'store', 'obama.jpg');
const CHROME_BUILD = '155.0.8059.39';

if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
  console.error('dist/ is missing. Run `npm run build` first.');
  process.exit(1);
}
fs.mkdirSync(examplesDir, { recursive: true });
fs.mkdirSync(storeDir, { recursive: true });
fs.copyFileSync(path.join(root, 'src', 'icons', 'icon128.png'), path.join(docs, 'icon128.png'));

// Every user-facing filter except the debug view, in popup order.
const filters = Object.entries(FILTERS).filter(([id]) => id !== 'mesh');

// ---------- docs/index.html ----------

const cells = [['original', 'No filter'], ...filters.map(([id, f]) => [id, f.label])]
  .map(([id, label]) => `<td align="center"><img src="examples/${id}.png" width="240" height="240" alt="${label}"><br>${label}</td>`);
const rows = [];
for (let i = 0; i < cells.length; i += 4) rows.push(`<tr>\n${cells.slice(i, i + 4).join('\n')}\n</tr>`);

fs.writeFileSync(
  path.join(docs, 'index.html'),
  `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Face Filters</title>
<link rel="icon" href="icon128.png">
</head>
<body>
<h1><img src="icon128.png" width="40" height="40" alt="" align="absmiddle"> Face Filters</h1>
<p>A Chrome extension that puts filters on faces in photos and videos on any website.<br>
Faces are detected on your computer. Nothing is uploaded.</p>

<h2>Filters</h2>
<table cellpadding="6">
${rows.join('\n')}
</table>

<h2>Install</h2>
<p>Chrome Web Store link coming soon.</p>

<p><a href="privacy.html">Privacy policy</a></p>
</body>
</html>
`,
);
console.log('wrote docs/index.html');

// ---------- Local server ----------

const TYPES = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg' };
// The portrait, zoomed so head and shoulders fill the 240x240 viewport. The
// viewport does the cropping, so the extension sees an ordinary <img>.
const EXAMPLE_PAGE = `<!doctype html><body style="margin:0;overflow:hidden">
<img src="/obama.jpg" style="width:460px;display:block;margin:-6px 0 0 -110px">
</body>`;
const TILE_PAGE = `<!doctype html><body style="margin:0;width:440px;height:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#fff">
<img src="/docs/icon128.png" width="112" height="112">
<h1 style="margin:12px 0 4px">Face Filters</h1>
<div>Filters for faces on any website.</div>
</body>`;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (url === '/example.html' || url === '/tile.html') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(url === '/tile.html' ? TILE_PAGE : EXAMPLE_PAGE);
    return;
  }
  const file = url === '/obama.jpg' ? SOURCE : url.startsWith('/docs/') ? path.join(docs, path.normalize(url.slice(6))) : null;
  if (!file || !file.startsWith(url === '/obama.jpg' ? SOURCE : docs) || !fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---------- Browser ----------

console.log(`Using Chrome for Testing ${CHROME_BUILD} (downloads to .cache/ on first run)`);
const { executablePath } = await install({
  browser: Browser.CHROME,
  buildId: CHROME_BUILD,
  cacheDir: path.join(root, '.cache', 'chrome'),
  platform: detectBrowserPlatform(),
});
const browser = await puppeteer.launch({ executablePath, headless: true, pipe: true, enableExtensions: [dist] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker')).worker();
  await sleep(1000); // let onInstalled write its defaults before we override them
  const setSettings = (s) => sw.evaluate((s) => chrome.storage.local.set(s), s);

  // Examples: one fresh page per filter, captured at 2x for crisp images.
  let first = true;
  for (const [id] of [['original'], ...filters]) {
    await setSettings(id === 'original' ? { enabled: false } : { enabled: true, filter: id });
    const page = await browser.newPage();
    await page.setViewport({ width: 240, height: 240, deviceScaleFactor: 2 });
    await page.goto(`${origin}/example.html`, { waitUntil: 'load' });
    await sleep(first ? 8000 : 3000); // the first page also loads MediaPipe
    first = false;
    await page.screenshot({ path: path.join(examplesDir, `${id}.png`) });
    await page.close();
    console.log(`wrote docs/examples/${id}.png`);
  }

  // Store graphics: plain captures with the extension off, so the already
  // filtered examples aren't filtered a second time.
  await setSettings({ enabled: false });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.goto(`${origin}/docs/index.html`, { waitUntil: 'load' });
  await sleep(500);
  await page.screenshot({ path: path.join(storeDir, 'screenshot-1280x800.png') });
  console.log('wrote store/screenshots/screenshot-1280x800.png');

  await page.setViewport({ width: 440, height: 280, deviceScaleFactor: 1 });
  await page.goto(`${origin}/tile.html`, { waitUntil: 'load' });
  await page.screenshot({ path: path.join(storeDir, 'promo-tile-440x280.png') });
  console.log('wrote store/screenshots/promo-tile-440x280.png');
} finally {
  await browser.close();
  server.close();
}
