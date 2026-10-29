import type { Binding } from '@harness-store/gateway';
import { describe, expect, it } from 'vitest';
import {
  resolveSlotBinding,
  type SlotResolutionInput,
} from '../../src/main/runtime/slot-resolver.js';
import type { BindingTarget, GlobalBinding } from '../../src/shared/ipc.js';

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

describe('resolveSlotBinding: the steps ahead of the Default Models (inputs filled in P0-03.5)', () => {
  const override: BindingTarget = { connectionId: 'ollama', model: 'llama3.2:3b' };
  const recommended: BindingTarget[] = [
    { connectionId: 'google', model: 'gemini-x' },
    { connectionId: 'anthropic', model: 'claude-haiku' },
  ];

  it('a Model Override with an enabled Connection comes first', () => {
    expect(resolveSlotBinding({ ...defaultsOnly('fast', [FAST]), override, recommended })).toEqual({
      providerId: 'ollama',
      model: 'llama3.2:3b',
      source: 'override',
    });
  });

  it('then the first Recommended Model with an enabled Connection', () => {
    expect(resolveSlotBinding({ ...defaultsOnly('fast', [FAST]), recommended })).toEqual({
      providerId: 'anthropic',
      model: 'claude-haiku',
      source: 'recommended',
    });
  });

  it('a disabled override and unreachable recommendations fall through to the Default Models', () => {
    expect(
      resolveSlotBinding({
        ...defaultsOnly('fast', [FAST], new Set(['ollama'])),
        override: { connectionId: 'anthropic', model: 'claude-opus' },
        recommended,
      }),
    ).toEqual(as(FAST, 'default_same_name'));
  });
});
