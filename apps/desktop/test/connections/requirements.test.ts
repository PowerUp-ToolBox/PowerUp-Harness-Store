import { MODEL_CATALOGUE } from '@harness-store/gateway';
import type { ModelRequirements } from '@harness-store/manifest';
import { describe, expect, it } from 'vitest';
import { checkRequirements, type RequirementCheck } from '../../src/shared/requirements.js';
import type { ModelInfo } from '../../src/shared/ipc.js';

const SMALL_CATALOGUE: ModelInfo = {
  id: 'small',
  contextWindow: 32_000,
  tools: false,
  vision: false,
};
const LARGE_CATALOGUE: ModelInfo = {
  id: 'large',
  contextWindow: 1_000_000,
  tools: true,
  vision: true,
};
/** A model typed by hand, or listed live: only its name is known. */
const TYPED: ModelInfo = { id: 'my-nonsense-model-name' };

const OK: RequirementCheck = { ok: true, unknown: false, failures: [] };

describe('checkRequirements', () => {
  it.each<{
    case: string;
    requirements: ModelRequirements | undefined;
    model: ModelInfo;
    expected: RequirementCheck;
  }>([
    { case: 'no requirements', requirements: undefined, model: TYPED, expected: OK },
    {
      case: 'requirements set to false',
      requirements: { tools: false, vision: false },
      model: SMALL_CATALOGUE,
      expected: OK,
    },
    {
      case: 'all met by a catalogue model',
      requirements: { tools: true, vision: true, minContext: 200_000 },
      model: LARGE_CATALOGUE,
      expected: OK,
    },
    {
      case: 'known failures, in order',
      requirements: { minContext: 64_000, vision: true, tools: true },
      model: SMALL_CATALOGUE,
      expected: { ok: false, unknown: false, failures: ['tools', 'vision', 'minContext'] },
    },
    {
      case: 'a typed model: unknown, never failing',
      requirements: { tools: true, vision: true, json: true, minContext: 1_000_000_000 },
      model: TYPED,
      expected: { ok: true, unknown: true, failures: [] },
    },
    {
      case: 'json, which no source states: unknown even for a catalogue model',
      requirements: { json: true },
      model: LARGE_CATALOGUE,
      expected: { ok: true, unknown: true, failures: [] },
    },
    {
      case: 'a known failure next to an unknown',
      requirements: { tools: true, json: true },
      model: SMALL_CATALOGUE,
      expected: { ok: false, unknown: true, failures: ['tools'] },
    },
    {
      case: 'each failure type on its own: tools',
      requirements: { tools: true },
      model: SMALL_CATALOGUE,
      expected: { ok: false, unknown: false, failures: ['tools'] },
    },
    {
      case: 'each failure type on its own: vision',
      requirements: { vision: true },
      model: SMALL_CATALOGUE,
      expected: { ok: false, unknown: false, failures: ['vision'] },
    },
    {
      case: 'each failure type on its own: json, for a model known to lack JSON output',
      requirements: { json: true },
      model: { ...SMALL_CATALOGUE, json: false },
      expected: { ok: false, unknown: false, failures: ['json'] },
    },
    {
      case: 'each failure type on its own: minContext',
      requirements: { minContext: 32_001 },
      model: SMALL_CATALOGUE,
      expected: { ok: false, unknown: false, failures: ['minContext'] },
    },
    {
      case: 'every failure at once, in the order of the type',
      requirements: { json: true, minContext: 64_000, vision: true, tools: true },
      model: { ...SMALL_CATALOGUE, json: false },
      expected: { ok: false, unknown: false, failures: ['tools', 'vision', 'json', 'minContext'] },
    },
    {
      case: 'a model with only some capabilities known: unknown for the rest',
      requirements: { tools: true, minContext: 8_000 },
      model: { id: 'partly-known', tools: true },
      expected: { ok: true, unknown: true, failures: [] },
    },
    {
      case: 'a context window exactly the minimum',
      requirements: { minContext: 32_000 },
      model: SMALL_CATALOGUE,
      expected: OK,
    },
  ])('$case', ({ requirements, model, expected }) => {
    expect(checkRequirements(requirements, model)).toEqual(expected);
  });

  it('judges every catalogue entry on tools, vision and context', () => {
    for (const model of [...MODEL_CATALOGUE.anthropic, ...MODEL_CATALOGUE.google]) {
      expect(checkRequirements({ tools: true, vision: true, minContext: 1 }, model).unknown).toBe(
        false,
      );
    }
  });
});
