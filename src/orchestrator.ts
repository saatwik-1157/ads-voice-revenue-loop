import { Store } from './store/db.ts';
import { env, assertLiveCredentials, type Env } from './config/env.ts';
import { loadGuardrails, type Guardrails } from './config/guardrails.ts';
import type { MetaProvider } from './meta/provider.ts';
import { MetaApiProvider } from './meta/api.ts';
import { MockMetaProvider } from './meta/mock.ts';
import type { VoiceProvider } from './voice/provider.ts';
import { OmniDimensionProvider } from './voice/omnidimension.ts';
import { MockVoiceProvider } from './voice/mock.ts';

export interface Context {
  env: Env;
  guardrails: Guardrails;
  store: Store;
  meta: MetaProvider;
  voice: VoiceProvider;
}

/**
 * Wires the loop together for one process.
 *
 * The mode switch lives here and nowhere else: in mock mode no real ad account
 * and no real phone line is reachable, and in live mode the process refuses to
 * start without complete credentials rather than half-publishing a campaign.
 */
export function createContext(overrides: Partial<Context> = {}): Context {
  const e = overrides.env ?? env();
  const guardrails = overrides.guardrails ?? loadGuardrails();
  const store = overrides.store ?? new Store(e.dbPath);

  if (e.mode === 'live') assertLiveCredentials(e);

  const meta =
    overrides.meta ??
    (e.mode === 'live'
      ? new MetaApiProvider({
          accessToken: e.meta.accessToken,
          adAccountId: e.meta.adAccountId,
          apiVersion: e.meta.apiVersion,
        })
      : new MockMetaProvider(42, e.dbPath === ':memory:' ? null : 'data/mock-meta.json'));

  const voice =
    overrides.voice ??
    (e.mode === 'live'
      ? new OmniDimensionProvider({ apiKey: e.omni.apiKey, agentId: e.omni.agentId, baseUrl: e.omni.baseUrl })
      : new MockVoiceProvider());

  return { env: e, guardrails, store, meta, voice };
}

export function voiceWebhookUrl(e: Env): string {
  return `${e.publicBaseUrl.replace(/\/$/, '')}/webhooks/omnidimension`;
}
