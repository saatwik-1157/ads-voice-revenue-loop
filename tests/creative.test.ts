import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bitmap, encodePng, rgb, wrapText } from '../src/creative/png.ts';
import { AssetError, imageInfo, REEL_SIZE } from '../src/creative/provider.ts';
import { RenderedAssetProvider } from '../src/creative/rendered.ts';
import { GENERATED_MANIFEST, LibraryAssetProvider } from '../src/creative/library.ts';
import { ensureCreativeAssets, hasGeneratedArtwork, missingAssets } from '../src/creative/pipeline.ts';
import { MockMetaProvider } from '../src/meta/mock.ts';
import { Store } from '../src/store/db.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { publishCampaign } from '../src/meta/publisher.ts';
import { requestGate1, approve } from '../src/approvals/gates.ts';
import { defaultGuardrails } from '../src/config/guardrails.ts';
import { DEFAULT_MODEL, resolveBriefModel } from '../src/brief/llm.ts';
import type { Brief } from '../src/core/types.ts';

const G = defaultGuardrails;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'fl-assets-'));
}

async function seedBrief(): Promise<{ store: Store; runId: string; brief: Brief }> {
  const store = new Store(':memory:');
  const { brief } = await generateBrief(G);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  return { store, runId, brief };
}

test('the PNG encoder emits a file other tools can read back', () => {
  const bitmap = new Bitmap(40, 20, rgb('#112233'));
  bitmap.fillRect(5, 5, 10, 10, rgb('#ffcc00'));
  const png = bitmap.toPng();

  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x08 + 2]);
  const info = imageInfo(png);
  assert.deepEqual(info, { format: 'png', width: 40, height: 20 });
  assert.ok(png.includes(Buffer.from('IEND', 'ascii')), 'the stream is terminated');
});

test('pixels land where they were drawn', () => {
  const bitmap = new Bitmap(10, 10, rgb('#000000'));
  bitmap.set(3, 4, rgb('#ff8000'));
  const offset = (4 * 10 + 3) * 3;
  assert.deepEqual([bitmap.pixels[offset], bitmap.pixels[offset + 1], bitmap.pixels[offset + 2]], [255, 128, 0]);
});

test('drawing outside the canvas is clipped, not crashed', () => {
  const bitmap = new Bitmap(8, 8, rgb('#000000'));
  assert.doesNotThrow(() => {
    bitmap.set(-1, -1, rgb('#ffffff'));
    bitmap.set(99, 99, rgb('#ffffff'));
    bitmap.fillRect(-20, -20, 60, 60, rgb('#ffffff'));
    bitmap.drawText('EDGE', -40, -40, 3, rgb('#ffffff'));
  });
});

test('text wraps to the available width and breaks words too long to fit', () => {
  const lines = wrapText('Still waiting on a callback?', 9, 900);
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(line.length <= 16, `"${line}" fits the column`);

  const unbreakable = wrapText('SUPERCALIFRAGILISTIC', 9, 300);
  assert.ok(unbreakable.length > 1, 'a word wider than the column is split rather than clipped');
  assert.equal(unbreakable.join(''), 'SUPERCALIFRAGILISTIC', 'no characters are lost');
});

test('a rendered creative is a valid, correctly sized reel image', async () => {
  const { brief, store } = await seedBrief();
  const provider = new RenderedAssetProvider();
  const asset = await provider.produce(brief.creatives[0]!, brief);

  assert.equal(asset.provenance, 'rendered');
  assert.equal(asset.contentType, 'image/png');
  assert.equal(asset.width, REEL_SIZE.width);
  assert.equal(asset.height, REEL_SIZE.height);
  assert.deepEqual(imageInfo(asset.bytes), { format: 'png', width: 1080, height: 1920 });
  assert.ok(asset.bytes.length > 1000, 'it actually drew something');
  store.close();
});

