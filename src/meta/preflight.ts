import type { Env } from '../config/env.ts';
import type { Guardrails } from '../config/guardrails.ts';
import { MetaApiProvider } from './api.ts';
import { MetaApiError } from './provider.ts';

/**
 * Read-only checks against a real ad account, before anything is published.
 *
 * The counterpart to `contract-test` on the voice side, for the half that
 * spends money. Every call here is a GET: it creates nothing, changes nothing
 * and spends nothing, which is what makes it safe to run as the very first
 * thing you do with a new token.
 *
 * The check that justifies the command on its own is the currency. Budgets go
 * to Meta as an integer of the account's minor units while every cap in the
 * control layer is written in the guardrails' currency, so guardrails in INR
 * against a USD account turn a 1,000 rupee cap into a 1,000 dollar campaign.
 * Publishing refuses on that mismatch; this finds it before you get that far,
 * and tells you which line to change.
 */

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skipped';

export interface Finding {
  check: string;
  status: CheckStatus;
  detail: string;
  /** What to do about it, when there is something to do. */
  fix?: string;
}

export interface PreflightResult {
  findings: Finding[];
  /** False if anything failed. Warnings do not block. */
  passed: boolean;
}

export interface PreflightOptions {
  env: Env;
  guardrails: Guardrails;
  /** The instant form id you intend to publish with, if you have one yet. */
  leadFormId?: string | null;
  fetchImpl?: typeof fetch;
}

/** Scopes this system cannot work without, and what each one is for. */
const REQUIRED_SCOPES: Array<[string, string]> = [
  ['ads_management', 'create and pause campaigns, ad sets and ads'],
  ['ads_read', 'read insights for the decision engine'],
  ['leads_retrieval', "fetch a lead's answers after the webhook delivers its id"],
  ['pages_show_list', 'confirm the Page the ads are published from'],
];

