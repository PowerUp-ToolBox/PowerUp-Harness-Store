/**
 * The inbound OpenAI Chat Completions request (gateway-protocol.md §3), validated. Objects are
 * loose: fields the Gateway does not support are ignored, never rejected, so a newer SDK cannot
 * break a Harness. A supported field with the wrong type is rejected.
 */
import { z } from 'zod';

const textPart = z.looseObject({ type: z.literal('text'), text: z.string() });

/**
 * A base64 data URL of an image: `data:image/<subtype>[;<parameter>...];base64,<data>`. Any other
 * data URL would reach the Provider as another modality (a PDF, audio, video), and data the AI SDK
 * cannot decode would fail inside the upstream call instead of as a 400.
 */
const IMAGE_DATA_URL = /^data:image\/[\w.+-]+(?:;[^;,]+)*;base64,([\w+/-]*)(={0,2})$/i;

/** Whether `url` is an image data URL whose data `atob` decodes (the AI SDK accepts base64url too). */
function isImageDataUrl(url: string): boolean {
  const [, data = '', padding = ''] = IMAGE_DATA_URL.exec(url) ?? [];
  if (data === '') return false;
  return padding === '' ? data.length % 4 !== 1 : (data.length + padding.length) % 4 === 0;
}

const imagePart = z.looseObject({
  type: z.literal('image_url'),
  image_url: z.looseObject({
    url: z
      .string()
      .refine(
        (url) => /^https?:\/\//i.test(url) || isImageDataUrl(url),
        'expected an http(s) URL or a base64 data URL of an image',
      ),
  }),
});

/** Text only: a string or text parts. */
const textContent = z.union([z.string(), z.array(textPart)]);

const toolCall = z.looseObject({
  id: z.string().min(1),
  type: z.literal('function').optional(),
  function: z.looseObject({ name: z.string().min(1), arguments: z.string() }),
});

const message = z.discriminatedUnion('role', [
  z.looseObject({ role: z.literal('system'), content: textContent }),
  z.looseObject({ role: z.literal('developer'), content: textContent }),
  z.looseObject({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(z.discriminatedUnion('type', [textPart, imagePart]))]),
  }),
  z.looseObject({
    role: z.literal('assistant'),
    content: textContent.nullish(),
    tool_calls: z.array(toolCall).nullish(),
  }),
  z.looseObject({ role: z.literal('tool'), content: textContent, tool_call_id: z.string().min(1) }),
]);

const functionTool = z.looseObject({
  type: z.literal('function'),
  function: z.looseObject({
    name: z.string().min(1),
    description: z.string().nullish(),
    parameters: z.record(z.string(), z.unknown()).nullish(),
  }),
});

const toolChoice = z.union([
  z.enum(['none', 'auto', 'required']),
  z.looseObject({
    type: z.literal('function'),
    function: z.looseObject({ name: z.string().min(1) }),
  }),
]);

const responseFormat = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('text') }),
  z.looseObject({ type: z.literal('json_object') }),
  z.looseObject({
    type: z.literal('json_schema'),
    json_schema: z.looseObject({
      name: z.string().min(1),
      description: z.string().nullish(),
      schema: z.record(z.string(), z.unknown()).nullish(),
    }),
  }),
]);

const tokenLimit = z.number().int().positive().nullish();

/**
 * The fields of gateway-protocol.md §3. `user` and `metadata` are listed there as ignored, so they
 * are not checked either.
 */
const chatCompletionRequest = z.looseObject({
  model: z.string().min(1),
  messages: z.array(message).min(1),
  tools: z.array(functionTool).nullish(),
  tool_choice: toolChoice.nullish(),
  temperature: z.number().nullish(),
  top_p: z.number().nullish(),
  max_tokens: tokenLimit,
  max_completion_tokens: tokenLimit,
  stop: z.union([z.string(), z.array(z.string())]).nullish(),
  stream: z.boolean().nullish(),
  stream_options: z.looseObject({ include_usage: z.boolean().nullish() }).nullish(),
  response_format: responseFormat.nullish(),
  seed: z.number().int().nullish(),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequest>;
export type ChatMessage = ChatCompletionRequest['messages'][number];

export type ParseResult =
  | { ok: true; request: ChatCompletionRequest }
  /** `message` names the offending fields; the caller answers 400 `invalid_request`. */
  | { ok: false; message: string };

/** How many validation problems a 400 message lists. */
const MAX_LISTED_ISSUES = 3;

/** Validates a request body (already known to be a JSON object). */
export function parseChatCompletionRequest(body: Record<string, unknown>): ParseResult {
  const result = chatCompletionRequest.safeParse(body);
  if (result.success) return { ok: true, request: result.data };
  const issues = result.error.issues
    .slice(0, MAX_LISTED_ISSUES)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'body'}: ${issue.message}`);
  return { ok: false, message: `Invalid request: ${issues.join('; ')}.` };
}