test('each angle renders differently, and the same variant renders the same twice', async () => {
  const { brief, store } = await seedBrief();
  const provider = new RenderedAssetProvider();

  const byAngle = new Map<string, string>();
  for (const variant of brief.creatives) {
    const asset = await provider.produce(variant, brief);
    byAngle.set(variant.angle, (byAngle.get(variant.angle) ?? '') + asset.bytes.length);
  }
  assert.ok(byAngle.size >= 3, 'the brief has several angles');

  const first = await provider.produce(brief.creatives[0]!, brief);
  const again = await provider.produce(brief.creatives[0]!, brief);
  assert.ok(first.bytes.equals(again.bytes), 'rendering is deterministic');
  store.close();
});

test('imageInfo reads real headers and refuses anything else', () => {
  const png = encodePng(3, 7, new Uint8Array(3 * 7 * 3));
  assert.deepEqual(imageInfo(png), { format: 'png', width: 3, height: 7 });

  // A minimal JPEG: SOI, then a baseline start-of-frame carrying the size.
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]),
    Buffer.from([0x02, 0x00]), // height 512
    Buffer.from([0x04, 0x00]), // width 1024
    Buffer.alloc(10),
  ]);
  assert.deepEqual(imageInfo(jpeg), { format: 'jpeg', width: 1024, height: 512 });

  assert.throws(() => imageInfo(Buffer.from('not an image at all')), AssetError);
  assert.throws(() => imageInfo(Buffer.from([0xff, 0xd8, 0xff])), AssetError);
});

test('the library serves cleared artwork and matches it to the angle by filename', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'speed-hero.png'), encodePng(800, 1000, new Uint8Array(800 * 1000 * 3)));
  writeFileSync(join(dir, 'general-01.png'), encodePng(700, 700, new Uint8Array(700 * 700 * 3)));

  const { brief, store } = await seedBrief();
  const library = new LibraryAssetProvider({ dir });
  assert.equal(library.files().length, 2);

  const speedVariant = brief.creatives.find((c) => c.angle === 'Speed')!;
  const asset = await library.produce(speedVariant, brief);
  assert.equal(asset.provenance, 'library');
  assert.match(asset.origin, /speed-hero\.png$/);
  assert.equal(asset.width, 800);
  store.close();
});

test('the library rejects artwork Meta would reject, before uploading it', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'tiny.png'), encodePng(100, 100, new Uint8Array(100 * 100 * 3)));

  const { brief, store } = await seedBrief();
  const library = new LibraryAssetProvider({ dir });
  await assert.rejects(() => library.produce(brief.creatives[0]!, brief), /minimum is 600x600/);

  const oversize = new LibraryAssetProvider({ dir, minWidth: 10, minHeight: 10, maxBytes: 10 });
  await assert.rejects(() => oversize.produce(brief.creatives[0]!, brief), /limit is/);
  store.close();
});

test('an empty library says so rather than publishing nothing', async () => {
  const { brief, store } = await seedBrief();
  const library = new LibraryAssetProvider({ dir: scratch() });
  await assert.rejects(() => library.produce(brief.creatives[0]!, brief), /no usable images/);
  store.close();
});

test('the pipeline uploads once, writes the hash onto the brief, and reuses it', async () => {
  const { store, runId, brief } = await seedBrief();
  const meta = new MockMetaProvider(3);
  let uploads = 0;
  const original = meta.uploadImage.bind(meta);
  meta.uploadImage = async (input) => {
    uploads += 1;
    return original(input);
  };

  assert.equal(missingAssets(brief).length, brief.creatives.length);

  const first = await ensureCreativeAssets(store, meta, new RenderedAssetProvider(), runId, brief);
  assert.ok(first.every((o) => o.status === 'uploaded'));
  assert.equal(uploads, brief.creatives.length);
  assert.deepEqual(missingAssets(brief), []);

  // The hash is persisted, not just held in memory.
  const reloaded = store.getBrief(runId)!;
  assert.ok(reloaded.creatives.every((c) => c.assetRef && c.assetProvenance === 'rendered'));

  const second = await ensureCreativeAssets(store, meta, new RenderedAssetProvider(), runId, reloaded);
  assert.ok(second.every((o) => o.status === 'reused'));
  assert.equal(uploads, brief.creatives.length, 'a re-run does not fill the ad account with duplicates');
  store.close();
});

