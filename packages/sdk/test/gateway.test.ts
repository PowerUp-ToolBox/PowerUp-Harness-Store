/**
 * The SDK against a real Model Gateway (`@harness-store/gateway`, in-process) whose `ollama`
 * Connection points at the fake Provider. No real Provider and no real key: the Gateway only
 * ever reaches the fake on loopback.
 */
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGateway } from '@harness-store/gateway';
import type { Binding, Gateway, UsageRecord } from '@harness-store/gateway';
import { startFakeProvider } from '@harness-store/gateway/testing/fake-provider';
import type { FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { validateManifest } from '@harness-store/manifest';
import type { Manifest } from '@harness-store/manifest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createOpenAIClient,
  GatewayError,
  gatewayFetch,
  getGatewayContext,
  isSlotUnbound,
  listSlots,
  NotInHarnessStoreError,
  Slots,
  SlotUnboundError,
} from '../src/index.js';
import { LAUNCH_ENV, stubLaunchEnv } from './support/env.js';

/** `alice/hello` declares four Model Slots; `smart` is bound to a model that always fails. */
const manifest: Manifest = (() => {
  const result = validateManifest({
    manifestVersion: 1,
    id: 'alice/hello',
    version: '1.2.3',
    name: 'Hello',
    summary: 'A test Harness.',
    license: 'MIT',
    platforms: ['darwin-arm64', 'linux-x64', 'win32-x64'],
    runtime: { kind: 'node', node: '22' },
    entry: 'dist/index.mjs',
    ui: { kind: 'web' },
    workspace: 'optional',
    models: {
      slots: {
        default: { description: 'Writes chat replies', requirements: { tools: false } },
        fast: {},
        smart: { requirements: { minContext: 32000 } },
      },
    },
    permissions: { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } },
  });
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.manifest;
})();

/** The User's Slot Bindings: `fast` is unbound. */
const BINDINGS: Record<string, Binding> = {
  default: { providerId: 'ollama', model: 'model-a', source: 'default' },
  smart: { providerId: 'ollama', model: 'model-broken', source: 'override' },
};

let fake: FakeProvider;
let gateway: Gateway;
let gatewayUrl: string;
let token: string;
const usage: UsageRecord[] = [];

beforeAll(async () => {
  fake = await startFakeProvider({
    aliases: { 'model-a': 'fake/echo', 'model-broken': 'fake/500' },
  });
  gateway = createGateway({
    resolveBinding: ({ slot }) => Promise.resolve(BINDINGS[slot] ?? null),
    getConnection: (providerId) =>
      Promise.resolve(providerId === 'ollama' ? { baseUrl: fake.url } : null),
    getManifest: (harnessId) => Promise.resolve(harnessId === 'alice/hello' ? manifest : null),
    onUsage: (record) => {
      usage.push(record);
      return Promise.resolve();
    },
    logger: { debug: () => undefined, error: () => undefined },
  });
  ({ url: gatewayUrl } = await gateway.listen());
  token = gateway.issueToken({
    harnessId: 'alice/hello',
    harnessVersion: '1.2.3',
    launchId: 'launch-1',
    locale: 'zh-CN',
    workspace: '/Users/alice/project',
  });
});

afterAll(async () => {
  await gateway.close();
  await fake.close();
});

beforeEach(() => {
  fake.reset();
  usage.length = 0;
  stubLaunchEnv({
    ...LAUNCH_ENV,
    HARNESS_GATEWAY_URL: gatewayUrl,
    HARNESS_GATEWAY_TOKEN: token,
    OPENAI_BASE_URL: gatewayUrl,
    OPENAI_API_KEY: token,
  });
});

/** Waits for the Usage Records the Gateway hands over after a response ended. */
async function usageRecords(count: number): Promise<UsageRecord[]> {
  while (usage.length < count) await once(gateway, 'usage');
  return [...usage];
}

