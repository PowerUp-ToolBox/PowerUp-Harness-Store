import { PROVIDERS, findProvider, type ProviderInfo } from '@harness-store/gateway';
import {
  customConnectionId,
  isNameTaken,
  keyHintFor,
  parseApiKey,
  parseBaseUrl,
  parseConnectionName,
} from '../../shared/connection-input.js';
import type {
  ConnectionDraft,
  ConnectionSummary,
  ConnectionUpdate,
  IpcResult,
  LocalProvider,
  ProviderPreset,
} from '../../shared/ipc.js';
import type { ConnectionRow, ConnectionStore } from './connection-store.js';
import { fail, ok } from './ipc-result.js';
import type { SecretCipher } from './secret-cipher.js';

/** The Providers that run on the User's machine. */
const LOCAL_PROVIDER_IDS: ReadonlySet<string> = new Set(['ollama', 'lmstudio']);

/** The Provider with no base URL of its own and many named Connections: the custom endpoint. */
const CUSTOM_PROVIDER_ID = 'openai-compatible';

/** Every row of `providers` as the UI offers it, in the Gateway's order. */
export function providerPresets(
  providers: readonly ProviderInfo[] = PROVIDERS,
): readonly ProviderPreset[] {
  return providers.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    requiresKey: provider.requiresKey,
    custom: provider.id === CUSTOM_PROVIDER_ID,
    local: LOCAL_PROVIDER_IDS.has(provider.id),
    baseUrl: provider.baseUrl ?? null,
    docsUrl: provider.docsUrl,
    supportsModelList: provider.supportsModelList,
    keyPlaceholder: provider.keyPlaceholder,
  }));
}

/** What a Connection test reaches: the Provider, its key and its effective base URL. */
export interface ConnectionUnderTest {
  /** The Provider id: `openai-compatible` for every custom endpoint. */
  readonly providerId: string;
  readonly apiKey?: string;
  readonly baseUrl: string;
}

/** A failed test carries the Provider's own error text, with the key redacted. */
export type ConnectionTestResult =
  { readonly ok: true } | { readonly ok: false; readonly detail: string };

/** Makes a small real request to check that a Connection works. */
export type ConnectionTester = (connection: ConnectionUnderTest) => Promise<ConnectionTestResult>;

/** The test until P0-03.2 brings the real one: every Connection passes. */
const passThroughTest: ConnectionTester = () => Promise.resolve({ ok: true });

/** The Connections service as the IPC handlers use it. */
export interface ConnectionsService {
  /** Every Connection: in the Provider table's order, custom endpoints by name. */
  list(): readonly ConnectionSummary[];
  /** Local Providers running on their default ports. */
  detectLocal(): Promise<readonly LocalProvider[]>;
  /** Checks the draft, tests the Connection and saves it when the test passes. */
  add(draft: ConnectionDraft): Promise<IpcResult<ConnectionSummary>>;
  /** Changes a Connection; a new key or base URL is tested first. */
  update(update: ConnectionUpdate): Promise<IpcResult<ConnectionSummary>>;
  /** Deletes a Connection, its secret and the Slot Bindings that use it. */
  remove(id: string): IpcResult<null>;
}

export interface ConnectionsServiceOptions {
  readonly store: ConnectionStore;
  readonly cipher: SecretCipher;
  /** Default: a test every Connection passes, until P0-03.2. */
  readonly test?: ConnectionTester;
  /** The Provider table; tests pass their own. */
  readonly providers?: readonly ProviderInfo[];
}

/**
 * Connections in the local database. Keys are encrypted with `cipher` before they are stored and
 * never leave this service except as the last-4 `keyHint`; without OS encryption a key is refused
 * with `encryption_unavailable`, never stored in plaintext (keyless Connections still work). Input
 * that does not fit (an unknown Provider, a missing key, a base URL that is not http(s), a name
 * already used) is `invalid_input`: the renderer checks the same rules first, with the functions
 * of shared/connection-input.ts.
 *
 * A Provider other than the custom endpoint has at most one Connection, whose id is the Provider
 * id; adding it again edits that Connection in place and enables it. Each custom endpoint is
 * named, and its id `openai-compatible:<slug>` comes from the name it was added with.
 */
