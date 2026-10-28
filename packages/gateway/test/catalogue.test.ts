/**
 * The static model catalogue the app ships for Anthropic and Google: its shape, which the desktop
 * app's model pickers and requirement checks rely on.
 */
import { describe, expect, it } from 'vitest';
import {
  MODEL_CATALOGUE,
  catalogueModels,
  catalogueTestModel,
  needsTestModel,
} from '../src/catalogue.js';
import { PROVIDERS, isModelName } from '../src/providers.js';

describe('MODEL_CATALOGUE', () => {
  it('covers exactly the Providers that cannot list their models: Anthropic and Google', () => {
    expect(Object.keys(MODEL_CATALOGUE).sort()).toEqual(['anthropic', 'google']);
    for (const providerId of Object.keys(MODEL_CATALOGUE)) {
      expect(PROVIDERS.find((provider) => provider.id === providerId)?.supportsModelList).toBe(
        false,
      );
    }
  });

  it.each(Object.entries(MODEL_CATALOGUE))(
    '%s entries are { id, contextWindow, tools, vision }, with unique valid ids',
    (providerId, models) => {
      expect(models.length).toBeGreaterThan(0);
      for (const model of models) {
        expect(
          Object.keys(model)
            .filter((key) => key !== 'test')
            .sort(),
        ).toEqual(['contextWindow', 'id', 'tools', 'vision']);
        expect(isModelName(providerId, model.id), model.id).toBe(true);
        expect(Number.isInteger(model.contextWindow) && model.contextWindow > 0).toBe(true);
        expect(typeof model.tools).toBe('boolean');
        expect(typeof model.vision).toBe('boolean');
      }
      expect(new Set(models.map((model) => model.id)).size).toBe(models.length);
    },
  );

  it.each(Object.entries(MODEL_CATALOGUE))(
    '%s marks exactly one entry, the last and smallest, as the test model',
    (_providerId, models) => {
      const tests = models.filter((model) => model.test === true);
      expect(tests).toHaveLength(1);
      expect(models.at(-1)).toBe(tests[0]);
    },
  );
});

describe('catalogueModels, catalogueTestModel and needsTestModel', () => {
  it('finds the catalogue by Provider id, and nothing for the others', () => {
    expect(catalogueModels('anthropic')).toBe(MODEL_CATALOGUE.anthropic);
    expect(catalogueModels('openai')).toBeUndefined();
    expect(catalogueModels('toString')).toBeUndefined();
  });

  it('names the test model of a catalogued Provider: its smallest current model', () => {
    expect(catalogueTestModel('anthropic')).toBe('claude-haiku-5-5');
    // Google serves the 2.5 models only to projects that used them before; new keys need 3.x.
    expect(catalogueTestModel('google')).toBe('gemini-3.5-flash-lite');
    expect(catalogueTestModel('openai')).toBeUndefined();
  });

  it('asks for a test model only where there is neither a model list nor a catalogue', () => {
    expect(PROVIDERS.filter((provider) => needsTestModel(provider.id)).map(({ id }) => id)).toEqual(
      ['zhipu', 'minimax', 'doubao'],
    );
    expect(needsTestModel('openai-compatible:vllm')).toBe(false);
    expect(needsTestModel('acme')).toBe(false);
  });
});
