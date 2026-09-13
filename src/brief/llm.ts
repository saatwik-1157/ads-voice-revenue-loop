import Anthropic from '@anthropic-ai/sdk';
import type { Guardrails } from '../config/guardrails.ts';
import type { CallScript, CreativeVariant, Offer, ScoredNiche } from '../core/types.ts';

/**
 * The orchestrator's writing step. Claude drafts the offer, the creative matrix
 * and the call script; everything it returns is then re-validated locally by
 * brief/claims.ts before a human ever sees it.
 *
 * The model is a drafting tool here, not an authority: it cannot spend, publish
 * or dial. If no API key is configured the caller falls back to the
 * deterministic writer in brief/generator.ts and the loop still runs end to end.
 */

export const MODEL = 'claude-opus-5';

export interface DraftedBrief {
  offer: Offer;
  creatives: Array<Omit<CreativeVariant, 'creativeId' | 'assetRef'>>;
  leadFormCopy: string;
  callScript: CallScript;
}

const BRIEF_TOOL: Anthropic.Tool = {
  name: 'submit_brief',
  description: 'Submit the finished campaign brief: offer, creative matrix, lead form copy and call script.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['offer', 'creatives', 'lead_form_copy', 'call_script'],
    properties: {
      offer: {
        type: 'object',
        additionalProperties: false,
        required: ['icp', 'problem', 'outcome', 'mechanism', 'proof', 'cta', 'deliverable'],
        properties: {
          icp: { type: 'string', description: 'One sentence describing exactly who this is for.' },
          problem: { type: 'string', description: 'The painful, present-tense problem.' },
          outcome: { type: 'string', description: 'The promised outcome, stated without guarantees.' },
          mechanism: { type: 'string', description: 'How the outcome is produced.' },
          proof: { type: 'string', description: 'Substantiable proof only. No invented statistics.' },
          cta: { type: 'string', description: 'The ad CTA; must create a lead the voice agent can act on.' },
          deliverable: {
            type: 'string',
            description: 'Exactly what the caller will do for the lead. The voice agent may promise nothing beyond this.',
          },
        },
      },
      creatives: {
        type: 'array',
        description: 'Exactly 6 variants: 3 angles x 2 hooks.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['angle', 'hook', 'primary_text', 'headline', 'description'],
          properties: {
            angle: { type: 'string' },
            hook: { type: 'string', description: 'First 3 seconds / first line.' },
            primary_text: { type: 'string' },
            headline: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
      lead_form_copy: {
        type: 'string',
        description: 'Instant-form intro text. Must state who will call, why, and that the lead can opt out.',
      },
      call_script: {
        type: 'object',
        additionalProperties: false,
        required: ['opener', 'qualifying_questions', 'approved_answers', 'objection_handling', 'conversion_ask', 'opt_out_line'],
        properties: {
          opener: { type: 'string', description: 'Must identify the business and say why it is calling.' },
          qualifying_questions: { type: 'array', items: { type: 'string' } },
          approved_answers: {
            type: 'array',
            description: 'Question/answer pairs the agent is allowed to give.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['question', 'answer'],
              properties: { question: { type: 'string' }, answer: { type: 'string' } },
            },
          },
          objection_handling: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['objection', 'response'],
              properties: { objection: { type: 'string' }, response: { type: 'string' } },
            },
          },
          conversion_ask: { type: 'string' },
          opt_out_line: { type: 'string', description: 'How the agent offers to stop calling. Must contain "opt out" or "do not call".' },
        },
      },
    },
  },
};

function systemPrompt(g: Guardrails): string {
  return [
    'You are the growth operator for a small business running a paid-ads-to-voice-agent funnel.',
    'You draft the offer, ad creative and call script. You never invent proof, statistics, testimonials or credentials.',
    '',
    'Hard rules:',
    `- Never use these words or anything equivalent: ${g.bannedClaimPatterns.join(', ')}.`,
    '- The voice agent will read your script to real people. It may promise nothing beyond offer.deliverable.',
    '- The ad CTA and the call conversion ask must be the same promise, worded for their medium.',
    '- Proof must be phrased as something the business can actually show ("we will send you the before/after report"), never as a number you made up.',
    '- Write for a first-time cold audience in the named geography. Plain language, no hype.',
    '- Call the submit_brief tool exactly once with the complete brief. Do not answer in prose.',
  ].join('\n');
}

function userPrompt(niche: ScoredNiche, g: Guardrails, maxTestBudget: string): string {
  return [
    `Niche: ${niche.name}`,
    `Why it scored well: ${niche.notes}`,
    `Score breakdown: ${JSON.stringify(niche.breakdown)}`,
    `Geography: ${g.allowedGeos.join(', ')}`,
    `Currency: ${g.currency}`,
    `Total test budget: ${maxTestBudget}`,
    `Calling window: ${g.callWindow.startHour}:00-${g.callWindow.endHour}:00 ${g.callWindow.timeZone}`,
    '',
    'Produce the brief. The lead is generated by a Meta instant form and called within minutes by an AI voice agent,',
    'so the CTA must be something a person is happy to be phoned about, and the opener must set that expectation honestly.',
  ].join('\n');
}

export async function draftBrief(
  niche: ScoredNiche,
  g: Guardrails,
  maxTestBudget: string,
  apiKey: string,
): Promise<DraftedBrief> {
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: 'high' },
    system: systemPrompt(g),
    tools: [BRIEF_TOOL],
    messages: [{ role: 'user', content: userPrompt(niche, g, maxTestBudget) }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`Model declined to draft this brief (${response.stop_details?.category ?? 'unknown'}).`);
  }

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === 'submit_brief',
  );
  if (!toolUse) throw new Error('Model did not return a submit_brief tool call.');

  return normalize(toolUse.input as RawBrief, niche, g);
}

interface RawBrief {
  offer: Record<string, string>;
  creatives: Array<Record<string, string>>;
  lead_form_copy: string;
  call_script: {
    opener: string;
    qualifying_questions: string[];
    approved_answers: Array<{ question: string; answer: string }>;
    objection_handling: Array<{ objection: string; response: string }>;
    conversion_ask: string;
    opt_out_line: string;
  };
}

function normalize(raw: RawBrief, niche: ScoredNiche, g: Guardrails): DraftedBrief {
  const offer: Offer = {
    niche: niche.name,
    icp: raw.offer.icp ?? '',
    problem: raw.offer.problem ?? '',
    outcome: raw.offer.outcome ?? '',
    mechanism: raw.offer.mechanism ?? '',
    proof: raw.offer.proof ?? '',
    cta: raw.offer.cta ?? '',
    deliverable: raw.offer.deliverable ?? '',
    pricePointMinor: 0,
    currency: g.currency,
  };

  const creatives = raw.creatives.slice(0, 6).map((c) => ({
    angle: c.angle ?? '',
    hook: c.hook ?? '',
    primaryText: c.primary_text ?? '',
    headline: c.headline ?? '',
    description: c.description ?? '',
    format: 'reel' as const,
  }));

  const callScript: CallScript = {
    opener: raw.call_script.opener,
    qualifyingQuestions: raw.call_script.qualifying_questions,
    approvedAnswers: Object.fromEntries(raw.call_script.approved_answers.map((a) => [a.question, a.answer])),
    objectionHandling: Object.fromEntries(raw.call_script.objection_handling.map((o) => [o.objection, o.response])),
    conversionAsk: raw.call_script.conversion_ask,
    optOutLine: raw.call_script.opt_out_line,
  };

  return { offer, creatives, leadFormCopy: raw.lead_form_copy, callScript };
}
