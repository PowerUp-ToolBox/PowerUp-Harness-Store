/**
 * The IPC contract between the renderer and the Runtime (main process), defined once and used by
 * the main handlers, the preload bridge and the renderer. It is types plus two constant lists; it
 * imports only types, so every process can bundle it.
 *
 * Transport: one `ipcMain.handle` channel carries `{ method, input }` and always resolves to an
 * {@link IpcResult}; one event channel carries `{ event, payload }` from main to the renderer.
 */

import type { DeclaredPermissions, Manifest, Platform, Problem } from '@harness-store/manifest';
import type { Locale } from './i18n/locale.js';

/**
 * Error codes the Runtime returns over IPC: its own, then every Model Gateway code
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
  /** The Store sign-in failed: GitHub or the Store refused it, or the callback carried an error. */
  | 'sign_in_failed'
  /** The browser did not come back to the app within 5 minutes of `auth.signIn`. */
  | 'sign_in_timeout'
  /** A newer `auth.signIn`, or `auth.signOut`, replaced this sign-in before it completed. */
  | 'sign_in_cancelled'
  /** The Store did not answer (network error, timeout or a 5xx). */
  | 'store_unreachable'
  /**
   * A Harness folder is not (or no longer) a valid Harness Package: it cannot be read, fails
   * validation, or its Manifest changed since `installs.inspectFolder` showed it. The problems
   * themselves come from `installs.inspectFolder`, never in the error.
   */
  | 'package_invalid'
  /**
   * A file of a Harness folder that the User's account is not allowed to open, named in the
   * `path` param (relative to the folder). Unlike `package_invalid` it does not go away when the
   * folder is checked again: the User has to fix the file's permissions.
   */
  | 'file_unreadable'
  /** The Harness is running, so it cannot be installed over (or uninstalled) now. */
  | 'harness_running'
  /**
   * An install of the Harness is putting new files in place, so it cannot be launched until the
   * install is done.
   */
  | 'harness_installing'
  /** No Harness with this ID is installed. */
  | 'not_installed'
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
  /**
   * Sets the Default Model of one Slot name, or clears it (`target: null`), and returns the global
   * Slot Bindings as they now are. The Model Gateway uses the change from its next request on. A
   * Connection that does not exist or is disabled answers `provider_not_connected`; a Slot name or
   * model name the Gateway would not accept, `invalid_input`.
   */
  'bindings.setGlobal': { input: GlobalBindingChange; output: readonly GlobalBinding[] };
  /**
   * The Model Overrides of one Harness, by Slot name: every stored row, including one for a Slot
   * its Manifest no longer declares (resolution ignores those). Empty for a Harness without any,
   * installed or not.
   */
  'bindings.getForHarness': { input: string; output: readonly ModelOverride[] };
  /**
   * Overrides one Model Slot of an installed Harness, and returns its Model Overrides as they now
   * are. The Model Gateway uses it from that Harness's next request on, ahead of its Recommended
   * Models and the Default Models. Checked as `bindings.setGlobal` checks a Default Model
   * (`provider_not_connected`, `invalid_input`); a Slot the Harness's Manifest does not declare is
   * `invalid_input`, a Harness that is not installed `not_installed`. The model is not checked
   * against the Slot's Model Requirements: a warning is advisory, never a refusal.
   */
  'bindings.setOverride': { input: ModelOverrideChange; output: readonly ModelOverride[] };
  /**
   * Removes the Model Override of one Slot of a Harness (nothing to remove is fine), and returns
   * its Model Overrides as they now are: resolution goes back to the automatic order.
   */
  'bindings.clearOverride': { input: ModelOverrideClear; output: readonly ModelOverride[] };
  /**
   * What every Model Slot of an installed Harness resolves to right now, and why, exactly as the
   * Model Gateway would resolve it: `default` first, then the Manifest's order. `not_installed`
   * for a Harness that is not installed.
   */
  'bindings.resolveAll': { input: string; output: readonly ResolvedSlot[] };
  /**
   * Signs the Publisher in to the Store with GitHub: opens the User's browser (never a window of
   * the app) on the Store's GitHub sign-in, and resolves once the browser comes back through
   * `harnessstore://auth-callback` and the session is stored encrypted. Fails with
   * `encryption_unavailable` (before opening the browser) when the OS offers no encryption,
   * `sign_in_timeout` after 5 minutes, `sign_in_cancelled` when a newer sign-in or a sign-out
   * replaced it, `sign_in_failed` or `store_unreachable`.
   */
  'auth.signIn': { input: undefined; output: AuthState };
  /** Signs out: revokes the session at the Store when it answers, and deletes the stored one. */
  'auth.signOut': { input: undefined; output: AuthState };
  /**
   * Who is signed in to the Store, with the profile as the Store has it now (the last one seen
   * while the Store does not answer). A session the Store refuses is deleted, and the answer is
   * signed out.
   */
  'auth.whoami': { input: undefined; output: AuthState };
  /**
   * Opens the OS folder picker over the main window; the chosen folder's absolute path, or null
   * when the User cancelled.
   */
  'installs.chooseFolder': { input: undefined; output: string | null };
  /**
   * Validates the Harness folder at this absolute path with `validatePackage`, reading it without
   * writing anything: every problem and warning, and, when it is valid, what the consent dialog
   * shows. A folder that cannot be read answers `package_invalid`.
   */
  'installs.inspectFolder': { input: string; output: FolderInspection };
  /**
   * Installs the Harness folder at this absolute path as a local install, after the User
   * consented: validates it again, copies its files into the install layout and records it.
   * Installing the version already installed replaces it; another version replaces the installed
   * one. `package_invalid` when the folder no longer validates or its Manifest changed since
   * `installs.inspectFolder`; `file_unreadable` when a file of the folder cannot be opened while
   * copying; `harness_running` while that Harness runs.
   */
  'installs.installFromFolder': { input: string; output: InstalledVersion };
  /**
   * Every installed Harness: the most recently launched first, then the never-launched ones, by
   * name.
   */
  'installs.list': { input: undefined; output: readonly InstalledHarness[] };
  /**
   * Launches an installed Harness (docs/tech/architecture.md §4) and answers as soon as its launch
   * has begun; how it goes arrives as `launch.state` events. One instance per Harness: while it
   * runs, the answer is `focused` and its window comes to the front instead (a launch that is
   * stopping is left to stop). `not_installed`; `slot_unbound` when no model can fill its
   * `default` Model Slot, and nothing starts; `not_implemented` for a binary runtime kind
   * (P0-05.5).
   */
  'launch.start': { input: LaunchRequest; output: LaunchStarted };
  /** The latest launch of every Harness launched since the app started. */
  'launch.status': { input: undefined; output: readonly LaunchStatus[] };
}

