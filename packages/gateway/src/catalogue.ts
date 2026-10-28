/**
 * The static model catalogue for the Providers that do not list their models through the API the
 * Gateway speaks (Anthropic, Google). It ships with the app and changes only with app updates, so
 * the desktop app can offer real model names and check Model Requirements for them without a
 * network call. Model ids, context windows and capabilities follow each vendor's public model
 * documentation.
 */
import { findProvider } from './providers.js';

/** What is known about one model a Connection offers. An absent capability is unknown. */
export interface ModelInfo {
  /** The model name at the Provider, without the Provider prefix. */
  id: string;
  /** The context window, in tokens. */
  contextWindow?: number;
  /** Whether the model supports tool calling. */
  tools?: boolean;
  /** Whether the model accepts images. */
  vision?: boolean;
}

/** A catalogue entry: everything is known. */
export interface CatalogueModel extends ModelInfo {
  contextWindow: number;
  tools: boolean;
  vision: boolean;
  /** Set on exactly one entry per Provider: the smallest model, which a Connection test calls. */
  test?: true;
}

/** The Providers the catalogue covers. */
export type CatalogueProviderId = 'anthropic' | 'google';

/** The catalogue, per Provider, largest model first. Kept small: current models only. */
export const MODEL_CATALOGUE: Readonly<Record<CatalogueProviderId, readonly CatalogueModel[]>> = {
  anthropic: [
    { id: 'claude-fable-5-1', contextWindow: 1_000_000, tools: true, vision: true },
    { id: 'claude-opus-5-5', contextWindow: 1_000_000, tools: true, vision: true },
    { id: 'claude-sonnet-5-5', contextWindow: 1_000_000, tools: true, vision: true },
    { id: 'claude-haiku-5-5', contextWindow: 1_000_000, tools: true, vision: true, test: true },
  ],
  google: [
    { id: 'gemini-4-argon', contextWindow: 1_048_576, tools: true, vision: true },
    { id: 'gemini-3.8-flash', contextWindow: 1_048_576, tools: true, vision: true },
    {
      id: 'gemini-3.5-flash-lite',
      contextWindow: 1_048_576,
      tools: true,
      vision: true,
      test: true,
    },
  ],
};

/** The catalogue entries for a Provider id; `undefined` for a Provider the catalogue does not cover. */
export function catalogueModels(providerId: string): readonly CatalogueModel[] | undefined {
  return Object.hasOwn(MODEL_CATALOGUE, providerId)
    ? MODEL_CATALOGUE[providerId as CatalogueProviderId]
    : undefined;
}

/**
 * The catalogue model a Connection test calls for `providerId` unless the User names another;
 * `undefined` for a Provider the catalogue does not cover.
 */
export function catalogueTestModel(providerId: string): string | undefined {
  return catalogueModels(providerId)?.find((model) => model.test)?.id;
}

/**
 * Whether testing a Connection for `providerId` needs a model name from the User: the Provider
 * neither lists its models nor has catalogue entries (Zhipu, MiniMax, Doubao), so the test sends
 * a 1-token completion to a model the User names.
 */
export function needsTestModel(providerId: string): boolean {
  const provider = findProvider(providerId);
  return (
    provider !== undefined &&
    !provider.supportsModelList &&
    catalogueModels(providerId) === undefined
  );
}
