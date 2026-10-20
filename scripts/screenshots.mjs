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
fs.cpSync(path.join(root, 'src', 'fonts'), path.join(docs, 'fonts'), { recursive: true });

// Shared site stylesheet (layout + self-hosted Space Mono from docs/fonts/).
const SITE_CSS = '<link rel="stylesheet" href="style.css">';

// Example images, one per filter in popup order. Debug-only filters are left
// out. `settings` is what the extension is set to when it's captured.
const EXAMPLES = Object.entries(FILTERS)
  .filter(([, f]) => !f.dev)
  .map(([id, f]) => ({ file: id, label: f.label, settings: { filter: id } }));

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

<p class="cta"><a class="button" href="https://chromewebstore.google.com/detail/face-hack/cfdhakfgjfcnkfbfhicgbdingnbppdho">Get the extension</a><br><small>Free on the Chrome Web Store</small></p>

<div class="intro">Face Hack puts filters on the faces in photos and videos on any website. Everything happens on your computer.</div>

<div class="filters">
${figuresFor(EXAMPLES)}
</div>

<div class="copy">
<h2>About</h2>
<p>How we present ourselves online has shifted to optimize, adjust, and perfect - leading to phenomenons like mewing, biohacking, and micro-beauty treatments to optimize our appearance for reach, trust, or growth. This chrome extension hacks every single face that it detects on the feed, satirizing, playing, remixing, or omitting identity altogether from the content that we consume. </p>
<h2>How it Works</h2>
<p>Turn it on and browse like normal. Face Hack finds the faces in photos and videos on the page and adds whichever filter you picked: dog ears, cat whiskers, sunglasses, a fisheye bulge, big eyes, chipmunk cheeks, a tiny face, or a face blur. Click the icon in your toolbar to switch filters, and drag the slider to make the ears bigger or the fisheye stronger. Every face on the page changes as you drag.</p>
<p>Face blur smudges out faces and necks; drag the slider from a soft haze to an unrecognisable smear.</p>

<h2>Private by design!</h2>
<p>Face detection runs on your computer, with a model that ships inside the extension. Your photos are never uploaded, there's no account, and nothing is tracked.</p>

<h2>Share your screenshots</h2>
<p>Caught something funny with Face Hack? Add it to the <a href="https://www.are.na/gli/screenshots-with-facehack">Screenshots with Face Hack</a> channel on Are.na.</p>
</div>

<footer>
<a href="https://chromewebstore.google.com/detail/face-hack/cfdhakfgjfcnkfbfhicgbdingnbppdho">Chrome Web Store</a> · <a href="https://www.are.na/gli/screenshots-with-facehack">Are.na</a> · <a href="privacy.html">Privacy policy</a> · <a href="https://github.com/gracejli/face-filters">Source on GitHub</a>
</footer>
</main>
</body>
</html>
`,
);
console.log('wrote docs/index.html');

// ---------- Local server ----------

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.ttf': 'font/ttf' };
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
  for (const { file: id, settings } of EXAMPLES) {
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
