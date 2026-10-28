/**
 * Usage Records through the Gateway HTTP seam: `onUsage` collects into an array and each test
 * asserts its exact contents. The rule under test is "one record for every request the Gateway
 * attempted an upstream call for, none for any other", with token counts only as the Provider
 * reported them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { serveLoopback } from '../src/serve.js';
import { startFakeProvider } from '../src/testing/fake-provider.js';
import type { FakeProvider } from '../src/testing/fake-provider.js';
import { usageRecord } from '../src/usage.js';
import type { Binding, Gateway, GatewayOptions, Logger, UsageRecord } from '../src/index.js';
import { claims, manifestWith, startGateway } from './support/gateway.js';
import { startScriptedUpstream } from './support/scripted-upstream.js';
import { readSse, readUntil } from './support/sse.js';

/** The Provider id the fake stands in for. */
const FAKE = 'openai-compatible:fake';
const SCRIPTED = 'openai-compatible:scripted';
const API_KEY = 'sk-fake-connection-key-0123456789';
/** How long `fake/slow` holds back its headers here. */
const SLOW_MS = 300;

let fake: FakeProvider;

beforeAll(async () => {
  fake = await startFakeProvider({ apiKey: API_KEY, slowMs: SLOW_MS });
});

afterAll(async () => {
  await fake.close();
});

/** Gateways and scripted upstreams started by the current test, closed after it. */
const started: Gateway[] = [];
const upstreams: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((gateway) => gateway.close()));
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
  fake.reset();
});

const SLOTS = manifestWith({ default: {}, unbound: {} });

/** `default` is bound to `fake/echo`; `unbound` has no Slot Binding. */
const resolveBinding: GatewayOptions['resolveBinding'] = ({ slot }) =>
  Promise.resolve<Binding | null>(
    slot === 'default' ? { providerId: FAKE, model: 'fake/echo', source: 'default' } : null,
  );

/** A Gateway whose Usage Records land in `records`. */
async function start(overrides: Partial<GatewayOptions> = {}) {
  const records: UsageRecord[] = [];
  const test = await startGateway({
    getConnection: (providerId) =>
      Promise.resolve(providerId === FAKE ? { baseUrl: fake.url, apiKey: API_KEY } : null),
    getManifest: () => Promise.resolve(SLOTS),
    resolveBinding,
    onUsage: (record) => {
      records.push(record);
      return Promise.resolve();
    },
    ...overrides,
  });
  started.push(test.gateway);
  const token = test.gateway.issueToken(claims());
  return { ...test, token, records };
}

function complete(url: string, token: string, body: unknown, signal?: AbortSignal) {
  return fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    ...(signal !== undefined && { signal }),
  });
}

const hello = [{ role: 'user', content: 'hello there world' }];

/** Waits until exactly `count` records have arrived, and returns them. */
async function recorded(records: UsageRecord[], count: number): Promise<UsageRecord[]> {
  await vi.waitFor(() => {
    expect(records).toHaveLength(count);
  });
  return records;
}

/**
 * Proves the requests sent so far wrote no record: a request that does write one is sent after
 * them, and it must be the only record. Records are delivered in the order requests end.
 */
async function expectNoRecordsSoFar(url: string, token: string, records: UsageRecord[]) {
  const response = await complete(url, token, { model: `${FAKE}/fake/echo`, messages: hello });
  expect(response.status).toBe(200);
  await response.text();
  const [only] = await recorded(records, 1);
  expect(only).toMatchObject({ model: 'fake/echo', status: 'ok' });
}

/** The fields every record of `alice/hello` 1.2.3 for `model` at the fake carries. */
const recordOf = (model: string, fields: Partial<UsageRecord>) => ({
  timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) as string,
  harnessId: 'alice/hello',
  harnessVersion: '1.2.3',
  slot: null,
  provider: FAKE,
  model,
  durationMs: expect.any(Number) as number,
  ...fields,
});

