import type { Binding } from '@harness-store/gateway';
import { describe, expect, it } from 'vitest';
import {
  declaredSlot,
  declaredSlots,
  recommendedTargets,
  resolveSlotBinding,
  type SlotResolutionInput,
} from '../../src/main/runtime/slot-resolver.js';
import type { BindingTarget, GlobalBinding } from '../../src/shared/ipc.js';
import { manifestWith } from '../support/manifest.js';

const DEFAULT: GlobalBinding = {
  slot: 'default',
  connectionId: 'anthropic',
  model: 'claude-sonnet',
};
const FAST: GlobalBinding = { slot: 'fast', connectionId: 'ollama', model: 'qwen3:8b' };
const ON_VLLM: GlobalBinding = {
  slot: 'default',
  connectionId: 'openai-compatible:vllm',
  model: 'meta/llama-4',
};
const BOTH_ENABLED = new Set(['anthropic', 'ollama']);

/** The resolution with no Model Override and no Recommended Models: only the Default Models. */
function defaultsOnly(
  slot: string,
  global: readonly GlobalBinding[],
  enabled: ReadonlySet<string> = BOTH_ENABLED,
): SlotResolutionInput {
  return { slot, override: null, recommended: [], global, enabledConnections: enabled };
}

const as = (binding: GlobalBinding, source: Binding['source']): Binding => ({
  providerId: binding.connectionId,
  model: binding.model,
  source,
});

describe('resolveSlotBinding: the Default Model tail', () => {
  it.each<{ case: string; input: SlotResolutionInput; expected: Binding | null }>([
    {
      case: 'no global bindings at all: unbound',
      input: defaultsOnly('default', []),
      expected: null,
    },
    {
      case: 'no global bindings, another Slot: unbound',
      input: defaultsOnly('fast', []),
      expected: null,
    },
    {
      case: '`default` bound, `default` asked: source default',
      input: defaultsOnly('default', [DEFAULT]),
      expected: as(DEFAULT, 'default'),
    },
    {
      case: 'only `default` bound, another Slot asked: falls through to `default`',
      input: defaultsOnly('summarize', [DEFAULT]),
      expected: as(DEFAULT, 'default'),
    },
    {
      case: '`fast` bound, `fast` asked: its own binding, source default_same_name',
      input: defaultsOnly('fast', [DEFAULT, FAST]),
      expected: as(FAST, 'default_same_name'),
    },
    {
      case: '`fast` bound, another Slot asked: `default`, not `fast`',
      input: defaultsOnly('summarize', [FAST, DEFAULT]),
      expected: as(DEFAULT, 'default'),
    },
    {
      case: '`fast` bound, `default` asked: `default`',
      input: defaultsOnly('default', [FAST, DEFAULT]),
      expected: as(DEFAULT, 'default'),
    },
    {
      case: 'only `fast` bound, `default` asked: unbound',
      input: defaultsOnly('default', [FAST]),
      expected: null,
    },
    {
      case: "`fast`'s Connection disabled: falls through to `default`",
      input: defaultsOnly('fast', [DEFAULT, FAST], new Set(['anthropic'])),
      expected: as(DEFAULT, 'default'),
    },
    {
      case: "`default`'s Connection disabled, `fast` asked: `fast` still binds",
      input: defaultsOnly('fast', [DEFAULT, FAST], new Set(['ollama'])),
      expected: as(FAST, 'default_same_name'),
    },
    {
      case: "`default`'s Connection disabled, another Slot asked: unbound",
      input: defaultsOnly('summarize', [DEFAULT, FAST], new Set(['ollama'])),
      expected: null,
    },
    {
      case: 'every Connection disabled or removed: unbound',
      input: defaultsOnly('fast', [DEFAULT, FAST], new Set()),
      expected: null,
    },
    {
      case: 'a custom endpoint: its Connection id is the Provider id',
      input: defaultsOnly('default', [ON_VLLM], new Set(['openai-compatible:vllm'])),
      expected: as(ON_VLLM, 'default'),
    },
  ])('$case', ({ input, expected }) => {
    expect(resolveSlotBinding(input)).toEqual(expected);
  });
});

