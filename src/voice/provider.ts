import type { Brief, Lead } from '../core/types.ts';

/**
 * Outbound voice dispatch. Whatever identifiers go in as metadata come back on
 * the post-call webhook - that round trip is the only reason a call outcome can
 * be attributed to the ad that paid for it.
 */
export interface VoiceProvider {
  readonly kind: 'omnidimension' | 'mock';
  dispatchCall(input: DispatchInput): Promise<{ callRef: string }>;
}

export interface DispatchInput {
  lead: Lead;
  brief: Brief;
  /** Echoed back verbatim by the provider's post-call webhook. */
  metadata: Record<string, string>;
  webhookUrl: string;
  idempotencyKey: string;
}

export class VoiceApiError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`Voice API error ${status}: ${body.slice(0, 500)}`);
    this.name = 'VoiceApiError';
    this.status = status;
  }
}