describe('successful requests', () => {
  it('records a non-streaming request once, with the Provider’s token counts', async () => {
    const before = Date.now();
    const { url, token, records } = await start();
    const response = await complete(url, token, { model: `${FAKE}/fake/echo`, messages: hello });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { usage: Record<string, number> };
    const [record] = await recorded(records, 1);
    expect(record).toEqual(
      recordOf('fake/echo', { promptTokens: 3, completionTokens: 3, status: 'ok' }),
    );
    expect(record).not.toHaveProperty('cachedPromptTokens');
    expect(body.usage).toMatchObject({ prompt_tokens: 3, completion_tokens: 3 });
    expect(Date.parse(record?.timestamp ?? '')).toBeGreaterThanOrEqual(before);
    expect(Date.parse(record?.timestamp ?? '')).toBeLessThanOrEqual(Date.now());
    expect(record?.durationMs).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(record?.durationMs)).toBe(true);
  });

  it('records a streamed request once, with the usage of the final SSE chunk', async () => {
    const { url, token, records } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/echo-stream`,
      messages: [{ role: 'user', content: 'one two three four five' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const body = await readSse(response);
    const usage = body.chunks.at(-1)?.usage as Record<string, number>;
    expect(usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 5 });
    const [record] = await recorded(records, 1);
    expect(record).toEqual(
      recordOf('fake/echo-stream', {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        status: 'ok',
      }),
    );
  });

  it('records the Provider’s token counts even when the Harness did not ask for usage', async () => {
    const { url, token, records } = await start();
    const body = await readSse(
      await complete(url, token, {
        model: `${FAKE}/fake/echo-stream`,
        messages: hello,
        stream: true,
      }),
    );
    expect(body.chunks.some((chunk) => 'usage' in chunk)).toBe(false);
    const [record] = await recorded(records, 1);
    expect(record).toMatchObject({ promptTokens: 3, completionTokens: 3, status: 'ok' });
  });

  it.each([false, true])(
    'records null token counts for fake/stream-no-usage, never zero (stream: %s)',
    async (stream) => {
      const { url, token, records } = await start();
      const response = await complete(url, token, {
        model: `${FAKE}/fake/stream-no-usage`,
        messages: hello,
        stream,
        ...(stream && { stream_options: { include_usage: true } }),
      });
      expect(response.status).toBe(200);
      await response.text();
      const [record] = await recorded(records, 1);
      expect(record).toEqual(
        recordOf('fake/stream-no-usage', {
          promptTokens: null,
          completionTokens: null,
          status: 'ok',
        }),
      );
    },
  );

  it('records cached prompt tokens when the Provider reports them', async () => {
    const upstream = await startScriptedUpstream(() => ({
      json: {
        id: 'chatcmpl-scripted',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
        ],
        usage: {
          prompt_tokens: 40,
          completion_tokens: 2,
          total_tokens: 42,
          prompt_tokens_details: { cached_tokens: 32 },
        },
      },
    }));
    upstreams.push(upstream);
    const { url, token, records } = await start({
      getConnection: () => Promise.resolve({ baseUrl: upstream.url, apiKey: API_KEY }),
    });
    expect((await complete(url, token, { model: `${SCRIPTED}/m`, messages: hello })).status).toBe(
      200,
    );
    const [record] = await recorded(records, 1);
    expect(record).toMatchObject({
      provider: SCRIPTED,
      model: 'm',
      promptTokens: 40,
      completionTokens: 2,
      cachedPromptTokens: 32,
      status: 'ok',
    });
  });

  it('records the Model Slot a request named', async () => {
    const { url, token, records } = await start();
    const response = await complete(url, token, { model: 'default', messages: hello });
    expect(response.status).toBe(200);
    const [record] = await recorded(records, 1);
    expect(record).toEqual(
      recordOf('fake/echo', {
        slot: 'default',
        promptTokens: 3,
        completionTokens: 3,
        status: 'ok',
      }),
    );
  });

  it('measures fake/slow from request receipt, so the duration covers the Provider’s delay', async () => {
    const { url, token, records } = await start();
    const response = await complete(url, token, { model: `${FAKE}/fake/slow`, messages: hello });
    expect(response.status).toBe(200);
    const [record] = await recorded(records, 1);
    expect(record?.durationMs).toBeGreaterThanOrEqual(SLOW_MS);
    expect(record?.durationMs).toBeLessThan(SLOW_MS + 2000);
  });

  it('measures a stream until it ends, not until its headers', async () => {
    const { url, token, records } = await start({ streamIdleTimeoutMs: 400 });
    const response = await complete(url, token, {
      model: `${FAKE}/fake/stall`,
      messages: hello,
      stream: true,
    });
    expect(response.status).toBe(200);
    expect((await readSse(response)).done).toBe(true);
    const [record] = await recorded(records, 1);
    expect(record).toMatchObject({ status: 'timeout' });
    expect(record?.durationMs).toBeGreaterThanOrEqual(400);
  });
});

describe('failed requests that reached a Provider', () => {
  it.each([
    ['fake/500', 502],
    ['fake/rate-limited', 502],
  ])('records %s once with status provider_error', async (model, status) => {
    const { url, token, records } = await start();
    const response = await complete(url, token, { model: `${FAKE}/${model}`, messages: hello });
    expect(response.status).toBe(status);
    const [record] = await recorded(records, 1);
    expect(record).toEqual(
      recordOf(model, { promptTokens: null, completionTokens: null, status: 'provider_error' }),
    );
  });

  it('records a streamed fake/500 once with status provider_error', async () => {
    const { url, token, records } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/500`,
      messages: hello,
      stream: true,
    });
    expect(response.status).toBe(502);
    const [record] = await recorded(records, 1);
    expect(record).toMatchObject({ model: 'fake/500', status: 'provider_error' });
  });

  it('records a Provider that breaks off mid-stream with status provider_error', async () => {
    const { url, token, records } = await start();
    const body = await readSse(
      await complete(url, token, {
        model: `${FAKE}/fake/stream-error`,
        messages: hello,
        stream: true,
      }),
    );
    expect((body.chunks.at(-1) as { error: { code: string } }).error.code).toBe('provider_error');
    const [record] = await recorded(records, 1);
    expect(record).toEqual(
      recordOf('fake/stream-error', {
        promptTokens: null,
        completionTokens: null,
        status: 'provider_error',
      }),
    );
  });

  it('records a refused connection, with no response byte at all, as provider_error', async () => {
    // A port that was free a moment ago: nothing listens there now.
    const gone = await serveLoopback(() => new Response(), { host: '127.0.0.1', port: 0 });
    await gone.close();
    const { url, token, records } = await start({
      getConnection: () => Promise.resolve({ baseUrl: `${gone.origin}/v1`, apiKey: API_KEY }),
    });
    const response = await complete(url, token, { model: `${FAKE}/fake/echo`, messages: hello });
    expect(response.status).toBe(502);
    const [record] = await recorded(records, 1);
    expect(record).toMatchObject({ status: 'provider_error', promptTokens: null });
  });

  it.each([false, true])(
    'records a first-byte timeout with status timeout (stream: %s)',
    async (stream) => {
      const { url, token, records } = await start({ firstByteTimeoutMs: 100 });
      const response = await complete(url, token, {
        model: `${FAKE}/fake/slow`,
        messages: hello,
        stream,
      });
      expect(response.status).toBe(504);
      const [record] = await recorded(records, 1);
      expect(record).toMatchObject({ model: 'fake/slow', status: 'timeout' });
    },
  );

  it('records an idle timeout of a non-streamed body with status timeout', async () => {
    const { url, token, records } = await start({ streamIdleTimeoutMs: 100 });
    const response = await complete(url, token, { model: `${FAKE}/fake/stall`, messages: hello });
    expect(response.status).toBe(504);
    const [record] = await recorded(records, 1);
    expect(record).toMatchObject({ model: 'fake/stall', status: 'timeout' });
  });
});

