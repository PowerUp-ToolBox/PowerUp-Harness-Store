/**
 * Model Slot resolution for `POST /v1/chat/completions` and `GET /v1/models`, through the Gateway
 * HTTP seam with the fake Provider. `resolveBinding` is a stub each test controls: the normative
 * resolution order belongs to the host (P0-03), so these tests prove only that the Gateway asks
 * on every request, obeys every answer and keeps `slot_unbound` apart from `unknown_slot`.
 */
import OpenAI from 'openai';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeProvider } from '../src/testing/fake-provider.js';
import type { FakeProvider } from '../src/testing/fake-provider.js';
import type {
  Binding,
  Gateway,
  GatewayOptions,
  Logger,
  ModelList,
  SlotUnboundEvent,
} from '../src/index.js';
import { claims, manifestWith, startGateway } from './support/gateway.js';
import { readSse } from './support/sse.js';

/** The Provider id the fake stands in for. */
const FAKE = 'openai-compatible:fake';
const API_KEY = 'sk-fake-connection-key-0123456789';

let fake: FakeProvider;

beforeAll(async () => {
  fake = await startFakeProvider({ apiKey: API_KEY });
});

afterAll(async () => {
  await fake.close();
});

/** Gateways started by the current test, closed after it. */
const started: Gateway[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((gateway) => gateway.close()));
  fake.reset();
});

/** `alice/hello` declares these Model Slots unless a test says otherwise. */
const SLOTS = manifestWith({ default: {}, fast: {}, vision: { requirements: { vision: true } } });

/** A Slot Binding to a fake scenario. */
const bound = (model: string, source: Binding['source'] = 'default'): Binding => ({
  providerId: FAKE,
  model,
  source,
});

type ResolveBinding = GatewayOptions['resolveBinding'];

/** A `resolveBinding` stub answering from `bindings` by Slot name; unlisted Slots are unbound. */
function stub(bindings: Record<string, Binding | null>) {
  return vi.fn<ResolveBinding>(({ slot }) => Promise.resolve(bindings[slot] ?? null));
}

async function start(overrides: Partial<GatewayOptions> = {}) {
  const getConnection = vi.fn((providerId: string) =>
    Promise.resolve(providerId === FAKE ? { baseUrl: fake.url, apiKey: API_KEY } : null),
  );
  const getManifest = vi.fn(() => Promise.resolve(SLOTS));
  const test = await startGateway({ getConnection, getManifest, ...overrides });
  started.push(test.gateway);
  const token = test.gateway.issueToken(claims());
  return { ...test, token, getConnection, getManifest };
}

