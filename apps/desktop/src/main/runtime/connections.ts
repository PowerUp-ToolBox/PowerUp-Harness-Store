import {
  PROVIDERS,
  catalogueModels,
  catalogueTestModel,
  findProvider,
  isModelName,
  listModels,
  needsTestModel,
  testConnection,
  type CheckFailure,
  type ProviderInfo,
} from '@harness-store/gateway';
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
  ConnectionTestDraft,
  ConnectionTestPassed,
  ConnectionTestRequest,
  ConnectionUpdate,
  IpcResult,
  LocalProvider,
  ModelInfo,
  ProviderPreset,
} from '../../shared/ipc.js';
import type { ConnectionRow, ConnectionStore } from './connection-store.js';
import { fail, ok } from './ipc-result.js';
import { createModelCache } from './model-cache.js';
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
    needsTestModel: needsTestModel(provider.id),
    testModel: catalogueTestModel(provider.id) ?? null,
  }));
}

/** What a Connection test or listing reaches: the Provider, its key and its effective base URL. */
export interface ConnectionUnderTest {
  /** The Provider id: `openai-compatible` for every custom endpoint. */
  readonly providerId: string;
  readonly apiKey?: string;
  readonly baseUrl: string;
  /** The model a test sends a 1-token completion to, where the Provider needs one named. */
  readonly model?: string;
}

/**
 * A passed test carries the models it found, when it listed them; a failed one why
 * ({@link CheckFailure}): the Provider's own error text, with the key redacted, or a reason the UI
 * translates.
 */
export type ConnectionTestResult =
  { readonly ok: true; readonly models?: readonly ModelInfo[] } | CheckFailure;

/** Makes a small real request to check that a Connection works. */
export type ConnectionTester = (connection: ConnectionUnderTest) => Promise<ConnectionTestResult>;

/** The models a Connection offers, or why they could not be listed. */
export type ModelListing =
  { readonly ok: true; readonly models: readonly ModelInfo[] } | CheckFailure;

/** Lists the models of a Connection. */
export type ModelLister = (connection: ConnectionUnderTest) => Promise<ModelListing>;

/**
 * The real test and listing (`testConnection` and `listModels` of @harness-store/gateway), over
 * `fetch`: Node's, the one the Model Gateway's upstream calls use, so a passing test means the
 * Gateway reaches the same place.
 */
export function createProviderChecks(fetch: typeof globalThis.fetch): {
  readonly test: ConnectionTester;
  readonly listModels: ModelLister;
} {
  return {
    test: (connection) => testConnection({ ...connection, fetch }),
    listModels: (connection) => listModels({ ...connection, fetch }),
  };
}

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
  /** Tests a saved Connection and stores the result, passed or failed. */
  test(request: ConnectionTestRequest): Promise<IpcResult<ConnectionSummary>>;
  /** Tests what a form holds, saving nothing. */
  testDraft(draft: ConnectionTestDraft): Promise<IpcResult<ConnectionTestPassed>>;
  /** The models a Connection offers: catalogue, cached or live listing. */
  models(id: string): Promise<IpcResult<readonly ModelInfo[]>>;
  /** Deletes a Connection, its secret and the Slot Bindings that use it. */
  remove(id: string): IpcResult<null>;
}

