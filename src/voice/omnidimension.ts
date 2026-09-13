import type { DispatchInput, VoiceProvider } from './provider.ts';
import { VoiceApiError } from './provider.ts';
import { redact } from '../core/util.ts';

/**
 * OmniDimension outbound calling.
 *
 * The call context we send is the script the brief already produced and a human
 * already approved at gate #1 - the voice agent is not free to improvise a new
 * offer. `call_context` carries the identifiers that must survive the round trip.
 */
export class OmniDimensionProvider implements VoiceProvider {
  readonly kind = 'omnidimension' as const;
  readonly #apiKey: string;
  readonly #agentId: string;
  readonly #baseUrl: string;

  constructor(opts: { apiKey: string; agentId: string; baseUrl: string }) {
    if (!opts.apiKey) throw new Error('OmniDimensionProvider requires OMNI_API_KEY');
    if (!opts.agentId) throw new Error('OmniDimensionProvider requires OMNI_AGENT_ID');
    this.#apiKey = opts.apiKey;
    this.#agentId = opts.agentId;
    this.#baseUrl = opts.baseUrl.replace(/\/$/, '');
  }

  async dispatchCall(input: DispatchInput): Promise<{ callRef: string }> {
    const { lead, brief } = input;
    const body = {
      agent_id: this.#agentId,
      to_number: lead.phoneE164,
      call_context: {
        customer_name: lead.name,
        offer_summary: brief.offer.outcome,
        deliverable: brief.offer.deliverable,
        opener: brief.callScript.opener,
        qualifying_questions: brief.callScript.qualifyingQuestions,
        approved_answers: brief.callScript.approvedAnswers,
        objection_handling: brief.callScript.objectionHandling,
        conversion_ask: brief.callScript.conversionAsk,
        opt_out_line: brief.callScript.optOutLine,
        ...input.metadata,
      },
      webhook_url: input.webhookUrl,
    };

    const res = await fetch(`${this.#baseUrl}/calls/dispatch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) throw new VoiceApiError(res.status, redact(text));
    const parsed = JSON.parse(text) as { requestId?: string; call_id?: string; id?: string };
    const callRef = parsed.requestId ?? parsed.call_id ?? parsed.id;
    if (!callRef) throw new VoiceApiError(res.status, `dispatch response carried no call id: ${redact(text)}`);
    return { callRef };
  }
}