describe('createOpenAIClient', () => {
  it('completes a chat call on the default Slot through the Gateway', async () => {
    const completion = await createOpenAIClient().chat.completions.create({
      model: Slots.default,
      messages: [{ role: 'user', content: 'Hello from the SDK' }],
    });
    expect(completion.choices[0]?.message.content).toBe('Hello from the SDK');
    // The Gateway reports the bound model, so a Harness can show what answered.
    expect(completion.model).toBe('ollama/model-a');
    // The fake saw the Gateway's call, never the Gateway Token.
    expect(fake.requests).toHaveLength(1);
    expect(JSON.stringify(fake.requests[0]?.headers)).not.toContain(token);
  });

  it('streams a chat completion', async () => {
    const stream = await createOpenAIClient().chat.completions.create({
      model: Slots.default,
      messages: [{ role: 'user', content: 'Stream these words please' }],
      stream: true,
    });
    let text = '';
    let model = '';
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? '';
      model = chunk.model;
    }
    expect(text).toBe('Stream these words please');
    expect(model).toBe('ollama/model-a');
  });

  it('surfaces an unbound Slot as an error isSlotUnbound recognises, naming the Slot', async () => {
    const error: unknown = await createOpenAIClient()
      .chat.completions.create({
        model: Slots.fast,
        messages: [{ role: 'user', content: 'Hi' }],
      })
      .catch((err: unknown) => err);

    expect(isSlotUnbound(error)).toBe(true);
    expect(error).toMatchObject({ status: 409, code: 'slot_unbound' });
    const typed = SlotUnboundError.from(error);
    expect(typed).toBeInstanceOf(SlotUnboundError);
    expect(typed?.slot).toBe('fast');
    // Nothing reached a Provider.
    expect(fake.requests).toHaveLength(0);
  });

  it('does not retry by default: one failed upstream call, one Usage Record', async () => {
    const error: unknown = await createOpenAIClient()
      .chat.completions.create({
        model: Slots.smart,
        messages: [{ role: 'user', content: 'Hi' }],
      })
      .catch((err: unknown) => err);

    expect(error).toMatchObject({ status: 502, code: 'provider_error' });
    expect(isSlotUnbound(error)).toBe(false);
    expect(SlotUnboundError.from(error)).toBeUndefined();
    expect(fake.requests).toHaveLength(1);
    const records = await usageRecords(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ slot: 'smart', status: 'provider_error' });
  });

  it('lets the caller turn retries back on', () => {
    const client = createOpenAIClient({ maxRetries: 1 });
    expect(client.maxRetries).toBe(1);
    expect(createOpenAIClient().maxRetries).toBe(0);
  });

  it('is not fooled by a network error', async () => {
    // A port nothing listens on any more.
    const closed = createServer();
    closed.listen(0, '127.0.0.1');
    await once(closed, 'listening');
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    stubLaunchEnv({
      ...LAUNCH_ENV,
      HARNESS_GATEWAY_URL: `http://127.0.0.1:${String(port)}/v1`,
      HARNESS_GATEWAY_TOKEN: token,
    });

    const error: unknown = await createOpenAIClient()
      .chat.completions.create({
        model: Slots.default,
        messages: [{ role: 'user', content: 'Hi' }],
      })
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(isSlotUnbound(error)).toBe(false);
  });

  it('throws NotInHarnessStoreError without the Gateway variables', () => {
    stubLaunchEnv({});
    expect(() => createOpenAIClient()).toThrow(NotInHarnessStoreError);
  });

  it('uses the base URL and token of the launch, not the shell OPENAI_ variables', () => {
    stubLaunchEnv({
      HARNESS_GATEWAY_URL: gatewayUrl,
      HARNESS_GATEWAY_TOKEN: token,
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      OPENAI_API_KEY: 'sk-from-the-shell',
    });
    const client = createOpenAIClient();
    expect(client.baseURL).toBe(gatewayUrl);
    expect(client.apiKey).toBe(token);
  });
});

