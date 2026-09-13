import type { Brief, CreativeVariant } from '../core/types.ts';
import type { CreativeAssetProvider, ProducedAsset } from './provider.ts';
import { REEL_SIZE } from './provider.ts';
import { Bitmap, charAdvance, GLYPH_HEIGHT, rgb, wrapText } from './png.ts';

/**
 * Renders a plain text-forward vertical card for each creative variant.
 *
 * This exists for the same reason the deterministic brief writer does: so the
 * whole loop can run, and a real delivery test can go out, without an API key
 * or a designer. It is a legitimate format for a text-led local-services offer
 * and it is deliberately plain - it is not trying to pass for art direction, and
 * gate #1 tells the approver the imagery was generated.
 *
 * Layout respects Reels safe areas: nothing lands in the top 14% or bottom 20%,
 * where the platform's own UI sits.
 */
export class RenderedAssetProvider implements CreativeAssetProvider {
  readonly kind = 'rendered' as const;
  readonly #palette: Palette[];

  constructor(palette: Palette[] = DEFAULT_PALETTE) {
    if (palette.length === 0) throw new Error('RenderedAssetProvider needs at least one palette');
    this.#palette = palette;
  }

  async produce(variant: CreativeVariant, brief: Brief): Promise<ProducedAsset> {
    // Angle picks the palette, so the three angles are visually distinct in the
    // ad account and a human can tell them apart at a glance.
    const angles = [...new Set(brief.creatives.map((c) => c.angle))];
    const index = Math.max(0, angles.indexOf(variant.angle)) % this.#palette.length;
    const theme = this.#palette[index]!;

    const bitmap = render(variant, brief, theme);
    return {
      bytes: bitmap.toPng(),
      filename: `${variant.creativeId}.png`,
      contentType: 'image/png',
      width: REEL_SIZE.width,
      height: REEL_SIZE.height,
      provenance: 'rendered',
      origin: `generated card, ${variant.angle} palette`,
    };
  }
}

export interface Palette {
  background: string;
  ink: string;
  accent: string;
  accentInk: string;
}

export const DEFAULT_PALETTE: Palette[] = [
  { background: '#0f2d3d', ink: '#f4f7f5', accent: '#f5b700', accentInk: '#0f2d3d' },
  { background: '#2b1a3d', ink: '#f6f2fb', accent: '#5ad2a0', accentInk: '#14281f' },
  { background: '#3d1f1f', ink: '#fbf3ef', accent: '#ffb08a', accentInk: '#3d1f1f' },
];

function render(variant: CreativeVariant, brief: Brief, theme: Palette): Bitmap {
  const { width, height } = REEL_SIZE;
  const bitmap = new Bitmap(width, height, rgb(theme.background));
  const ink = rgb(theme.ink);
  const accent = rgb(theme.accent);
  const accentInk = rgb(theme.accentInk);

  const margin = 96;
  const usable = width - margin * 2;
  const safeTop = Math.round(height * 0.14);
  const safeBottom = Math.round(height * 0.80);

  // A stripe of the accent colour down the left edge, inside the safe area.
  bitmap.fillRect(margin - 28, safeTop, 8, safeBottom - safeTop, accent);

  // The CTA block is laid out first because it is anchored to the bottom of the
  // safe area; everything above flows down into the space that leaves.
  const ctaScale = 5;
  const ctaPadding = 28;
  const ctaLines = wrapText(brief.offer.cta, ctaScale, usable - ctaPadding * 2).slice(0, 2);
  const ctaLineHeight = GLYPH_HEIGHT * ctaScale + 16;
  const ctaHeight = ctaLines.length * ctaLineHeight + ctaPadding * 2 - 16;
  const ctaTop = safeBottom - ctaHeight;

  let y = safeTop + 24;

  const eyebrowScale = 4;
  bitmap.drawText(truncateWords(brief.niche.name, Math.floor(usable / charAdvance(eyebrowScale))), margin, y, eyebrowScale, accent);
  y += GLYPH_HEIGHT * eyebrowScale + 56;

  const hookScale = 9;
  for (const line of wrapText(variant.hook, hookScale, usable)) {
    bitmap.drawText(line, margin, y, hookScale, ink);
    y += GLYPH_HEIGHT * hookScale + 18;
  }

  y += 30;
  bitmap.fillRect(margin, y, Math.round(usable * 0.32), 6, accent);
  y += 52;

  const headlineScale = 5;
  for (const line of wrapText(variant.headline, headlineScale, usable).slice(0, 3)) {
    bitmap.drawText(line, margin, y, headlineScale, ink);
    y += GLYPH_HEIGHT * headlineScale + 14;
  }

  // What the lead actually gets. This carries the ad and it is also what stops
  // the middle of the card being dead space.
  y += 44;
  const bodyScale = 4;
  const bodyLineHeight = GLYPH_HEIGHT * bodyScale + 16;
  const bodyRoom = Math.max(0, Math.floor((ctaTop - 60 - y) / bodyLineHeight));
  for (const line of wrapText(brief.offer.deliverable, bodyScale, usable).slice(0, bodyRoom)) {
    bitmap.drawText(line, margin, y, bodyScale, ink);
    y += bodyLineHeight;
  }

  bitmap.fillRect(margin, ctaTop, usable, ctaHeight, accent);
  let ctaY = ctaTop + ctaPadding;
  for (const line of ctaLines) {
    bitmap.drawText(line, margin + ctaPadding, ctaY, ctaScale, accentInk);
    ctaY += ctaLineHeight;
  }

  return bitmap;
}

/** Cut at a word boundary rather than mid-word, which reads as a typo. */
function truncateWords(text: string, maxChars: number): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.5 ? cut.slice(0, lastSpace) : cut).trim();
}
