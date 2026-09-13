import type { Brief, CreativeVariant } from '../core/types.ts';

/**
 * Where an ad's image comes from.
 *
 * The playbook allows either generated imagery or an approved asset library.
 * Two implementations ship: the library (what a real operator runs, because a
 * human made and cleared the artwork) and a deterministic renderer (so the loop
 * completes offline and a delivery test can run before anyone opens a design
 * tool). An image-generation API would be a third implementation of this
 * interface and would change nothing else.
 */
export interface CreativeAssetProvider {
  readonly kind: AssetProvenance;
  produce(variant: CreativeVariant, brief: Brief): Promise<ProducedAsset>;
}

export type AssetProvenance = 'rendered' | 'library' | 'manual';

export interface ProducedAsset {
  /** Raw image bytes, ready to upload. */
  bytes: Buffer;
  filename: string;
  contentType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  provenance: AssetProvenance;
  /** Where it came from: a file path, or a note about how it was made. */
  origin: string;
}

export class AssetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssetError';
  }
}

/** Reels and vertical feed placements. Meta's recommended 9:16 size. */
export const REEL_SIZE = { width: 1080, height: 1920 } as const;

/**
 * Read dimensions and format straight from the file header.
 *
 * Worth doing rather than trusting the extension: an oversized or wrongly
 * shaped image is rejected by Meta after upload, which is a slow and confusing
 * way to find out, and a mislabelled file is rejected before it is ever sent.
 */
export function imageInfo(bytes: Buffer): { format: 'png' | 'jpeg'; width: number; height: number } {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG') {
    return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Walk the JPEG segments to the start-of-frame, which carries the size.
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      const length = bytes.readUInt16BE(offset + 2);
      // SOF0-SOF15, excluding the non-frame markers DHT/JPG/DAC.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
    throw new AssetError('JPEG carried no start-of-frame segment; the file is truncated or not a JPEG');
  }
  throw new AssetError('unrecognised image; Meta ad images must be PNG or JPEG');
}