describe('listSlots', () => {
  it('returns the Slots the Gateway reports for the calling Harness, in Manifest order', async () => {
    expect(await listSlots()).toEqual([
      { name: 'default', resolvedModel: 'ollama/model-a' },
      { name: 'fast', resolvedModel: null },
      { name: 'smart', resolvedModel: 'ollama/model-broken' },
    ]);
  });

  it('throws a GatewayError carrying the Gateway code for a revoked or unknown token', async () => {
    stubLaunchEnv({ HARNESS_GATEWAY_URL: gatewayUrl, HARNESS_GATEWAY_TOKEN: 'not-a-token' });
    const error: unknown = await listSlots().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ status: 401, code: 'invalid_token' });
  });
});

describe('getGatewayContext', () => {
  it("returns the Gateway's view of the launch, with the wire field names", async () => {
    expect(await getGatewayContext()).toEqual({
      harnessId: 'alice/hello',
      version: '1.2.3',
      locale: 'zh-CN',
      workspace: '/Users/alice/project',
      slots: {
        default: { description: 'Writes chat replies', requirements: { tools: false } },
        fast: { requirements: {} },
        smart: { requirements: { minContext: 32000 } },
      },
    });
  });
});

describe('gatewayFetch', () => {
  it('reaches the Gateway with the Gateway Token', async () => {
    const response = await gatewayFetch('/models');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ object: 'list' });
  });

  describe('against a recording server', () => {
    let recorder: Server;
    let base: string;
    const seen: { url: string | undefined; headers: IncomingHttpHeaders }[] = [];

    beforeAll(async () => {
      recorder = createServer((req, res) => {
        seen.push({ url: req.url, headers: req.headers });
        res.statusCode = req.url?.endsWith('/missing') === true ? 404 : 200;
        res.end('{}');
      });
      recorder.listen(0, '127.0.0.1');
      await once(recorder, 'listening');
      base = `http://127.0.0.1:${String((recorder.address() as AddressInfo).port)}/v1`;
    });

    afterAll(async () => {
      await new Promise((resolve) => recorder.close(resolve));
    });

    beforeEach(() => {
      seen.length = 0;
    });

    it.each([
      ['/models', '/v1/models', ''],
      ['models', '/v1/models', ''],
      ['/harness/context', '/v1/harness/context', ''],
      ['//models', '/v1/models', ''],
      ['/models', '/v1/models', '/'],
      ['/v1/models', '/v1/v1/models', ''],
    ])('joins %s to the base URL as %s (base URL suffix %j)', async (path, expected, suffix) => {
      stubLaunchEnv({ HARNESS_GATEWAY_URL: base + suffix, HARNESS_GATEWAY_TOKEN: 'launch-token' });
      await gatewayFetch(path);
      expect(seen[0]?.url).toBe(expected);
    });

    it("sets Authorization: Bearer <token> over the caller's, and keeps the other headers", async () => {
      stubLaunchEnv({ HARNESS_GATEWAY_URL: base, HARNESS_GATEWAY_TOKEN: 'launch-token' });
      await gatewayFetch('/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer something-else', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(seen[0]?.headers.authorization).toBe('Bearer launch-token');
      expect(seen[0]?.headers['content-type']).toBe('application/json');
    });

    it('returns a non-2xx response as it is, without throwing', async () => {
      stubLaunchEnv({ HARNESS_GATEWAY_URL: base, HARNESS_GATEWAY_TOKEN: 'launch-token' });
      const response = await gatewayFetch('/missing');
      expect(response.status).toBe(404);
    });

    it('rejects with NotInHarnessStoreError without the Gateway variables', async () => {
      stubLaunchEnv({ HARNESS_GATEWAY_URL: base });
      await expect(gatewayFetch('/models')).rejects.toThrow(NotInHarnessStoreError);
    });
  });
});
