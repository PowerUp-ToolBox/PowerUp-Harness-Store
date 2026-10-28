/**
 * The IPC contract between the renderer and the Runtime (main process), defined once and used by
 * the main handlers, the preload bridge and the renderer. It is types plus a few constants; it
 * imports only types, so every process can bundle it.
 *
 * Transport: one `ipcMain.handle` channel carries `{ method, input }` and always resolves to an
 * {@link IpcResult}; one event channel carries `{ event, payload }` from main to the renderer.
 */

import type {
  DeclaredPermissions,
  Manifest,
  Platform,
  Problem,
  Tag,
} from '@harness-store/manifest';
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
   * A Store read got an answer that is not what api.md says it returns: a 5xx, another refusal or
   * a body that is not the rows it asked for. The Store answers, so this is not offline.
   */
  | 'store_error'
  /**
   * The Store refused the Publisher's session (a 401), or nobody is signed in: the session is
   * ended (`session_expired`) and the Publish screen asks to sign in again.
   */
  | 'unauthenticated'
  /** The Store refused a Harness Package whose ID is not the signed-in Publisher's; `problems`. */
  | 'publisher_mismatch'
  /**
   * The Store already has this version of the Harness or a greater one (any status); `problems`,
   * except when another publish of it got there first.
   */
  | 'version_not_greater'
  /** The Store found problems in the Harness Package; `problems` lists them. */
  | 'invalid_manifest'
  /** The Harness Package, or its icon, is larger than the Store takes. */
  | 'package_too_large'
  /** The Publisher published too many versions lately (20 per 24 hours). */
  | 'rate_limited'
  /** The Harness was taken down: it gets no new version, and its versions cannot be Unpublished. */
  | 'harness_taken_down'
  /** The Store refused the call: the Harness is another Publisher's. */
  | 'forbidden'
  /** The Store has no such Harness or version (or none the Publisher can see). */
  | 'not_found'
  /** The Publisher cancelled the upload (`publish.cancel`) before it was all sent. */
  | 'upload_cancelled'
  /**
   * A downloaded Harness Package is not the one the Store described: another size or SHA-256
   * than its `download` answer. Nothing of it was kept.
   */
  | 'checksum_mismatch'
  /**
   * A downloaded Harness Package matched the Store's checksum but cannot be installed safely: it
   * does not validate (an unsafe archive entry included), cannot be unpacked, or its Manifest is
   * not the one the Store answered with. Nothing of it was kept.
   */
  | 'integrity_error'
  /** The User cancelled the download (`installs.cancel`). Nothing of it was kept. */
  | 'download_cancelled'
  /** The Store has no package of this Harness Version for this machine's platform. */
  | 'platform_not_supported'
  /**
   * An update widens the Declared Permissions, or changes the Entry or the runtime kind, and the
   * User did not consent to it again (`installs.update` without `reconsented`). Nothing changed.
   */
  | 'reconsent_required'
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
  /**
   * The OS could not open a log, logs folder or Data Directory (Electron `shell.openPath`
   * failed: on Linux, say, no app is set up for it). The `path` param names it, so the User can
   * open it another way.
   */
  | 'open_failed'
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
  /**
   * English text, the last fallback when the catalog cannot render `messageKey`. For a refusal
   * from the Store, the Store's own message.
   */
  readonly message: string;
  /**
   * The problems the Store found in a Harness Package it refused (`invalid_manifest`,
   * `package_too_large`, `publisher_mismatch`, `version_not_greater`), exactly as its
   * `validatePackage` returned them: shown by `manifest.<messageKey>`.
   */
  readonly problems?: readonly Problem[];
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
  /**
   * The Store home (P0-09.1): Featured, Most downloaded and New, read anonymously with api.md's
   * three home reads at once. The answer is kept in memory for 5 minutes per Store base URL;
   * `refresh` (Retry) reads again. `store_unreachable` when the Store did not answer (connectivity
   * is checked again), `store_error` when it answered with something else.
   */
  'store.home': { input: StoreHomeRequest; output: StoreHome };
  /**
   * One page of a Store search (P0-09.2): `search_harnesses` with the anon key, at most
   * {@link STORE_SEARCH_PAGE_SIZE} results in the Store's order (never re-sorted), limited to this
   * machine's platform unless `allPlatforms`. Never kept in memory. `store_unreachable` when the
   * Store did not answer (connectivity is checked again), `store_error` when it answered with
   * something else.
   */
  'store.search': { input: StoreSearchRequest; output: StoreSearchPage };
  /**
   * A Harness's Store detail page (P0-09.3), by Harness ID: api.md's detail read (published
   * versions only, newest first), then its latest version's Manifest, README and screenshots,
   * read anonymously and never kept in memory. A Harness the Store does not show answers its
   * status from `latest_versions` and no page. `store_unreachable` when the Store did not answer
   * (connectivity is checked again), `store_error` when it answered with something else, a
   * Manifest that does not validate included.
   */
  'store.detail': { input: string; output: StoreDetail };
  /**
   * A Publisher's Store page (P0-09.4), by GitHub login: api.md's Publisher page read, anonymous
   * and never kept in memory, so it lists exactly the Harnesses every User sees (active, with a
   * published version), most downloaded first. A login with no profile answers `publisher: null`.
   * `store_unreachable` when the Store did not answer (connectivity is checked again),
   * `store_error` when it answered with something else.
   */
  'store.publisher': { input: string; output: StorePublisherPage };
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
   * What every Model Slot of a Manifest would resolve to right now, installed or not (the Store
   * detail page's "Will use"): the same resolution as `bindings.resolveAll`, over the Slots and
   * Recommended Models given, with the Harness's Model Overrides when it has some. `default`
   * first, then in the given order. Model Requirements are not checked: they only warn.
   */
  'bindings.resolveManifest': { input: ManifestSlotsRequest; output: readonly ResolvedSlot[] };
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
   * Installs a Harness from the Store (docs/ux/flows.md F2), up to the consent dialog: calls the
   * Store's `download` function for its latest version on this machine's platform, streams the
   * Harness Package into the downloads folder (`progress:<jobId>` events report
   * {@link DownloadProgress}; subscribe before calling), checks its size and SHA-256 against the
   * Store's, validates it and checks its Manifest is the Store's, which must be one of this
   * Harness. Answers what the consent dialog shows once the package waits for consent:
   * `installs.confirm` installs it, `installs.cancel` discards it; main discards it too when the
   * main window's page closes, crashes or loads again, as only that page knows the job. `invalid_input` for a Harness already installed (also locally) or a job ID in
   * use; `harness_installing` while it is being installed; `not_found`, `platform_not_supported`,
   * `store_unreachable`, `store_error`; `checksum_mismatch`, `integrity_error`;
   * `download_cancelled`. On any failure nothing of the download is left.
   */
  'installs.install': { input: StoreInstallRequest; output: ManifestSummary };
  /**
   * The User consented: unpacks the package that `installs.install` downloaded for this job into
   * the install layout and records the install, which `installs.changed` reports. On a failure
   * (`integrity_error`) nothing is left. `invalid_input` for a job not waiting for consent.
   */
  'installs.confirm': { input: string; output: InstalledVersion };
  /**
   * Cancels the Store install `jobId` while it downloads (its `installs.install` then answers
   * `download_cancelled`) or waits for consent, deleting what it downloaded. Once it is
   * unpacking it changes nothing, and neither does an unknown or finished job.
   */
  'installs.cancel': { input: string; output: null };
  /**
   * Updates a Store install to `version` (docs/ux/flows.md F4), the one the update prompt showed:
   * calls the Store's `download` function for that version, streams it as `installs.install` does
   * (`progress:<jobId>`, cancelled by `installs.cancel`), checks its size, SHA-256 and Manifest,
   * then compares that Manifest with the installed one (`diffForReconsent`): when it widens the
   * Declared Permissions or changes the Entry or the runtime kind and `reconsented` is false, it
   * answers `reconsent_required` before unpacking anything. Otherwise it unpacks the new version
   * next to the old one, switches the `installs` row to it (`installs.changed`), then deletes the
   * old version's folder; the Data Directory is never touched. Until the switch, the old version
   * stays installed and launchable, whatever fails. `not_installed`; `invalid_input` for a local
   * install, a version not greater than the installed one or a job ID in use;
   * `harness_installing` while it is being installed or updated; `harness_running` while it runs
   * (checked when asked, and again just before the switch); and the download's errors of
   * `installs.install`.
   */
  'installs.update': { input: StoreUpdateRequest; output: InstalledVersion };
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
   * `default` Model Slot, and nothing starts; `invalid_input` when `workspace` is not an absolute
   * path, or, for a Harness that takes a Workspace and does not run, not an existing folder (any
   * more).
   */
  'launch.start': { input: LaunchRequest; output: LaunchStarted };
  /**
   * Opens the OS folder picker over the main window to choose a Workspace for this installed
   * Harness, at its last Workspace while that folder exists; the chosen folder's absolute path, or
   * null when the User cancelled. `not_installed`.
   */
  'launch.chooseWorkspace': { input: string; output: string | null };
  /**
   * The Workspace this installed Harness was last launched with, for the Workspace sheet; null
   * when it never had one. `not_installed`.
   */
  'launch.lastWorkspace': { input: string; output: LastWorkspace | null };
  /** The latest launch of every Harness launched since the app started. */
  'launch.status': { input: undefined; output: readonly LaunchStatus[] };
  /**
   * Opens this installed Harness's newest launch log in the OS's app for it: its latest launch's
   * log, else the most recently written one; its logs folder (created) before it has any. Main
   * computes the path; `not_installed`, and `open_failed` when the OS could not open it.
   */
  'launch.openLogs': { input: string; output: null };
  /**
   * Opens this installed Harness's Data Directory in the OS file browser, creating it when
   * missing. Main computes the path; `not_installed`, and `open_failed` when the OS could not
   * open it.
   */
  'launch.openDataFolder': { input: string; output: null };
  /**
   * Builds the Harness Package of the folder at this absolute path, exactly as the Publish flow
   * uploads it (a deterministic zip of what the exclusion rules keep), and validates that zip
   * with `validatePackage`, passing the signed-in Publisher's login and, when the Harness ID is
   * theirs, every version of it the Store has (any status). Starts watching the folder
   * (`publish.folderChanged`), replacing the folder watched before. Only the latest run's zip is
   * kept; a run that a newer one replaced answers `package_invalid`. `invalid_input` for a path
   * that is not a folder (a dropped file); `package_invalid` for a folder that cannot be read;
   * `file_unreadable` for a file in it that the User's account cannot open.
   */
  'publish.validateFolder': { input: string; output: FolderValidation };
  /** Stops watching the folder `publish.validateFolder` watches; nothing to stop is fine. */
  'publish.stopWatching': { input: undefined; output: null };
  /**
   * Uploads the Harness Package `publish.validateFolder` built (`archiveId`) to the Store's
   * `publish` function with the Publisher's session, and resolves once the Store answered: the
   * new Harness Version and its listing's route. While the body is sent, `progress:<jobId>`
   * events report `UploadProgress`; subscribe before calling. `package_invalid` when the archive
   * is not the latest validation's, or that one found problems (validate again);
   * `unauthenticated` (the session is ended, `session_expired`); `upload_cancelled`
   * (`publish.cancel`); `store_unreachable`; the Store's refusals by its code, with its
   * `problems`.
   */
  'publish.publish': { input: PublishRequest; output: PublishedVersion };
  /**
   * Cancels the upload `jobId` while its body is still being sent: `publish.publish` then answers
   * `upload_cancelled`, and the Store keeps nothing. Once all of it is sent it changes nothing (the
   * Store may already be saving it), and neither does an unknown or finished job.
   */
  'publish.cancel': { input: string; output: null };
  /**
   * The signed-in Publisher's Harnesses and every Harness Version of them the Store has, in any
   * status (published, Unpublished, taken down with the administrator's note), read with their
   * session (api.md, "Own versions"), with each Harness's own status from `latest_versions`.
   * `unauthenticated` when nobody is signed in or the Store refused the session (which is then
   * ended, `session_expired`); `store_unreachable`.
   */
  'publish.myHarnesses': { input: undefined; output: readonly OwnHarness[] };
  /**
   * Unpublishes one of the Publisher's Harness Versions through the Store's `unpublish`
   * function: it can no longer be downloaded, and existing installs keep working. One already
   * Unpublished is a success too. `unauthenticated` (the session is ended); `forbidden`,
   * `not_found`, `harness_taken_down` (a taken-down Harness or version); `store_unreachable`.
   */
  'publish.unpublish': { input: UnpublishRequest; output: UnpublishedVersion };
}

