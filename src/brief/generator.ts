import type { Brief, CallScript, CreativeVariant, NicheCandidate, Offer, ScoredNiche, SuccessMetrics } from '../core/types.ts';
import type { Guardrails } from '../config/guardrails.ts';
import { id, money, now } from '../core/util.ts';
import { pickNiche, SEED_CANDIDATES } from './niche.ts';
import { checkClaims, checkPromiseAlignment, type ClaimIssue } from './claims.ts';
import { draftBrief, type DraftedBrief } from './llm.ts';

export interface BriefResult {
  brief: Brief;
  claimIssues: ClaimIssue[];
  promiseDrift: string[];
  rejectedNiches: Array<{ name: string; reason: string }>;
  ranked: ScoredNiche[];
  /** Ambiguous exclusion matches on the chosen niche, for gate #1 to confirm. */
  reviewFlags: string[];
}

export interface BriefOptions {
  candidates?: NicheCandidate[];
  /** Explicit key. Omit to let the SDK resolve credentials itself. */
  anthropicKey?: string;
  /** Attempt the model at all. Defaults to false, so an offline run stays offline. */
  useModel?: boolean;
  /** Expected revenue per closed sale; drives the target CAC and ROAS. */
  dealValueMinor?: number;
}

/**
 * Phase B of the playbook: the AI brief.
 *
 * Produces the niche thesis, offer, creative matrix, lead-form copy, call script
 * and success metrics - then validates its own output. A brief with claim issues
 * is still returned (so a human can see exactly what was wrong) but the approval
 * gate will refuse to let it publish.
 */
export async function generateBrief(g: Guardrails, options: BriefOptions = {}): Promise<BriefResult> {
  const { chosen, ranked, rejected, reviewFlags } = pickNiche(options.candidates ?? SEED_CANDIDATES, g);
  const dealValueMinor = options.dealValueMinor ?? 500000;

  let drafted: DraftedBrief;
  let source: Brief['source'] = 'llm';
  if (options.useModel ?? Boolean(options.anthropicKey)) {
    try {
      drafted = await draftBrief(chosen, g, money(g.maxTestBudgetMinor, g.currency), options.anthropicKey);
    } catch (err) {
      process.stderr.write(`[brief] model draft failed (${(err as Error).message}); using deterministic writer\n`);
      drafted = deterministicDraft(chosen, g);
      source = 'deterministic';
    }
  } else {
    drafted = deterministicDraft(chosen, g);
    source = 'deterministic';
  }

  const creatives: CreativeVariant[] = drafted.creatives.map((c) => ({
    ...c,
    creativeId: id('cr'),
    assetRef: null,
    assetProvenance: null,
  }));

  const offer: Offer = { ...drafted.offer, pricePointMinor: dealValueMinor, currency: g.currency };

  const brief: Brief = {
    briefId: id('brief'),
    createdAt: now(),
    niche: chosen,
    offer,
    creatives,
    leadFormCopy: drafted.leadFormCopy,
    callScript: drafted.callScript,
    successMetrics: successMetrics(g, dealValueMinor),
    source,
  };

  return {
    brief,
    claimIssues: checkClaims(brief, g),
    promiseDrift: checkPromiseAlignment(brief),
    rejectedNiches: rejected,
    ranked,
    reviewFlags,
  };
}

/**
 * Targets derived from the money, not from vanity metrics. Everything is anchored
 * to "what CPL still leaves a profit at this deal value and this close rate".
 */
export function successMetrics(g: Guardrails, dealValueMinor: number): SuccessMetrics {
  const targetConnectRate = 0.55;
  const targetQualifiedRate = 0.35; // of connected calls
  const closeRateOfQualified = 0.2;
  const targetRoas = 2.5;

  const targetCacMinor = Math.round(dealValueMinor / targetRoas);
  const leadsPerSale = 1 / (targetConnectRate * targetQualifiedRate * closeRateOfQualified);
  const targetCplMinor = Math.round(targetCacMinor / leadsPerSale);

  return {
    targetCplMinor: Math.max(1, Math.min(targetCplMinor, g.maxDailySpendMinor)),
    targetConnectRate,
    targetQualifiedRate,
    targetCacMinor,
    targetRoas,
  };
}

