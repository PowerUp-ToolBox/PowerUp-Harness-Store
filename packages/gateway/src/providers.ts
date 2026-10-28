/**
 * Provider ids (gateway-protocol.md §6) and the explicit `provider/model` ids a Harness may send
 * as `model` instead of a Slot name.
 */

/** The AI SDK adapter a Provider's requests go through. */
export type AdapterKind = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'openai-compatible';

/**
 * One Provider of gateway-protocol.md §6: everything the Gateway needs to reach it and the desktop
 * app needs to offer it. A Provider that speaks the OpenAI wire format (a preset) is a row with
 * the `openai-compatible` adapter and nothing else: adding one never needs a code change.
 */
export interface ProviderInfo {
  /** The Provider id; `openai-compatible` also covers every `openai-compatible:<name>`. */
  id: string;
  displayName: string;
  adapter: AdapterKind;
  /** Where requests go unless the Connection names its own base URL; absent when it must. */
  baseUrl?: string;
  /** Whether a Connection needs an API key (Ollama and LM Studio need none). */
  requiresKey: boolean;
  /** Whether the Provider lists its models (`GET /models`), so the app can offer them. */
  supportsModelList: boolean;
  /** The Provider's own API documentation, for the User. */
  docsUrl: string;
  /** What the Provider's keys look like, for the key field's placeholder; `''` when unknown. */
  keyPlaceholder: string;
}

/** The table, typed literally so that {@link ProviderId} is the union of its ids. */
const TABLE = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    requiresKey: true,
    supportsModelList: false,
    docsUrl: 'https://docs.claude.com/en/api/overview',
    keyPlaceholder: 'sk-ant-...',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    adapter: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    requiresKey: true,
    supportsModelList: true,
    docsUrl: 'https://platform.openai.com/docs/api-reference',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'google',
    displayName: 'Google Gemini',
    adapter: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresKey: true,
    supportsModelList: false,
    docsUrl: 'https://ai.google.dev/gemini-api/docs/api-key',
    keyPlaceholder: 'AIza...',
  },
  {
    id: 'openrouter',
    displayName: 'OpenRouter',
    adapter: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    supportsModelList: true,
    docsUrl: 'https://openrouter.ai/docs/quickstart',
    keyPlaceholder: 'sk-or-v1-...',
  },
  {
    id: 'ollama',
    displayName: 'Ollama',
    adapter: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    requiresKey: false,
    supportsModelList: true,
    docsUrl: 'https://docs.ollama.com/api/openai-compatibility',
    keyPlaceholder: '',
  },
  {
    id: 'lmstudio',
    displayName: 'LM Studio',
    adapter: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    requiresKey: false,
    supportsModelList: true,
    docsUrl: 'https://lmstudio.ai/docs/developer/openai-compat',
    keyPlaceholder: '',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresKey: true,
    supportsModelList: true,
    docsUrl: 'https://api-docs.deepseek.com/',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'qwen',
    displayName: 'Qwen (Alibaba Cloud Model Studio)',
    adapter: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    requiresKey: true,
    supportsModelList: true,
    docsUrl: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'moonshot',
    displayName: 'Moonshot AI (Kimi)',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    requiresKey: true,
    supportsModelList: true,
    docsUrl: 'https://platform.moonshot.cn/docs/api/chat',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'zhipu',
    displayName: 'Zhipu AI (GLM)',
    adapter: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    requiresKey: true,
    supportsModelList: false,
    docsUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    keyPlaceholder: '',
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.minimax.cn/v1',
    requiresKey: true,
    supportsModelList: false,
    docsUrl: 'https://platform.minimaxi.com/docs/guides/text-generation',
    keyPlaceholder: '',
  },
  {
    id: 'doubao',
    displayName: 'Doubao (Volcengine Ark)',
    adapter: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    requiresKey: true,
    supportsModelList: false,
    docsUrl: 'https://www.volcengine.com/docs/82379/1330626',
    keyPlaceholder: '',
  },
  {
    id: 'groq',
    displayName: 'Groq',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresKey: true,
    supportsModelList: true,
    docsUrl: 'https://console.groq.com/docs/openai',
    keyPlaceholder: 'gsk_...',
  },
  {
    id: 'openai-compatible',
    displayName: 'OpenAI-compatible endpoint',
    adapter: 'openai-compatible',
    requiresKey: false,
    supportsModelList: true,
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    keyPlaceholder: '',
  },
] as const satisfies readonly ProviderInfo[];

/**
 * Every Provider of gateway-protocol.md §6, in the order of its table. Preset base URLs are the
 * mainland-China endpoints where a vendor has two; a Connection's base URL overrides them (an
 * international account, Ollama on another port).
 */
export const PROVIDERS: readonly ProviderInfo[] = TABLE;

export type ProviderId = (typeof TABLE)[number]['id'];

/** Every Provider id of gateway-protocol.md §6, in the order of its table. */
export const PROVIDER_IDS: readonly ProviderId[] = TABLE.map((provider) => provider.id);

/**
 * The row of `providers` serving `providerId`: the one whose id is the part before any `:`
 * (`openai-compatible:vllm` is served by `openai-compatible`); `undefined` when there is none.
 */
export function findProvider(
  providerId: string,
  providers: readonly ProviderInfo[] = PROVIDERS,
): ProviderInfo | undefined {
  const [base] = providerId.split(':');
  return providers.find((provider) => provider.id === base);
}

/** A named `openai-compatible` endpoint: `openai-compatible:<name>`. */
const NAMED_OPENAI_COMPATIBLE = /^openai-compatible:[a-z0-9][a-z0-9-]*$/;

/**
 * Whether `id` names a Provider: one of {@link PROVIDER_IDS}, or `openai-compatible:<name>` with
 * a lower-case slug name.
 */
export function isProviderId(id: string): boolean {
  return (PROVIDER_IDS as readonly string[]).includes(id) || NAMED_OPENAI_COMPATIBLE.test(id);
}

/** What a request's `model` asks for. */
export type ModelRef =
  /** An explicit `provider/model` id. */
  | { kind: 'explicit'; providerId: string; model: string }
  /** A Model Slot name, resolved through the Harness's Slot Bindings. */
  | { kind: 'slot'; slot: string };

/**
 * Reads a request's `model`. A value containing `/` is an explicit id, split at the first `/`:
 * the Provider part must be a Provider id and the model part non-empty without whitespace
 * (`openrouter/anthropic/claude-sonnet-4-5` keeps `anthropic/claude-sonnet-4-5` as the model).
 * Anything else is a Slot name; Slot names never contain `/`, so the two forms cannot overlap.
 * Returns `null` for a malformed explicit id.
 */
export function parseModelRef(model: string): ModelRef | null {
  const slash = model.indexOf('/');
  if (slash === -1) return { kind: 'slot', slot: model };
  const providerId = model.slice(0, slash);
  const name = model.slice(slash + 1);
  if (!isProviderId(providerId) || !/^\S+$/.test(name)) return null;
  return { kind: 'explicit', providerId, model: name };
}
