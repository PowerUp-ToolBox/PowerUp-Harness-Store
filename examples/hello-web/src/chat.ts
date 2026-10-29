/**
 * `POST /chat`, the page's backend: takes `{ messages: [{ role, content }] }` (the page keeps the
 * conversation; this server holds no state), sends it to the Model Gateway on the `default` Model
 * Slot with streaming on, and answers `200 text/event-stream` with these events:
 *
 * - `token` `{ "text" }`: the next piece of the answer;
 * - `done` `{ "model" }`: the answer is complete; `model` is the `provider/model` that wrote it,
 *   as the Gateway reports it in every chunk;
 * - `error` `{ "code", "message" }`: no answer, or not all of it; `code` is the Gateway's error
 *   code (`slot_unbound` when no model is bound to the Slot), which the page turns into a message
 *   in its language.
 *
 * When the page goes away mid-answer, the Gateway call is aborted, and the Gateway aborts its own
 * call to the Provider.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Slots, SlotUnboundError } from '@harness-store/sdk';
import type { createOpenAIClient } from '@harness-store/sdk';

/** Larger request bodies get 413: a chat page's conversation is far smaller. */
const MAX_BODY_BYTES = 1024 * 1024;

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** The OpenAI client pointed at the Model Gateway, from `createOpenAIClient()`. */
  readonly client: ReturnType<typeof createOpenAIClient>;
  /** `HARNESS_PORT`, for the `Host` check. */
  readonly port: number;
}

export async function relayChat(
  request: IncomingMessage,
  response: ServerResponse,
  { client, port }: ChatOptions,
): Promise<void> {
  // Only this Harness's own page may call: a page on another site cannot send JSON here without a
  // preflight this server never answers, and a rebound DNS name arrives with the wrong Host.
  if (!isOwnHost(request.headers.host, port)) {
    refuse(response, 403, 'invalid_host', 'Host must be 127.0.0.1 or localhost on this port');
    return;
  }
  if (!isJson(request.headers['content-type'])) {
    refuse(response, 415, 'invalid_request', 'Content-Type must be application/json');
    return;
  }
  let body: string;
  try {
    body = await readBody(request);
  } catch (error) {
    if (error instanceof TooLargeError) {
      refuse(response, 413, 'invalid_request', 'The request body is too large');
      return;
    }
    // The page went away while sending; there is no one to answer.
    response.destroy();
    return;
  }
  const messages = parseMessages(body);
  if (messages === undefined) {
    refuse(
      response,
      400,
      'invalid_request',
      'Expected { "messages": [{ "role": "user" | "assistant", "content": string }, ...] }',
    );
    return;
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.flushHeaders();
  const send = (event: string, data: object) => {
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const controller = new AbortController();
  response.on('close', () => {
    if (!response.writableFinished) controller.abort();
  });
  try {
    const stream = await client.chat.completions.create(
      { model: Slots.default, messages, stream: true },
      { signal: controller.signal },
    );
    let model = '';
    for await (const chunk of stream) {
      model = chunk.model || model;
      const text = chunk.choices[0]?.delta.content;
      if (text) send('token', { text });
    }
    send('done', { model });
  } catch (error) {
    if (!controller.signal.aborted) send('error', describe(error));
  } finally {
    response.end();
  }
}

/** A Gateway error as the page needs it: its code, and the Gateway's message. */
function describe(error: unknown): { code: string; message: string } {
  const unbound = SlotUnboundError.from(error);
  if (unbound !== undefined) {
    const slot = unbound.slot || Slots.default;
    return {
      code: 'slot_unbound',
      message: `No model is bound to the Model Slot "${slot}". Bind one on the Models page of Harness Store.`,
    };
  }
  const record = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    error?: { code?: unknown };
  };
  const code =
    typeof record.code === 'string'
      ? record.code
      : typeof record.error?.code === 'string'
        ? record.error.code
        : 'unknown';
  return { code, message: error instanceof Error ? error.message : String(error) };
}

function refuse(response: ServerResponse, status: number, code: string, message: string): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: { code, message } }));
}

function isOwnHost(host: string | undefined, port: number): boolean {
  const value = host?.toLowerCase();
  return value === `127.0.0.1:${String(port)}` || value === `localhost:${String(port)}`;
}

function isJson(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

class TooLargeError extends Error {}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new TooLargeError());
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
    request.on('close', () => {
      if (!request.complete) reject(new Error('The request was aborted'));
    });
  });
}

/** The conversation from a `/chat` body, `undefined` when it is not one. */
function parseMessages(body: string): Message[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { messages } = value as { messages?: unknown };
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const parsed: Message[] = [];
  for (const message of messages as unknown[]) {
    if (typeof message !== 'object' || message === null) return undefined;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return undefined;
    parsed.push({ role, content });
  }
  return parsed;
}
