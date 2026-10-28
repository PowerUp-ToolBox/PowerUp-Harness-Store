/**
 * The IPC contract between the renderer and the Runtime (main process), defined once and used by
 * the main handlers, the preload bridge and the renderer. It is types plus two constant lists; it
 * imports only types, so every process can bundle it.
 *
 * Transport: one `ipcMain.handle` channel carries `{ method, input }` and always resolves to an
 * {@link IpcResult}; one event channel carries `{ event, payload }` from main to the renderer.
 */

import type { Locale } from './i18n/locale.js';

/**
 * Error codes the Runtime returns over IPC: its own five, then every Model Gateway code
 * (`GATEWAY_ERROR_STATUS` in @harness-store/gateway; a test keeps the two lists in step). Each has
 * an `error.<code>` entry in both message catalogs.
 */
export type IpcErrorCode =
  | 'internal_error'
  | 'invalid_input'
  | 'not_implemented'
  /**
   * The OS offers no encryption for secrets (Electron `safeStorage`; on Linux, no keyring), so a
   * key cannot be stored. It is never stored in plaintext instead.
   */
  | 'encryption_unavailable'
  /**
   * A Connection test or model listing reached something that answered, but not with what the
   * Provider's API returns (not JSON, or not a model list): usually a wrong base URL.
   */
  | 'unexpected_response'
  | 'invalid_request'
  | 'invalid_token'
  | 'invalid_host'
  | 'provider_not_connected'
  | 'not_supported'
  | 'unknown_slot'
  | 'slot_unbound'
  | 'provider_error'
  | 'provider_timeout';

export interface IpcError {
  readonly code: IpcErrorCode;
  /** The catalog key the renderer looks up, always `error.<code>`. */
  readonly messageKey: `error.${IpcErrorCode}`;
  readonly params?: Readonly<Record<string, string | number>>;
  /** English text, the last fallback when the catalog cannot render `messageKey`. */
  readonly message: string;
}

export type IpcResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: IpcError };

/**
 * Every request/response method: name (`<domain>.<verb>`) → input and output types. `input:
 * undefined` means the renderer calls it with no argument. Each handler checks its own input at
 * runtime.
 */
export interface IpcMethods {
  'app.ping': { input: undefined; output: { version: string } };
  /** Whether the Runtime started; the renderer asks first and shows an error screen on failure. */
  'app.status': { input: undefined; output: StartupStatus };
  /** Quits the app, stopping the Model Gateway and closing the database first. */
  'app.quit': { input: undefined; output: null };
  'settings.get': { input: undefined; output: Settings };
  /** Applies the patch and returns the settings as they now are. */
  'settings.set': { input: SettingsPatch; output: Settings };
  /** Read-only facts for support and debugging, shown in Settings. */
  'diagnostics.get': { input: undefined; output: Diagnostics };
  /** Whether the Store answered the last connectivity check. */
  'connectivity.get': { input: undefined; output: Connectivity };
  /**
   * Checks the Store now (Retry) and returns the result. Joins a check already running instead
   * of starting a second one.
   */
  'connectivity.check': { input: undefined; output: Connectivity };
  /** Every Provider of the Gateway's table, in its order, local ones (Ollama, LM Studio) included. */
  'providers.list': { input: undefined; output: readonly ProviderPreset[] };
  /**
   * Looks for local Providers (Ollama, LM Studio) on their default ports now: `GET /v1/models` on
   * both at once, each for at most 1.5 seconds, so the answer comes within about that long. Lists
   * those that answered with a model list, each with whether it already has its Connection. It
   * never adds a Connection: the User adds one with `connections.add`.
   */
  'connections.detectLocal': { input: undefined; output: readonly LocalProvider[] };
  /**
   * Every saved Connection: in the order of the Provider table, custom endpoints by name. Keys
   * appear only as `keyHint`.
   */
  'connections.list': { input: undefined; output: readonly ConnectionSummary[] };
  /**
   * Checks the draft, tests the Connection and saves it, with the passed test, when the test
   * passes; a failed test stores nothing and answers `provider_error`, `provider_timeout` or
   * `unexpected_response`. Adding a Provider that allows one Connection and already
   * has it edits that Connection in place (and enables it). A key is stored only encrypted:
   * without OS encryption, a draft with a key answers `encryption_unavailable`.
   */
  'connections.add': { input: ConnectionDraft; output: ConnectionSummary };
  /**
   * Changes a saved Connection. A new key or base URL is tested first and saved only when the test
   * passes; a change of `enabled` or `displayName` alone is saved without a test.
   */
  'connections.update': { input: ConnectionUpdate; output: ConnectionSummary };
  /**
   * Tests a saved Connection with one small real request and stores the result
   * (`lastTestedAt`, `lastTestOk`, `lastTestError`, `lastTestFailure`). A failed test is not an IPC
   * failure: the Connection comes back with `lastTestOk: false` and the Provider's text in
   * `lastTestError`, or the reason without one in `lastTestFailure`.
   * `model` names the model to test with; without one the test uses the Connection's
   * `testModel`, else the catalogue's.
   */
  'connections.test': { input: ConnectionTestRequest; output: ConnectionSummary };
  /**
   * Tests what a Connection form holds, without saving anything: for a new Connection, or for the
   * saved one `id` with the fields left out taken from it (its stored key included). A failed test
   * answers `provider_error` with the Provider's text, `provider_timeout` or `unexpected_response`.
   */
  'connections.testDraft': { input: ConnectionTestDraft; output: ConnectionTestPassed };
  /**
   * The models a Connection offers: the app's catalogue for Anthropic and Google, a live listing
   * where the Provider lists its models (reused for 10 minutes), else none. A failed listing
   * answers as a failed test does; the User can still type a model name.
   */
  'connections.models': { input: string; output: readonly ModelInfo[] };
  /**
   * Deletes the Connection with this id, its secret and every Slot Binding that uses it, at once.
   * An unknown id is `invalid_input`.
   */
  'connections.remove': { input: string; output: null };
  /** The global Slot Bindings (the Default Models), `default` first, then by Slot name. */
  'bindings.getGlobal': { input: undefined; output: readonly GlobalBinding[] };
}

