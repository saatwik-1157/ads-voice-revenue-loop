import type { DispatchInput, VoiceProvider } from './provider.ts';
import { VoiceApiError } from './provider.ts';
import { redact } from '../core/util.ts';
import { parseRetryAfter, withRetry, type RetryOptions } from '../core/retry.ts';
import { breakerFor } from '../core/breaker.ts';

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
  readonly #retry: RetryOptions;
  readonly #breaker = breakerFor('omnidimension');
  readonly #fetch: typeof fetch;

  constructor(opts: {
    apiKey: string;
    agentId: string;
    baseUrl: string;
    retry?: RetryOptions;
    fetchImpl?: typeof fetch;
  }) {
    if (!opts.apiKey) throw new Error('OmniDimensionProvider requires OMNI_API_KEY');
    if (!opts.agentId) throw new Error('OmniDimensionProvider requires OMNI_AGENT_ID');
    this.#apiKey = opts.apiKey;
    this.#agentId = opts.agentId;
    this.#baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#retry = {
      onRetry: (info) => {
        process.stderr.write(
          `[voice] dispatch failed (${info.error.message.slice(0, 120)}); retry ${info.attempt}/${info.attempts - 1} in ${info.delayMs}ms\n`,
        );
      },
      ...opts.retry,
    };
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

    // Retrying is safe only because of the idempotency key: the provider must
    // treat a replayed dispatch as the same call, not dial the person twice.
    // Through the breaker, around the retries. A dialler that is down makes
    // every lead wait out a full retry ladder before being deferred; failing
    // fast defers them immediately and stops adding load to a provider that is
    // already struggling.
    const text = await this.#breaker.run('calls/dispatch', () => withRetry(
      'calls/dispatch',
      async () => {
        let res: Response;
        try {
          res = await this.#fetch(`${this.#baseUrl}/calls/dispatch`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.#apiKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': input.idempotencyKey,
            },
            body: JSON.stringify(body),
          });
        } catch (err) {
          throw new VoiceApiError(0, (err as Error).message, { cause: err });
        }
        const payload = await res.text();
        if (!res.ok) {
          throw new VoiceApiError(res.status, redact(payload), {
            retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
          });
        }
        return payload;
      },
      this.#retry,
    ));

    const parsed = JSON.parse(text) as { requestId?: string; call_id?: string; id?: string };
    const callRef = parsed.requestId ?? parsed.call_id ?? parsed.id;
    // A 200 with no call id is a contract mismatch, not a transient fault.
    if (!callRef) throw new VoiceApiError(422, `dispatch response carried no call id: ${redact(text)}`);
    return { callRef };
  }
}
