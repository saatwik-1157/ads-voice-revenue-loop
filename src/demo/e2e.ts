import type { Context } from '../orchestrator.ts';
import { exclusionRules, isWithinCallWindow, nextTimeInsideCallWindow } from '../config/guardrails.ts';
import { hasAnthropicCredentials } from '../config/env.ts';
import type { MockMetaProvider } from '../meta/mock.ts';
import type { MockVoiceProvider } from '../voice/mock.ts';
import type { Brief } from '../core/types.ts';
import { generateBrief } from '../brief/generator.ts';
import { approve, requestGate1, requestGate2, GATE_2 } from '../approvals/gates.ts';
import { publishCampaign, syncInsights } from '../meta/publisher.ts';
import { intakeLead } from '../pipeline/intake.ts';
import { dispatchLead } from '../pipeline/dispatch.ts';
import { handleCallWebhook } from '../pipeline/webhooks.ts';
import { evaluate, planScale } from '../economics/decision.ts';
import { formatBrief, formatRecommendation } from '../report.ts';
import { money } from '../core/util.ts';
import { ensureCreativeAssets } from '../creative/pipeline.ts';
import { pauseKilledAds } from '../apply.ts';

/**
 * The 48-hour MVP, compressed into one command.
 *
 * Runs phases A-H against the mock providers so the closed loop can be shown
 * end to end with no spend and no real calls: brief -> gate #1 -> publish ->
 * lead -> voice call -> structured outcome -> attribution -> decision -> gate #2.
 */