test('--force re-produces artwork that already has a hash', async () => {
  const { store, runId, brief } = await seedBrief();
  const meta = new MockMetaProvider(3);
  await ensureCreativeAssets(store, meta, new RenderedAssetProvider(), runId, brief);

  const forced = await ensureCreativeAssets(store, meta, new RenderedAssetProvider(), runId, brief, { force: true });
  assert.ok(forced.every((o) => o.status === 'uploaded'));
  store.close();
});

test('re-rendered artwork actually reaches the ad account', async () => {
  // Regression: the upload was keyed on the creative id alone, so --force
  // re-rendered the image and then quietly handed back the previous hash - the
  // new artwork never shipped.
  const { store, runId, brief } = await seedBrief();
  const meta = new MockMetaProvider(8);

  const first = await ensureCreativeAssets(store, meta, new RenderedAssetProvider(), runId, brief);
  const firstHash = first[0]!.assetRef!;

  // A different palette is genuinely different artwork.
  const restyled = new RenderedAssetProvider([
    { background: '#101010', ink: '#ffffff', accent: '#ff0055', accentInk: '#101010' },
  ]);
  const second = await ensureCreativeAssets(store, meta, restyled, runId, brief, { force: true });
  assert.notEqual(second[0]!.assetRef, firstHash, 'new artwork must get a new hash');

  // Unchanged artwork still reuses its upload rather than duplicating it.
  let uploads = 0;
  const original = meta.uploadImage.bind(meta);
  meta.uploadImage = async (input) => {
    uploads += 1;
    return original(input);
  };
  const third = await ensureCreativeAssets(store, meta, restyled, runId, brief, { force: true });
  assert.equal(third[0]!.assetRef, second[0]!.assetRef, 'identical bytes keep the same hash');
  assert.equal(uploads, 0, 'and are not re-uploaded');
  store.close();
});

test('one unusable file costs that one ad, not the whole test', async () => {
  const { store, runId, brief } = await seedBrief();
  const meta = new MockMetaProvider(3);
  const flaky = {
    kind: 'library' as const,
    produce: async (variant: (typeof brief.creatives)[number]) => {
      if (variant.creativeId === brief.creatives[1]!.creativeId) {
        throw new AssetError('artwork.png is 120x120; the minimum is 600x600');
      }
      return new RenderedAssetProvider().produce(variant, brief);
    },
  };

  const outcomes = await ensureCreativeAssets(store, meta, flaky, runId, brief);
  assert.equal(outcomes.filter((o) => o.status === 'failed').length, 1);
  assert.equal(outcomes.filter((o) => o.status === 'uploaded').length, brief.creatives.length - 1);
  assert.equal(missingAssets(brief).length, 1, 'only the broken one is still missing');

  const audited = store.auditTrail(runId).find((e) => e.kind === 'creative.asset_failed');
  assert.ok(audited, 'the failure is auditable');
  store.close();
});

test('previews are written where a human can look at them before approving', async () => {
  const { store, runId, brief } = await seedBrief();
  const dir = scratch();
  const outcomes = await ensureCreativeAssets(store, new MockMetaProvider(4), new RenderedAssetProvider(), runId, brief, {
    previewDir: dir,
  });
  for (const outcome of outcomes) {
    assert.ok(outcome.previewPath, 'each creative has a preview');
    assert.ok(existsSync(outcome.previewPath));
    assert.deepEqual(imageInfo(readFileSync(outcome.previewPath)), { format: 'png', width: 1080, height: 1920 });
  }
  store.close();
});

