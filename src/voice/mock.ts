import type { DispatchInput, VoiceProvider } from './provider.ts';
import type { CallOutcome } from '../core/types.ts';
import { id, now } from '../core/util.ts';
import { mulberry32Step, normalizedQuality } from '../meta/mock.ts';

/**
 * Simulated voice agent for FL_MODE=mock.
 *
 * Call outcomes are correlated with the creative that produced the lead: a lead
 * from a stronger angle connects and qualifies more often. That is what makes
 * the demo meaningful - the decision engine has to find the good creative from
 * the outcome data alone.
 */
export class MockVoiceProvider implements VoiceProvider {
  readonly kind = 'mock' as const;
  #prng: number;
  #pending = new Map<string, { leadId: string; quality: number; dealValueMinor: number }>();

  constructor(seed = 7) {
    this.#prng = seed >>> 0;
  }

  #rand(): number {
    const [value, next] = mulberry32Step(this.#prng);
    this.#prng = next;
    return value;
  }

  async dispatchCall(input: DispatchInput): Promise<{ callRef: string }> {
    const callRef = id('omni');
    const quality = Number(input.metadata.creative_quality ?? '1');
    this.#pending.set(callRef, {
      leadId: input.lead.leadId,
      quality,
      dealValueMinor: input.brief.offer.pricePointMinor,
    });
    return { callRef };
  }

  /** Produce the post-call webhook payload the real provider would send. */
  simulateOutcome(callRef: string): CallOutcome {
    const pending = this.#pending.get(callRef);
    if (!pending) throw new Error(`unknown callRef ${callRef}`);
    // Funnel rates scale with the creative's hidden quality, so a lead from a
    // strong angle is genuinely more likely to connect, qualify and close. End
    // to end this lands between ~0.2% and ~6% of leads becoming sales, which is
    // the range a phone-closed local offer actually lives in.
    const qn = normalizedQuality(pending.quality);

    const connected = this.#rand() < 0.35 + 0.3 * qn;
    const qualified = connected && this.#rand() < 0.15 + 0.3 * qn;
    const appointmentBooked = qualified && this.#rand() < 0.25 + 0.25 * qn;
    const won = appointmentBooked && this.#rand() < 0.15 + 0.25 * qn;
    const optOut = connected && !qualified && this.#rand() < 0.08;

    const objections = ['Too expensive', 'Need to think about it', 'Already have someone', 'Not the decision maker'];
    const objection = connected && !won ? objections[Math.floor(this.#rand() * objections.length)]! : null;

    return {
      callId: id('call'),
      leadId: pending.leadId,
      connected,
      qualified,
      intentScore: Math.round((connected ? 30 : 0) + (qualified ? 35 : 0) + this.#rand() * 30),
      objection,
      appointmentBooked,
      saleStatus: won ? 'won' : appointmentBooked ? 'pending' : connected ? 'lost' : 'none',
      expectedValueMinor: won ? pending.dealValueMinor : appointmentBooked ? Math.round(pending.dealValueMinor * 0.3) : 0,
      nextAction: won ? 'schedule fulfilment' : appointmentBooked ? 'confirm appointment' : connected ? 'nurture' : 'retry once',
      summary: connected
        ? `Spoke with lead. Qualified: ${qualified}. Objection: ${objection ?? 'none'}.`
        : 'No answer.',
      optOut,
      receivedAt: now(),
    };
  }

  pendingRefs(): string[] {
    return [...this.#pending.keys()];
  }
}
