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
import { FILTERS, kindOf } from '../src/filters.js';

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
fs.cpSync(path.join(root, 'src', 'fonts'), path.join(docs, 'fonts'), { recursive: true });

// Shared site stylesheet (layout + self-hosted Space Mono from docs/fonts/).
const SITE_CSS = '<link rel="stylesheet" href="style.css">';

// Example images: stickers and warps, then face blur and each body style.
// `settings` is what the extension is set to when the example is captured.
const FACE_EXAMPLES = Object.entries(FILTERS)
  .filter(([id, f]) => id !== 'mesh' && ['sticker', 'warp'].includes(kindOf(f)))
  .map(([id, f]) => ({ file: id, label: f.label, settings: { filter: id } }));
const BLUR_EXAMPLES = [
  { file: 'faceBlur', label: FILTERS.faceBlur.label, settings: { filter: 'faceBlur' } },
  ...Object.entries(FILTERS.body.styles).map(([style, { label }]) => ({
    file: `body-${style}`,
    label: `Body: ${label.toLowerCase()}`,
    settings: { filter: 'body', body: { style, color: '#ee6f9a' }, bodyImage: null },
  })),
];

// ---------- docs/index.html ----------

const figuresFor = (examples) =>
  examples
    .map(({ file, label }) => `<figure><img src="examples/${file}.png" width="240" height="240" alt="${label} filter"><figcaption>${label}</figcaption></figure>`)
    .join('\n');

fs.writeFileSync(
  path.join(docs, 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Face Hack</title>
<link rel="icon" href="icon128.png">
${SITE_CSS}
</head>
<body>
<main>
<img class="logo" src="icon128.png" alt="">
<h1>Face Hack</h1>

<p class="cta">Get the extension<br><small>(Chrome Web Store link coming soon)</small></p>

<div class="intro">Face Hack puts filters on the faces in photos and videos on any website. Everything happens on your computer.</div>

<div class="filters">
${figuresFor(FACE_EXAMPLES)}
</div>

<h2>Blur and block out</h2>
<div class="filters two">
${figuresFor(BLUR_EXAMPLES)}
</div>

<div class="copy">
<h2>How it works</h2>
<p>Turn it on and browse like normal. Face Hack finds the faces in photos and videos on the page and adds whichever filter you picked: dog ears, cat whiskers, sunglasses, a fisheye bulge, big eyes or a tiny face. Click the icon in your toolbar to switch filters, and drag the slider to make the ears bigger or the fisheye stronger. Every face on the page changes as you drag.</p>
<p>Face blur smudges out faces and necks. Body blur finds whole people, even ones facing away, and blocks them out with a solid color, a pixelated smear, or an image of your choice. Until you upload one, everybody becomes YOUR AD HERE.</p>

<h2>Private by design</h2>
<p>Face and person detection run on your computer, with models that ship inside the extension. Your photos are never uploaded, any image you add stays in your browser, there's no account, and nothing is tracked.</p>
</div>

<footer>
<a href="privacy.html">Privacy policy</a> · <a href="https://github.com/gracejli/face-filters">Source on GitHub</a>
</footer>
</main>
</body>
</html>
`,
);
console.log('wrote docs/index.html');

// ---------- Local server ----------

const TYPES = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.ttf': 'font/ttf' };
// The portrait, zoomed so head and shoulders fill the 240x240 viewport. The
// viewport does the cropping, so the extension sees an ordinary <img>.
const EXAMPLE_PAGE = `<!doctype html><body style="margin:0;overflow:hidden">
<img src="/obama.jpg" style="width:460px;display:block;margin:-6px 0 0 -110px">
</body>`;
const TILE_PAGE = `<!doctype html><base href="/docs/">${SITE_CSS}<body style="margin:0;width:440px;height:280px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#fff">
<img src="/docs/icon128.png" width="112" height="112">
<h1 style="margin:12px 0 4px">Face Hack</h1>
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
  for (const { file: id, settings } of [...FACE_EXAMPLES, ...BLUR_EXAMPLES]) {
    await setSettings({ enabled: true, ...settings });
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