/**
 * Offline writer. Deliberately plain: it exists so the whole loop can be
 * demonstrated and tested without an API key, not to win a copywriting award.
 */
function deterministicDraft(niche: ScoredNiche, g: Guardrails): DraftedBrief {
  const subject = niche.name.toLowerCase();
  const offer: Offer = {
    niche: niche.name,
    icp: `Owner-operators in ${g.allowedGeos.join('/')} responsible for ${subject}, who decide on the phone and want it handled this week.`,
    problem: `${niche.notes}`,
    outcome: 'A booked slot with a specialist and a written scope before any money changes hands.',
    mechanism: 'A 10-minute qualification call, then a fixed-scope visit quoted from what you describe.',
    proof: 'We send the last three anonymised job reports for the same problem before you commit.',
    cta: 'Get a callback in 10 minutes with a fixed quote',
    deliverable: 'One phone call today that ends with either a written fixed quote or an honest "not a fit".',
    pricePointMinor: 0,
    currency: g.currency,
  };

  const angles = [
    { angle: 'Speed', hooks: ['Still waiting on a callback?', 'Booked today, quoted today.'] },
    { angle: 'Cost certainty', hooks: ['No surprise line items.', 'Fixed quote before anyone shows up.'] },
    { angle: 'Risk of delay', hooks: ['What this costs you next week.', 'The cheap fix has an expiry date.'] },
  ];

  const creatives = angles.flatMap((a) =>
    a.hooks.map((hook) => ({
      angle: a.angle,
      hook,
      primaryText: `${hook} We handle ${subject} for businesses in ${g.allowedGeos.join('/')}. Tell us what is happening and we will call you back with a fixed scope and a price - usually within 10 minutes during working hours.`,
      headline: 'Callback with a fixed quote',
      description: offer.deliverable,
      format: 'reel' as const,
    })),
  );

  const callScript: CallScript = {
    opener: `Hi, this is the callback you requested about ${subject}. I have two minutes of questions and then I can give you a fixed scope - is now still alright?`,
    qualifyingQuestions: [
      'What is happening right now, and since when?',
      'What is the site and roughly how large is the area involved?',
      'When does this need to be finished by?',
      'Who signs off on the spend, you or someone else?',
      'What budget range were you expecting?',
    ],
    approvedAnswers: {
      'How much does it cost?': 'It depends on scope, which is why we quote after these questions rather than before. I can give you a range today and a fixed number in writing.',
      'Who are you?': 'We are the service partner running this campaign. I am an AI assistant doing the first call, and a human handles the visit.',
      'Where did you get my number?': 'You submitted it on the ad form a few minutes ago and asked for a callback. If that was a mistake I will remove you now.',
      'How soon can you come?': 'I can offer you the next available slot on this call, subject to the specialist confirming.',
    },
    objectionHandling: {
      'Too expensive': 'Understood. I can scope a smaller first job so you can judge the work before spending more.',
      'Need to think about it': 'Fair. I will send the written scope so you have something concrete, and I will not call again unless you ask.',
      'Already have someone': 'Then I will not take your time. Would you like the written scope anyway as a second reference point?',
      'Not the decision maker': 'No problem - who should I send the written scope to, and when do they usually decide?',
    },
    conversionAsk: 'Shall I lock in the callback slot and send you the fixed quote in writing?',
    optOutLine: 'If you would rather not hear from us again, say the word and I will opt you out right now - we will not call this number again.',
  };

  const leadFormCopy = `Tell us what is happening with ${subject}. An assistant calls you back - usually within 10 minutes during working hours - to confirm the scope and give you a fixed quote. You can opt out on the call at any time.`;

  return { offer, creatives, leadFormCopy, callScript };
}
