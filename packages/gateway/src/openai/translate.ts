/**
 * Translation between the OpenAI Chat Completions wire format and the Vercel AI SDK, kept apart
 * from the HTTP layer so another inbound protocol (Anthropic Messages, P1-03) can sit beside it.
 *
 * Inbound, exactly the fields of gateway-protocol.md §3 are forwarded; everything else (`n`,
 * penalties, `logprobs`, `parallel_tool_calls`, vendor extras) is dropped. Outbound, the AI SDK
 * result becomes an OpenAI `chat.completion` object.
 */
import { jsonSchema, tool } from 'ai';
import type {
  AssistantModelMessage,
  FinishReason,
  LanguageModelUsage,
  ModelMessage,
  OutputInterface,
  ToolChoice,
  ToolSet,
  UserModelMessage,
} from 'ai';
import type { ChatCompletionRequest, ChatMessage } from './request.js';

/** The AI SDK call settings one Chat Completions request translates to. */
export interface CallSettings {
  messages: ModelMessage[];
  tools?: ToolSet;
  /**
   * For the Provider only: the AI SDK enforces a tool choice it is given on the reply, while the
   * Gateway passes the Provider's reply through whether or not it honoured the choice.
   */
  toolChoice?: ToolChoice<ToolSet>;
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  seed?: number;
  /** Set for a JSON `response_format`; the reply text is returned as is, never parsed. */
  output?: OutputInterface<string, string, never>;
}

export type TranslateResult =
  | { ok: true; settings: CallSettings }
  /** The request is well-formed but inconsistent; the caller answers 400 `invalid_request`. */
  | { ok: false; message: string };

type TextContent = string | readonly { text: string }[];

function joinText(content: TextContent): string {
  return typeof content === 'string' ? content : content.map((part) => part.text).join('');
}

/**
 * Tool arguments as the AI SDK wants them: parsed JSON, or the raw string when it is not JSON (the
 * Provider then sees what the Harness sent, re-encoded as a JSON string).
 */
function parseArguments(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function userMessage(content: Extract<ChatMessage, { role: 'user' }>['content']): UserModelMessage {
  if (typeof content === 'string') return { role: 'user', content };
  return {
    role: 'user',
    content: content.map((part) => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      const { url } = part.image_url;
      // http(s) URLs pass through for the Provider to fetch; data URLs carry their media type,
      // which validation limited to image/*.
      if (/^data:/i.test(url)) {
        return { type: 'file', mediaType: /^data:([^;,]+)/i.exec(url)?.[1] ?? 'image', data: url };
      }
      const parsed = new URL(url);
      return { type: 'file', mediaType: imageMediaTypeOf(parsed), data: parsed };
    }),
  };
}

const IMAGE_EXTENSIONS = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['heic', 'image/heic'],
  ['heif', 'image/heif'],
]);

/**
 * The media type of an http(s) image, guessed from its path's extension, else `image/jpeg`. Some
 * adapters need a full media type for an image they hand over as a URL (Google's `fileData`,
 * OpenRouter's `image_url`); the Provider fetches the image and sees what it really is.
 */
function imageMediaTypeOf(url: URL): string {
  const extension = /\.([a-z0-9]+)$/i.exec(url.pathname)?.[1]?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.get(extension) ?? 'image/jpeg';
}

/**
 * The 400 message for a tool call still waiting for its result, or `undefined` when none is.
 * `before` is the index of the message that arrived too early; absent at the end of `messages`.
 */
function missingToolResult(open: ReadonlyMap<string, number>, before?: number): string | undefined {
  const first = open.entries().next();
  if (first.done === true) return undefined;
  const [id, index] = first.value;
  const where =
    before === undefined ? 'by the end of messages' : `before messages.${String(before)}`;
  return `messages.${String(index)}: tool call ${id} has no tool result ${where}.`;
}

/**
 * Translates the messages. Tool calls and results must pair up the way the AI SDK requires: each
 * `tool` message answers an earlier assistant tool call, and every tool call is answered before
 * the next user or system message and before the end of `messages` (OpenAI rejects the same).
 */
function toMessages(messages: readonly ChatMessage[]): ModelMessage[] | string {
  /** Tool names by tool call id, from the assistant messages seen so far. */
  const toolNames = new Map<string, string>();
  /** The index of the assistant message for each tool call not yet answered, in call order. */
  const open = new Map<string, number>();
  const result: ModelMessage[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system' || message.role === 'developer' || message.role === 'user') {
      const missing = missingToolResult(open, index);
      if (missing !== undefined) return missing;
    }
    switch (message.role) {
      case 'system':
      case 'developer':
        result.push({ role: 'system', content: joinText(message.content) });
        break;
      case 'user':
        try {
          result.push(userMessage(message.content));
        } catch {
          return `messages.${String(index)}: an image_url is not a valid URL.`;
        }
        break;
      case 'assistant': {
        const content: Exclude<AssistantModelMessage['content'], string> = [];
        const text = message.content == null ? '' : joinText(message.content);
        if (text !== '') content.push({ type: 'text', text });
        for (const call of message.tool_calls ?? []) {
          toolNames.set(call.id, call.function.name);
          open.set(call.id, index);
          content.push({
            type: 'tool-call',
            toolCallId: call.id,
            toolName: call.function.name,
            input: parseArguments(call.function.arguments),
          });
        }
        result.push({ role: 'assistant', content });
        break;
      }
      case 'tool': {
        const toolName = toolNames.get(message.tool_call_id);
        if (toolName === undefined) {
          return `messages.${String(index)}: tool_call_id ${message.tool_call_id} matches no earlier assistant tool call.`;
        }
        open.delete(message.tool_call_id);
        result.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: message.tool_call_id,
              toolName,
              output: { type: 'text', value: joinText(message.content) },
            },
          ],
        });
        break;
      }
    }
  }
  return missingToolResult(open) ?? result;
}

