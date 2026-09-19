import { dirname, join } from 'node:path';
import { Store } from './store/db.ts';
import { env, assertLiveCredentials, type Env } from './config/env.ts';
import { loadGuardrails, type Guardrails } from './config/guardrails.ts';
import type { MetaProvider } from './meta/provider.ts';
import { MetaApiProvider } from './meta/api.ts';
import { MockMetaProvider } from './meta/mock.ts';
import type { VoiceProvider } from './voice/provider.ts';
import { OmniDimensionProvider } from './voice/omnidimension.ts';
import { MockVoiceProvider } from './voice/mock.ts';
import type { CreativeAssetProvider } from './creative/provider.ts';
import { RenderedAssetProvider } from './creative/rendered.ts';
import { LibraryAssetProvider } from './creative/library.ts';

export interface Context {
  env: Env;
  guardrails: Guardrails;
  store: Store;
  meta: MetaProvider;
  voice: VoiceProvider;
  assets: CreativeAssetProvider;
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
      : new MockMetaProvider(
          42,
          // Beside the database, not beside the working directory. `reset`
          // derives this path from FL_DB_PATH; a hardcoded 'data/' agreed with
          // it only by coincidence, so with the database anywhere else reset
          // wiped it and left the simulated ad account behind, and the next
          // demo resumed on the previous run's spend.
          e.dbPath === ':memory:' ? null : join(dirname(e.dbPath), 'mock-meta.json'),
        ));

  const voice =
    overrides.voice ??
    (e.mode === 'live'
      ? new OmniDimensionProvider({ apiKey: e.omni.apiKey, agentId: e.omni.agentId, baseUrl: e.omni.baseUrl })
      : new MockVoiceProvider());

  // Cleared artwork wins whenever there is any: a human made and approved it.
  // The renderer is the fallback that keeps the loop runnable without one.
  const library = new LibraryAssetProvider({ dir: e.assetDir });
  const assets = overrides.assets ?? (library.files().length > 0 ? library : new RenderedAssetProvider());

  return { env: e, guardrails, store, meta, voice, assets };
}

export function voiceWebhookUrl(e: Env): string {
  return `${e.publicBaseUrl.replace(/\/$/, '')}/webhooks/omnidimension`;
}