/** The Runtime's startup steps, in order: open and migrate SQLite, then start the Model Gateway. */
export type StartupStage = 'database' | 'gateway';

/** How the Runtime's startup went; `detail` is the cause, in English, for a support request. */
export type StartupStatus =
  | { readonly state: 'ready' }
  | { readonly state: 'failed'; readonly stage: StartupStage; readonly detail: string };

export interface Diagnostics {
  /** The desktop app's version. */
  readonly version: string;
  /** The Model Gateway as it is now: listening on a loopback port, or not running. */
  readonly gateway: { readonly running: true; readonly port: number } | { readonly running: false };
  /** The absolute path of the local SQLite database file. */
  readonly databasePath: string;
}

/**
 * Whether the Store answers: `unknown` until the first check ends, then `online` or `offline`.
 * The Store being down counts as offline, since the User meets the same problem either way.
 */
export type ConnectivityState = 'unknown' | 'online' | 'offline';

export interface Connectivity {
  readonly state: ConnectivityState;
}

/** The app settings as the renderer sees them. */
export interface Settings {
  /** The User's language override; absent means "System" (follow the OS locale). */
  readonly locale?: Locale;
  /** The locale the UI renders in: `locale`, else the OS locale mapped to `en` or `zh-CN`. */
  readonly resolvedLocale: Locale;
  /** Whether the first-run wizard reached its end (completed or skipped) once. */
  readonly onboardingDone: boolean;
}

/** The settings the renderer may write. `locale: null` clears the override (back to System). */
export interface SettingsPatch {
  readonly locale?: Locale | null;
  readonly onboardingDone?: boolean;
}

/** A Provider the User can add a Connection for: one row of the Gateway's table. */
export interface ProviderPreset {
  /** The Provider id (`anthropic`, `openai-compatible`, …). */
  readonly id: string;
  /** The Gateway's English name; the UI shows the `provider.<id>` catalog entry instead. */
  readonly displayName: string;
  /** Whether a Connection needs an API key. */
  readonly requiresKey: boolean;
  /**
   * The custom OpenAI-compatible endpoint: the User names it and gives its base URL, since the
   * Provider has none of its own. It may have many Connections; every other Provider has one.
   */
  readonly custom: boolean;
  /** Whether the Provider runs on the User's machine (Ollama, LM Studio). */
  readonly local: boolean;
  /** Where requests go unless the Connection names another base URL; null for the custom one. */
  readonly baseUrl: string | null;
  /** The Provider's API documentation. */
  readonly docsUrl: string;
  /** Whether the Provider lists its models (`GET /models`). */
  readonly supportsModelList: boolean;
  /** What the Provider's keys look like, for the key field's placeholder; `''` when unknown. */
  readonly keyPlaceholder: string;
  /**
   * Whether a Connection test needs a model name from the User: the Provider neither lists its
   * models nor is in the app's catalogue (Zhipu, MiniMax, Doubao).
   */
  readonly needsTestModel: boolean;
  /**
   * The catalogue model a Connection test calls unless the User names another (Anthropic,
   * Google); null where there is none. Naming another keeps a key that cannot use this one, or an
   * app whose catalogue has aged, from blocking the Connection.
   */
  readonly testModel: string | null;
}