export async function runDemo(ctx: Context, opts: { days?: number; leadsPerDay?: number } = {}): Promise<void> {
  const days = opts.days ?? 7;
  const { store, guardrails: g } = ctx;
  const meta = ctx.meta as MockMetaProvider;
  const voice = ctx.voice as MockVoiceProvider;

  if (ctx.meta.kind !== 'mock' || ctx.voice.kind !== 'mock') {
    throw new Error('demo only runs against mock providers; set FL_MODE=mock');
  }

  say('PHASE A  control layer');
  say(`  geo ${g.allowedGeos.join(',')}  daily cap ${money(g.maxDailySpendMinor, g.currency)}  test budget ${money(g.maxTestBudgetMinor, g.currency)}  stop-loss ${money(g.stopLossMinor, g.currency)}`);
  const rules = exclusionRules(g);
  const blockRules = rules.filter((r) => r.severity === 'block').length;
  say(
    `  exclusion rules: ${rules.length} (${blockRules} block, ${rules.length - blockRules} route to a human)   special ad categories: ${g.specialAdCategoriesAllowed ? 'ALLOWED' : 'blocked'}`,
  );

  say('\nPHASE B  AI brief');
  const { brief, claimIssues, promiseDrift, rejectedNiches, reviewFlags } = await generateBrief(g, {
    anthropicKey: ctx.env.anthropicKey || undefined,
    useModel: hasAnthropicCredentials(ctx.env),
  });
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  say(`  run ${runId}`);
  say(indent(formatBrief(brief, g)));
  if (rejectedNiches.length) {
    say(`  niches rejected by guardrails: ${rejectedNiches.map((r) => r.name).join('; ')}`);
  }

  say('\nPHASE C  creative assets + human gate #1');
  // Artwork is produced before the gate, not after it: gate #1 asks a person to
  // approve the creative, and they cannot do that without seeing it.
  const assetOutcomes = await ensureCreativeAssets(store, meta, ctx.assets, runId, brief, {
    previewDir: ctx.env.previewDir,
  });
  const failedAssets = assetOutcomes.filter((o) => o.status === 'failed');
  if (failedAssets.length) {
    say(`  ${failedAssets.length} creative(s) have no usable artwork; the demo stops here.`);
    for (const outcome of failedAssets) say(`    - ${outcome.creativeId}: ${outcome.error}`);
    return;
  }
  say(`  artwork ready for ${assetOutcomes.length} creative(s) via the ${ctx.assets.kind} provider`);
  if (ctx.env.previewDir) say(`  previews in ${ctx.env.previewDir}/${runId}`);

  // Floor, not round: dividing a total across days and rounding up overshoots
  // the total by up to one minor unit per day, which the test-budget cap then
  // correctly refuses. 1,500 over 7 days rounds to 21429 and projects 150003.
  const dailyBudgetMinor = Math.min(g.maxDailySpendMinor, Math.floor(g.maxTestBudgetMinor / days));
  const gate1 = requestGate1(store, g, runId, brief, dailyBudgetMinor, reviewFlags);
  if (claimIssues.length || promiseDrift.length || gate1.blocking.length) {
    say('  BLOCKED - the brief has issues a human must not be asked to wave through:');
    for (const issue of gate1.blocking) say(`    - ${issue}`);
    say('  demo stops here; regenerate the brief.');
    return;
  }
  say(`  approval ${gate1.approvalId} requested; no claim or promise-drift issues found`);
  for (const flag of gate1.reviewFlags) say(`    confirm: ${flag}`);
  approve(store, gate1.approvalId, 'demo-operator');
  say('  approved by demo-operator (in production this is a person reading the summary above)');

  say('\nPHASE D  Meta execution');
  const published = await publishCampaign(store, meta, g, runId, brief, ctx.env.meta.pageId || 'mock_page', {
    dailyBudgetMinor,
    windowDays: days,
    activate: true,
  });
  say(`  campaign ${published.campaign.campaignId} / adset ${published.campaign.adsetId}`);
  say(`  ${published.ads.length} ads live at ${money(dailyBudgetMinor, g.currency)}/day for ${days} days`);

  say('\nPHASE E+F  leads -> voice -> structured outcomes');
  // The demo simulates days elapsing, so it simulates the hour those calls
  // happen too. Judging a simulated call against the real wall clock means
  // running this after dinner silently skips the entire voice half.
  const callTime = nextTimeInsideCallWindow(g);
  const simulated = !isWithinCallWindow(g);
  if (simulated) {
    say(
      `  it is outside the ${g.callWindow.startHour}:00-${g.callWindow.endHour}:00 ${g.callWindow.timeZone} calling window,` +
        ` so calls are simulated as if placed at ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: g.callWindow.timeZone }).format(callTime)} local`,
    );
    say('  (a live run would defer them instead - the guardrail is real, only the demo clock is not)');
  }

  const skipped = { deferred: 0, suppressed: 0 };
  let leadsSeen = 0;
  for (let day = 1; day <= days; day += 1) {
    meta.tick();
    const before = new Map(store.spendByAd(runId).map((r) => [r.adId, r.leads]));
    await syncInsights(store, meta, runId);
    const after = store.spendByAd(runId);

    for (const row of after) {
      if (!row.adId) continue;
      const newLeads = row.leads - (before.get(row.adId) ?? 0);
      const ad = store.listAds(published.campaign.campaignId).find((a) => a.adId === row.adId);
      if (!ad || newLeads <= 0) continue;

      for (let i = 0; i < newLeads; i += 1) {
        leadsSeen += 1;
        const intake = intakeLead(store, g, runId, {
          name: `Demo Lead ${leadsSeen}`,
          phone: `9${String(800000000 + leadsSeen * 137)}`,
          consent: true,
          consentSource: 'meta_instant_form',
          campaignId: published.campaign.campaignId,
          adsetId: published.campaign.adsetId,
          adId: ad.adId,
          creativeId: ad.creativeId,
        });
        if (intake.status !== 'accepted') continue;

        const dispatch = await dispatchLead(
          store,
          voice,
          g,
          intake.lead,
          brief,
          'http://localhost/demo',
          {
            // The mock voice agent uses this to correlate outcome quality with
            // the creative, so the decision engine has a real signal to find.
            creative_quality: meta.quality(ad.adId).toFixed(3),
          },
          callTime,
        );
        if (dispatch.status !== 'dispatched') {
          // A skipped dispatch must never be silent: it is the difference
          // between a broken funnel and a guardrail doing its job.
          skipped[dispatch.status] += 1;
          continue;
        }

        const outcome = voice.simulateOutcome(dispatch.callRef);
        handleCallWebhook(store, {
          call_id: outcome.callId,
          lead_id: outcome.leadId,
          connected: outcome.connected,
          qualified: outcome.qualified,
          intent_score: outcome.intentScore,
          objection: outcome.objection,
          appointment_booked: outcome.appointmentBooked,
          sale_status: outcome.saleStatus,
          expected_value: outcome.expectedValueMinor / 100,
          next_action: outcome.nextAction,
          summary: outcome.summary,
          opt_out: outcome.optOut,
        });
      }
    }
    const note = skipped.deferred || skipped.suppressed
      ? ` (${skipped.deferred} deferred, ${skipped.suppressed} suppressed)`
      : '';
    say(`  day ${day}: ${store.countLeads(runId)} leads captured and called so far${note}`);
  }

  say('\nPHASE G  AI review');
  const rec = evaluate(store, g, runId, brief);
  say(indent(formatRecommendation(rec, g)));

  say('\nPHASE H  human gate #2');
  const plan = planScale(g, published.campaign.dailyBudgetMinor, rec.decision, rec.perAd);
  if (plan.proposedDailyMinor !== published.campaign.dailyBudgetMinor) {
    if (plan.needsApproval) {
      const gate2 = requestGate2(store, runId, `Raise daily budget to ${money(plan.proposedDailyMinor, g.currency)}`, {
        from: published.campaign.dailyBudgetMinor,
        to: plan.proposedDailyMinor,
        proven: plan.provenDailyMinor,
        holdout: plan.holdoutDailyMinor,
        reason: plan.reason,
      });
      say(`  approval ${gate2.approvalId} pending: ${gate2.summary} (${plan.reason})`);
      say('  the agent stops here until a human decides.');
    } else {
      await meta.setDailyBudget(published.campaign.adsetId, plan.proposedDailyMinor);
      store.setCampaignBudget(published.campaign.campaignId, plan.proposedDailyMinor);
      say(`  budget raised to ${money(plan.proposedDailyMinor, g.currency)}/day within the approved step (${plan.reason})`);
      say(
        `  holdout reserved: ${money(plan.holdoutDailyMinor, g.currency)}/day across ${plan.holdoutAdIds.length} test creative(s)`,
      );
    }
  } else {
    say(`  no budget change proposed (${plan.reason})`);
  }
  for (const warning of plan.warnings) say(`  WARNING: ${warning}`);

  // Apply the per-creative verdicts the agent is allowed to act on alone,
  // leaving the holdout creatives running.
  const paused = await pauseKilledAds(ctx, runId, rec, plan);
  if (paused) say(`  paused ${paused} underperforming creative(s) inside the existing cap`);

  say('\nSUCCESS CONDITION');
  say(indent(attributionProof(ctx, runId, brief)));
  say(`\n  pending approvals: ${store.pendingApprovals(runId).length}`);
  say(`  audit events: ${store.auditTrail(runId).length}`);
  say(`  run id: ${runId}   (inspect with: node src/cli.ts review ${runId})`);
}

