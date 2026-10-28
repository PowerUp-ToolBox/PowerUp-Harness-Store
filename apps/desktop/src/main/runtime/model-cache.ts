import type { ModelInfo } from '../../shared/ipc.js';

/** How long a live model listing is reused before the Provider is asked again: 10 minutes. */
export const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * The models each Connection listed live, kept in memory for {@link MODEL_CACHE_TTL_MS} so that
 * opening a model picker again does not ask the Provider again. Keyed by Connection id. Only
 * successful listings are kept; the Connections service drops an entry when that Connection's key
 * or base URL changes or it is removed. Nothing is persisted: a restart lists again.
 */
export interface ModelCache {
  /** The models listed less than the TTL ago; undefined when there are none or they are stale. */
  get(connectionId: string): readonly ModelInfo[] | undefined;
  set(connectionId: string, models: readonly ModelInfo[]): void;
  delete(connectionId: string): void;
}

/** A cache whose clock is `now` (milliseconds since the epoch); tests pass a fake one. */
export function createModelCache(
  now: () => number = Date.now,
  ttlMs: number = MODEL_CACHE_TTL_MS,
): ModelCache {
  const entries = new Map<string, { readonly models: readonly ModelInfo[]; readonly at: number }>();
  return {
    get(connectionId) {
      const entry = entries.get(connectionId);
      if (entry === undefined) return undefined;
      if (now() - entry.at >= ttlMs) {
        entries.delete(connectionId);
        return undefined;
      }
      return entry.models;
    },
    set(connectionId, models) {
      entries.set(connectionId, { models, at: now() });
    },
    delete(connectionId) {
      entries.delete(connectionId);
    },
  };
}
