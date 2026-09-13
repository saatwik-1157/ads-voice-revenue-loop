import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Store } from '../store/db.ts';
import type { MetaProvider } from '../meta/provider.ts';
import type { Brief } from '../core/types.ts';
import type { CreativeAssetProvider } from './provider.ts';
import { AssetError } from './provider.ts';

export interface EnsureAssetsOptions {
  /** Write a copy of each produced image here so a human can look before approving. */
  previewDir?: string | null;
  /** Re-produce and re-upload even for variants that already carry a hash. */
  force?: boolean;
}

export interface AssetOutcome {
  creativeId: string;
  status: 'uploaded' | 'reused' | 'failed';
  assetRef?: string;
  provenance?: string;
  origin?: string;
  previewPath?: string;
  error?: string;
}

/**
 * Give every creative variant an image hash the ad account can use.
 *
 * Runs before publish. Producing and uploading is idempotent per variant: the
 * hash is written back onto the brief, so a retried or re-run publish reuses
 * the artwork instead of filling the ad account with duplicates.
 *
 * A failure here is not fatal to the other variants - one unusable file in an
 * asset library should cost you that one ad, not the whole test.
 */
export async function ensureCreativeAssets(
  store: Store,
  meta: MetaProvider,
  assets: CreativeAssetProvider,
  runId: string,
  brief: Brief,
  options: EnsureAssetsOptions = {},
): Promise<AssetOutcome[]> {
  const outcomes: AssetOutcome[] = [];
  let changed = false;

  for (const variant of brief.creatives) {
    if (variant.assetRef && !options.force) {
      outcomes.push({
        creativeId: variant.creativeId,
        status: 'reused',
        assetRef: variant.assetRef,
        provenance: variant.assetProvenance ?? undefined,
      });
      continue;
    }

    try {
      const produced = await assets.produce(variant, brief);

      let previewPath: string | undefined;
      if (options.previewDir) {
        const dir = resolve(process.cwd(), options.previewDir, runId);
        mkdirSync(dir, { recursive: true });
        previewPath = join(dir, produced.filename);
        writeFileSync(previewPath, produced.bytes);
      }

      // Keyed on the bytes, not just the creative id: a retried publish must
      // reuse the upload, but re-rendered artwork is genuinely a new image and
      // has to reach the ad account. Keying on the id alone silently returned
      // the old hash and the new artwork never shipped.
      const digest = createHash('sha256').update(produced.bytes).digest('hex').slice(0, 16);
      const { imageHash } = await store.onceAsync('meta.uploadImage', [runId, variant.creativeId, digest], () =>
        meta.uploadImage({
          bytes: produced.bytes,
          filename: produced.filename,
          contentType: produced.contentType,
          idempotencyKey: `${runId}:image:${variant.creativeId}:${digest}`,
        }),
      );

      variant.assetRef = imageHash;
      variant.assetProvenance = produced.provenance;
      changed = true;

      store.audit(runId, 'agent', 'creative.asset_ready', {
        creativeId: variant.creativeId,
        provenance: produced.provenance,
        origin: produced.origin,
        size: `${produced.width}x${produced.height}`,
        bytes: produced.bytes.length,
      });

      outcomes.push({
        creativeId: variant.creativeId,
        status: 'uploaded',
        assetRef: imageHash,
        provenance: produced.provenance,
        origin: produced.origin,
        previewPath,
      });
    } catch (err) {
      const message = err instanceof AssetError ? err.message : (err as Error).message;
      store.audit(runId, 'system', 'creative.asset_failed', { creativeId: variant.creativeId, error: message });
      outcomes.push({ creativeId: variant.creativeId, status: 'failed', error: message });
    }
  }

  if (changed) store.saveBrief(runId, brief);
  return outcomes;
}

/** Variants still without artwork. Publish refuses to run while any remain. */
export function missingAssets(brief: Brief): string[] {
  return brief.creatives.filter((c) => !c.assetRef).map((c) => c.creativeId);
}

/** True when any creative's imagery was machine-generated rather than cleared by a person. */
export function hasGeneratedArtwork(brief: Brief): boolean {
  return brief.creatives.some((c) => c.assetProvenance === 'rendered');
}
