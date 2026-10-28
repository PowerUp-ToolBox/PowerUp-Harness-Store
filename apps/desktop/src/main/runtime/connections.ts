import { PROVIDERS, findProvider, type ProviderInfo } from '@harness-store/gateway';
import type {
  ConnectionDraft,
  ConnectionSummary,
  IpcResult,
  LocalProvider,
  ProviderPreset,
} from '../../shared/ipc.js';
import { fail } from './ipc-result.js';

/** The Providers that run on the User's machine; detection finds them, so they are no preset. */
const LOCAL_PROVIDER_IDS: ReadonlySet<string> = new Set(['ollama', 'lmstudio']);

/** The Provider with no base URL of its own: the custom OpenAI-compatible endpoint. */
const CUSTOM_PROVIDER_ID = 'openai-compatible';

/**
 * The Providers a User can add a Connection for by hand, in the Gateway's order (the wizard's
 * preset dropdown): every row of `providers` except the local ones.
 */
export function providerPresets(
  providers: readonly ProviderInfo[] = PROVIDERS,
): readonly ProviderPreset[] {
  return providers
    .filter((provider) => !LOCAL_PROVIDER_IDS.has(provider.id))
    .map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      requiresKey: provider.requiresKey,
      custom: provider.id === CUSTOM_PROVIDER_ID,
      keyPlaceholder: provider.keyPlaceholder,
    }));
}

/** The Connections service as the IPC handlers use it; P0-03 replaces the stubs below. */
export interface ConnectionsService {
  /** Local Providers running on their default ports. */
  detectLocal(): Promise<readonly LocalProvider[]>;
  /** Tests the draft's Connection and saves it when the test succeeds. */
  add(draft: ConnectionDraft): Promise<IpcResult<ConnectionSummary>>;
}

/**
 * Connections before P0-03: detection finds nothing and adding answers `not_implemented`, so the
 * first-run wizard shows its "nothing found" and empty Default Model states.
 */
export function createConnectionsStub(): ConnectionsService {
  return {
    detectLocal: () => Promise.resolve([]),
    add: () => Promise.resolve(fail('not_implemented', { method: 'connections.add' })),
  };
}

/**
 * The draft when `input` is a well-formed {@link ConnectionDraft} for a Provider the Gateway
 * serves, else null (never throws). Only the shape is checked here; whether the key works is the
 * Connection test's job.
 */
export function parseConnectionDraft(input: unknown): ConnectionDraft | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const allowed = new Set(['providerId', 'apiKey', 'displayName', 'baseUrl']);
  if (!Object.keys(input).every((key) => allowed.has(key))) return null;
  const draft = input as Record<string, unknown>;
  const { providerId } = draft;
  if (typeof providerId !== 'string' || findProvider(providerId) === undefined) return null;
  const optional = ['apiKey', 'displayName', 'baseUrl'] as const;
  if (!optional.every((key) => draft[key] === undefined || typeof draft[key] === 'string')) {
    return null;
  }
  return input as ConnectionDraft;
}