/** Which installed Harness to launch. */
export interface LaunchRequest {
  readonly harnessId: string;
}

/** A launch that began (`started`), or the running one whose window was focused instead. */
export interface LaunchStarted {
  readonly outcome: 'started' | 'focused';
  readonly launchId: string;
}

/**
 * Where a launch is (P0-05 spec, launch state machine). A Harness never launched since the app
 * started is idle and has no status. `preparing`: resolving its Entry and Data Directory, issuing
 * its Gateway Token; `spawning`: its window is open and the process is being started;
 * `waiting-ready`: a web Harness's process runs, its port does not answer yet (P0-05.3); `ready`:
 * it runs; `stopping`: it was asked to stop (SIGTERM, then SIGKILL after 5 s); `stopped` and
 * `failed`: it has ended, and its Gateway Token is revoked.
 */
export type LaunchState =
  'preparing' | 'spawning' | 'waiting-ready' | 'ready' | 'stopping' | 'stopped' | 'failed';

/**
 * Why a launch failed: the process could not be started (`spawn_error`), never became ready
 * (`ready_timeout`, web), exited on its own with a code other than 0 (`exit_nonzero`), the
 * Harness does not run on this platform (`platform_unsupported`), or the User cancelled the
 * Workspace picker of a Harness that requires one (`workspace_cancelled`).
 */
export type LaunchFailure =
  'spawn_error' | 'ready_timeout' | 'exit_nonzero' | 'platform_unsupported' | 'workspace_cancelled';