function complete(url: string, token: string, body: unknown) {
  return fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function listModels(url: string, token?: string) {
  return fetch(`${url}/models`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

const hello = [{ role: 'user', content: 'hello there world' }];

async function errorOf(response: Response) {
  return ((await response.json()) as { error: Record<string, unknown> }).error;
}

/** The `model` of the chat completions the fake received, in order. */
function upstreamModels(): unknown[] {
  return fake.requests
    .filter((request) => request.path === '/v1/chat/completions')
    .map((request) => (request.body as { model?: unknown }).model);
}

describe('a request naming a Model Slot', () => {
  it.each<[string, string, Binding]>([
    ['a Model Override', 'default', bound('fake/echo', 'override')],
    ['the first reachable Recommended Model', 'fast', bound('fake/stream-no-usage', 'recommended')],
    ['the Default Model of the same name', 'fast', bound('fake/echo', 'default_same_name')],
    ['the Default Model of `default`', 'vision', bound('fake/echo', 'default')],
  ])('is answered by the model %s binds', async (_rule, slot, binding) => {
    const resolveBinding = vi.fn<ResolveBinding>(() => Promise.resolve(binding));
    const { url, token, getManifest } = await start({ resolveBinding });
    const response = await complete(url, token, { model: slot, messages: hello });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      object: 'chat.completion',
      model: `${FAKE}/${binding.model}`,
      choices: [{ message: { role: 'assistant', content: 'hello there world' } }],
    });
    // Which rule chose the binding is the app's business, never the Harness's.
    expect(JSON.stringify(body)).not.toContain(binding.source);
    expect(resolveBinding.mock.calls).toEqual([[{ harnessId: 'alice/hello', slot }]]);
    expect(getManifest).toHaveBeenCalledWith('alice/hello');
    expect(upstreamModels()).toEqual([binding.model]);
  });

  it('gets 409 slot_unbound when nothing is bound, without reaching a Provider', async () => {
    const resolveBinding = stub({});
    const { url, token, getConnection } = await start({ resolveBinding });
    const response = await complete(url, token, { model: 'default', messages: hello });
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toEqual({
      code: 'slot_unbound',
      slot: 'default',
      message: expect.stringContaining('default') as string,
      type: 'harness_store',
    });
    expect(resolveBinding).toHaveBeenCalledOnce();
    expect(getConnection).not.toHaveBeenCalled();
    expect(fake.requests).toEqual([]);
  });

  it.each([
    ['a Slot the Manifest does not declare', 'nonexistent-slot'],
    ['an Object.prototype property name', 'constructor'],
    ['__proto__', '__proto__'],
  ])('gets 404 unknown_slot for %s, without calling resolveBinding', async (_name, model) => {
    const resolveBinding = stub({ default: bound('fake/echo') });
    const { url, token, getManifest } = await start({ resolveBinding });
    const response = await complete(url, token, { model, messages: hello });
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toEqual({
      code: 'unknown_slot',
      message: expect.any(String) as string,
      type: 'harness_store',
    });
    expect(getManifest).toHaveBeenCalledWith('alice/hello');
    expect(resolveBinding).not.toHaveBeenCalled();
    expect(fake.requests).toEqual([]);
  });

  it('gets 404 unknown_slot for any Slot name when the Harness has no Manifest', async () => {
    const resolveBinding = stub({ default: bound('fake/echo') });
    const { url, token } = await start({
      resolveBinding,
      getManifest: vi.fn(() => Promise.resolve(null)),
    });
    const response = await complete(url, token, { model: 'default', messages: hello });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('unknown_slot');
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it('gets 403 provider_not_connected when the bound Provider has no Connection', async () => {
    const resolveBinding = stub({ default: { ...bound('m'), providerId: 'anthropic' } });
    const { url, token, getConnection } = await start({ resolveBinding });
    const response = await complete(url, token, { model: 'default', messages: hello });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('provider_not_connected');
    expect(getConnection.mock.calls).toEqual([['anthropic']]);
    expect(fake.requests).toEqual([]);
  });

  it('validates the body before resolving the Slot', async () => {
    const resolveBinding = stub({ default: bound('fake/echo') });
    const { url, token, getManifest } = await start({ resolveBinding });
    const response = await complete(url, token, { model: 'default', messages: [] });
    expect(response.status).toBe(400);
    expect(getManifest).not.toHaveBeenCalled();
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it('streams under the resolved provider/model', async () => {
    const { url, token } = await start({ resolveBinding: stub({ fast: bound('fake/echo') }) });
    const response = await complete(url, token, { model: 'fast', messages: hello, stream: true });
    expect(response.status).toBe(200);
    const { chunks } = await readSse(response);
    expect(chunks.length).toBeGreaterThan(0);
    expect(new Set(chunks.map((chunk) => chunk.model))).toEqual(new Set([`${FAKE}/fake/echo`]));
  });

  it('works with the OpenAI SDK naming a Slot', async () => {
    const { url, token } = await start({ resolveBinding: stub({ default: bound('fake/echo') }) });
    const client = new OpenAI({ baseURL: url, apiKey: token, maxRetries: 0 });
    const completion = await client.chat.completions.create({
      model: 'default',
      messages: [{ role: 'user', content: 'ping' }],
    });
    expect(completion.model).toBe(`${FAKE}/fake/echo`);
    expect(completion.choices[0]?.message.content).toBe('ping');
  });
});

describe('rebinding mid-session', () => {
  it('applies a binding change to the very next request, without a restart', async () => {
    let current = bound('fake/echo', 'default');
    const resolveBinding = vi.fn<ResolveBinding>(() => Promise.resolve(current));
    const { url, token, getManifest } = await start({ resolveBinding });

    const first = await complete(url, token, { model: 'default', messages: hello });
    current = bound('fake/stream-no-usage', 'override');
    const second = await complete(url, token, { model: 'default', messages: hello });

    const models = [first, second].map(async (response) => {
      expect(response.status).toBe(200);
      return ((await response.json()) as { model: string }).model;
    });
    expect(await Promise.all(models)).toEqual([
      `${FAKE}/fake/echo`,
      `${FAKE}/fake/stream-no-usage`,
    ]);
    expect(upstreamModels()).toEqual(['fake/echo', 'fake/stream-no-usage']);
    expect(resolveBinding).toHaveBeenCalledTimes(2);
    expect(getManifest).toHaveBeenCalledTimes(2);
  });

  it('turns a bound Slot unbound, and back, from one request to the next', async () => {
    let current: Binding | null = bound('fake/echo');
    const { url, token } = await start({
      resolveBinding: () => Promise.resolve(current),
    });
    const statuses: number[] = [];
    for (const next of [null, bound('fake/echo')]) {
      statuses.push((await complete(url, token, { model: 'default', messages: hello })).status);
      current = next;
    }
    statuses.push((await complete(url, token, { model: 'default', messages: hello })).status);
    expect(statuses).toEqual([200, 409, 200]);
  });

  it('follows a Slot newly declared by an updated Manifest', async () => {
    let manifest = manifestWith({ default: {} });
    const { url, token } = await start({
      getManifest: () => Promise.resolve(manifest),
      resolveBinding: stub({ fast: bound('fake/echo') }),
    });
    const before = await complete(url, token, { model: 'fast', messages: hello });
    manifest = manifestWith({ default: {}, fast: {} });
    const after = await complete(url, token, { model: 'fast', messages: hello });
    expect([before.status, after.status]).toEqual([404, 200]);
  });
});

describe('the slot_unbound event', () => {
  it('is emitted with the Harness and Slot for every slot_unbound request', async () => {
    const { gateway, url, token } = await start({ resolveBinding: stub({}) });
    const events: SlotUnboundEvent[] = [];
    gateway.on('slot_unbound', (event) => events.push(event));
    await complete(url, token, { model: 'fast', messages: hello });
    await complete(url, token, { model: 'fast', messages: hello });
    // Neither an unknown Slot nor a listing of unbound Slots is a failed model call.
    await complete(url, token, { model: 'nonexistent-slot', messages: hello });
    await listModels(url, token);
    expect(events).toEqual([
      { harnessId: 'alice/hello', slot: 'fast' },
      { harnessId: 'alice/hello', slot: 'fast' },
    ]);
  });

  it('still answers 409 when a listener throws, and logs the failure', async () => {
    const error = vi.fn<Logger['error']>();
    const { gateway, url, token } = await start({
      resolveBinding: stub({}),
      logger: { debug: () => undefined, error },
    });
    gateway.on('slot_unbound', () => {
      throw new Error('notification center unavailable');
    });
    const response = await complete(url, token, { model: 'default', messages: hello });
    expect(response.status).toBe(409);
    expect(error).toHaveBeenCalledOnce();
  });
});

describe('a resolveBinding that breaks its contract', () => {
  it.each<[string, () => Promise<unknown>]>([
    ['rejects', () => Promise.reject(new Error('database is locked'))],
    ['returns undefined', () => Promise.resolve(undefined)],
    [
      'returns an unknown Provider id',
      () => Promise.resolve({ ...bound('m'), providerId: 'acme' }),
    ],
    ['returns an empty model', () => Promise.resolve(bound(''))],
    ['returns a model with whitespace', () => Promise.resolve(bound('fake echo'))],
    ['returns a model with a dot segment', () => Promise.resolve(bound('../fake/echo'))],
    [
      'returns a Google model that is not a Gemini model name',
      () => Promise.resolve({ ...bound('gemini-2.5-flash?alt=sse#'), providerId: 'google' }),
    ],
  ])('fails the request with 500 internal_error when it %s', async (_name, answer) => {
    const error = vi.fn<Logger['error']>();
    const resolveBinding = answer as ResolveBinding;
    const { url, token, getConnection } = await start({
      resolveBinding,
      logger: { debug: () => undefined, error },
    });
    for (const response of [
      await complete(url, token, { model: 'default', messages: hello }),
      await listModels(url, token),
    ]) {
      expect(response.status).toBe(500);
      expect(await errorOf(response)).toEqual({
        code: 'internal_error',
        message: expect.any(String) as string,
        type: 'harness_store',
      });
    }
    expect(error).toHaveBeenCalledTimes(2);
    expect(getConnection).not.toHaveBeenCalled();
    expect(fake.requests).toEqual([]);
  });
});

describe('an explicit provider/model id', () => {
  it('still bypasses the Manifest and the Slot Bindings', async () => {
    const resolveBinding = stub({ default: bound('fake/stream-no-usage') });
    const { url, token, getManifest } = await start({ resolveBinding });
    const response = await complete(url, token, { model: `${FAKE}/fake/echo`, messages: hello });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { model: string }).model).toBe(`${FAKE}/fake/echo`);
    expect(getManifest).not.toHaveBeenCalled();
    expect(resolveBinding).not.toHaveBeenCalled();
  });
});

describe('GET /v1/models', () => {
  it('lists every declared Slot with its current binding, bound or not', async () => {
    const resolveBinding = stub({
      default: bound('fake/echo', 'override'),
      vision: { providerId: 'openrouter', model: 'anthropic/claude-sonnet-4-5', source: 'default' },
    });
    const { url, token, getManifest } = await start({ resolveBinding });
    const response = await listModels(url, token);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const body = (await response.json()) as ModelList;
    expect(body).toEqual({
      object: 'list',
      data: [
        {
          id: 'default',
          object: 'model',
          created: 0,
          owned_by: 'harness-store',
          resolved_model: `${FAKE}/fake/echo`,
        },
        {
          id: 'fast',
          object: 'model',
          created: 0,
          owned_by: 'harness-store',
          resolved_model: null,
        },
        {
          id: 'vision',
          object: 'model',
          created: 0,
          owned_by: 'harness-store',
          resolved_model: 'openrouter/anthropic/claude-sonnet-4-5',
        },
      ],
    });
    expect(getManifest).toHaveBeenCalledWith('alice/hello');
    expect(resolveBinding.mock.calls.map(([ctx]) => ctx)).toEqual([
      { harnessId: 'alice/hello', slot: 'default' },
      { harnessId: 'alice/hello', slot: 'fast' },
      { harnessId: 'alice/hello', slot: 'vision' },
    ]);
    // Neither a source nor any Provider is consulted for a listing.
    expect(JSON.stringify(body)).not.toContain('override');
    expect(fake.requests).toEqual([]);
  });

  it('reflects a binding change made between two calls', async () => {
    let current: Binding | null = null;
    const { url, token } = await start({
      resolveBinding: ({ slot }) => Promise.resolve(slot === 'fast' ? current : null),
    });
    const resolvedFast = async () => {
      const body = (await (await listModels(url, token)).json()) as ModelList;
      return body.data.find((model) => model.id === 'fast')?.resolved_model;
    };
    const unbound = await resolvedFast();
    current = bound('fake/echo', 'override');
    const rebound = await resolvedFast();
    current = bound('fake/stream-no-usage', 'recommended');
    const changed = await resolvedFast();
    expect([unbound, rebound, changed]).toEqual([
      null,
      `${FAKE}/fake/echo`,
      `${FAKE}/fake/stream-no-usage`,
    ]);
  });

  it('is empty for a Harness with no Manifest', async () => {
    const resolveBinding = stub({});
    const { url, token } = await start({
      resolveBinding,
      getManifest: vi.fn(() => Promise.resolve(null)),
    });
    expect(await (await listModels(url, token)).json()).toEqual({ object: 'list', data: [] });
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it('needs a valid Gateway Token', async () => {
    const resolveBinding = stub({});
    const { url, getManifest } = await start({ resolveBinding });
    const response = await listModels(url, 'not-a-token');
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe('invalid_token');
    expect(getManifest).not.toHaveBeenCalled();
  });

  it('fails with 401 when the token is revoked while bindings resolve', async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<null>((resolve) => {
      release = () => {
        resolve(null);
      };
    });
    const resolveBinding = vi.fn<ResolveBinding>(() => pending);
    const { gateway, url, token } = await start({ resolveBinding });
    const response = listModels(url, token);
    await vi.waitFor(() => {
      expect(resolveBinding).toHaveBeenCalled();
    });
    gateway.revokeToken(token);
    expect((await response).status).toBe(401);
    release();
  });

  it('works with the OpenAI SDK', async () => {
    const { url, token } = await start({ resolveBinding: stub({ default: bound('fake/echo') }) });
    const client = new OpenAI({ baseURL: url, apiKey: token, maxRetries: 0 });
    const ids: string[] = [];
    for await (const model of client.models.list()) ids.push(model.id);
    expect(ids).toEqual(['default', 'fast', 'vision']);
  });
});
