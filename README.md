# Face Hack (Chrome extension, MV3)

Puts Snapchat-style filters on faces in images and videos on any page. Face
detection uses MediaPipe Face Landmarker and runs entirely on your machine.

## Build

```bash
npm install
npm run build      # outputs dist/
npm run watch      # rebuilds on change (unminified, inline sourcemaps)
npm run icons      # regenerates src/icons/*.png from scripts/make-icons.mjs
npm run screenshots  # regenerates docs/ (website + filter examples) and store/screenshots/
npm run package    # builds and zips dist/ into release/ for the Chrome Web Store
```

The first build downloads `face_landmarker.task` (~3.7 MB) into `assets/` and
copies it and the MediaPipe WASM files into `dist/`. After that the extension
needs no network access of its own.

## Load it in Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/` folder.
4. Pin the extension and use its popup to switch filters or turn it off.

After a rebuild, click the reload icon on the extension's card and reload the
tabs you're testing in.

## How it works

| File | Role |
| --- | --- |
| `src/content.js` | Finds `<img>`/`<video>` (MutationObserver), processes only visible ones (IntersectionObserver), and draws on a canvas inserted right after each image, so popups, sticky headers and carousels that cover or clip the image do the same to the filter. Runs video detection with `requestVideoFrameCallback` at 15 fps. |
| `src/detector.js` | Creates the Face Landmarker (GPU, falls back to CPU), decodes images to an untainted `ImageBitmap`. |
| `src/background.js` | Fetches cross-origin images for the content script and injects MediaPipe's WASM loader on demand. |
| `src/filters.js` | Stickers (dog, cat, sunglasses, landmark debug view) drawn with Canvas 2D paths, and warps (fisheye, big eyes, tiny face) defined as bulges. |
| `src/warp.js` | One shared WebGL2 context that renders an image or video frame with bulge distortions; the result is pasted onto the overlay canvas. |
| `src/popup.*` | On/off toggle and filter picker, stored in `chrome.storage.local`. |

Notes:

- **Running MediaPipe in a content script.** MediaPipe normally injects its
  WASM loader with a `<script>` tag, which would run in the page's world, not
  the content script's. The background worker injects the loader into the
  content script's isolated world with `chrome.scripting.executeScript`, and the
  detector passes an empty `wasmLoaderPath` so MediaPipe skips its own loader.
  The loader is only injected once there is a visible image or video to process.
- **Cross-origin images.** Same-origin, `data:` and `blob:` images are read
  directly. Other images are fetched by the service worker (GET, no cookies,
  served from the HTTP cache when possible), sent back as base64 because runtime
  messaging is JSON-only, and decoded with `createImageBitmap(blob)`.
- **Geometry.** Stickers are drawn in a face-local frame: the origin is on the
  anchor landmark, rotation is the angle of the eye line, and one unit is the
  distance between landmarks 33 and 263. Ears anchor on landmark 10 (forehead),
  the nose on landmark 1 (nose tip). The dog's tongue appears when the mouth
  opens (landmarks 13/14).
- **Warps.** A warp needs the image's own pixels, so images keep an untainted
  `ImageBitmap` (up to 2048px) while they're visible. A fragment shader moves
  each pixel toward or away from a bulge centre, fading to no change at the
  bulge's edge, and only the affected square is copied onto the overlay. On
  video, warps redraw on every frame with the latest landmarks so the warped
  area doesn't stutter.
- **Privacy.** Nothing is uploaded. The only network requests are the service
  worker re-fetching image URLs the page already loaded. Settings use
  `storage.local`, not `storage.sync`.

## Limitations

- Cross-origin videos served without CORS headers can't be read. They're
  skipped after the first failed frame. Most large video sites use same-origin
  `blob:` (MSE) URLs, which work.
- CSS background images, images inside shadow roots, and iframes (the content
  script runs in the top frame only) aren't processed.
- Overlays are clipped like their image in almost all layouts. The exception
  is a non-positioned `overflow: hidden` element between the image and its
  nearest positioned ancestor; it clips the image but not the overlay. Warps
  follow the image's own `border-radius` (round avatars work), but not
  `clip-path` or masks.
- Detection runs on the page's main thread. Each run is a few milliseconds on
  the GPU delegate, but very image-heavy pages will feel it.