/** One launch of a Harness, as `launch.status` lists it and `launch.state` reports it. */
export interface LaunchStatus {
  readonly harnessId: string;
  readonly launchId: string;
  readonly state: LaunchState;
  /** Present exactly when `state` is `failed`. */
  readonly reason?: LaunchFailure;
  /**
   * How the process ended, once it has: its exit code, or 128 + the signal number for a process
   * a signal ended (137 after SIGKILL). Absent before, and when it never started.
   */
  readonly exitCode?: number;
  /** ISO-8601 UTC. */
  readonly startedAt: string;
  /**
   * The last 50 lines of the launch's log (`<ISO-8601> [out|err|runtime] <text>`), present only on
   * `failed(ready_timeout)`, for the Timed-out state.
   */
  readonly logTail?: readonly string[];
}

/** A route of the main window to show, such as `/models?harness=acme%2Fhello`. */
export interface AppNavigate {
  readonly path: string;
}

/** Where an installed Harness Package came from: the Store, or a local folder. */
export type InstallSource = 'store' | 'local';

/** The facts of a valid Manifest that the install consent dialog shows. */
export interface ManifestSummary {
  readonly harnessId: string;
  readonly version: string;
  readonly name: string;
  readonly runtimeKind: Manifest['runtime']['kind'];
  readonly uiKind: Manifest['ui']['kind'];
  /** The Manifest's `workspace`, `none` when absent. */
  readonly workspace: NonNullable<Manifest['workspace']>;
  readonly platforms: readonly Platform[];
  /**
   * The Entry the Runtime runs: the path for a Node Harness; for a binary one, the path for this
   * platform, null when the Harness does not declare it.
   */
  readonly entry: string | null;
  readonly permissions: DeclaredPermissions;
  /** Whether the Harness declares this platform (and, binary, has an Entry for it). */
  readonly platformSupported: boolean;
}

/** What `validatePackage` found in a Harness folder. */
export interface FolderInspection {
  /** Whether it has no problem, so it can be installed. */
  readonly valid: boolean;
  /** Present exactly when `valid`. */
  readonly manifestSummary: ManifestSummary | null;
  /** Every problem, as `validatePackage` returned it: shown by `manifest.<messageKey>`. */
  readonly problems: readonly Problem[];
  /** Findings that do not block installing, such as an ignored key. */
  readonly warnings: readonly Problem[];
}

/** The Harness and version an install put in place. */
export interface InstalledVersion {
  readonly harnessId: string;
  readonly version: string;
}

/** An installed Harness, as the Library and the Models page show it. */
export interface InstalledHarness {
  readonly harnessId: string;
  readonly version: string;
  /** The Manifest's display name. */
  readonly name: string;
  /** The Publisher: the Harness ID's publisher segment. */
  readonly publisher: string;
  readonly source: InstallSource;
  /** The installed Manifest. */
  readonly manifest: Manifest;
  /** The absolute path of the installed files, `harnesses/<publisher>/<slug>/<version>/`. */
  readonly installPath: string;
  /** ISO-8601 UTC. */
  readonly installedAt: string;
  /** ISO-8601 UTC; null until it is first launched. */
  readonly lastLaunchedAt: string | null;
  /**
   * The Harness's `assets/icon.png` as a `data:` URL (the renderer may load no file), null when
   * it cannot be read.
   */
  readonly iconDataUrl: string | null;
  /** Whether it can run on this platform: listed in `platforms`, with an Entry. */
  readonly platformSupported: boolean;
}

/** Which installed Harness changed: installed, replaced by another version, or removed. */
export interface InstallsChanged {
  readonly harnessId: string;
}

/** Whether a Publisher is signed in to the Store, and as whom. */
export type AuthState =
  | { readonly signedIn: false }
  | {
      readonly signedIn: true;
      /** The GitHub login, lower-cased: the publisher segment of the Publisher's Harness IDs. */
      readonly githubLogin: string;
      readonly displayName: string | null;
      readonly avatarUrl: string | null;
    };

/**
 * Why the sign-in state changed: a completed sign-in, a sign-out, or a session the Store no
 * longer accepts (its refresh failed, or a Store call answered 401), which asks to sign in again.
 */
export type AuthChangeReason = 'signed_in' | 'signed_out' | 'session_expired';

export type AuthChanged = AuthState & { readonly reason: AuthChangeReason };

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
  /** Whether it has a JSON output mode. No source states it yet: the catalogue leaves it out. */
  readonly json?: boolean;
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

/** Where a Slot Binding points: one Connection and a model at its Provider. */
export interface BindingTarget {
  readonly connectionId: string;
  /** The model name at that Connection's Provider, without the Provider prefix. */
  readonly model: string;
}

