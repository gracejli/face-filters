// The built-in fill for the body filter's "Image" style: a repeating
// "YOUR AD HERE" pattern, used until the user uploads their own image.

const FONT_URL = () => chrome.runtime.getURL('fonts/SpaceMono-Bold.ttf');
export const FAMILY = 'Face Hack Space Mono';

let fontReady = null;
/** Load Space Mono Bold for drawing on canvases (shared with card.js). */
export function loadFont() {
  fontReady ??= (async () => {
    try {
      const font = new FontFace(FAMILY, `url(${FONT_URL()})`, { weight: '700' });
      await font.load();
      (self.document?.fonts ?? self.fonts)?.add(font);
    } catch {
      // Falls back to the system monospace font.
    }
  })();
  return fontReady;
}

/**
 * Draw the default fill: a seamless tile of "YOUR AD HERE" in two offset
 * rows, so it can repeat across a silhouette of any shape. 640x240.
 */
export async function drawDefaultAd() {
  await loadFont();
  const c = new OffscreenCanvas(640, 240);
  const g = c.getContext('2d');
  g.fillStyle = '#f5c400';
  g.fillRect(0, 0, 640, 240);
  g.fillStyle = '#1b1b1f';
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.font = `700 52px '${FAMILY}', monospace`;
  // Row 1 centred; row 2 offset by half a tile and wrapped, so tiles join up.
  g.fillText('YOUR AD HERE', 320, 60);
  for (const x of [0, 640]) g.fillText('YOUR AD HERE', x, 180);
  return c;
}

/** A blob: URL of the default fill, for <img> previews. */
export async function defaultAdURL() {
  const blob = await (await drawDefaultAd()).convertToBlob({ type: 'image/png' });
  return URL.createObjectURL(blob);
}
