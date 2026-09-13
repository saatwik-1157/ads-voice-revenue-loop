import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { Brief, CreativeVariant } from '../core/types.ts';
import type { CreativeAssetProvider, ProducedAsset } from './provider.ts';
import { AssetError, imageInfo } from './provider.ts';

export interface LibraryOptions {
  /** Directory of cleared artwork. */
  dir: string;
  minWidth?: number;
  minHeight?: number;
  maxBytes?: number;
}

/**
 * The approved asset library: artwork a human made and cleared, on disk.
 *
 * This is what a real operator runs. Files are matched to a creative by angle
 * when the filename says so (`speed-01.png` serves the "Speed" angle), which
 * keeps the pairing of message and image deliberate rather than arbitrary;
 * anything unmatched is drawn from the general pool in a stable order so the
 * same variant keeps the same image across republishes.
 */
export class LibraryAssetProvider implements CreativeAssetProvider {
  readonly kind = 'library' as const;
  readonly #dir: string;
  readonly #minWidth: number;
  readonly #minHeight: number;
  readonly #maxBytes: number;

  constructor(options: LibraryOptions) {
    this.#dir = resolve(process.cwd(), options.dir);
    this.#minWidth = options.minWidth ?? 600;
    this.#minHeight = options.minHeight ?? 600;
    this.#maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  }

  /** Cleared artwork on disk, in a stable order. */
  files(): string[] {
    if (!existsSync(this.#dir)) return [];
    return readdirSync(this.#dir)
      .filter((name) => ['.png', '.jpg', '.jpeg'].includes(extname(name).toLowerCase()))
      .sort();
  }

  async produce(variant: CreativeVariant, brief: Brief): Promise<ProducedAsset> {
    const files = this.files();
    if (files.length === 0) {
      throw new AssetError(`no usable images in ${this.#dir}; add PNG or JPEG artwork, or use the rendered provider`);
    }

    const chosen = this.#pick(files, variant, brief);
    const path = join(this.#dir, chosen);
    const bytes = readFileSync(path);

    if (bytes.length > this.#maxBytes) {
      throw new AssetError(`${chosen} is ${(bytes.length / 1e6).toFixed(1)}MB; the limit is ${(this.#maxBytes / 1e6).toFixed(0)}MB`);
    }
    const info = imageInfo(bytes);
    if (info.width < this.#minWidth || info.height < this.#minHeight) {
      throw new AssetError(
        `${chosen} is ${info.width}x${info.height}; the minimum is ${this.#minWidth}x${this.#minHeight}`,
      );
    }

    return {
      bytes,
      filename: `${variant.creativeId}${extname(chosen).toLowerCase() === '.png' ? '.png' : '.jpg'}`,
      contentType: info.format === 'png' ? 'image/png' : 'image/jpeg',
      width: info.width,
      height: info.height,
      provenance: 'library',
      origin: path,
    };
  }

  /** Prefer a file whose name names the angle; otherwise take a stable slot. */
  #pick(files: string[], variant: CreativeVariant, brief: Brief): string {
    const angleKey = slug(variant.angle);
    const matching = files.filter((name) => slug(basename(name, extname(name))).includes(angleKey));
    const pool = matching.length ? matching : files;

    const index = Math.max(0, brief.creatives.findIndex((c) => c.creativeId === variant.creativeId));
    return pool[index % pool.length]!;
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
