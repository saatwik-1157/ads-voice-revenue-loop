import { Bitmap, rgb, type Rgb } from './png.ts';
import { REEL_SIZE } from './provider.ts';

/**
 * Abstract placeholder artwork, for demonstrating the asset-library path when
 * no real artwork exists.
 *
 * Deliberately text-free, the way a stock image or a photograph would be: the
 * ad copy lives in the Meta creative fields, not burnt into the picture. That
 * also makes it visually obvious which provider produced a given image - the
 * generated fallback draws text cards, this draws backgrounds.
 *
 * Nothing here makes the result *cleared* artwork. The script that writes these
 * into assets/ also records them in a manifest, so the library provider still
 * reports them as machine-made and gate #1 still warns. Moving a file must not
 * be able to launder its provenance.
 */

export interface PlaceholderTheme {
  name: string;
  top: string;
  bottom: string;
  accent: string;
}

export const PLACEHOLDER_THEMES: PlaceholderTheme[] = [
  { name: 'speed', top: '#06263a', bottom: '#0d5c7a', accent: '#ffc94d' },
  { name: 'cost-certainty', top: '#1e1033', bottom: '#43276b', accent: '#5ad2a0' },
  { name: 'risk-of-delay', top: '#2e0f12', bottom: '#6d2320', accent: '#ff9d6e' },
];

/** A vertical gradient, a soft glow, and two diagonal bands. */
export function renderPlaceholder(theme: PlaceholderTheme, variant: number): Bitmap {
  const { width, height } = REEL_SIZE;
  const top = rgb(theme.top);
  const bottom = rgb(theme.bottom);
  const accent = rgb(theme.accent);
  const bitmap = new Bitmap(width, height, top);

  // Gradient. Eased so the darker half holds more of the frame, which is where
  // Reels overlays sit.
  for (let y = 0; y < height; y += 1) {
    const t = Math.pow(y / (height - 1), 1.4);
    const row = mix(top, bottom, t);
    bitmap.fillRect(0, y, width, 1, row);
  }

  // An off-centre glow, brightest at its core and falling away smoothly.
  const cx = width * (variant % 2 === 0 ? 0.68 : 0.3);
  const cy = height * 0.34;
  const radius = width * 0.62;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - cx;
      const dy = (y - cy) * 1.25;
      const d = Math.sqrt(dx * dx + dy * dy) / radius;
      if (d >= 1) continue;
      const strength = Math.pow(1 - d, 2.2) * 0.55;
      bitmap.set(x, y, mix(bitmap.get(x, y), accent, strength));
    }
  }

  // Two diagonal bands, thin and confident, angled the other way on odd variants.
  const slope = variant % 2 === 0 ? 0.42 : -0.42;
  for (const [offset, thickness, alpha] of [
    [height * 0.62, 26, 0.9],
    [height * 0.62 + 70, 10, 0.5],
  ] as const) {
    for (let x = 0; x < width; x += 1) {
      const y0 = Math.round(offset + (x - width / 2) * slope);
      for (let t = 0; t < thickness; t += 1) {
        bitmap.set(x, y0 + t, mix(bitmap.get(x, y0 + t), accent, alpha));
      }
    }
  }

  return bitmap;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.min(1, Math.max(0, t));
  return {
    r: Math.round(a.r + (b.r - a.r) * k),
    g: Math.round(a.g + (b.g - a.g) * k),
    b: Math.round(a.b + (b.b - a.b) * k),
  };
}
