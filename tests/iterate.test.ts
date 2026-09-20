import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails } from '../src/config/guardrails.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { requestGate1, approve } from '../src/approvals/gates.ts';
import { publishCampaign } from '../src/meta/publisher.ts';
import { MockMetaProvider } from '../src/meta/mock.ts';
import { MockVoiceProvider } from '../src/voice/mock.ts';
import { RenderedAssetProvider } from '../src/creative/rendered.ts';
import { iterateCreative, nextUntried } from '../src/creative/iterate.ts';
import type { Context } from '../src/orchestrator.ts';
import type { Brief } from '../src/core/types.ts';

/**
 * The ITERATE arm.
 *
 * It did nothing at all: the engine concluded the offer was not landing and
 * then held everything exactly as it was, reaching the same conclusion on every
 * cycle after that. What matters in these tests is that iterating writes a
 * genuinely different angle, costs nothing extra, and cannot slip new copy past
 * the check that gate #1 applied to the original.
 */

const G = { ...defaultGuardrails, maxCreativeVariants: 2 };

async function liveRun(): Promise<{ ctx: Context; runId: string; brief: Brief }> {
  const store = new Store(':memory:');
  const ctx = {
    store,
    guardrails: G,
    meta: new MockMetaProvider(5),
    voice: new MockVoiceProvider(5),
    assets: new RenderedAssetProvider(),
    env: { mode: 'mock', meta: { pageId: 'page_1' }, previewDir: null },
  } as unknown as Context;

  const { brief } = await generateBrief(G);
  for (const c of brief.creatives) {
    c.assetRef = `hash_${c.creativeId}`;
    c.assetProvenance = 'manual';
  }
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  approve(store, requestGate1(store, G, runId, brief, 20000).approvalId, 'tester');
  await publishCampaign(store, ctx.meta, G, runId, brief, 'page_1', {
    dailyBudgetMinor: 20000,
    windowDays: 5,
    activate: true,
  });
  return { ctx, runId, brief };
}

test('it picks an angle the run has not tried', async () => {
  const { brief } = await liveRun();
  const used = new Set(brief.creatives.map((c) => c.angle));
  const pick = nextUntried(brief);

  assert.ok(pick, 'with two of six used there is something left');
  assert.equal(used.has(pick.angle), false, 'a new angle beats a new hook on an angle already losing');
});

test('iterating publishes a new ad into the existing ad set, at no extra budget', async () => {
  const { ctx, runId, brief } = await liveRun();
  const campaign = ctx.store.getCampaign(runId)!;
  const budgetBefore = campaign.dailyBudgetMinor;
  const adsBefore = ctx.store.listAds(campaign.campaignId);

  // A kill frees the slot iteration fills.
  ctx.store.setAdStatus(adsBefore[0]!.adId, 'PAUSED');

  const outcome = await iterateCreative(ctx, runId, brief);
  assert.equal(outcome.status, 'published', outcome.reason);

  const adsAfter = ctx.store.listAds(campaign.campaignId);
  assert.equal(adsAfter.length, adsBefore.length + 1, 'one more ad');
  assert.equal(
    ctx.store.getCampaign(runId)?.dailyBudgetMinor,
    budgetBefore,
    'iterating is a change of message, not of spend',
  );

  const added = adsAfter.find((a) => !adsBefore.some((b) => b.adId === a.adId));
  assert.equal(added?.adsetId, campaign.adsetId, 'into the ad set that is already running');
  assert.equal(added?.status, 'ACTIVE', 'live, because the campaign it joined is live');

  // And the brief carries it, so the next iteration knows this angle is spent.
  const saved = ctx.store.getBrief(runId)!;
  assert.equal(saved.creatives.length, brief.creatives.length + 1);
  assert.ok(saved.creatives.some((c) => c.creativeId === outcome.creativeId));
  ctx.store.close();
});

test('it will not exceed the variant cap', async () => {
  // Without a kill there is no room, and iterating would quietly run more
  // creatives than the control layer allows.
  const { ctx, runId, brief } = await liveRun();
  const outcome = await iterateCreative(ctx, runId, brief);

  assert.equal(outcome.status, 'no_room');
  assert.match(outcome.reason, /maxCreativeVariants/);
  ctx.store.close();
});

test('new copy goes through the same claim check as the brief did', async () => {
  // Iteration needs no human precisely because it cannot introduce a new claim.
  // This is the line that makes that true rather than aspirational.
  const { ctx, runId, brief } = await liveRun();
  ctx.store.setAdStatus(ctx.store.listAds(ctx.store.getCampaign(runId)!.campaignId)[0]!.adId, 'PAUSED');

  // A deliverable the claim checker refuses. The new variant's description is
  // taken from it, so the copy it writes would carry the claim.
  const poisoned: Brief = {
    ...brief,
    offer: { ...brief.offer, deliverable: 'guaranteed results, risk free, 100% success' },
  };

  const outcome = await iterateCreative(ctx, runId, poisoned);
  assert.equal(outcome.status, 'refused');
  assert.match(outcome.reason, /needs a person/);
  assert.equal(
    ctx.store.listAudit(runId, { kind: 'creative.iteration_refused' }).length,
    1,
    'and the refusal is on the record, not silent',
  );
  ctx.store.close();
});

test('it refuses while the emergency stop is engaged', async () => {
  const { ctx, runId, brief } = await liveRun();
  ctx.store.setAdStatus(ctx.store.listAds(ctx.store.getCampaign(runId)!.campaignId)[0]!.adId, 'PAUSED');
  ctx.store.engageEmergencyStop({ trigger: 'manual', reason: 'looking into something', by: 'ada' });

  const outcome = await iterateCreative(ctx, runId, brief);
  assert.equal(outcome.status, 'refused');
  assert.match(outcome.reason, /emergency stop/);
  ctx.store.close();
});

test('it says so plainly when the writer has run out of angles', async () => {
  // Not an error and not a success. The next move is a person's, and reporting
  // it as "nothing happened" would hide that.
  const { ctx, runId } = await liveRun();
  const campaign = ctx.store.getCampaign(runId)!;
  for (const ad of ctx.store.listAds(campaign.campaignId)) ctx.store.setAdStatus(ad.adId, 'PAUSED');

  let exhausted: Brief = ctx.store.getBrief(runId)!;
  for (let i = 0; i < 6; i += 1) {
    const pick = nextUntried(exhausted);
    if (!pick) break;
    exhausted = {
      ...exhausted,
      creatives: [
        ...exhausted.creatives,
        { ...exhausted.creatives[0]!, creativeId: `cr_used_${i}`, angle: pick.angle, hook: pick.hook },
      ],
    };
  }

  assert.equal(nextUntried(exhausted), null, 'the catalogue is spent');
  const outcome = await iterateCreative(ctx, runId, exhausted);
  assert.equal(outcome.status, 'nothing_untried');
  ctx.store.close();
});

test('an iteration is not activated on a campaign a human paused', async () => {
  const { ctx, runId, brief } = await liveRun();
  const campaign = ctx.store.getCampaign(runId)!;
  ctx.store.setAdStatus(ctx.store.listAds(campaign.campaignId)[0]!.adId, 'PAUSED');
  ctx.store.setCampaignStatus(campaign.campaignId, 'PAUSED');

  const outcome = await iterateCreative(ctx, runId, brief);
  assert.equal(outcome.status, 'published');

  const added = ctx.store.listAds(campaign.campaignId).find((a) => a.adId === outcome.adId);
  assert.equal(added?.status, 'PAUSED', 'iterating must not be what restarts a paused run');
  ctx.store.close();
});