/** A JSON response format whose output is the raw reply text: invalid JSON is never an error. */
function rawJsonOutput(
  format: Exclude<NonNullable<ChatCompletionRequest['response_format']>, { type: 'text' }>,
): OutputInterface<string, string, never> {
  const schema = format.type === 'json_schema' ? format.json_schema : undefined;
  return {
    name: 'json',
    responseFormat: Promise.resolve({
      type: 'json',
      ...(schema?.schema != null && { schema: schema.schema }),
      ...(schema !== undefined && { name: schema.name }),
      ...(schema?.description != null && { description: schema.description }),
    }),
    parseCompleteOutput: ({ text }) => Promise.resolve(text),
    parsePartialOutput: ({ text }) => Promise.resolve({ partial: text }),
    createElementStreamTransform: () => undefined,
  };
}

const EMPTY_PARAMETERS = { type: 'object', properties: {} } as const;

/** Translates a validated request into AI SDK call settings. */
export function toCallSettings(request: ChatCompletionRequest): TranslateResult {
  const messages = toMessages(request.messages);
  if (typeof messages === 'string') return { ok: false, message: messages };

  const settings: CallSettings = { messages };
  if (request.tools != null && request.tools.length > 0) {
    // No `execute`: the Gateway never runs a tool, so each call is a single step.
    settings.tools = Object.fromEntries(
      request.tools.map(({ function: fn }) => [
        fn.name,
        tool({
          ...(fn.description != null && { description: fn.description }),
          inputSchema: jsonSchema(fn.parameters ?? EMPTY_PARAMETERS),
        }),
      ]),
    );
  }
  const choice = request.tool_choice;
  if (choice != null) {
    const toolNames = new Set(request.tools?.map((entry) => entry.function.name));
    if (typeof choice !== 'string' && !toolNames.has(choice.function.name)) {
      return {
        ok: false,
        message: `tool_choice: the function ${choice.function.name} is not in tools.`,
      };
    }
    if (choice === 'required' && toolNames.size === 0) {
      return { ok: false, message: 'tool_choice: "required" needs at least one tool in tools.' };
    }
    settings.toolChoice =
      typeof choice === 'string' ? choice : { type: 'tool', toolName: choice.function.name };
  }
  if (request.temperature != null) settings.temperature = request.temperature;
  if (request.top_p != null) settings.topP = request.top_p;
  const maxTokens = request.max_completion_tokens ?? request.max_tokens;
  if (maxTokens != null) settings.maxOutputTokens = maxTokens;
  if (request.stop != null) {
    settings.stopSequences = typeof request.stop === 'string' ? [request.stop] : request.stop;
  }
  if (request.seed != null) settings.seed = request.seed;
  const format = request.response_format;
  if (format != null && format.type !== 'text') settings.output = rawJsonOutput(format);
  return { ok: true, settings };
}

/** OpenAI's finish reasons. */
export type OpenAiFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export function toFinishReason(reason: FinishReason): OpenAiFinishReason {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool-calls':
      return 'tool_calls';
    case 'content-filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export interface OpenAiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
}

/**
 * OpenAI usage from the Provider's report; `undefined` unless the Provider reported both input
 * and output tokens. Nothing is ever estimated. Cached prompt tokens appear only when there were
 * some: the `openai-compatible` adapter reports 0 when the Provider said nothing.
 */
export function toUsage(usage: LanguageModelUsage): OpenAiUsage | undefined {
  const { inputTokens, outputTokens } = usage;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cached = usage.inputTokenDetails.cacheReadTokens;
  return {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    ...(cached !== undefined && cached > 0 && { prompt_tokens_details: { cached_tokens: cached } }),
  };
}

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A non-streaming `chat.completion` object. */
export interface ChatCompletion {
  /** `chatcmpl_<uuid>`. */
  id: string;
  object: 'chat.completion';
  /** Epoch seconds. */
  created: number;
  /** The resolved `provider/model`. */
  model: string;
  choices: [
    {
      index: 0;
      message: { role: 'assistant'; content: string | null; tool_calls?: OpenAiToolCall[] };
      finish_reason: OpenAiFinishReason;
    },
  ];
  usage?: OpenAiUsage;
}

/** What the Gateway reads from a finished AI SDK call. */
export interface CallResult {
  text: string;
  toolCalls: readonly { toolCallId: string; toolName: string; input: unknown }[];
  finishReason: FinishReason;
  usage: LanguageModelUsage;
}

export function newCompletionId(): string {
  return `chatcmpl_${crypto.randomUUID()}`;
}

/** Assembles the `chat.completion` object. Reasoning output is dropped. */
export function toChatCompletion(result: CallResult, model: string): ChatCompletion {
  const toolCalls = result.toolCalls.map((call): OpenAiToolCall => ({
    id: call.toolCallId,
    type: 'function',
    function: {
      name: call.toolName,
      arguments: typeof call.input === 'string' ? call.input : JSON.stringify(call.input),
    },
  }));
  const usage = toUsage(result.usage);
  return {
    id: newCompletionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: result.text === '' && toolCalls.length > 0 ? null : result.text,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        finish_reason: toFinishReason(result.finishReason),
      },
    ],
    ...(usage !== undefined && { usage }),
  };
}
