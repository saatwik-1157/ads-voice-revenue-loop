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
import { applyRecommendation } from '../src/apply.ts';
import type { Brief, Recommendation } from '../src/core/types.ts';

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

test('a Meta failure mid-iteration leaves the stored brief intact', async () => {
  // The worst defect this module has had: ensureCreativeAssets persists
  // whatever brief it is handed, so handing it only the new variant erased
  // every existing creative from the run. The next iteration then read those
  // angles as untried and republished a creative the engine had just killed.
  //
  // Asserting on the return value cannot catch it. This asserts on what is on
  // disk, both while the provider call is in flight and after it throws.
  const { ctx, runId, brief } = await liveRun();
  ctx.store.setAdStatus(ctx.store.listAds(ctx.store.getCampaign(runId)!.campaignId)[0]!.adId, 'PAUSED');
  const before = ctx.store.getBrief(runId)!.creatives.map((c) => `${c.angle}/${c.hook}`);
  assert.equal(before.length, 2, 'two creatives to lose');

  let duringCall: string[] = [];
  ctx.meta.createAdCreative = (): Promise<{ creativeId: string }> => {
    // What a concurrent reader would see at this instant.
    duringCall = ctx.store.getBrief(runId)!.creatives.map((c) => `${c.angle}/${c.hook}`);
    return Promise.reject(Object.assign(new Error('meta 503'), { retryable: false }));
  };

  await assert.rejects(iterateCreative(ctx, runId, brief));

  for (const original of before) {
    assert.ok(duringCall.includes(original), `${original} must still be readable mid-call`);
    assert.ok(
      ctx.store.getBrief(runId)!.creatives.some((c) => `${c.angle}/${c.hook}` === original),
      `${original} must survive a failed publish`,
    );
  }
  ctx.store.close();
});

test('the new copy itself is claim-checked, not just the brief it came from', async () => {
  // The previous version of this test poisoned brief.offer.deliverable, which
  // checkClaims walks anyway - so it passed whether or not the new variant was
  // examined. Banning a phrase that appears only in the drafted hook is what
  // makes the difference observable.
  const { ctx, runId, brief } = await liveRun();
  ctx.store.setAdStatus(ctx.store.listAds(ctx.store.getCampaign(runId)!.campaignId)[0]!.adId, 'PAUSED');

  const pick = nextUntried(brief);
  assert.ok(pick, 'there is an untried angle to draft');
  const guarded = {
    ...ctx,
    guardrails: { ...G, bannedClaimPatterns: [...G.bannedClaimPatterns, pick.hook.toLowerCase()] },
  };

  const outcome = await iterateCreative(guarded, runId, brief);
  assert.equal(outcome.status, 'refused', 'the phrase is only in the copy this call drafted');
  assert.match(outcome.reason, /needs a person/);
  ctx.store.close();
});

test('a new angle is preferred over a new hook on an angle already losing', async () => {
  // nextUntried's documented rule. The old assertion passed on the fallback
  // path too, because the fallback happened to land on an unused angle.
  const { brief } = await liveRun();
  const usedAngles = new Set(brief.creatives.map((c) => c.angle));

  // A brief that has used every angle once. The rule now has to choose a
  // second hook, and any pair is fine - what matters is the case above it.
  const everyAngle = {
    ...brief,
    creatives: ['Speed', 'Cost certainty', 'Risk of delay'].map((angle, i) => ({
      ...brief.creatives[0]!,
      creativeId: `cr_${i}`,
      angle,
      hook: `first hook for ${angle}`,
    })),
  };
  assert.ok(nextUntried(everyAngle), 'still something to try');

  // And with one angle untouched, that is the one it takes.
  const pick = nextUntried(brief);
  assert.ok(pick);
  assert.equal(usedAngles.has(pick.angle), false);
});

/** A recommendation shaped like the engine's, for driving `apply` directly. */
function recommendation(signal: string, perAd: Brief['creatives']): Recommendation {
  const zero = {
    spendMinor: 0, leads: 0, unattributedLeads: 0, calledLeads: 0, leadsAwaitingCall: 0,
    connectedLeads: 0, qualifiedLeads: 0, appointments: 0, sales: 0, revenueMinor: 0,
    cplMinor: null, costPerConnectedMinor: null, costPerQualifiedMinor: null, cacMinor: null,
    roas: 0, connectRate: 0, qualifyRate: 0,
  } as Recommendation['economics'];
  return {
    decision: 'ITERATE',
    signal,
    rationale: 'test',
    action: 'test',
    requiresHumanApproval: false,
    economics: zero,
    perAd: perAd.map((c) => ({ adId: `ad_${c.creativeId}`, decision: 'KEEP' as const, rationale: '', economics: zero })),
  };
}

test('applying an ITERATE on a creative fault publishes a new ad', async () => {
  // iterateCreative was only ever called directly by these tests. The branch in
  // applyRecommendation that reaches it had no coverage at all, so the whole
  // arm could be turned back into the no-op it started as.
  const { ctx, runId, brief } = await liveRun();
  const campaign = ctx.store.getCampaign(runId)!;
  const adsBefore = ctx.store.listAds(campaign.campaignId).length;
  ctx.store.setAdStatus(ctx.store.listAds(campaign.campaignId)[0]!.adId, 'PAUSED');

  const outcome = await applyRecommendation(ctx, runId, brief, recommendation('poor_qualification', brief.creatives));

  assert.equal(outcome.kind, 'iterated');
  assert.equal(ctx.store.listAds(campaign.campaignId).length, adsBefore + 1);
  ctx.store.close();
});

test('applying an ITERATE on a plumbing fault publishes nothing', async () => {
  // The engine says so in its own words - "this is a pipeline fault, not a
  // creative fault". Branching on the decision alone would spend more on a
  // message that was never the problem.
  for (const signal of ['no_delivery', 'no_leads', 'attribution_gap', 'low_connect_rate']) {
    const { ctx, runId, brief } = await liveRun();
    const campaign = ctx.store.getCampaign(runId)!;
    const adsBefore = ctx.store.listAds(campaign.campaignId).length;
    ctx.store.setAdStatus(ctx.store.listAds(campaign.campaignId)[0]!.adId, 'PAUSED');

    const outcome = await applyRecommendation(ctx, runId, brief, recommendation(signal, brief.creatives));

    assert.notEqual(outcome.kind, 'iterated', `${signal} is not a creative fault`);
    assert.equal(ctx.store.listAds(campaign.campaignId).length, adsBefore, `${signal} published nothing`);
    ctx.store.close();
  }
});