export function createConnectionsService(options: ConnectionsServiceOptions): ConnectionsService {
  const { store, cipher, test = passThroughTest, providers = PROVIDERS } = options;
  const order = new Map(providers.map((provider, index) => [provider.id, index]));

  const summarize = (row: ConnectionRow): ConnectionSummary => ({
    id: row.id,
    providerId: row.providerId,
    displayName: row.displayName,
    local: LOCAL_PROVIDER_IDS.has(row.providerId),
    enabled: row.enabled,
    baseUrl: row.baseUrl ?? findProvider(row.providerId, providers)?.baseUrl ?? '',
    keyHint: row.secretRef === null ? null : (row.keyHint ?? ''),
    lastTestedAt: row.lastTestedAt,
    lastTestOk: row.lastTestOk,
    lastTestError: row.lastTestError,
    models: [],
  });

  /** Whether another custom endpoint than `exceptId` is called `name`. */
  const nameTaken = (name: string, exceptId?: string) =>
    isNameTaken(
      name,
      store
        .all()
        .filter((row) => row.providerId === CUSTOM_PROVIDER_ID && row.id !== exceptId)
        .map((row) => row.displayName),
    );

  /** The key as it would be stored, or what is wrong with it. */
  const checkKey = (
    raw: string | undefined,
    provider: ProviderInfo,
  ): { readonly ok: true; readonly key: string | undefined } | { readonly ok: false } => {
    if (raw === undefined) return { ok: true, key: undefined };
    const key = parseApiKey(raw);
    if (key === null) return { ok: false };
    // Only Providers that take a key show the field: those that need one, and the custom endpoint.
    if (key !== undefined && !provider.requiresKey && provider.id !== CUSTOM_PROVIDER_ID) {
      return { ok: false };
    }
    return { ok: true, key };
  };

  return {
    list() {
      const rank = (row: ConnectionRow) => order.get(row.providerId) ?? order.size;
      return store
        .all()
        .sort(
          (a, b) =>
            rank(a) - rank(b) ||
            a.displayName.localeCompare(b.displayName, 'en') ||
            a.id.localeCompare(b.id, 'en'),
        )
        .map(summarize);
    },

    detectLocal: () => Promise.resolve([]),

    async add(draft) {
      const invalid = () => fail('invalid_input', { method: 'connections.add' });
      const provider = findProvider(draft.providerId, providers);
      if (provider?.id !== draft.providerId) return invalid();
      const custom = provider.id === CUSTOM_PROVIDER_ID;

      const key = checkKey(draft.apiKey, provider);
      if (!key.ok || (provider.requiresKey && key.key === undefined)) return invalid();
      let displayName = provider.displayName;
      if (custom) {
        const name = parseConnectionName(draft.displayName ?? '');
        if (name === null || nameTaken(name)) return invalid();
        displayName = name;
      } else if (draft.displayName !== undefined) {
        return invalid();
      }
      const baseUrl = storedBaseUrl(draft.baseUrl ?? '', provider);
      if (baseUrl === undefined) return invalid();
      if (key.key !== undefined && !(await cipher.isAvailable())) {
        return fail('encryption_unavailable');
      }

      const tested = await test({
        providerId: provider.id,
        ...(key.key === undefined ? {} : { apiKey: key.key }),
        baseUrl: effectiveBaseUrl(baseUrl, provider),
      });
      if (!tested.ok) return fail('provider_error', { detail: tested.detail });
      const ciphertext = key.key === undefined ? undefined : await cipher.encrypt(key.key);

      // From here on nothing awaits, so the checks and the write see the same rows. The name is
      // checked again: another add may have taken it during the test.
      if (custom && nameTaken(displayName)) return invalid();
      const id = custom
        ? customConnectionId(displayName, new Set(store.all().map((row) => row.id)))
        : provider.id;
      const row: ConnectionRow = {
        id,
        providerId: provider.id,
        displayName,
        baseUrl,
        secretRef: key.key === undefined ? null : id,
        keyHint: key.key === undefined ? null : keyHintFor(key.key),
        enabled: true,
        lastTestedAt: null,
        lastTestOk: null,
        lastTestError: null,
      };
      store.save(row, ciphertext);
      return ok(summarize(row));
    },

    async update(update) {
      const invalid = () => fail('invalid_input', { method: 'connections.update' });
      const row = store.get(update.id);
      const provider = row === undefined ? undefined : findProvider(row.providerId, providers);
      if (row === undefined || provider === undefined) return invalid();
      const custom = provider.id === CUSTOM_PROVIDER_ID;

      const changes: { -readonly [K in keyof ConnectionRow]?: ConnectionRow[K] } = {};
      if (update.displayName !== undefined) {
        const name = parseConnectionName(update.displayName);
        if (!custom || name === null || nameTaken(name, row.id)) return invalid();
        changes.displayName = name;
      }
      const key = checkKey(update.apiKey, provider);
      // A stored key can be replaced, not cleared.
      if (!key.ok || (update.apiKey !== undefined && key.key === undefined)) return invalid();
      if (update.baseUrl !== undefined) {
        const baseUrl = storedBaseUrl(update.baseUrl, provider);
        if (baseUrl === undefined) return invalid();
        if (baseUrl !== row.baseUrl) changes.baseUrl = baseUrl;
      }
      if (update.enabled !== undefined) changes.enabled = update.enabled;
      if (key.key !== undefined && !(await cipher.isAvailable())) {
        return fail('encryption_unavailable');
      }

      // New credentials are tested before they are saved, and the last test result, which
      // belonged to the old ones, is dropped.
      const newBaseUrl = 'baseUrl' in changes;
      if (key.key !== undefined || newBaseUrl) {
        const apiKey = key.key ?? (await storedKey(row));
        const tested = await test({
          providerId: provider.id,
          ...(apiKey === undefined ? {} : { apiKey }),
          baseUrl: effectiveBaseUrl(newBaseUrl ? (changes.baseUrl ?? null) : row.baseUrl, provider),
        });
        if (!tested.ok) return fail('provider_error', { detail: tested.detail });
        Object.assign(changes, { lastTestedAt: null, lastTestOk: null, lastTestError: null });
        if (key.key !== undefined) {
          Object.assign(changes, { secretRef: row.id, keyHint: keyHintFor(key.key) });
        }
      }

      const ciphertext = key.key === undefined ? undefined : await cipher.encrypt(key.key);

      // Applied to the row as it is now: it may have changed, or gone, during the awaits above.
      const current = store.get(row.id);
      if (current === undefined) return invalid();
      if (changes.displayName !== undefined && nameTaken(changes.displayName, row.id)) {
        return invalid();
      }
      const next: ConnectionRow = { ...current, ...changes };
      store.save(next, ciphertext);
      return ok(summarize(next));
    },

    remove(id) {
      if (store.get(id) === undefined)
        return fail('invalid_input', { method: 'connections.remove' });
      store.remove(id);
      return ok(null);
    },
  };

  /** The Connection's decrypted key; undefined when it has none. */
  function storedKey(row: ConnectionRow): Promise<string | undefined> {
    return row.secretRef === null
      ? Promise.resolve(undefined)
      : decryptSecret(store, cipher, row.secretRef);
  }
}

