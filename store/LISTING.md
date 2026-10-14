# Chrome Web Store listing

Everything to paste into the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), section by section.

## Package

Upload `release/face-hack-<version>.zip` from `npm run package`.

## Store listing

**Name:** Face Hack

**Summary** (from the manifest, ≤132 characters):

> Fun face filters for photos and videos on any website. Faces are detected on your computer and nothing is uploaded.

**Description:**

```
Give every face on the web dog ears, cat whiskers, sunglasses or a fisheye bulge.

Face Hack finds faces in photos and videos on any website and adds a filter on top, live. Scroll a gallery, a news site or your social feed and every face gets the treatment.

FILTERS
• Dog: floppy ears and a nose, plus a tongue when the mouth is open
• Cat: pointy ears, nose and whiskers
• Sunglasses
• Fisheye: bulges the whole face
• Big eyes
• Tiny face

HOW TO USE
Click the Face Hack icon in the toolbar to pick a filter or turn it off. Drag the slider to change how big the stickers are or how strong the warp is. Every photo on the page updates as you drag.

PRIVATE BY DESIGN
Face detection runs entirely on your computer using Google's MediaPipe face model, which ships inside the extension. Your images are never uploaded, there's no account, and no data is collected. The only network requests the extension makes are re-downloading images the page already shows, so it can read their pixels.

GOOD TO KNOW
• Works best on front-facing faces. Faces turned to the side may not be found.
• Very small images (under 64 pixels) are skipped.
• Some videos from other websites can't be read because of browser security rules. Those are skipped.
```

**Category:** Lifestyle › Just for Fun (or Entertainment, if that's what the dashboard offers)

**Language:** English

**Graphics** (from `npm run screenshots`, in `store/screenshots/`):

| Field | File |
| --- | --- |
| Store icon (128×128) | `src/icons/icon128.png` |
| Screenshot (1280×800) | `screenshot-1280x800.png` |
| Small promo tile (440×280) | `promo-tile-440x280.png` |

## Privacy practices

**Single purpose:**

> Adds face filters (stickers and face distortions) to images and videos on web pages, using on-device face detection.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `storage` | Saves the user's two settings (filters on/off and which filter is selected) locally with chrome.storage.local. |
| `scripting` | Loads the bundled MediaPipe WebAssembly loader into the extension's content script only when a page has a visible image or video to process, so pages without media don't pay for it. No remote code is injected. |
| Host permission `<all_urls>` | The extension's purpose is to add filters to images on whatever site the user is viewing, so the content script must run on all sites. The background service worker also re-fetches cross-origin images the page already displays, because the browser blocks reading their pixels otherwise. These requests are GETs to URLs taken from the page, without cookies, and the image data never leaves the device. |

**Are you using remote code?** No. All JavaScript and the WebAssembly face model are packaged in the extension.

**Data usage:** Tick none of the data categories. The extension does not collect or transmit any user data.

Certify all three:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Homepage URL:** https://gracejli.github.io/face-filters/

**Privacy policy URL:** https://gracejli.github.io/face-filters/privacy.html

## Before submitting

- [x] Fill in the contact email in `docs/privacy.html`.
- [x] Push to GitHub and publish `docs/` with GitHub Pages.
- [ ] Bump `version` in `src/manifest.json` for each new upload, then `npm run package`.