/**
 * The playbook's success condition: one real lead travels end to end and the
 * system can name the exact ad that produced the outcome.
 */
function attributionProof(ctx: Context, runId: string, brief: Brief): string {
  const row = ctx.store.db
    .prepare(
      `SELECT l.lead_id AS leadId, l.ad_id AS adId, l.creative_id AS creativeId,
              c.connected, c.qualified, c.sale_status AS saleStatus, c.next_action AS nextAction
       FROM leads l JOIN calls c ON c.lead_id = l.lead_id
       WHERE l.run_id = ?
       ORDER BY c.qualified DESC, c.connected DESC, c.received_at ASC
       LIMIT 1`,
    )
    .get(runId) as
    | { leadId: string; adId: string; creativeId: string; connected: number; qualified: number; saleStatus: string; nextAction: string }
    | undefined;

  if (!row) return 'No lead completed the loop in this run - nothing to attribute.';

  const creative = brief.creatives.find((c) => c.creativeId === row.creativeId);
  return [
    `lead ${row.leadId}`,
    `  came from ad ${row.adId}`,
    `  creative ${row.creativeId} - ${creative ? `${creative.angle} / "${creative.hook}"` : 'unknown'}`,
    `  call connected=${row.connected === 1} qualified=${row.qualified === 1} sale=${row.saleStatus}`,
    `  next action: ${row.nextAction}`,
  ].join('\n');
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `  ${line}` : line))
    .join('\n');
}

export { GATE_2 };
