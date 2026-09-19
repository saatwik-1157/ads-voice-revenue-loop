import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Logger } from '../src/core/log.ts';
import { Store } from '../src/store/db.ts';
import { defaultGuardrails } from '../src/config/guardrails.ts';
import { createHttpServer } from '../src/server/http.ts';
import type { Context } from '../src/orchestrator.ts';

/**
 * What must never reach a log line.
 *
 * The format is the least interesting property here and these tests mostly
 * ignore it. What they check is the one thing a log pipeline cannot undo: that
 * a token, a password or a full phone number was never written in the first
 * place. Redaction is enforced on the way out rather than at the call sites,
 * so these tests exercise the way out.
 */

/** A logger that collects its output instead of writing it, for assertions. */
function capture(options: { level?: 'debug' | 'info' | 'warn' | 'error'; format?: 'json' | 'pretty' } = {}) {
  const lines: string[] = [];
  const logger = new Logger({
    format: options.format ?? 'json',
    level: options.level ?? 'debug',
    write: (line) => lines.push(line),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  return { logger, lines, last: (): string => lines[lines.length - 1] ?? '' };
}

const parseLast = (lines: string[]): Record<string, unknown> =>
  JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;

test('a field whose name suggests a secret is dropped, not redacted', () => {
  const { logger, lines } = capture();
  logger.info('auth.attempt', {
    token: 'EAAsuperlongmetatoken12345',
    secret: 'hunter2',
    password: 'hunter2',
    api_key: 'sk-abcdefghijklmnop',
    apiKey: 'sk-abcdefghijklmnop',
    authorization: 'Bearer abc',
    credential: 'x',
    cookie: 'session=1',
    signature: 'sha256=deadbeef',
    runId: 'run_1',
  });

  const record = parseLast(lines);
  // Present, because it is not sensitive - this proves the line was emitted.
  assert.equal(record.runId, 'run_1');
  for (const key of [
    'token',
    'secret',
    'password',
    'api_key',
    'apiKey',
    'authorization',
    'credential',
    'cookie',
    'signature',
  ]) {
    assert.equal(key in record, false, `${key} should not appear in the record at all`);
  }
  // And no trace of any of the values, under any key.
  const raw = lines[lines.length - 1]!;
  for (const value of ['hunter2', 'sk-abcdefghijklmnop', 'deadbeef', 'session=1']) {
    assert.equal(raw.includes(value), false, `${value} leaked into the line`);
  }
});

test('a secret nested inside an object is dropped too', () => {
  const { logger, lines } = capture();
  logger.info('provider.config', {
    provider: { name: 'meta', credentials: { accessToken: 'EAAlongtokenvalue123456' } },
  });

  const raw = lines[lines.length - 1]!;
  assert.equal(raw.includes('EAAlongtokenvalue123456'), false);
  // `credentials` matches the deny-list, so the whole subtree goes.
  assert.equal(raw.includes('credentials'), false);
  assert.equal(raw.includes('meta'), true);
});

test('a phone number is masked to its last four digits', () => {
  const { logger, lines } = capture();
  logger.info('call.placed', { phone: '+919876543210', to_number: '+14155552671' });

  const record = parseLast(lines);
  assert.equal(record.phone, '+91******3210');
  assert.equal(record.to_number, '+14*****2671');
  // The point of the mask: the subscriber digits are gone.
  assert.equal((lines[lines.length - 1] ?? '').includes('9876543210'), false);
});

test('a token pasted into a free-text value is still redacted', () => {
  // The deny-list only sees field names. A token that arrives inside a message
  // - which is how provider errors carry them - has to be caught by value.
  const { logger, lines } = capture();
  logger.error('provider.request', {
    error: 'request failed: EAAabcdefghijklmnopqrstuv rejected',
    detail: 'access_token=EAAzyxwvutsrqponmlkjihg&fields=id',
  });

  const raw = lines[lines.length - 1]!;
  assert.equal(raw.includes('EAAabcdefghijklmnopqrstuv'), false);
  assert.equal(raw.includes('EAAzyxwvutsrqponmlkjihg'), false);
  assert.equal(raw.includes('redacted'), true);
});

test('an Error is logged as name and message, never as a raw object', () => {
  const { logger, lines } = capture();
  logger.error('cycle.failed', { error: new Error('token EAAabcdefghijklmnop expired') });

  const record = parseLast(lines);
  const error = record.error as Record<string, unknown>;
  assert.equal(error.name, 'Error');
  assert.equal(String(error.message).includes('EAAabcdefghijklmnop'), false);
  assert.equal('stack' in error, false, 'a stack belongs in the message, not in structured fields');
});

test('depth and breadth are bounded so one bad field cannot hang the logger', () => {
  const { logger, lines } = capture();
  logger.info('big', {
    deep: { a: { b: { c: { d: { e: 'buried' } } } } },
    wide: Array.from({ length: 200 }, (_, i) => i),
  });

  const record = parseLast(lines);
  const deep = record.deep as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
  assert.equal(deep.a!.b!.c!.d, '[deep]');
  assert.equal((record.wide as number[]).length, 50);
});

test('a cyclic object does not hang or throw', () => {
  const { logger, lines } = capture();
  const cyclic: Record<string, unknown> = { name: 'loop' };
  cyclic.self = cyclic;
  logger.info('cyclic', { cyclic });

  // Depth bounding is what saves this: the cycle is cut off, not followed.
  assert.equal(lines.length, 1);
  assert.equal(parseLast(lines).event, 'cyclic');
});

test('levels filter, and the level is on every line', () => {
  const { logger, lines } = capture({ level: 'warn' });
  logger.debug('dropped');
  logger.info('dropped');
  logger.warn('kept.warn');
  logger.error('kept.error');

  assert.equal(lines.length, 2);
  assert.equal(parseLast(lines).level, 'error');
  assert.equal((JSON.parse(lines[0]!) as Record<string, unknown>).event, 'kept.warn');
});

test('a child logger carries its context onto every line and still redacts', () => {
  const { logger, lines } = capture();
  const child = logger.child({ requestId: 'req_1', token: 'should-not-survive' });
  child.info('http.request', { status: 200 });

  const record = parseLast(lines);
  assert.equal(record.requestId, 'req_1');
  assert.equal(record.status, 200);
  assert.equal('token' in record, false);
});

test('both formats carry the same facts', () => {
  const json = capture({ format: 'json' });
  json.logger.info('http.request', { status: 200, path: '/runs' });
  const record = parseLast(json.lines);
  assert.equal(record.at, '2026-01-01T00:00:00.000Z');
  assert.equal(record.level, 'info');
  assert.equal(record.event, 'http.request');
  assert.equal(record.path, '/runs');

  const pretty = capture({ format: 'pretty' });
  pretty.logger.info('http.request', { status: 200, path: '/runs' });
  const line = pretty.last();
  assert.equal(line.includes('2026-01-01T00:00:00.000Z'), true);
  assert.equal(line.includes('INFO'), true);
  assert.equal(line.includes('http.request'), true);
  assert.equal(line.includes('path=/runs'), true);
});

test('a request log records the path but never the query string', async () => {
  // The case that made this worth testing: somebody debugging pastes a token
  // into the URL, and without this the whole URL lands in the log file.
  const store = new Store(':memory:');
  const ctx = {
    store,
    guardrails: defaultGuardrails,
    meta: { kind: 'mock' },
    voice: { kind: 'mock' },
    env: {
      mode: 'mock',
      port: 0,
      publicBaseUrl: 'http://localhost',
      meta: { appSecret: 's', verifyToken: 'v', pageId: 'p' },
      omni: { webhookSecret: 'o', webhookToken: '' },
      previewDir: null,
    },
  } as unknown as Context;

  const server = createHttpServer(ctx);
  server.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The server logs through the module-wide logger, which writes to stderr.
  const written: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    written.push(String(chunk));
    return true;
  };

  try {
    const res = await fetch(`${base}/health?access_token=EAAsecretpastedintourl123`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('x-request-id') ?? '', /^req_/);
    // The log is written on 'finish', which can land just after fetch resolves.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.stderr.write = real;
    server.close();
    await once(server, 'close');
    store.close();
  }

  const line = written.find((l) => l.includes('http.request'));
  assert.ok(line, 'the request should have been logged');
  assert.equal(line.includes('path=/health'), true);
  assert.equal(line.includes('EAAsecretpastedintourl123'), false);
  assert.equal(line.includes('access_token'), false);
});