/** A local Provider found running on this machine. */
export interface LocalProvider {
  /** `ollama` or `lmstudio`, also the id its Connection gets. */
  readonly providerId: string;
  readonly displayName: string;
  /** Where it answered, such as `http://127.0.0.1:11434/v1`. */
  readonly baseUrl: string;
  /** The models it lists. */
  readonly models: readonly string[];
  /**
   * Whether this Provider already had its Connection (enabled or not) when detection ran. A
   * Provider already added is shown as Added and not offered again, so its Connection (a custom
   * base URL, a disabled state) is left alone. The wizard reads this flag; the Models page reads
   * its live Connections list instead, which also covers a Connection added or removed since.
   */
  readonly added: boolean;
}

/** What the User entered to add a Connection. */
export interface ConnectionDraft {
  readonly providerId: string;
  /** Required where the Provider needs a key, optional for the custom endpoint, else absent. */
  readonly apiKey?: string;
  /** The custom endpoint's name (required for it); other Providers use their own name. */
  readonly displayName?: string;
  /** Required for the custom endpoint; absent or empty means the Provider's default. */
  readonly baseUrl?: string;
  /**
   * The model the test sends a 1-token completion to: required where `needsTestModel`, and
   * replacing the preset's `testModel` where it has one; ignored by the other Providers. Once a
   * test with it passes, it is the Connection's `testModel`. Absent when re-adding a Provider
   * already added: that Connection's `testModel`.
   */
  readonly testModel?: string;
}

/** A change to a saved Connection; absent fields keep their value. */
export interface ConnectionUpdate {
  readonly id: string;
  /** A new name; only a custom endpoint has its own. */
  readonly displayName?: string;
  /** A new key; the stored one cannot be cleared, only replaced. */
  readonly apiKey?: string;
  /** A new base URL; empty means the Provider's default (the custom endpoint has none). */
  readonly baseUrl?: string;
  readonly enabled?: boolean;
  /**
   * The model to test a new key or base URL with; absent or empty, the Connection's `testModel`.
   */
  readonly testModel?: string;
}

/** Which saved Connection to test, and with which model. */
export interface ConnectionTestRequest {
  readonly id: string;
  /**
   * The model to test with; absent, the Connection's `testModel`, else the catalogue's (required
   * where the Provider `needsTestModel` and the Connection has none).
   */
  readonly model?: string;
}

/** The Connection a form describes, to test before it is saved. */
export interface ConnectionTestDraft {
  /** The saved Connection being edited: what the draft leaves out is taken from it. */
  readonly id?: string;
  readonly providerId: string;
  readonly apiKey?: string;
  /** Absent: the saved Connection's, else the Provider's default; empty: the default. */
  readonly baseUrl?: string;
  readonly testModel?: string;
}

/** A passed test of a draft: the models it found (the catalogue for Anthropic and Google). */
export interface ConnectionTestPassed {
  readonly models: readonly ModelInfo[];
}

/** One model a Connection offers. An absent capability is unknown, never assumed missing. */
export interface ModelInfo {
  /** The model name at the Provider, without the Provider prefix. */
  readonly id: string;
  /** The context window, in tokens. */
  readonly contextWindow?: number;
  /** Whether it supports tool calling. */
  readonly tools?: boolean;
  /** Whether it accepts images. */
  readonly vision?: boolean;
}

