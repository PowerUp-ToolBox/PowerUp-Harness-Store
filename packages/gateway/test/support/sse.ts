/** Reading OpenAI-style server-sent events in tests. */

export interface SseBody {
  /** The parsed `data:` payloads, `[DONE]` excluded. */
  chunks: Record<string, unknown>[];
  /** Whether the stream ended with `data: [DONE]`. */
  done: boolean;
}

/** Parses a complete SSE body (`data: {...}` events separated by blank lines). */
export function parseSse(text: string): SseBody {
  const chunks: Record<string, unknown>[] = [];
  let done = false;
  for (const event of text.split('\n\n')) {
    if (event.trim() === '') continue;
    const data = event
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .join('\n');
    if (data === '[DONE]') done = true;
    else chunks.push(JSON.parse(data) as Record<string, unknown>);
  }
  return { chunks, done };
}

/** Reads `response` to the end and parses it as SSE. */
export async function readSse(response: Response): Promise<SseBody> {
  return parseSse(await response.text());
}

/** The first choice's delta of each chunk that has one. */
export function deltas(body: SseBody): Record<string, unknown>[] {
  return body.chunks.flatMap((chunk) => {
    const [choice] = chunk.choices as { delta: Record<string, unknown> }[];
    return choice ? [choice.delta] : [];
  });
}

/** The streamed text: every delta's `content` joined. */
export function textOf(body: SseBody): string {
  return deltas(body)
    .map((delta) => (typeof delta.content === 'string' ? delta.content : ''))
    .join('');
}

/** Reads from `reader` until `text` has arrived; returns everything read so far. */
export async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  text: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let received = '';
  while (!received.includes(text)) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`Stream ended before ${JSON.stringify(text)}: ${received}`);
    received += decoder.decode(value, { stream: true });
  }
  return received;
}
