import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimal .env loader - keeps the project dependency-light. */
function loadDotEnv(path = '.env'): void {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) return;
  for (const line of readFileSync(full, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

export type Mode = 'mock' | 'live';

export interface Env {
  mode: Mode;
  port: number;
  publicBaseUrl: string;
  meta: {
    accessToken: string;
    adAccountId: string;
    pageId: string;
    apiVersion: string;
    appSecret: string;
    verifyToken: string;
  };
  omni: { apiKey: string; agentId: string; baseUrl: string; webhookSecret: string };
  anthropicKey: string;
  dbPath: string;
  /** Directory of cleared artwork; used when it contains any images. */
  assetDir: string;
  /** Where produced creatives are written so a human can look before approving. */
  previewDir: string;
}

export function env(): Env {
  const mode = (process.env.FL_MODE ?? 'mock') as Mode;
  if (mode !== 'mock' && mode !== 'live') {
    throw new Error(`FL_MODE must be "mock" or "live", got "${mode}"`);
  }
  return {
    mode,
    port: Number(process.env.PORT ?? 8787),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787',
    meta: {
      accessToken: process.env.META_ACCESS_TOKEN ?? '',
      adAccountId: process.env.META_AD_ACCOUNT_ID ?? '',
      pageId: process.env.META_PAGE_ID ?? '',
      apiVersion: process.env.META_API_VERSION ?? 'v21.0',
      appSecret: process.env.META_APP_SECRET ?? '',
      verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? '',
    },
    omni: {
      apiKey: process.env.OMNI_API_KEY ?? '',
      agentId: process.env.OMNI_AGENT_ID ?? '',
      baseUrl: process.env.OMNI_BASE_URL ?? 'https://api.omnidim.io/api/v1',
      webhookSecret: process.env.OMNI_WEBHOOK_SECRET ?? '',
    },
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
    dbPath: process.env.FL_DB_PATH ?? 'data/autopilot.db',
    assetDir: process.env.FL_ASSET_DIR ?? 'assets',
    previewDir: process.env.FL_PREVIEW_DIR ?? 'data/previews',
  };
}

/** Fail fast rather than half-publishing a campaign with missing credentials. */
export function assertLiveCredentials(e: Env): void {
  const missing: string[] = [];
  if (!e.meta.accessToken) missing.push('META_ACCESS_TOKEN');
  if (!e.meta.adAccountId || e.meta.adAccountId === 'act_000000000000') missing.push('META_AD_ACCOUNT_ID');
  if (!e.meta.pageId) missing.push('META_PAGE_ID');
  if (!e.omni.apiKey) missing.push('OMNI_API_KEY');
  if (!e.omni.agentId) missing.push('OMNI_AGENT_ID');
  if (missing.length) {
    throw new Error(`FL_MODE=live requires: ${missing.join(', ')}. Fill them in .env or stay in mock mode.`);
  }
}
