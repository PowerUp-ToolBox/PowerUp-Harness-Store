/**
 * The conformance suite against real Providers, through the Gateway HTTP seam: text, streaming
 * and tool-call scenarios (error, timeout, no-usage and vision scenarios stay with the fake, in
 * `conformance.test.ts`). Each Provider's tests run only when its variables are set, and are
 * reported as skipped otherwise, so `pnpm test` never needs a key and never spends money. Only
 * these prefixed variables are read, never a developer's own `OPENAI_API_KEY` and the like:
 *
 * - `CONFORMANCE_ANTHROPIC_API_KEY` (model: `CONFORMANCE_ANTHROPIC_MODEL`, default
 *   `claude-haiku-4-5`)
 * - `CONFORMANCE_OPENAI_API_KEY` (model: `CONFORMANCE_OPENAI_MODEL`, default `gpt-4.1-mini`)
 * - `CONFORMANCE_OPENAI_COMPATIBLE_BASE_URL` and `CONFORMANCE_OPENAI_COMPATIBLE_MODEL`, with
 *   `CONFORMANCE_OPENAI_COMPATIBLE_API_KEY` when the endpoint needs one
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectionSecret, Gateway } from '../src/index.js';
import { claims, startGateway } from './support/gateway.js';
import { allowNetwork } from './support/offline.js';
import { deltas, readSse, textOf } from './support/sse.js';

const env = (name: string): string | undefined => {
  const value = process.env[`CONFORMANCE_${name}`];
  return value === undefined || value === '' ? undefined : value;
};

interface LiveProvider {
  providerId: string;
  model: string;
  /** `undefined` when the variables are not set: the Provider's tests are skipped. */
  connection: ConnectionSecret | undefined;
}

const anthropicKey = env('ANTHROPIC_API_KEY');
const openaiKey = env('OPENAI_API_KEY');
const compatibleBaseUrl = env('OPENAI_COMPATIBLE_BASE_URL');
const compatibleKey = env('OPENAI_COMPATIBLE_API_KEY');
const compatibleModel = env('OPENAI_COMPATIBLE_MODEL');

const LIVE: LiveProvider[] = [
  {
    providerId: 'anthropic',
    model: env('ANTHROPIC_MODEL') ?? 'claude-haiku-4-5',
    connection: anthropicKey === undefined ? undefined : { apiKey: anthropicKey },
  },
  {
    providerId: 'openai',
    model: env('OPENAI_MODEL') ?? 'gpt-4.1-mini',
    connection: openaiKey === undefined ? undefined : { apiKey: openaiKey },
  },
  {
    providerId: 'openai-compatible:live',
    model: compatibleModel ?? '',
    connection:
      compatibleBaseUrl === undefined || compatibleModel === undefined
        ? undefined
        : {
            baseUrl: compatibleBaseUrl,
            ...(compatibleKey !== undefined && { apiKey: compatibleKey }),
          },
  },
];

const ask = [{ role: 'user', content: 'Reply with exactly one word: pong' }];

const weather = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Gets the current weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
};

interface Completion {
  model: string;
  choices: {
    message: {
      content: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
    finish_reason: string;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

describe.each(LIVE)('live conformance: $providerId', ({ providerId, model, connection }) => {
  let gateway: Gateway | undefined;
  let url: string;
  let token: string;

  beforeAll(async () => {
    if (connection === undefined) return;
    allowNetwork();
    const started = await startGateway({
      getConnection: (id) => Promise.resolve(id === providerId ? connection : null),
    });
    gateway = started.gateway;
    url = started.url;
    token = started.gateway.issueToken(claims());
  });

  afterAll(async () => {
    await gateway?.close();
  });

  const complete = (body: Record<string, unknown>) =>
    fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: `${providerId}/${model}`, ...body }),
    });

  it.skipIf(connection === undefined)('answers a non-streaming text completion', async () => {
    const response = await complete({ messages: ask, max_tokens: 20 });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as Completion;
    expect(body.model).toBe(`${providerId}/${model}`);
    expect(body.choices[0]?.message.content?.toLowerCase()).toContain('pong');
    expect(body.choices[0]?.finish_reason).toBe('stop');
    expect(body.usage?.prompt_tokens).toBeGreaterThan(0);
    expect(body.usage?.completion_tokens).toBeGreaterThan(0);
  });

  it.skipIf(connection === undefined)('streams a text completion with usage', async () => {
    const response = await complete({
      messages: ask,
      max_tokens: 20,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await readSse(response);
    expect(body.done).toBe(true);
    expect(deltas(body)[0]).toEqual({ role: 'assistant' });
    expect(textOf(body).toLowerCase()).toContain('pong');
    const finishes = body.chunks.flatMap(
      (chunk) => (chunk.choices as { finish_reason: string | null }[] | undefined) ?? [],
    );
    expect(finishes.at(-1)?.finish_reason).toBe('stop');
    // A Provider that reports no usage gets no usage chunk; the ones under test all report it.
    const usage = body.chunks.at(-1) as { choices: unknown[]; usage?: Completion['usage'] };
    expect(usage.choices).toEqual([]);
    expect(usage.usage?.completion_tokens).toBeGreaterThan(0);
  });

  it.skipIf(connection === undefined)('returns a forced tool call', async () => {
    const response = await complete({
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      tools: [weather],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      max_tokens: 100,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const [choice] = ((await response.json()) as Completion).choices;
    expect(choice?.finish_reason).toBe('tool_calls');
    const [call] = choice?.message.tool_calls ?? [];
    expect(call?.function.name).toBe('get_weather');
    expect(JSON.parse(call?.function.arguments ?? '{}')).toHaveProperty('city');
  });

  it.skipIf(connection === undefined)('streams a forced tool call', async () => {
    const response = await complete({
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      tools: [weather],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      max_tokens: 100,
      stream: true,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await readSse(response);
    const fragments = deltas(body).flatMap(
      (delta) =>
        (delta.tool_calls as { function: { name?: string; arguments?: string } }[] | undefined) ??
        [],
    );
    expect(fragments[0]?.function.name).toBe('get_weather');
    const args = fragments.map((fragment) => fragment.function.arguments ?? '').join('');
    expect(JSON.parse(args)).toHaveProperty('city');
    expect(body.done).toBe(true);
  });
});