/** A saved Connection as the renderer sees it; its secret never leaves the Runtime. */
export interface ConnectionSummary {
  /** The Connection id: the Provider id, or `openai-compatible:<slug>` for a custom endpoint. */
  readonly id: string;
  readonly providerId: string;
  /** The custom endpoint's name, else the Provider's English name. */
  readonly displayName: string;
  /** Whether the Provider runs on this machine (Ollama, LM Studio). */
  readonly local: boolean;
  /** A disabled Connection is kept, but nothing resolves to it and the Gateway cannot use it. */
  readonly enabled: boolean;
  /** Where its requests go: its own base URL, else the Provider's default. */
  readonly baseUrl: string;
  /**
   * The last 4 characters of the stored key (`''` for a key too short to show any); null when the
   * Connection has no key.
   */
  readonly keyHint: string | null;
  /** When the Connection was last tested, ISO-8601 UTC; null when never. */
  readonly lastTestedAt: string | null;
  readonly lastTestOk: boolean | null;
  /** The Provider's own error text from the last failed test, when it sent some. */
  readonly lastTestError: string | null;
  /**
   * Why the last test failed when there is no Provider text to show: the Provider did not answer
   * in time, or answered with something its API does not return. The UI shows the
   * `error.<lastTestFailure>` catalog entry. Null otherwise.
   */
  readonly lastTestFailure: ConnectionTestFailure | null;
  /**
   * The model the User named for the last passed test, which tests that name none use again;
   * null when it used the catalogue's.
   */
  readonly testModel: string | null;
  /**
   * The model names known without a network call: the catalogue's, or a live listing from the
   * last 10 minutes; empty otherwise. `connections.models` lists them with what is known of each.
   */
  readonly models: readonly string[];
}

/** A failed Connection test's reason, where the Provider sent no text of its own. */
export type ConnectionTestFailure = 'provider_timeout' | 'unexpected_response';

/** A global Slot Binding: the Default Model for one Slot name. */
export interface GlobalBinding {
  readonly slot: string;
  readonly connectionId: string;
  /** The model name at that Connection's Provider, without the Provider prefix. */
  readonly model: string;
}

export type IpcMethodName = keyof IpcMethods;
export type IpcInput<M extends IpcMethodName> = IpcMethods[M]['input'];
export type IpcOutput<M extends IpcMethodName> = IpcMethods[M]['output'];

// A record keyed by every method name fails to compile when a method is added to IpcMethods but
// not here, or listed here but not in IpcMethods.
const METHOD_NAMES: Readonly<Record<IpcMethodName, true>> = {
  'app.ping': true,
  'app.status': true,
  'app.quit': true,
  'settings.get': true,
  'settings.set': true,
  'diagnostics.get': true,
  'connectivity.get': true,
  'connectivity.check': true,
  'providers.list': true,
  'connections.detectLocal': true,
  'connections.list': true,
  'connections.add': true,
  'connections.update': true,
  'connections.test': true,
  'connections.testDraft': true,
  'connections.models': true,
  'connections.remove': true,
  'bindings.getGlobal': true,
};

/** The method names at runtime; the preload builds `window.api` from this list. */
export const IPC_METHODS = Object.freeze(Object.keys(METHOD_NAMES) as IpcMethodName[]);

/**
 * Events main pushes to the renderer: name → payload. `progress:<jobId>` is reserved for
 * long-running jobs (downloads, uploads, launch readiness); its payload is defined by its first
 * producer.
 */
export interface IpcEvents {
  /** The Store's connectivity changed; sent on every change, never twice for the same state. */
  'connectivity.changed': Connectivity;
  [event: `progress:${string}`]: unknown;
}

export type IpcEventName = keyof IpcEvents;

export interface IpcRequest {
  readonly method: string;
  readonly input?: unknown;
}

export interface IpcEventMessage {
  readonly event: string;
  readonly payload: unknown;
}

/** The single channel `ipcRenderer.invoke` uses for every method. */
export const IPC_INVOKE_CHANNEL = 'harness-store:invoke';
/** The single channel main uses to push every event. */
export const IPC_EVENT_CHANNEL = 'harness-store:event';

export function isIpcEventName(name: string): name is IpcEventName {
  return name === 'connectivity.changed' || /^progress:.+$/.test(name);
}

type Domain<M extends string> = M extends `${infer D}.${string}` ? D : never;
type Verb<M extends string, D extends string> = M extends `${D}.${infer V}` ? V : never;

type MethodFunction<M extends IpcMethodName> = [IpcInput<M>] extends [undefined]
  ? () => Promise<IpcResult<IpcOutput<M>>>
  : (input: IpcInput<M>) => Promise<IpcResult<IpcOutput<M>>>;

/** Subscribes to one event; returns the function that unsubscribes. */
export type IpcSubscribe = <E extends IpcEventName>(
  event: E,
  listener: (payload: IpcEvents[E]) => void,
) => () => void;

/** The only object the renderer sees: `window.api.<domain>.<verb>(input)` plus `on`. */
export type DesktopApi = {
  readonly [D in Domain<IpcMethodName>]: {
    readonly [V in Verb<IpcMethodName, D>]: MethodFunction<Extract<`${D}.${V}`, IpcMethodName>>;
  };
} & { readonly on: IpcSubscribe };