/** Which Harness Package to upload, and the job its progress events are named after. */
export interface PublishRequest {
  /** From `publish.validateFolder`. */
  readonly archiveId: string;
  /** Chosen by the renderer (a UUID): the events are `progress:<jobId>`. */
  readonly jobId: string;
}

/** The Harness Version the Store published. */
export interface PublishedVersion {
  readonly harnessId: string;
  readonly version: string;
  /** The listing's in-app route, `/store/h/<publisher>/<slug>`. */
  readonly url: string;
}

/** The payload of `progress:<jobId>` for an upload: bytes of the request body sent so far. */
export interface UploadProgress {
  readonly sent: number;
  readonly total: number;
}

/** A Harness Version's status in the Store. */
export type HarnessVersionStatus = 'published' | 'unpublished' | 'taken_down';

/**
 * A Harness's own status in the Store (`latest_versions`): `available` with a published version,
 * `unpublished` with none left, `taken_down` by an administrator, or `not_found`.
 */
export type HarnessStoreStatus = 'available' | 'unpublished' | 'taken_down' | 'not_found';

/** One of the signed-in Publisher's Harnesses, as My Harnesses lists it. */
export interface OwnHarness {
  readonly harnessId: string;
  /** The Manifest name of its newest Harness Version. */
  readonly name: string;
  readonly storeStatus: HarnessStoreStatus;
  /** The version the Store offers (its latest published one); null when not `available`. */
  readonly latestVersion: string | null;
  /** The downloads of all its versions. */
  readonly downloadCount: number;
  /** Every Harness Version, newest published first. */
  readonly versions: readonly OwnVersion[];
}