export async function preflight(options: PreflightOptions): Promise<PreflightResult> {
  const { env, guardrails: g } = options;
  const findings: Finding[] = [];
  const add = (f: Finding): void => void findings.push(f);

  // --- credentials present at all -----------------------------------------
  const missing = [
    !env.meta.accessToken && 'META_ACCESS_TOKEN',
    !env.meta.adAccountId && 'META_AD_ACCOUNT_ID',
    !env.meta.pageId && 'META_PAGE_ID',
  ].filter((v): v is string => typeof v === 'string');

  if (missing.length) {
    add({
      check: 'credentials',
      status: 'fail',
      detail: `not set: ${missing.join(', ')}`,
      fix: 'Fill these in .env from .env.example. Nothing below can run without them.',
    });
    return { findings, passed: false };
  }
  add({ check: 'credentials', status: 'pass', detail: 'token, ad account and page id are all set' });

  if (!/^act_\d+$/.test(env.meta.adAccountId)) {
    add({
      check: 'ad account id',
      status: 'fail',
      detail: `META_AD_ACCOUNT_ID is "${env.meta.adAccountId}"`,
      fix: 'It must be the account id with the act_ prefix, e.g. act_1234567890.',
    });
    return { findings, passed: false };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const graph = async (path: string, params: Record<string, string>): Promise<Record<string, unknown>> => {
    const url = new URL(`https://graph.facebook.com/${env.meta.apiVersion}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${env.meta.accessToken}` } });
    const text = await res.text();
    if (!res.ok) throw new MetaApiError(res.status, text);
    return JSON.parse(text) as Record<string, unknown>;
  };

  // --- the token: who it is, when it dies, what it may do -----------------
  let scopes: string[];
  try {
    const debug = (await graph('debug_token', { input_token: env.meta.accessToken })) as {
      data?: { expires_at?: number; scopes?: string[]; is_valid?: boolean; type?: string };
    };
    const data = debug.data ?? {};
    scopes = data.scopes ?? [];

    if (data.is_valid === false) {
      add({
        check: 'access token',
        status: 'fail',
        detail: 'Meta reports this token as not valid',
        fix: 'Generate a new one in Business Settings and put it in .env.',
      });
    } else {
      const expiresAt = data.expires_at ?? 0;
      if (expiresAt === 0) {
        add({ check: 'access token', status: 'pass', detail: `valid, does not expire (type ${data.type ?? 'unknown'})` });
      } else {
        const days = Math.round((expiresAt * 1000 - Date.now()) / 86_400_000);
        // An unattended loop that outlives its own credential stops silently,
        // which looks exactly like a campaign that stopped delivering.
        add({
          check: 'access token',
          status: days <= 14 ? 'warn' : 'pass',
          detail: `valid, expires in ${days} day(s)`,
          fix:
            days <= 14
              ? 'Exchange it for a long-lived or system-user token before leaving the scheduler running, or the loop stops without saying why.'
              : undefined,
        });
      }
    }
  } catch (err) {
    add({
      check: 'access token',
      status: 'fail',
      detail: describe(err),
      fix: 'The token could not be inspected at all. Check it is pasted whole and has not been revoked.',
    });
    return { findings, passed: false };
  }

  for (const [scope, why] of REQUIRED_SCOPES) {
    const held = scopes.includes(scope);
    add({
      check: `scope ${scope}`,
      status: held ? 'pass' : 'fail',
      detail: held ? why : `missing - needed to ${why}`,
      fix: held ? undefined : `Add ${scope} to the token's permissions and regenerate it.`,
    });
  }
  if (scopes.length === 0) {
    add({
      check: 'scopes',
      status: 'warn',
      detail: 'Meta returned no scope list for this token, so the checks above are inconclusive',
    });
  }

  // --- the ad account: currency first -------------------------------------
  try {
    const provider = new MetaApiProvider({
      accessToken: env.meta.accessToken,
      adAccountId: env.meta.adAccountId,
      apiVersion: env.meta.apiVersion,
      retry: { attempts: 1 },
      fetchImpl,
    });
    const account = await provider.accountSummary();

    add({
      check: 'ad account',
      status: 'pass',
      detail: `${account.name ?? account.accountId} (${account.accountId}), timezone ${account.timezone ?? 'unknown'}`,
    });

    const matches = account.currency.toUpperCase() === g.currency.toUpperCase();
    add({
      check: 'currency',
      status: matches ? 'pass' : 'fail',
      detail: matches
        ? `account and control layer both in ${account.currency}`
        : `account bills in ${account.currency}, config/guardrails.json is written in ${g.currency}`,
      fix: matches
        ? undefined
        : `Every budget is sent as ${account.currency} minor units and checked as ${g.currency}, so a cap of ${g.maxDailySpendMinor} would buy ${account.currency} ${(g.maxDailySpendMinor / 100).toFixed(2)}/day. Set "currency" to ${account.currency} in config/guardrails.json and restate the caps in it, or use an account billing in ${g.currency}. Publishing refuses until they agree.`,
    });

    const active = account.status === null || account.status === 1;
    add({
      check: 'account status',
      status: active ? 'pass' : 'fail',
      detail: active ? 'active' : `account_status ${account.status}, disable_reason ${account.disableReason ?? 'none'}`,
      fix: active ? undefined : 'Resolve the account issue in Business Settings; ads cannot run while it is disabled.',
    });
  } catch (err) {
    add({
      check: 'ad account',
      status: 'fail',
      detail: describe(err),
      fix: 'Confirm the id is right and that this token has access to that ad account.',
    });
  }

  // --- the page -----------------------------------------------------------
  try {
    const page = (await graph(env.meta.pageId, { fields: 'name,id' })) as { name?: string; id?: string };
    add({ check: 'page', status: 'pass', detail: `${page.name ?? '(unnamed)'} (${page.id ?? env.meta.pageId})` });
  } catch (err) {
    add({
      check: 'page',
      status: 'fail',
      detail: describe(err),
      fix: 'META_PAGE_ID must be a Page this token can act on. Ads are published from it.',
    });
  }

  // --- the instant form, if there is one yet ------------------------------
  if (options.leadFormId) {
    try {
      const form = (await graph(options.leadFormId, { fields: 'name,status,questions' })) as {
        name?: string;
        status?: string;
        questions?: Array<{ type?: string; key?: string }>;
      };
      const types = (form.questions ?? []).map((q) => (q.type ?? q.key ?? '').toUpperCase());
      const hasPhone = types.some((t) => t.includes('PHONE'));

      add({
        check: 'lead form',
        status: form.status && form.status !== 'ACTIVE' ? 'warn' : 'pass',
        detail: `${form.name ?? options.leadFormId} - status ${form.status ?? 'unknown'}, ${types.length} question(s)`,
      });
      // Without a phone number there is nothing for the voice agent to call,
      // and that is only discovered when the first lead arrives.
      add({
        check: 'lead form phone field',
        status: hasPhone ? 'pass' : 'fail',
        detail: hasPhone ? 'the form asks for a phone number' : `no phone question found (${types.join(', ') || 'none'})`,
        fix: hasPhone ? undefined : 'Add the PHONE question to the form; every lead without one is refused at intake.',
      });
    } catch (err) {
      add({
        check: 'lead form',
        status: 'fail',
        detail: describe(err),
        fix: 'Check the form id, and that leads_retrieval is granted on a token for the Page that owns it.',
      });
    }
  } else {
    add({
      check: 'lead form',
      status: 'skipped',
      detail: 'no --lead-form given',
      fix: 'Pass the instant form id to check it too - docs/meta-instant-form.md creates one.',
    });
  }

  return { findings, passed: !findings.some((f) => f.status === 'fail') };
}

function describe(err: unknown): string {
  if (err instanceof MetaApiError) return err.message.slice(0, 200);
  return (err as Error).message.slice(0, 200);
}