describe('resolveSlotBinding: the full order', () => {
  const OVERRIDE: BindingTarget = { connectionId: 'ollama', model: 'llama3.2:3b' };
  /** Recommended Models as a Manifest lists them, mapped as the Runtime maps them. */
  const recommended = (...ids: string[]) => recommendedTargets(ids);
  const REC = recommended('google/gemini-x', 'anthropic/claude-haiku');
  const ALL = new Set(['anthropic', 'ollama', 'google']);

  it.each<{ case: string; input: SlotResolutionInput; expected: Binding | null }>([
    {
      case: 'an override with an enabled Connection wins over everything',
      input: {
        ...defaultsOnly('fast', [DEFAULT, FAST], ALL),
        override: OVERRIDE,
        recommended: REC,
      },
      expected: { providerId: 'ollama', model: 'llama3.2:3b', source: 'override' },
    },
    {
      case: 'an override wins on the `default` Slot too',
      input: { ...defaultsOnly('default', [DEFAULT], ALL), override: OVERRIDE },
      expected: { providerId: 'ollama', model: 'llama3.2:3b', source: 'override' },
    },
    {
      case: 'an override whose Connection is disabled: the first reachable Recommended Model',
      input: {
        ...defaultsOnly('fast', [DEFAULT, FAST], new Set(['anthropic'])),
        override: OVERRIDE,
        recommended: REC,
      },
      expected: { providerId: 'anthropic', model: 'claude-haiku', source: 'recommended' },
    },
    {
      case: 'an override whose Connection was removed (no such id) falls through the same way',
      input: {
        ...defaultsOnly('fast', [DEFAULT, FAST], new Set(['anthropic'])),
        override: { connectionId: 'openai-compatible:gone', model: 'm' },
        recommended: REC,
      },
      expected: { providerId: 'anthropic', model: 'claude-haiku', source: 'recommended' },
    },
    {
      case: 'Recommended Models in Manifest order: the first reachable one, not the first listed',
      input: {
        ...defaultsOnly('fast', [DEFAULT, FAST], new Set(['anthropic', 'ollama'])),
        recommended: REC,
      },
      expected: { providerId: 'anthropic', model: 'claude-haiku', source: 'recommended' },
    },
    {
      case: 'both Recommended Models reachable: the first listed',
      input: { ...defaultsOnly('fast', [DEFAULT, FAST], ALL), recommended: REC },
      expected: { providerId: 'google', model: 'gemini-x', source: 'recommended' },
    },
    {
      case: "a Recommended Model wins over the `default` Slot's own Default Model",
      input: {
        ...defaultsOnly('default', [DEFAULT], ALL),
        recommended: recommended('ollama/qwen3:8b'),
      },
      expected: { providerId: 'ollama', model: 'qwen3:8b', source: 'recommended' },
    },
    {
      case: 'given recommended [anthropic/x, ollama/y] and only an Ollama Connection: ollama/y',
      input: {
        ...defaultsOnly('default', [], new Set(['ollama'])),
        recommended: recommended('anthropic/x', 'ollama/y'),
      },
      expected: { providerId: 'ollama', model: 'y', source: 'recommended' },
    },
    {
      case: 'no Recommended Model reachable: the Default Model of the same Slot name',
      input: {
        ...defaultsOnly('fast', [DEFAULT, FAST], new Set(['ollama', 'anthropic'])),
        recommended: recommended('google/gemini-x'),
      },
      expected: as(FAST, 'default_same_name'),
    },
    {
      case: 'no Recommended Model reachable, no same-name Default Model: `default`',
      input: {
        ...defaultsOnly('summarize', [DEFAULT, FAST], ALL),
        recommended: recommended('openai/gpt-x'),
      },
      expected: as(DEFAULT, 'default'),
    },
    {
      case: 'unknown Provider ids among the Recommended Models are skipped, not a crash',
      input: {
        ...defaultsOnly('fast', [DEFAULT], ALL),
        recommended: recommended('acme-ai/model', 'not a provider/x', 'ollama/qwen3:8b'),
      },
      expected: { providerId: 'ollama', model: 'qwen3:8b', source: 'recommended' },
    },
    {
      case: 'only unknown Provider ids: on to the Default Models',
      input: { ...defaultsOnly('fast', [DEFAULT], ALL), recommended: recommended('acme-ai/model') },
      expected: as(DEFAULT, 'default'),
    },
    {
      case: 'a disabled override and unreachable Recommended Models fall through to the Default Models',
      input: {
        ...defaultsOnly('fast', [FAST], new Set(['ollama'])),
        override: { connectionId: 'anthropic', model: 'claude-opus' },
        recommended: REC,
      },
      expected: as(FAST, 'default_same_name'),
    },
    {
      case: 'everything unreachable: unbound',
      input: {
        ...defaultsOnly('fast', [DEFAULT, FAST], new Set(['openai'])),
        override: OVERRIDE,
        recommended: REC,
      },
      expected: null,
    },
  ])('$case', ({ input, expected }) => {
    expect(resolveSlotBinding(input)).toEqual(expected);
  });
});

describe('recommendedTargets', () => {
  it('splits each id at its first slash into a Connection id and a model, in order', () => {
    expect(
      recommendedTargets([
        'openrouter/anthropic/claude-sonnet',
        'ollama/qwen3:8b',
        'openai-compatible:vllm/meta/llama-4',
      ]),
    ).toEqual([
      { connectionId: 'openrouter', model: 'anthropic/claude-sonnet' },
      { connectionId: 'ollama', model: 'qwen3:8b' },
      { connectionId: 'openai-compatible:vllm', model: 'meta/llama-4' },
    ]);
  });

  it.each([
    ['a Provider id the Gateway does not serve', 'acme-ai/model'],
    ['the generic openai-compatible id, which no Connection has', 'openai-compatible/llama'],
    ['no slash', 'ollama'],
    ['nothing before the slash', '/qwen3:8b'],
    ['an empty model', 'ollama/'],
    ['a model the Gateway would not send', 'ollama/../x'],
    ['a Google model outside the Gemini names', 'google/models/../x'],
  ])('skips %s', (_case, id) => {
    expect(recommendedTargets([id, 'ollama/ok'])).toEqual([
      { connectionId: 'ollama', model: 'ok' },
    ]);
  });
});

describe('declaredSlots and declaredSlot', () => {
  it('lists `default` first, then the Manifest order', () => {
    expect(declaredSlots(manifestWith({ fast: {}, default: {}, summarize: {} }))).toEqual([
      'default',
      'fast',
      'summarize',
    ]);
  });

  it('finds own Slots only', () => {
    const manifest = manifestWith({ default: { description: 'Chat' } });
    expect(declaredSlot(manifest, 'default')).toEqual({ description: 'Chat' });
    expect(declaredSlot(manifest, 'constructor')).toBeUndefined();
    expect(declaredSlot(manifest, 'fast')).toBeUndefined();
    expect(declaredSlot(null, 'default')).toBeUndefined();
  });
});