/** One of the Publisher's Harness Versions, in any status. */
export interface OwnVersion {
  readonly version: string;
  readonly status: HarnessVersionStatus;
  /** ISO-8601. */
  readonly publishedAt: string;
  /** ISO-8601; null unless Unpublished. */
  readonly unpublishedAt: string | null;
  /** The administrator's note on a taken-down version; null otherwise. */
  readonly takedownNote: string | null;
  readonly downloadCount: number;
}

/** Which Harness Version to Unpublish. */
export interface UnpublishRequest {
  readonly harnessId: string;
  readonly version: string;
}

/** The Harness Version Unpublished, and the Harness's latest published version since. */
export interface UnpublishedVersion {
  readonly harnessId: string;
  readonly version: string;
  /** Null when no published version is left. */
  readonly latestVersion: string | null;
}

/** Which installed Harness to launch, and with which Workspace. */
export interface LaunchRequest {
  readonly harnessId: string;
  /**
   * The absolute path of the Workspace the User chose (`launch.chooseWorkspace`); null or absent
   * when they chose none: a Harness whose Manifest requires one then fails
   * `workspace_cancelled`, an optional one launches without. Ignored for a Harness whose Manifest
   * declares no Workspace.
   */
  readonly workspace?: string | null;
}

/** A Harness's last Workspace (`installs.last_workspace`), which may be gone since. */
export interface LastWorkspace {
  /** Absolute. */
  readonly path: string;
  /** Whether it is still a folder. */
  readonly exists: boolean;
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

/** Which Harness to install from the Store, and the job its progress events are named after. */
export interface StoreInstallRequest {
  readonly harnessId: string;
  /** Chosen by the renderer (a UUID): the events are `progress:<jobId>`. */
  readonly jobId: string;
}

/** Which Store install to update, to which version, and the job its progress events are named after. */
export interface StoreUpdateRequest {
  readonly harnessId: string;
  /** The version the update prompt showed: its Manifest is the one compared and installed. */
  readonly version: string;
  /** Chosen by the renderer (a UUID): the events are `progress:<jobId>`. */
  readonly jobId: string;
  /** The User consented to what the update changes (the re-consent prompt's Update). */
  readonly reconsented: boolean;
}

/**
 * The payload of `progress:<jobId>` for a download: bytes of the Harness Package received so far,
 * of the size the Store reported.
 */
export interface DownloadProgress {
  readonly received: number;
  readonly total: number;
}

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

/**
 * Whether the Store was asked for the Publisher's earlier versions of the Harness: `checked`;
 * `skipped` when nobody is signed in, the Manifest has no Harness ID or the ID is another
 * Publisher's; `failed` when the Store did not answer (it checks again on upload).
 */
export type VersionCheck = 'checked' | 'skipped' | 'failed';

/** A folder's Harness Package as the Publish flow built and validated it. */
export interface FolderValidation {
  /** Names the zip main keeps for the upload; null when none could be built (too large). */
  readonly archiveId: string | null;
  /** Every problem, ordered by path: shown by `manifest.<messageKey>`. Publishing needs none. */
  readonly problems: readonly Problem[];
  /** Findings that never block publishing. */
  readonly warnings: readonly Problem[];
  /** The Manifest, present exactly when there is no problem. */
  readonly manifest: Manifest | null;
  /** `assets/icon.png` of the zip as a `data:` URL, null when it has none that can be read. */
  readonly iconDataUrl: string | null;
  /** README.md of the zip (its first 1 MiB), null when it has none. */
  readonly readme: string | null;
  /** What the zip leaves out, topmost only: a folder as `dir/`, a file by its path. */
  readonly excluded: readonly string[];
  /** The zip's size in bytes. */
  readonly archiveSize: number;
  readonly versionCheck: VersionCheck;
  /** The highest version the Store has of this Harness (any status); null when none or unchecked. */
  readonly lastPublishedVersion: string | null;
  /** The Store has no version of this Harness yet; false when unchecked. */
  readonly isNew: boolean;
}

/** The watched Harness folder changed on disk (outside what the Publish flow leaves out). */
export interface PublishFolderChanged {
  /** Absolute, as given to `publish.validateFolder`. */
  readonly path: string;
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
  /**
   * What the last update check said of it in the Store; null before the first check, and always
   * for a local install, which is never checked.
   */
  readonly storeStatus: InstallStoreStatus | null;
  /**
   * The newer version the Store offers, which runs on this platform; null when there is none (a
   * local install, a Harness the Store no longer offers, or no check yet).
   */
  readonly availableUpdate: AvailableUpdate | null;
}

/**
 * A Store install's status as the update check stores it: `latest_versions`' `store_status`, its
 * `not_found` (a Harness the Store no longer has) kept as `unpublished`.
 */
export type InstallStoreStatus = 'available' | 'unpublished' | 'taken_down';

/** A newer Harness Version the Store offers for an installed Harness. */
export interface AvailableUpdate {
  readonly version: string;
  /** Its full Manifest: the changelog, and what `diffForReconsent` compares. */
  readonly manifest: Manifest;
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

/** How to read the Store home. */
export interface StoreHomeRequest {
  /** Read the Store again even when the answer kept in memory is less than 5 minutes old. */
  readonly refresh?: boolean;
}

/** The Store home's three rows, each at most 12 Harnesses in the Store's order. */
export interface StoreHome {
  /**
   * This machine's platform as a Manifest names it, for the platform badges; null on a platform
   * no Manifest can declare.
   */
  readonly platform: Platform | null;
  /** Ascending `featured_rank`. */
  readonly featured: readonly StoreListing[];
  /** By `download_count`, highest first. */
  readonly mostDownloaded: readonly StoreListing[];
  /** By the latest version's `published_at`, newest first. */
  readonly newest: readonly StoreListing[];
}

/** How many results one page of a Store search has; "Load more" asks for the next one. */
export const STORE_SEARCH_PAGE_SIZE = 24;

/** The longest search text `store.search` takes; the search box takes no more. */
export const STORE_SEARCH_MAX_LENGTH = 200;

/** A Store search: text, tags and platform together, and which page. */
export interface StoreSearchRequest {
  /**
   * `websearch_to_tsquery` syntax; blank means no text filter. At most
   * {@link STORE_SEARCH_MAX_LENGTH} characters.
   */
  readonly q: string;
  /** The Harness has every one of them; none means no tag filter. */
  readonly tags: readonly Tag[];
  /** Every platform; false keeps only Harnesses whose latest version declares this machine's. */
  readonly allPlatforms: boolean;
  /** How many results to skip: 0, then one page size more for each "Load more". */
  readonly offset: number;
}

/** One page of Store search results. */
export interface StoreSearchPage {
  /** This machine's platform, as in {@link StoreHome}; null searches every platform. */
  readonly platform: Platform | null;
  /** Most relevant first, as the Store ranks them. */
  readonly listings: readonly StoreListing[];
  /** The page was full: the next one may have more ("Load more"). */
  readonly hasMore: boolean;
}

/** A Harness as a Store list shows it on its card (api.md `<list columns>`). */
export interface StoreListing {
  readonly harnessId: string;
  /** The Publisher's GitHub login: the publisher segment of the Harness ID. */
  readonly publisher: string;
  readonly name: string;
  readonly summary: string;
  /** A `store-asset:` URL of the icon in the Store's asset bucket; null for the monogram. */
  readonly iconUrl: string | null;
  readonly tags: readonly Tag[];
  readonly downloadCount: number;
  /** The latest published Harness Version. */
  readonly latestVersion: string;
  readonly latestPublishedAt: string;
  /** The platforms the latest version declares. */
  readonly platforms: readonly Platform[];
}

/** A Harness's Store detail page, or why there is none (`store.detail`). */
export interface StoreDetail {
  /** This machine's platform, as in {@link StoreHome}. */
  readonly platform: Platform | null;
  /** The Harness's status in the Store; only an `available` one has a page. */
  readonly storeStatus: HarnessStoreStatus;
  /** Everything the page shows; null unless `available`. */
  readonly harness: StoreHarness | null;
}

/** A Harness as its Store detail page shows it: its latest published version, and its history. */
export interface StoreHarness {
  readonly harnessId: string;
  readonly publisher: StorePublisher;
  /** A `store-asset:` URL of the icon in the Store's asset bucket; null for the monogram. */
  readonly iconUrl: string | null;
  /** The downloads of all its versions. */
  readonly downloadCount: number;
  /** The Manifest of the latest published version, as the Store keeps it. */
  readonly manifest: Manifest;
  /** That version's README.md (Markdown); null when it has none. */
  readonly readme: string | null;
  /** `store-asset:` URLs of that version's screenshots, at most five, in order. */
  readonly screenshotUrls: readonly string[];
  /** Every published version, newest first. */
  readonly versions: readonly StoreVersion[];
}

/** The Publisher of a Harness, as their Store profile names them. */
export interface StorePublisher {
  /** The GitHub login: the publisher segment of the Harness ID. */
  readonly login: string;
  readonly displayName: string | null;
  /** Their GitHub avatar (on `https://avatars.githubusercontent.com`); null without one. */
  readonly avatarUrl: string | null;
}

/** A Publisher's Store page, or none for a login with no profile (`store.publisher`). */
export interface StorePublisherPage {
  /** This machine's platform, as in {@link StoreHome}. */
  readonly platform: Platform | null;
  /** The Publisher and their Harnesses; null when no Publisher has this login. */
  readonly publisher: StorePublisherProfile | null;
}

/** A Publisher as their Store page shows them. */
export interface StorePublisherProfile extends StorePublisher {
  /** What they wrote about themselves (plain text); null without it. */
  readonly bio: string | null;
  /** When their profile was made (ISO-8601): the page's join date. Null when unknown or unparseable. */
  readonly joinedAt: string | null;
  /** Their Harnesses every User sees, most downloaded first; none when all are hidden. */
  readonly harnesses: readonly StoreListing[];
}

/** One published Harness Version in a detail page's version history. */
export interface StoreVersion {
  readonly version: string;
  /** ISO-8601. */
  readonly publishedAt: string;
  /** The Manifest's changelog of that version (Markdown); null without one. */
  readonly changelog: string | null;
  /**
   * Its Declared Permissions differ from those of the next older published version; false for
   * the oldest one.
   */
  readonly permissionsChanged: boolean;
}

/**
 * What the Model Slots of a Manifest that is not installed would resolve to on this machine
 * (`bindings.resolveManifest`): the Store detail page's "Will use" note per Slot.
 */
export interface ManifestSlotsRequest {
  /** The Harness's ID: its Model Overrides count when it has some. */
  readonly harnessId: string;
  /** The Manifest's `models`: its Slots and their Recommended Models. */
  readonly models: Manifest['models'];
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
  'store.home': true,
  'store.search': true,
  'store.detail': true,
  'store.publisher': true,
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
  'bindings.resolveManifest': true,
  'auth.signIn': true,
  'auth.signOut': true,
  'auth.whoami': true,
  'installs.chooseFolder': true,
  'installs.inspectFolder': true,
  'installs.installFromFolder': true,
  'installs.install': true,
  'installs.confirm': true,
  'installs.cancel': true,
  'installs.update': true,
  'installs.list': true,
  'launch.start': true,
  'launch.chooseWorkspace': true,
  'launch.lastWorkspace': true,
  'launch.status': true,
  'launch.openLogs': true,
  'launch.openDataFolder': true,
  'publish.validateFolder': true,
  'publish.stopWatching': true,
  'publish.publish': true,
  'publish.cancel': true,
  'publish.myHarnesses': true,
  'publish.unpublish': true,
};

/** The method names at runtime; the preload builds `window.api` from this list. */
export const IPC_METHODS = Object.freeze(Object.keys(METHOD_NAMES) as IpcMethodName[]);

/**
 * Events main pushes to the renderer: name → payload. `progress:<jobId>` is reserved for
 * long-running jobs (downloads, uploads, launch readiness); its payload is defined by its
 * producer: `publish.publish`'s is {@link UploadProgress}, `installs.install`'s and
 * `installs.update`'s {@link DownloadProgress}.
 */
export interface IpcEvents {
  /** The Store's connectivity changed; sent on every change, never twice for the same state. */
  'connectivity.changed': Connectivity;
  /** The Store sign-in state changed; `session_expired` asks the screen in use to sign in again. */
  'auth.changed': AuthChanged;
  /**
   * An installed Harness was installed, replaced or removed, or the update check changed what it
   * says of it; lists read `installs.list` again.
   */
  'installs.changed': InstallsChanged;
  /** A launch changed state; sent on every change, `launch.status` lists the latest ones. */
  'launch.state': LaunchStatus;
  /**
   * Shows a route in the main window: a Harness window's model indicator opens the Models page
   * at that Harness's card.
   */
  'app.navigate': AppNavigate;
  /**
   * The folder `publish.validateFolder` watches changed (500 ms after the last change); the
   * Publish screen validates it again.
   */
  'publish.folderChanged': PublishFolderChanged;
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
    name === 'publish.folderChanged' ||
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

/**
 * The absolute path of a file or folder dropped on the page (Electron's
 * `webUtils.getPathForFile`); `''` for one that has no path on disk.
 */
export type PathForFile = (file: File) => string;

/**
 * The only object the renderer sees: `window.api.<domain>.<verb>(input)`, plus `on` and
 * `pathForFile`, which run in the preload without a call to main.
 */
export type DesktopApi = BridgeCalls<IpcMethods> & {
  readonly on: IpcSubscribe;
  readonly pathForFile: PathForFile;
};