export interface ConnectionsServiceOptions {
  readonly store: ConnectionStore;
  readonly cipher: SecretCipher;
  /** The Connection test: {@link createProviderChecks} in the app; tests pass a fake. */
  readonly test: ConnectionTester;
  /** The live model listing: {@link createProviderChecks} in the app; tests pass a fake. */
  readonly listModels: ModelLister;
  /** The clock of `lastTestedAt` and of the 10-minute model cache. Default: the system clock. */
  readonly now?: () => Date;
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
 * id; adding it again edits that Connection in place: what the draft gives replaces what is stored,
 * what it leaves out (a custom base URL, a key) is kept, and the Connection is enabled, since the
 * User asked to use it. Each custom endpoint is named, and its id `openai-compatible:<slug>` comes
 * from the name it was added with.
 *
 * Every test that runs is recorded on the Connection (`lastTestedAt`, `lastTestOk`,
 * `lastTestError`, `lastTestFailure`): the one `add` and a credential change in `update` pass
 * before saving, and each `test`. A passed test also keeps the model it was named (`testModel`),
 * and every later test without one uses it: a key that cannot use the catalogue's test model, or
 * a Provider that needs one named, is not asked for it again. Live model listings are kept for 10
 * minutes per Connection; the models of a passed test fill that cache too, and a new key or base
 * URL, or removing the Connection, empties it.
 */
export function createConnectionsService(options: ConnectionsServiceOptions): ConnectionsService {
  const { store, cipher, test, providers = PROVIDERS } = options;
  const now = options.now ?? (() => new Date());
  const cache = createModelCache(() => now().getTime());
  const order = new Map(providers.map((provider, index) => [provider.id, index]));

  /** The models known without a network call: the catalogue's, else a fresh cached listing. */
  const knownModels = (row: ConnectionRow): readonly ModelInfo[] =>
    catalogueModels(row.providerId) ?? cache.get(row.id) ?? [];

  /** Keeps the models a passed test listed, for a Provider that lists them live. */
  const remember = (
    id: string,
    provider: ProviderInfo,
    models: readonly ModelInfo[] | undefined,
  ) => {
    if (models !== undefined && provider.supportsModelList) cache.set(id, models);
  };

  /** A passed test's record; `model` is the one it was named, which later tests reuse. */
  const passed = (model: string | undefined) => ({
    lastTestedAt: now().toISOString(),
    lastTestOk: true,
    lastTestError: null,
    lastTestFailure: null,
    testModel: model ?? null,
  });

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
    lastTestFailure: row.lastTestFailure,
    testModel: row.testModel,
    models: knownModels(row).map((model) => model.id),
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

  /**
   * The model to test with, trimmed: the one named, else `saved` (the one the Connection last
   * passed a test with), else none, so the test uses the catalogue's. A Provider whose test lists
   * its models calls none, so gets none. Null when there is none where the Provider needs one
   * named, or the name is not one the Gateway would send.
   */
  const checkTestModel = (
    raw: string | undefined,
    provider: ProviderInfo,
    saved: string | null = null,
  ): { readonly model: string | undefined } | null => {
    const named = raw?.trim();
    const model = named === undefined || named === '' ? (saved ?? undefined) : named;
    if (model === undefined) return needsTestModel(provider.id) ? null : { model: undefined };
    if (!isModelName(provider.id, model)) return null;
    const callsModel = needsTestModel(provider.id) || catalogueTestModel(provider.id) !== undefined;
    return { model: callsModel ? model : undefined };
  };

  /** Runs the test of `provider` against these credentials. */
  const runTest = (
    provider: ProviderInfo,
    apiKey: string | undefined,
    baseUrl: string | null,
    model: string | undefined,
  ) =>
    test({
      providerId: provider.id,
      ...(apiKey === undefined ? {} : { apiKey }),
      baseUrl: effectiveBaseUrl(baseUrl, provider),
      ...(model === undefined ? {} : { model }),
    });

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
      // A single-instance Provider's saved Connection, which this add edits in place.
      const existing = custom ? undefined : store.get(provider.id);
      const baseUrl =
        draft.baseUrl === undefined && existing !== undefined
          ? existing.baseUrl
          : storedBaseUrl(draft.baseUrl ?? '', provider);
      if (baseUrl === undefined) return invalid();
      const testModel = checkTestModel(draft.testModel, provider, existing?.testModel);
      if (testModel === null) return invalid();
      if (key.key !== undefined && !(await cipher.isAvailable())) {
        return fail('encryption_unavailable');
      }

      // Without a new key, the stored one (if any) is kept, and tested with the base URL.
      const keptKey = key.key === undefined && existing !== undefined ? existing : undefined;
      const apiKey = key.key ?? (keptKey === undefined ? undefined : await storedKey(keptKey));
      const tested = await runTest(provider, apiKey, baseUrl, testModel.model);
      if (!tested.ok) return failedCheck(tested);
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
        secretRef: key.key === undefined ? (keptKey?.secretRef ?? null) : id,
        keyHint: key.key === undefined ? (keptKey?.keyHint ?? null) : keyHintFor(key.key),
        enabled: true,
        ...passed(testModel.model),
      };
      store.save(row, ciphertext);
      cache.delete(id);
      remember(id, provider, tested.models);
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
      const newBaseUrl = 'baseUrl' in changes;
      const newCredentials = key.key !== undefined || newBaseUrl;
      // A missing test model matters only when a test runs.
      const testModel = checkTestModel(update.testModel, provider, row.testModel);
      if (testModel === null && (newCredentials || (update.testModel?.trim() ?? '') !== '')) {
        return invalid();
      }
      if (key.key !== undefined && !(await cipher.isAvailable())) {
        return fail('encryption_unavailable');
      }