test('publishing is refused while any creative has no artwork', async () => {
  const { store, runId, brief } = await seedBrief();
  const meta = new MockMetaProvider(5);
  approve(store, requestGate1(store, G, runId, brief, 50000).approvalId, 'tester');

  await assert.rejects(
    () => publishCampaign(store, meta, G, runId, brief, 'page_1', { dailyBudgetMinor: 50000, windowDays: 3 }),
    /creative_assets/,
  );

  await ensureCreativeAssets(store, meta, new RenderedAssetProvider(), runId, brief);
  const result = await publishCampaign(store, meta, G, runId, brief, 'page_1', {
    dailyBudgetMinor: 50000,
    windowDays: 3,
  });
  assert.equal(result.ads.length, brief.creatives.length);
  store.close();
});

test('generated artwork is flagged so gate #1 can say so', async () => {
  const { store, runId, brief } = await seedBrief();
  assert.equal(hasGeneratedArtwork(brief), false, 'nothing produced yet');

  await ensureCreativeAssets(store, new MockMetaProvider(6), new RenderedAssetProvider(), runId, brief);
  assert.equal(hasGeneratedArtwork(brief), true);

  for (const creative of brief.creatives) creative.assetProvenance = 'library';
  assert.equal(hasGeneratedArtwork(brief), false, 'cleared artwork needs no warning');
  store.close();
});

test('identical artwork yields an identical hash, the way an ad account deduplicates', async () => {
  const meta = new MockMetaProvider(7);
  const bytes = encodePng(10, 10, new Uint8Array(300));
  const a = await meta.uploadImage({ bytes, filename: 'a.png', contentType: 'image/png', idempotencyKey: 'k1' });
  const b = await meta.uploadImage({ bytes, filename: 'b.png', contentType: 'image/png', idempotencyKey: 'k2' });
  assert.equal(a.imageHash, b.imageHash);

  const different = await meta.uploadImage({
    bytes: encodePng(10, 10, new Uint8Array(300).fill(9)),
    filename: 'c.png',
    contentType: 'image/png',
    idempotencyKey: 'k3',
  });
  assert.notEqual(different.imageHash, a.imageHash);
});

test('the brief model defaults to Sonnet, and a blank override does not win', () => {
  assert.equal(resolveBriefModel(undefined), 'claude-sonnet-5');
  assert.equal(resolveBriefModel(''), 'claude-sonnet-5', 'FL_BRIEF_MODEL= in .env arrives as an empty string');
  assert.equal(resolveBriefModel('   '), 'claude-sonnet-5');
  assert.equal(resolveBriefModel('claude-opus-5'), 'claude-opus-5');
  assert.equal(resolveBriefModel('  claude-haiku-4-5  '), 'claude-haiku-4-5');
  assert.equal(DEFAULT_MODEL, 'claude-sonnet-5');
});

test('moving a file into the library cannot launder machine art into cleared art', async () => {
  // `library` provenance means a person put the file there and vouched for it,
  // which is why gate #1 stops warning. A generator that writes into assets/
  // records what it wrote, and those files keep reporting as machine-made.
  // Both files are named for the angle that selects them, so each creative
  // picks its file by name. Leaving that to the index fallback would couple
  // this to the order creatives happen to be generated in, which is a detail
  // the control layer is allowed to change.
  const dir = scratch();
  writeFileSync(join(dir, 'speed-01.png'), encodePng(800, 1000, new Uint8Array(800 * 1000 * 3)));
  writeFileSync(join(dir, 'cost-certainty-01.png'), encodePng(800, 1000, new Uint8Array(800 * 1000 * 3)));
  writeFileSync(join(dir, GENERATED_MANIFEST), JSON.stringify({ generated: ['speed-01.png'] }));

  const { brief, store } = await seedBrief();
  const library = new LibraryAssetProvider({ dir });

  const speed = brief.creatives.find((c) => c.angle === 'Speed')!;
  assert.equal((await library.produce(speed, brief)).provenance, 'rendered', 'listed in the manifest');

  const other = brief.creatives.find((c) => c.angle === 'Cost certainty')!;
  assert.equal((await library.produce(other, brief)).provenance, 'library', 'not listed, so a person vouched');
  store.close();
});