/** A Model Override: the model one Harness uses for one of its Model Slots. */
export interface ModelOverride {
  readonly slot: string;
  readonly connectionId: string;
  /** The model name at that Connection's Provider, without the Provider prefix. */
  readonly model: string;
}

/** A Model Override to set. */
export interface ModelOverrideChange {
  /** The installed Harness. */
  readonly harnessId: string;
  /** One of its Manifest's Model Slots. */
  readonly slot: string;
  readonly target: BindingTarget;
}

/** A Model Override to remove. */
export interface ModelOverrideClear {
  readonly harnessId: string;
  readonly slot: string;
}

/**
 * Why a Model Slot resolved to its model: the Harness's Model Override, one of its Recommended
 * Models, the Default Model of the same Slot name, or the Default Model of `default` (which the
 * `default` Slot's own Default Model also reports). The UI shows the last two as "Default".
 */
export type BindingSource = 'override' | 'recommended' | 'default_same_name' | 'default';

/** The model a Model Slot resolves to, and why. */
export interface ResolvedBinding {
  readonly connectionId: string;
  /** The model name at that Connection's Provider, without the Provider prefix. */
  readonly model: string;
  readonly source: BindingSource;
}

/** One Model Slot of a Harness and what it resolves to; null when nothing can fill it. */
export interface ResolvedSlot {
  readonly slot: string;
  readonly binding: ResolvedBinding | null;
}

/** A change to the Default Model of one Slot name. */
export interface GlobalBindingChange {
  /** The Model Slot name, as a Manifest declares it (`default`, `fast`, …). */
  readonly slot: string;
  /** The model to bind; null clears the Default Model of this Slot name. */
  readonly target: BindingTarget | null;
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
  'bindings.setGlobal': true,
  'bindings.getForHarness': true,
  'bindings.setOverride': true,
  'bindings.clearOverride': true,
  'bindings.resolveAll': true,
  'auth.signIn': true,
  'auth.signOut': true,
  'auth.whoami': true,
  'installs.chooseFolder': true,
  'installs.inspectFolder': true,
  'installs.installFromFolder': true,
  'installs.list': true,
  'launch.start': true,
  'launch.status': true,
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
  /** The Store sign-in state changed; `session_expired` asks the screen in use to sign in again. */
  'auth.changed': AuthChanged;
  /** An installed Harness was installed, replaced or removed; lists read `installs.list` again. */
  'installs.changed': InstallsChanged;
  /** A launch changed state; sent on every change, `launch.status` lists the latest ones. */
  'launch.state': LaunchStatus;
  /**
   * Shows a route in the main window: a Harness window's model indicator opens the Models page
   * at that Harness's card.
   */
  'app.navigate': AppNavigate;
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
  return (
    name === 'connectivity.changed' ||
    name === 'auth.changed' ||
    name === 'installs.changed' ||
    name === 'launch.state' ||
    name === 'app.navigate' ||
    /^progress:.+$/.test(name)
  );
}

type Domain<M extends string> = M extends `${infer D}.${string}` ? D : never;
type Verb<M extends string, D extends string> = M extends `${D}.${infer V}` ? V : never;

type MethodFunction<T> = T extends { input: infer I; output: infer O }
  ? [I] extends [undefined]
    ? () => Promise<IpcResult<O>>
    : (input: I) => Promise<IpcResult<O>>
  : never;

/**
 * The calls of a bridge built from a method table (`'<domain>.<verb>'` → input and output):
 * `bridge.<domain>.<verb>(input)`. `window.api` is the one over {@link IpcMethods}; a Harness
 * window's `window.harness` (./harness-ipc.ts) is another.
 */
export type BridgeCalls<Methods> = {
  readonly [D in Domain<keyof Methods & string>]: {
    readonly [V in Verb<keyof Methods & string, D>]: MethodFunction<
      Methods[Extract<`${D}.${V}`, keyof Methods>]
    >;
  };
};

/** Subscribes to one event; returns the function that unsubscribes. */
export type IpcSubscribe = <E extends IpcEventName>(
  event: E,
  listener: (payload: IpcEvents[E]) => void,
) => () => void;

/** The only object the renderer sees: `window.api.<domain>.<verb>(input)` plus `on`. */
export type DesktopApi = BridgeCalls<IpcMethods> & { readonly on: IpcSubscribe };