      // New credentials are tested before they are saved; that test replaces the last result,
      // which belonged to the old ones.
      let listed: readonly ModelInfo[] | undefined;
      if (newCredentials) {
        const apiKey = key.key ?? (await storedKey(row));
        const tested = await runTest(
          provider,
          apiKey,
          newBaseUrl ? (changes.baseUrl ?? null) : row.baseUrl,
          testModel?.model,
        );
        if (!tested.ok) return failedCheck(tested);
        listed = tested.models;
        Object.assign(changes, passed(testModel?.model));
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
      if (newCredentials) {
        cache.delete(row.id);
        remember(row.id, provider, listed);
      }
      return ok(summarize(next));
    },

    async test(request) {
      const invalid = () => fail('invalid_input', { method: 'connections.test' });
      const row = store.get(request.id);
      const provider = row === undefined ? undefined : findProvider(row.providerId, providers);
      if (row === undefined || provider === undefined) return invalid();
      const testModel = checkTestModel(request.model, provider, row.testModel);
      if (testModel === null) return invalid();

      const credentials = credentialsOf(row);
      const tested = await runTest(provider, await storedKey(row), row.baseUrl, testModel.model);
      // Recorded on the row as it is now, unless its credentials changed during the test: then the
      // result belongs to the old ones (and the change ran its own test).
      const current = store.get(row.id);
      if (current === undefined) return invalid();
      if (credentialsOf(current) !== credentials) return ok(summarize(current));
      const next: ConnectionRow = tested.ok
        ? { ...current, ...passed(testModel.model) }
        : {
            ...current,
            lastTestedAt: now().toISOString(),
            lastTestOk: false,
            lastTestError: tested.reason === 'provider_error' ? tested.detail : null,
            lastTestFailure: tested.reason === 'provider_error' ? null : tested.reason,
          };
      store.save(next);
      if (tested.ok) remember(row.id, provider, tested.models);
      return ok(summarize(next));
    },

    async testDraft(draft) {
      const invalid = () => fail('invalid_input', { method: 'connections.testDraft' });
      const provider = findProvider(draft.providerId, providers);
      if (provider?.id !== draft.providerId) return invalid();
      const saved = draft.id === undefined ? undefined : store.get(draft.id);
      if (draft.id !== undefined && saved?.providerId !== provider.id) return invalid();

      const key = checkKey(draft.apiKey, provider);
      if (!key.ok || (draft.apiKey !== undefined && key.key === undefined)) return invalid();
      const hasKey = key.key !== undefined || (saved !== undefined && saved.secretRef !== null);
      if (provider.requiresKey && !hasKey) return invalid();
      const baseUrl =
        draft.baseUrl === undefined && saved !== undefined
          ? saved.baseUrl
          : storedBaseUrl(draft.baseUrl ?? '', provider);
      if (baseUrl === undefined) return invalid();
      const testModel = checkTestModel(draft.testModel, provider, saved?.testModel);
      if (testModel === null) return invalid();

      const apiKey = key.key ?? (saved === undefined ? undefined : await storedKey(saved));
      const tested = await runTest(provider, apiKey, baseUrl, testModel.model);
      if (!tested.ok) return failedCheck(tested);
      return ok({ models: tested.models ?? catalogueModels(provider.id) ?? [] });
    },

