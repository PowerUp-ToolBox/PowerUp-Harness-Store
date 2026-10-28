/**
 * Outbound streaming: AI SDK stream parts to OpenAI `chat.completion.chunk` objects, sent as
 * server-sent events (gateway-protocol.md §3). One response is, in order: a chunk with
 * `delta.role`, the content and tool-call deltas, a chunk with `delta: {}` and the
 * `finish_reason`, the usage chunk (`choices: []`) when the Harness asked for it and the Provider
 * reported usage, then `data: [DONE]`.
 */
import type { TextStreamPart, ToolSet } from 'ai';
import type { GatewayErrorBody } from '../errors.js';
import { toFinishReason, toUsage } from './translate.js';
import type { OpenAiFinishReason, OpenAiUsage } from './translate.js';

/** One tool-call fragment, addressed by `index`; the first one of a call carries id and name. */
export interface ToolCallDelta {
  /** 0-based, in order of first appearance in the response. */
  index: number;
  id?: string;
  type?: 'function';
  function: { name?: string; arguments: string };
}

export interface ChunkDelta {
  role?: 'assistant';
  content?: string;
  tool_calls?: ToolCallDelta[];
}

/** A `chat.completion.chunk` object. */
export interface ChatCompletionChunk {
  /** The same `chatcmpl_<uuid>` on every chunk of one response. */
  id: string;
  object: 'chat.completion.chunk';
  /** Epoch seconds, the same on every chunk. */
  created: number;
  /** The resolved `provider/model`. */
  model: string;
  /** Empty only on the usage chunk. */
  choices: { index: 0; delta: ChunkDelta; finish_reason: OpenAiFinishReason | null }[];
  usage?: OpenAiUsage;
}

/** The text of one server-sent event carrying `data`. */
export function sseEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** The event that ends every stream. */
export const SSE_DONE = 'data: [DONE]\n\n';

/** The events that end a stream with an error: the error body, then `[DONE]`. */
export function sseError(body: GatewayErrorBody): string {
  return sseEvent(body) + SSE_DONE;
}

/** Turns the AI SDK stream parts of one response into OpenAI chunks. */
export class ChunkTranslator {
  readonly #id: string;
  readonly #created = Math.floor(Date.now() / 1000);
  readonly #model: string;
  readonly #includeUsage: boolean;
  /** The `index` of each tool call by its id, in order of first appearance. */
  readonly #toolIndex = new Map<string, number>();

  /**
   * @param id The response id, `chatcmpl_<uuid>`.
   * @param model The resolved `provider/model`.
   * @param includeUsage Whether the Harness set `stream_options.include_usage`.
   */
  constructor(id: string, model: string, includeUsage: boolean) {
    this.#id = id;
    this.#model = model;
    this.#includeUsage = includeUsage;
  }

  /** The first chunk of the response: `delta.role`. */
  start(): ChatCompletionChunk {
    return this.#chunk({ role: 'assistant' });
  }

  /** The chunks one stream part becomes; none for parts OpenAI has no equivalent of. */
  translate(part: TextStreamPart<ToolSet>): ChatCompletionChunk[] {
    switch (part.type) {
      case 'text-delta':
        return part.text === '' ? [] : [this.#chunk({ content: part.text })];
      case 'tool-input-start':
        return [this.#toolCall(part.id, part.toolName, '')];
      case 'tool-input-delta': {
        const index = this.#toolIndex.get(part.id);
        if (index === undefined || part.delta === '') return [];
        return [this.#chunk({ tool_calls: [{ index, function: { arguments: part.delta } }] })];
      }
      case 'tool-call':
        // Already streamed as fragments, unless the adapter only reports whole tool calls.
        if (this.#toolIndex.has(part.toolCallId)) return [];
        return [
          this.#toolCall(
            part.toolCallId,
            part.toolName,
            typeof part.input === 'string' ? part.input : JSON.stringify(part.input),
          ),
        ];
      case 'finish': {
        const chunks = [this.#chunk({}, toFinishReason(part.finishReason))];
        const usage = this.#includeUsage ? toUsage(part.totalUsage) : undefined;
        if (usage !== undefined) chunks.push({ ...this.#chunk({}), choices: [], usage });
        return chunks;
      }
      default:
        // Text and tool-input boundaries, reasoning, sources, step markers: nothing to send.
        return [];
    }
  }

  /** The first fragment of a tool call, which gets the next index. */
  #toolCall(id: string, name: string, args: string): ChatCompletionChunk {
    const index = this.#toolIndex.size;
    this.#toolIndex.set(id, index);
    return this.#chunk({
      tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }],
    });
  }

  #chunk(delta: ChunkDelta, finishReason: OpenAiFinishReason | null = null): ChatCompletionChunk {
    return {
      id: this.#id,
      object: 'chat.completion.chunk',
      created: this.#created,
      model: this.#model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
  }
}