test('an unreadable manifest fails safe rather than upgrading everything to cleared', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'art.png'), encodePng(800, 1000, new Uint8Array(800 * 1000 * 3)));
  writeFileSync(join(dir, GENERATED_MANIFEST), 'not json at all');

  const { brief, store } = await seedBrief();
  const asset = await new LibraryAssetProvider({ dir }).produce(brief.creatives[0]!, brief);
  assert.equal(asset.provenance, 'rendered', 'a manifest we cannot read means we cannot vouch');
  store.close();
});

test('with no manifest at all, library files are treated as cleared', async () => {
  const dir = scratch();
  writeFileSync(join(dir, 'art.png'), encodePng(800, 1000, new Uint8Array(800 * 1000 * 3)));

  const { brief, store } = await seedBrief();
  const asset = await new LibraryAssetProvider({ dir }).produce(brief.creatives[0]!, brief);
  assert.equal(asset.provenance, 'library');
  assert.equal(hasGeneratedArtwork({ ...brief, creatives: [{ ...brief.creatives[0]!, assetProvenance: 'library' }] }), false);
  store.close();
});

/** A structurally correct PNG header: real signature, real IHDR, chosen size. */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

test('a header is a claim, not a measurement', async () => {
  // 64 bytes declaring 4294967295 square used to be believed: it cleared the
  // minimum-size check by a wide margin and went on to be uploaded to Meta.
  const dir = scratch();
  writeFileSync(join(dir, 'art.png'), pngHeader(0xffffffff, 0xffffffff));
  const { brief, store } = await seedBrief();
  await assert.rejects(new LibraryAssetProvider({ dir }).produce(brief.creatives[0]!, brief), AssetError);
  store.close();
});

test('a file that is not the image it claims to be is refused', async () => {
  const { brief, store } = await seedBrief();
  const cases: Array<[string, Buffer]> = [
    ['plain text', Buffer.from('this is a note, not artwork\n')],
    ['an empty file', Buffer.alloc(0)],
    ['four bytes of a PNG signature', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ['a PNG signature with no IHDR', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(56)])],
    ['a JPEG with no start-of-frame', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0, 0, 0, 0, 0])],
    ['a zero-sized PNG', pngHeader(0, 0)],
  ];
  for (const [label, bytes] of cases) {
    const dir = scratch();
    writeFileSync(join(dir, 'art.png'), bytes);
    await assert.rejects(
      new LibraryAssetProvider({ dir }).produce(brief.creatives[0]!, brief),
      AssetError,
      `${label} must not reach the ad account`,
    );
  }
  store.close();
});

test('an oversized file is refused by its size on disk, before it is read', async () => {
  const dir = scratch();
  // maxBytes is set low rather than writing 50MB: the point is that the
  // refusal comes from stat, not from having loaded the file to measure it.
  writeFileSync(join(dir, 'art.png'), encodePng(800, 1000, new Uint8Array(800 * 1000 * 3)));
  const { brief, store } = await seedBrief();
  await assert.rejects(
    new LibraryAssetProvider({ dir, maxBytes: 1024 }).produce(brief.creatives[0]!, brief),
    (err: Error) => err instanceof AssetError && /the limit is/.test(err.message),
  );
  store.close();
});

test('imageInfo bounds the dimensions it reports', () => {
  assert.throws(() => imageInfo(pngHeader(0, 600)), AssetError);
  assert.throws(() => imageInfo(pngHeader(600, 0)), AssetError);
  assert.throws(() => imageInfo(pngHeader(50_000, 600)), AssetError);
  assert.deepEqual(imageInfo(encodePng(800, 1000, new Uint8Array(800 * 1000 * 3))), {
    format: 'png',
    width: 800,
    height: 1000,
  });
});
