/**
 * A one-off OpenAI-compatible upstream for wire behaviours the fake Provider has no scenario for
 * (an in-stream error frame, argument JSON with whitespace, a tool call with empty or whitespace-only arguments): each
 * test scripts the exact bytes the "Provider" answers.
 */
import { serveLoopback } from '../../src/serve.js';

/** What the upstream answers: SSE `data:` payloads (then `[DONE]`), or a JSON body. */
export type ScriptedReply = { sse: unknown[]; done?: boolean } | { json: unknown };

export interface ScriptedUpstream {
  /** The `/v1` base URL. */
  url: string;
  close(): Promise<void>;
}

/** A `chat.completion.chunk` carrying `delta`, as an OpenAI-compatible Provider streams it. */
export function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: 'chatcmpl-scripted',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'scripted',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** Serves `reply(body)` to every `POST /v1/chat/completions`. */
export async function startScriptedUpstream(
  reply: (body: Record<string, unknown>) => ScriptedReply,
): Promise<ScriptedUpstream> {
  const server = await serveLoopback(
    async (request) => {
      const answer = reply((await request.json()) as Record<string, unknown>);
      if ('json' in answer) return Response.json(answer.json);
      const events = answer.sse.map((data) => `data: ${JSON.stringify(data)}\n\n`);
      if (answer.done !== false) events.push('data: [DONE]\n\n');
      return new Response(events.join(''), { headers: { 'content-type': 'text/event-stream' } });
    },
    { host: '127.0.0.1', port: 0 },
  );
  return { url: `${server.origin}/v1`, close: () => server.close() };
}
