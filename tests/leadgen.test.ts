import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails } from '../src/config/guardrails.ts';
import { generateBrief } from '../src/brief/generator.ts';
import { MockMetaProvider } from '../src/meta/mock.ts';
import { MockVoiceProvider } from '../src/voice/mock.ts';
import { createHttpServer } from '../src/server/http.ts';
import type { Context } from '../src/orchestrator.ts';

const APP_SECRET = 'meta-app-secret';

async function harness(): Promise<{
  ctx: Context;
  runId: string;
  meta: MockMetaProvider;
  post: (body: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;
  postUnsigned: (body: unknown) => Promise<{ status: number }>;
  close: () => Promise<void>;
}> {
  const store = new Store(':memory:');
  const guardrails = { ...defaultGuardrails, callWindow: { startHour: 0, endHour: 24, timeZone: 'UTC' } };
  const meta = new MockMetaProvider(21);
  const ctx = {
    store,
    guardrails,
    meta,
    voice: new MockVoiceProvider(3),
    env: {
      mode: 'mock',
      port: 0,
      publicBaseUrl: 'http://localhost',
      meta: { appSecret: APP_SECRET, verifyToken: 'vt', pageId: 'page_1' },
      omni: { webhookSecret: 'omni' },
      previewDir: null,
    },
  } as unknown as Context;

  const { brief } = await generateBrief(guardrails);
  const runId = store.createRun(brief.niche.name);
  store.saveBrief(runId, brief);
  store.setRunState(runId, 'live');

  const server = createHttpServer(ctx);
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  return {
    ctx,
    runId,
    meta,
    post: async (body: unknown) => {
      const payload = JSON.stringify(body);
      const signature = `sha256=${createHmac('sha256', APP_SECRET).update(payload, 'utf8').digest('hex')}`;
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/meta`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
        body: payload,
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    },
    postUnsigned: async (body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/meta`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
        body: JSON.stringify(body),
      });
      return { status: res.status };
    },
    close: async () => {
      server.close();
      await once(server, 'close');
      store.close();
    },
  };
}

/** The shape Meta actually posts: identifiers only, no answers. */
function leadgenWebhook(leadgenId: string) {
  return {
    object: 'page',
    entry: [
      {
        id: 'page_1',
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: 'leadgen',
            value: {
              created_time: Math.floor(Date.now() / 1000),
              page_id: 'page_1',
              form_id: 'form_1',
              leadgen_id: leadgenId,
              ad_id: 'ad_1',
              adgroup_id: 'adset_1',
            },
          },
        ],
      },
    ],
  };
}

test('a real leadgen webhook carries no answers, so the lead is retrieved from Meta', async () => {
  const h = await harness();
  h.meta.seedLead({
    leadgenId: 'lead_9001',
    fieldData: [
      { name: 'full_name', values: ['Asha R'] },
      { name: 'phone_number', values: ['+91 98765 43210'] },
      { name: 'email', values: ['asha@example.com'] },
    ],
    adId: 'ad_1',
    adsetId: 'adset_1',
    campaignId: 'cmp_1',
    formId: 'form_1',
    createdTime: new Date().toISOString(),
  });

  const { status, json } = await h.post(leadgenWebhook('lead_9001'));
  assert.equal(status, 200);

  const [result] = json.results as Array<Record<string, unknown>>;
  assert.equal(result?.status, 'accepted', `expected acceptance, got ${JSON.stringify(result)}`);
  assert.equal(h.ctx.store.countLeads(h.runId), 1);

  const lead = h.ctx.store.pendingLeads(h.runId)[0] ?? h.ctx.store.getLead(String(result.leadId))!;
  assert.equal(lead.name, 'Asha R');
  assert.equal(lead.phoneE164, '+919876543210');
  assert.equal(lead.adId, 'ad_1', 'the ad id survives so the call can be attributed');
  await h.close();
});

test('a lead Meta will not hand over is rejected and audited, not half-processed', async () => {
  const h = await harness();
  const { status, json } = await h.post(leadgenWebhook('lead_missing'));
  assert.equal(status, 200);

  const [result] = json.results as Array<Record<string, unknown>>;
  assert.equal(result?.status, 'rejected');
  assert.match(String(result?.reason), /could not retrieve/);
  assert.equal(h.ctx.store.countLeads(h.runId), 0);

  const audited = h.ctx.store.auditTrail(h.runId).find((e) => e.kind === 'lead.retrieval_failed');
  assert.ok(audited, 'a lead we could not read is worth an audit entry');
  await h.close();
});

test('an inline field_data payload still works, for the Lead Ads Testing Tool', async () => {
  const h = await harness();
  const payload = {
    object: 'page',
    entry: [
      {
        changes: [
          {
            field: 'leadgen',
            value: {
              ad_id: 'ad_2',
              field_data: [
                { name: 'full_name', values: ['Test Lead'] },
                { name: 'phone_number', values: ['9876500000'] },
              ],
            },
          },
        ],
      },
    ],
  };

  const { json } = await h.post(payload);
  const [result] = json.results as Array<Record<string, unknown>>;
  assert.equal(result?.status, 'accepted');
  assert.equal(h.ctx.store.countLeads(h.runId), 1);
  await h.close();
});

test('an unsigned leadgen webhook never reaches the lead pipeline', async () => {
  const h = await harness();
  h.meta.seedLead({
    leadgenId: 'lead_9001',
    fieldData: [
      { name: 'full_name', values: ['Asha R'] },
      { name: 'phone_number', values: ['9876543210'] },
    ],
    adId: 'ad_1',
    adsetId: 'adset_1',
    campaignId: 'cmp_1',
    formId: 'form_1',
    createdTime: null,
  });

  const { status } = await h.postUnsigned(leadgenWebhook('lead_9001'));
  assert.equal(status, 401);
  assert.equal(h.ctx.store.countLeads(h.runId), 0, 'a forged webhook dials nobody');
  await h.close();
});