/** Decrypts the secret `secretRef`; rejects when the row is missing or cannot be decrypted. */
export async function decryptSecret(
  store: ConnectionStore,
  cipher: SecretCipher,
  secretRef: string,
): Promise<string> {
  const ciphertext = store.secret(secretRef);
  if (ciphertext === undefined) throw new Error(`The secret ${secretRef} is missing.`);
  return cipher.decrypt(ciphertext);
}

/**
 * The base URL as stored: null for the Provider's default (nothing typed, or exactly the default),
 * else the URL without its trailing `/`. Undefined when it is not an http(s) URL, or when the
 * custom endpoint, which has no default, gets none.
 */
function storedBaseUrl(raw: string, provider: ProviderInfo): string | null | undefined {
  const parsed = parseBaseUrl(raw);
  if (parsed === null) return undefined;
  if (parsed === undefined || parsed === provider.baseUrl) {
    return provider.baseUrl === undefined ? undefined : null;
  }
  return parsed;
}

function effectiveBaseUrl(stored: string | null, provider: ProviderInfo): string {
  return stored ?? provider.baseUrl ?? '';
}

/**
 * Connections without a database, when the Runtime could not open it: the window shows only its
 * startup error screen, so nothing is listed and every change answers `not_implemented`.
 */
export function createConnectionsStub(): ConnectionsService {
  return {
    list: () => [],
    detectLocal: () => Promise.resolve([]),
    add: () => Promise.resolve(fail('not_implemented', { method: 'connections.add' })),
    update: () => Promise.resolve(fail('not_implemented', { method: 'connections.update' })),
    remove: () => fail('not_implemented', { method: 'connections.remove' }),
  };
}

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

const hasOnly = (input: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(input).every((key) => keys.includes(key));

const optionalStrings = (input: Record<string, unknown>, keys: readonly string[]) =>
  keys.every((key) => input[key] === undefined || typeof input[key] === 'string');

/**
 * The draft when `input` is a well-formed {@link ConnectionDraft} for a Provider the Gateway
 * serves, else null (never throws). Only the shape is checked here; the Connections service checks
 * the values, and the test whether the key works.
 */
export function parseConnectionDraft(input: unknown): ConnectionDraft | null {
  if (!isRecord(input) || !hasOnly(input, ['providerId', 'apiKey', 'displayName', 'baseUrl'])) {
    return null;
  }
  const { providerId } = input;
  if (typeof providerId !== 'string' || findProvider(providerId) === undefined) return null;
  if (!optionalStrings(input, ['apiKey', 'displayName', 'baseUrl'])) return null;
  return input as unknown as ConnectionDraft;
}

/** The update when `input` is a well-formed {@link ConnectionUpdate}, else null (never throws). */
export function parseConnectionUpdate(input: unknown): ConnectionUpdate | null {
  if (!isRecord(input) || !hasOnly(input, ['id', 'displayName', 'apiKey', 'baseUrl', 'enabled'])) {
    return null;
  }
  if (typeof input.id !== 'string') return null;
  if (!optionalStrings(input, ['displayName', 'apiKey', 'baseUrl'])) return null;
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return null;
  return input as unknown as ConnectionUpdate;
}