    async models(id) {
      const row = store.get(id);
      const provider = row === undefined ? undefined : findProvider(row.providerId, providers);
      if (row === undefined || provider === undefined) {
        return fail('invalid_input', { method: 'connections.models' });
      }
      const known = catalogueModels(row.providerId) ?? cache.get(row.id);
      if (known !== undefined) return ok(known);
      if (!provider.supportsModelList) return ok([]);

      const credentials = credentialsOf(row);
      const listed = await options.listModels({
        providerId: provider.id,
        ...(row.secretRef === null ? {} : { apiKey: await storedKey(row) }),
        baseUrl: effectiveBaseUrl(row.baseUrl, provider),
      });
      if (!listed.ok) return failedCheck(listed);
      // Kept only while the credentials it was listed with are still the Connection's.
      const current = store.get(row.id);
      if (current !== undefined && credentialsOf(current) === credentials) {
        cache.set(row.id, listed.models);
      }
      return ok(listed.models);
    },

    remove(id) {
      if (store.get(id) === undefined)
        return fail('invalid_input', { method: 'connections.remove' });
      store.remove(id);
      cache.delete(id);
      return ok(null);
    },
  };

  /**
   * What a Connection reaches with, as one comparable value: its base URL and its stored key's
   * ciphertext. Taken before an awaited test or listing and again after it, it tells whether the
   * credentials changed meanwhile.
   */
  function credentialsOf(row: ConnectionRow): string {
    const ciphertext = row.secretRef === null ? undefined : store.secret(row.secretRef);
    return JSON.stringify([row.baseUrl, row.secretRef, ciphertext && Array.from(ciphertext)]);
  }

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
 * A failed test or listing as an IPC failure: `provider_error` with the Provider's own text, else
 * `provider_timeout` or `unexpected_response`, whose messages are the catalogs' own.
 */
function failedCheck(failure: CheckFailure) {
  return failure.reason === 'provider_error'
    ? fail('provider_error', { detail: failure.detail })
    : fail(failure.reason);
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
    test: () => Promise.resolve(fail('not_implemented', { method: 'connections.test' })),
    testDraft: () => Promise.resolve(fail('not_implemented', { method: 'connections.testDraft' })),
    models: () => Promise.resolve(fail('not_implemented', { method: 'connections.models' })),
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
  const fields = ['providerId', 'apiKey', 'displayName', 'baseUrl', 'testModel'];
  if (!isRecord(input) || !hasOnly(input, fields)) return null;
  const { providerId } = input;
  if (typeof providerId !== 'string' || findProvider(providerId) === undefined) return null;
  if (!optionalStrings(input, ['apiKey', 'displayName', 'baseUrl', 'testModel'])) return null;
  return input as unknown as ConnectionDraft;
}

/** The draft when `input` is a well-formed {@link ConnectionTestDraft}, else null (never throws). */
export function parseConnectionTestDraft(input: unknown): ConnectionTestDraft | null {
  const fields = ['id', 'providerId', 'apiKey', 'baseUrl', 'testModel'];
  if (!isRecord(input) || !hasOnly(input, fields)) return null;
  if (typeof input.providerId !== 'string') return null;
  if (!optionalStrings(input, ['id', 'apiKey', 'baseUrl', 'testModel'])) return null;
  return input as unknown as ConnectionTestDraft;
}

/** The request when `input` is a well-formed {@link ConnectionTestRequest}, else null. */
export function parseConnectionTestRequest(input: unknown): ConnectionTestRequest | null {
  if (!isRecord(input) || !hasOnly(input, ['id', 'model'])) return null;
  if (typeof input.id !== 'string' || !optionalStrings(input, ['model'])) return null;
  return input as unknown as ConnectionTestRequest;
}

/** The update when `input` is a well-formed {@link ConnectionUpdate}, else null (never throws). */
export function parseConnectionUpdate(input: unknown): ConnectionUpdate | null {
  const fields = ['id', 'displayName', 'apiKey', 'baseUrl', 'enabled', 'testModel'];
  if (!isRecord(input) || !hasOnly(input, fields)) return null;
  if (typeof input.id !== 'string') return null;
  if (!optionalStrings(input, ['displayName', 'apiKey', 'baseUrl', 'testModel'])) return null;
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') return null;
  return input as unknown as ConnectionUpdate;
}
