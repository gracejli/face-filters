// The built-in picture for the headband filter's card: a big question mark,
// like a guessing-game card waiting for its picture. Used until the user
// uploads their own image.
import { FAMILY, loadFont } from './ad.js';

/** Draw the default card picture. 300x420 (portrait, like the card). */
export async function drawDefaultCard() {
  await loadFont();
  const c = new OffscreenCanvas(300, 420);
  const g = c.getContext('2d');
  g.fillStyle = '#f5c400';
  g.fillRect(0, 0, 300, 420);
  g.fillStyle = '#1b1b1f';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `700 260px '${FAMILY}', monospace`;
  g.fillText('?', 150, 180);
  g.font = `700 34px '${FAMILY}', monospace`;
  g.fillText('WHO AM I?', 150, 360);
  return c;
}

/** A blob: URL of the default card picture, for <img> previews. */
export async function defaultCardURL() {
  const blob = await (await drawDefaultCard()).convertToBlob({ type: 'image/png' });
  return URL.createObjectURL(blob);
}