describe('aborted requests', () => {
  it('records a Harness that disconnects mid-stream once, with status aborted', async () => {
    const { url, token, records } = await start();
    const client = new AbortController();
    const response = await complete(
      url,
      token,
      { model: `${FAKE}/fake/stall`, messages: hello, stream: true },
      client.signal,
    );
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await readUntil(reader, '"content":"hello');
    // The stream is still open: its record waits for the end.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(records).toHaveLength(0);
    client.abort();
    const [record] = await recorded(records, 1);
    expect(record).toEqual(
      recordOf('fake/stall', { promptTokens: null, completionTokens: null, status: 'aborted' }),
    );
  });

  it('records a Harness that disconnects before a non-streamed answer with status aborted', async () => {
    const { url, token, records } = await start();
    const client = new AbortController();
    const pending = complete(
      url,
      token,
      { model: `${FAKE}/fake/slow`, messages: hello },
      client.signal,
    );
    await vi.waitFor(() => {
      expect(fake.requests).toHaveLength(1);
    });
    client.abort();
    await expect(pending).rejects.toThrow();
    const [record] = await recorded(records, 1);
    expect(record).toMatchObject({ model: 'fake/slow', status: 'aborted' });
  });

  it.each([false, true])(
    'records a request whose token is revoked mid-call with status aborted (stream: %s)',
    async (stream) => {
      const { gateway, url, token, records } = await start();
      const pending = complete(url, token, { model: `${FAKE}/fake/slow`, messages: hello, stream });
      await vi.waitFor(() => {
        expect(fake.requests).toHaveLength(1);
      });
      gateway.revokeToken(token);
      expect((await pending).status).toBe(401);
      const [record] = await recorded(records, 1);
      expect(record).toMatchObject({ model: 'fake/slow', status: 'aborted' });
    },
  );

  it('records an open stream the token revocation ends with status aborted', async () => {
    const { gateway, url, token, records } = await start();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/stall`,
      messages: hello,
      stream: true,
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await readUntil(reader, '"content":"hello');
    gateway.revokeLaunch('launch-1');
    const [record] = await recorded(records, 1);
    expect(record).toMatchObject({ model: 'fake/stall', status: 'aborted' });
  });

  it('records an open stream that close() drops before close() resolves', async () => {
    const { gateway, url, token, records } = await start();
    const events: UsageRecord[] = [];
    gateway.on('usage', (record) => events.push(record));
    const response = await complete(url, token, {
      model: `${FAKE}/fake/stall`,
      messages: hello,
      stream: true,
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await readUntil(reader, '"content":"hello');
    await gateway.close();
    // No waiting: the host may close its usage store right after close() resolves.
    expect(records).toEqual([
      recordOf('fake/stall', { promptTokens: null, completionTokens: null, status: 'aborted' }),
    ]);
    expect(events).toEqual(records);
  });

  it('records a non-streamed call that close() stops before close() resolves', async () => {
    const { gateway, url, token, records } = await start();
    // close() drops the connection: the Harness sees a network error.
    const pending = complete(url, token, { model: `${FAKE}/fake/slow`, messages: hello }).catch(
      () => undefined,
    );
    await vi.waitFor(() => {
      expect(fake.requests).toHaveLength(1);
    });
    await gateway.close();
    expect(records).toEqual([
      recordOf('fake/slow', { promptTokens: null, completionTokens: null, status: 'aborted' }),
    ]);
    await pending;
  });

  it('waits in close() for onUsage to settle, for stopped and already finished requests', async () => {
    const stored: UsageRecord[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { gateway, url, token } = await start({
      // A slow store: the record counts as written once this promise settles.
      onUsage: async (record) => {
        await held;
        stored.push(record);
      },
    });
    const done = await complete(url, token, { model: `${FAKE}/fake/echo`, messages: hello });
    await done.text();
    const response = await complete(url, token, {
      model: `${FAKE}/fake/stall`,
      messages: hello,
      stream: true,
    });
    await readUntil((response.body as ReadableStream<Uint8Array>).getReader(), '"content":"hello');
    let closed = false;
    const closing = gateway.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(stored.map(({ model, status }) => ({ model, status }))).toEqual([
      { model: 'fake/echo', status: 'ok' },
      { model: 'fake/stall', status: 'aborted' },
    ]);
  });
});

describe('requests that never reached a Provider', () => {
  it('records nothing for invalid_token, invalid_request, unknown_slot, slot_unbound or provider_not_connected', async () => {
    const { url, token, records } = await start();
    const cases: [unknown, number, string | undefined][] = [
      [{ model: `${FAKE}/fake/echo`, messages: hello }, 401, 'not-a-token'],
      [{ model: `${FAKE}/fake/echo`, messages: [] }, 400, undefined],
      [{ model: 'nonexistent', messages: hello }, 404, undefined],
      [{ model: 'unbound', messages: hello }, 409, undefined],
      [{ model: 'anthropic/claude-haiku-4-5', messages: hello }, 403, undefined],
    ];
    for (const [body, status, other] of cases) {
      const response = await complete(url, other ?? token, body);
      expect(response.status).toBe(status);
      await response.text();
    }
    expect(fake.requests).toHaveLength(0);
    await expectNoRecordsSoFar(url, token, records);
  });

  it('records nothing for a request revoked before its upstream call', async () => {
    const connection = { baseUrl: fake.url, apiKey: API_KEY };
    let release: (() => void) | undefined;
    const getConnection = vi.fn(() =>
      // The first request waits in model resolution until the test revokes its token.
      release === undefined
        ? new Promise<typeof connection>((resolve) => {
            release = () => {
              resolve(connection);
            };
          })
        : Promise.resolve(connection),
    );
    const { gateway, url, token, records } = await start({ getConnection });
    const pending = complete(url, token, { model: `${FAKE}/fake/echo`, messages: hello });
    await vi.waitFor(() => {
      expect(getConnection).toHaveBeenCalledTimes(1);
    });
    gateway.revokeToken(token);
    expect((await pending).status).toBe(401);
    release?.();
    expect(fake.requests).toHaveLength(0);
    await expectNoRecordsSoFar(url, gateway.issueToken(claims({ launchId: 'launch-2' })), records);
  });
});

describe('many concurrent requests', () => {
  it('writes exactly one record per request that reached a Provider, and no duplicates', async () => {
    const usage = vi.fn<(record: UsageRecord) => void>();
    const { gateway, url, token, records } = await start();
    gateway.on('usage', usage);
    const text = async (response: Promise<Response>) => (await response).text();
    const stalled = async () => {
      const client = new AbortController();
      const response = await complete(
        url,
        token,
        { model: `${FAKE}/fake/stall`, messages: hello, stream: true },
        client.signal,
      );
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      await readUntil(reader, '"content":"hello');
      client.abort();
    };
    const times = <T>(count: number, run: () => Promise<T>) =>
      Array.from({ length: count }, () => run());
    await Promise.all([
      ...times(6, () =>
        text(complete(url, token, { model: `${FAKE}/fake/echo`, messages: hello })),
      ),
      ...times(6, () =>
        text(
          complete(url, token, {
            model: 'default',
            messages: hello,
            stream: true,
            stream_options: { include_usage: true },
          }),
        ),
      ),
      ...times(4, () => text(complete(url, token, { model: `${FAKE}/fake/500`, messages: hello }))),
      ...times(4, stalled),
      ...times(4, () => text(complete(url, 'bad-token', { model: 'default', messages: hello }))),
      ...times(4, () => text(complete(url, token, { model: 'unbound', messages: hello }))),
    ]);
    await recorded(records, 20);
    // Nothing more arrives late.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(records).toHaveLength(20);
    const count = (filter: Partial<UsageRecord>) =>
      records.filter((record) =>
        Object.entries(filter).every(([key, value]) => record[key as keyof UsageRecord] === value),
      ).length;
    expect(count({ model: 'fake/echo', slot: null, status: 'ok' })).toBe(6);
    expect(count({ model: 'fake/echo', slot: 'default', status: 'ok' })).toBe(6);
    expect(count({ model: 'fake/500', status: 'provider_error' })).toBe(4);
    expect(count({ model: 'fake/stall', status: 'aborted' })).toBe(4);
    expect(usage).toHaveBeenCalledTimes(20);
    expect(usage.mock.calls.map(([record]) => record)).toEqual(records);
  });
});

describe('delivery', () => {
  it('emits usage after onUsage settled, with the same record', async () => {
    let settle: () => void = () => undefined;
    const onUsage = vi.fn<GatewayOptions['onUsage']>(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const { gateway, url, token } = await start({ onUsage });
    const usage = vi.fn<(record: UsageRecord) => void>();
    gateway.on('usage', usage);
    expect(
      (await complete(url, token, { model: `${FAKE}/fake/echo`, messages: hello })).status,
    ).toBe(200);
    await vi.waitFor(() => {
      expect(onUsage).toHaveBeenCalledTimes(1);
    });
    expect(usage).not.toHaveBeenCalled();
    settle();
    await vi.waitFor(() => {
      expect(usage).toHaveBeenCalledTimes(1);
    });
    expect(usage).toHaveBeenCalledWith(onUsage.mock.calls[0]?.[0]);
  });

  it('answers before onUsage finishes, and logs a rejecting onUsage without failing the request', async () => {
    const error = vi.fn<Logger['error']>();
    const onUsage = vi.fn<GatewayOptions['onUsage']>(() => Promise.reject(new Error('disk full')));
    const { gateway, url, token } = await start({
      onUsage,
      logger: { debug: () => undefined, error },
    });
    const usage = vi.fn<(record: UsageRecord) => void>();
    gateway.on('usage', usage);
    const response = await complete(url, token, { model: `${FAKE}/fake/echo`, messages: hello });
    expect(response.status).toBe(200);
    await response.json();
    await vi.waitFor(() => {
      expect(usage).toHaveBeenCalledTimes(1);
    });
    expect(error).toHaveBeenCalledWith(
      'onUsage failed',
      expect.objectContaining({ harnessId: 'alice/hello' }),
    );
  });

  it('logs a throwing onUsage and a throwing usage listener, and keeps serving', async () => {
    const error = vi.fn<Logger['error']>();
    const { gateway, url, token } = await start({
      onUsage: () => {
        throw new Error('sync failure');
      },
      logger: { debug: () => undefined, error },
    });
    gateway.on('usage', () => {
      throw new Error('listener failure');
    });
    for (let i = 0; i < 2; i++) {
      const response = await complete(url, token, { model: `${FAKE}/fake/echo`, messages: hello });
      expect(response.status).toBe(200);
    }
    await vi.waitFor(() => {
      expect(error.mock.calls.map(([message]) => message)).toEqual([
        'onUsage failed',
        'usage listener failed',
        'onUsage failed',
        'usage listener failed',
      ]);
    });
  });
});

describe('usageRecord', () => {
  const context = {
    receivedAt: { time: Date.UTC(2026, 0, 2, 3, 4, 5, 6), mark: 1000 },
    harnessId: 'alice/hello',
    harnessVersion: '1.2.3',
    slot: 'default',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
  };
  const usage = (inputTokens?: number, outputTokens?: number, cacheReadTokens?: number) => ({
    inputTokens,
    outputTokens,
    totalTokens: undefined,
    inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens, cacheWriteTokens: undefined },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  });

  it('builds the record with a UTC timestamp and a whole, positive duration', () => {
    expect(usageRecord(context, 'ok', usage(10, 5, 4), 1012.6)).toEqual({
      timestamp: '2026-01-02T03:04:05.006Z',
      harnessId: 'alice/hello',
      harnessVersion: '1.2.3',
      slot: 'default',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      promptTokens: 10,
      completionTokens: 5,
      cachedPromptTokens: 4,
      durationMs: 13,
      status: 'ok',
    });
    expect(usageRecord(context, 'ok', usage(1, 1), 1000.2).durationMs).toBe(1);
  });

  it('keeps each count the Provider left out as null, and omits zero cached tokens', () => {
    const partial = usageRecord(context, 'ok', usage(7, undefined, 0), 1001);
    expect(partial).toMatchObject({ promptTokens: 7, completionTokens: null });
    expect(partial).not.toHaveProperty('cachedPromptTokens');
    expect(usageRecord(context, 'aborted', undefined, 1001)).toMatchObject({
      promptTokens: null,
      completionTokens: null,
      status: 'aborted',
    });
  });
});
