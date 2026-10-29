/**
 * The fake Provider through real clients: the OpenAI SDK (what Harnesses use against the Gateway)
 * and the Vercel AI SDK `openai-compatible` adapter (what the Gateway uses against Providers).
 * Both must treat it like a real OpenAI-compatible vendor.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, generateText, jsonSchema, streamText, tool } from 'ai';
import OpenAI from 'openai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeProvider } from '../src/testing/fake-provider.js';
import type { FakeProvider } from '../src/testing/fake-provider.js';

let fake: FakeProvider;

beforeAll(async () => {
  fake = await startFakeProvider({ apiKey: 'sk-fake' });
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.reset();
});

describe('OpenAI SDK', () => {
  const client = () => new OpenAI({ baseURL: fake.url, apiKey: 'sk-fake', maxRetries: 0 });

  it('consumes a fake/echo-stream stream, usage chunk included', async () => {
    const stream = await client().chat.completions.create({
      model: 'fake/echo-stream',
      messages: [{ role: 'user', content: 'Stream me some words' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = '';
    let finish: string | null = null;
    let usage: OpenAI.CompletionUsage | null | undefined;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? '';
      finish = chunk.choices[0]?.finish_reason ?? finish;
      usage = chunk.usage ?? usage;
    }
    expect(text).toBe('Stream me some words');
    expect(finish).toBe('stop');
    expect(usage).toMatchObject({ prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 });
  });

  it('reads a fake/tool-call completion', async () => {
    const completion = await client().chat.completions.create({
      model: 'fake/tool-call',
      messages: [{ role: 'user', content: 'Weather in Paris' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: { type: 'object', properties: {} } },
        },
      ],
    });
    const [choice] = completion.choices;
    expect(choice?.finish_reason).toBe('tool_calls');
    expect(choice?.message.tool_calls).toEqual([
      {
        id: 'call_0',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"input":"Weather in Paris"}' },
      },
    ]);
  });

  it.each([
    ['fake/500', 500, null],
    ['fake/rate-limited', 429, 'rate_limit_exceeded'],
  ])('maps %s to an APIError with status %i', async (model, status, code) => {
    const failure = client().chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'Hi' }],
    });
    await expect(failure).rejects.toBeInstanceOf(OpenAI.APIError);
    await expect(failure).rejects.toMatchObject({ status, code });
  });

  it('gets 401 with the wrong key', async () => {
    const wrong = new OpenAI({ baseURL: fake.url, apiKey: 'sk-wrong', maxRetries: 0 });
    await expect(wrong.models.list()).rejects.toBeInstanceOf(OpenAI.AuthenticationError);
  });

  it('lists models', async () => {
    const ids: string[] = [];
    for await (const model of client().models.list()) ids.push(model.id);
    expect(ids).toContain('fake/echo');
  });
});

describe('AI SDK openai-compatible adapter', () => {
  const model = (name: string) =>
    createOpenAICompatible({
      name: 'fake',
      baseURL: fake.url,
      apiKey: 'sk-fake',
      includeUsage: true,
    })(name);

  it('generates text with usage from fake/echo', async () => {
    const result = await generateText({
      model: model('fake/echo'),
      prompt: 'Echo these four words',
      maxRetries: 0,
    });
    expect(result.text).toBe('Echo these four words');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toMatchObject({ inputTokens: 4, outputTokens: 4, totalTokens: 8 });
    // The adapter sent the Connection key upstream.
    expect(fake.requests[0]?.headers.authorization).toBe('Bearer sk-fake');
  });

  it('streams text with usage from fake/echo-stream', async () => {
    const result = streamText({
      model: model('fake/echo-stream'),
      prompt: 'Stream these words please',
      maxRetries: 0,
    });
    let text = '';
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe('Stream these words please');
    expect(await result.usage).toMatchObject({ inputTokens: 4, outputTokens: 4 });
    expect(fake.requests[0]?.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('reports unknown token counts for fake/stream-no-usage', async () => {
    const result = streamText({
      model: model('fake/stream-no-usage'),
      prompt: 'No usage here',
      maxRetries: 0,
    });
    let text = '';
    for await (const delta of result.textStream) text += delta;
    expect(text).toBe('No usage here');
    const usage = await result.usage;
    expect(usage.inputTokens).toBeUndefined();
    expect(usage.outputTokens).toBeUndefined();
  });

  it.each([false, true])(
    'returns parallel tool calls from fake/tool-call-parallel (stream: %s)',
    async (stream) => {
      const tools = {
        get_weather: tool({
          description: 'Weather for a city',
          inputSchema: jsonSchema<{ input: string }>({
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
          }),
        }),
        get_time: tool({
          inputSchema: jsonSchema<{ input: string }>({
            type: 'object',
            properties: { input: { type: 'string' } },
          }),
        }),
      };
      const options = {
        model: model('fake/tool-call-parallel'),
        prompt: 'Weather and time in Paris',
        tools,
        maxRetries: 0,
      };
      const { toolCalls, finishReason } = stream
        ? await (async () => {
            const result = streamText(options);
            await result.consumeStream();
            return { toolCalls: await result.toolCalls, finishReason: await result.finishReason };
          })()
        : await generateText(options);
      expect(finishReason).toBe('tool-calls');
      expect(
        toolCalls.map((call) => ({ id: call.toolCallId, name: call.toolName, input: call.input })),
      ).toEqual([
        { id: 'call_0', name: 'get_weather', input: { input: 'Weather and time in Paris' } },
        { id: 'call_1', name: 'get_time', input: { input: 'Weather and time in Paris' } },
      ]);
      // The tool definitions reached the Provider as OpenAI function tools.
      expect(fake.requests[0]?.body).toMatchObject({
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', description: 'Weather for a city' },
          },
          { type: 'function', function: { name: 'get_time' } },
        ],
      });
    },
  );

  it('sends image parts that fake/vision accepts', async () => {
    // Image bytes, not a URL: the AI SDK downloads URLs it thinks the model cannot fetch, and
    // these tests never touch the network.
    const result = await generateText({
      model: model('fake/vision'),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'file', data: new Uint8Array([137, 80, 78, 71]), mediaType: 'image/png' },
          ],
        },
      ],
      maxRetries: 0,
    });
    expect(result.text).toBe('I see 1 image.');
    expect(fake.requests[0]?.body).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } },
          ],
        },
      ],
    });
  });

  it.each([
    ['fake/500', 500],
    ['fake/rate-limited', 429],
  ])('surfaces %s as an APICallError with status %i', async (name, status) => {
    const failure = generateText({ model: model(name), prompt: 'Hi', maxRetries: 0 });
    await expect(failure).rejects.toSatisfy(
      (error: unknown) => APICallError.isInstance(error) && error.statusCode === status,
    );
  });
});
