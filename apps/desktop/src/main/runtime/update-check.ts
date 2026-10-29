import { validateManifest, type Manifest, type Platform } from '@harness-store/manifest';
import semver from 'semver';
import type { Connectivity, InstalledHarness, InstallStoreStatus } from '../../shared/ipc.js';
import { entryFor } from './harness-paths.js';
import type { InstallStore, UpdateCheckResult } from './install-store.js';
import type { StoreFetch } from './store-auth.js';

/** The first check waits this long after the app started (docs/ux/flows.md F4). */
export const FIRST_UPDATE_CHECK_DELAY_MS = 10_000;

/**
 * Then a check runs this often by default: the `update_check_interval` setting's `6h`, which the
 * User can change to 1 hour, 24 hours or Never in Settings (P0-11.2).
 */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** `latest_versions` takes at most this many IDs per call (api.md). */
export const LATEST_VERSIONS_MAX_IDS = 1000;

/** One `latest_versions` call gives up after this long. */
const CALL_TIMEOUT_MS = 15_000;

export interface UpdateCheckOptions {
  readonly store: InstallStore;
  /** The installed Harnesses, read once the installer cleaned up after an interrupted install. */
  readonly installs: () => Promise<
    readonly Pick<InstalledHarness, 'harnessId' | 'source' | 'version'>[]
  >;
  /** Makes the Store calls (Electron's `net.fetch`, so system proxies apply). */
  readonly fetch: StoreFetch;
  /** The Store base URL, read on every check (the `store_base_url` setting). */
  readonly storeBaseUrl: () => string;
  /** The Store's anon key: the update check needs no account. */
  readonly anonKey: string;
  /** This machine's platform; an update that does not declare it is not offered. */
  readonly platform: Platform | null;
  /** Whether the Store is reachable; told when a check got no answer. */
  readonly connectivity: { get(): Connectivity; reportFailure(): void };
  /** Told for each installed Harness whose row the check changed. */
  readonly onChanged?: (harnessId: string) => void;
  /** Default: {@link FIRST_UPDATE_CHECK_DELAY_MS}. */
  readonly firstDelayMs?: number;
  /**
   * The time between checks, read each time a check is scheduled (the `update_check_interval`
   * setting); null for Never. Default: always {@link UPDATE_CHECK_INTERVAL_MS}.
   */
  readonly intervalMs?: () => number | null;
}

export interface UpdateChecker {
  /**
   * Schedules the first check after the delay, then one every interval; with Never, nothing at
   * all, not even the first check.
   */
  start(): void;
  /**
   * Checks now, whatever the interval; joins the check in flight if there is one. Resolves
   * whether the Store answered every call as api.md says: false offline, or when it did not, in
   * which case nothing changed. Never rejects.
   */
  check(): Promise<boolean>;
  /**
   * Once started, replaces the scheduled check with one a whole interval from now, as read now
   * (none for Never); the interval setting changed. Checks nothing now.
   */
  reschedule(): void;
  /** Cancels the scheduled checks; a check in flight changes nothing more. */
  stop(): void;
}

/**
 * The background update check (P0-10.2; docs/ux/flows.md F4 step 1): 10 seconds after start and
 * then every interval (6 hours unless the User chose 1 hour, 24 hours or Never), it asks the
 * Store's `latest_versions` (api.md) about every installed Store Harness (never a local install)
 * and its installed version, in calls of at most 1000 IDs with the anon key, and stores per install
 * its Store status, the update it can take when there is one, and whether the installed version
 * itself was taken down ({@link resolveUpdateCheck}; kept as it was for an install updated since
 * the Store was asked). Each install whose row changed is reported, so the Library and its nav
 * badge read the list again.
 *
 * While the Store is known to be offline the check is skipped; a check that gets no answer has
 * connectivity checked again and is dropped silently. Nothing is retried: the next scheduled check
 * runs, also when the Store comes back. With Never no check is ever scheduled; only `check`
 * (Settings' Check now) runs one.
 */
export function createUpdateChecker(options: UpdateCheckOptions): UpdateChecker {
  const firstDelayMs = options.firstDelayMs ?? FIRST_UPDATE_CHECK_DELAY_MS;
  const intervalMs = options.intervalMs ?? (() => UPDATE_CHECK_INTERVAL_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<boolean> | null = null;
  let started = false;
  let stopped = false;

  /**
   * One `latest_versions` call about these installs; null when the Store did not answer as
   * api.md says.
   */
  const latestVersions = async (
    installs: readonly { readonly harnessId: string; readonly version: string }[],
  ): Promise<unknown[] | null> => {
    const base = options.storeBaseUrl().replace(/\/+$/, '');
    let response: Response;
    let text: string;
    try {
      response = await options.fetch(`${base}/rest/v1/rpc/latest_versions`, {
        method: 'POST',
        headers: {
          apikey: options.anonKey,
          authorization: `Bearer ${options.anonKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          harness_ids: installs.map((install) => install.harnessId),
          installed_versions: installs.map((install) => install.version),
        }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      text = await response.text();
    } catch {
      options.connectivity.reportFailure();
      return null;
    }
    if (!response.ok) return null;
    try {
      const rows = JSON.parse(text) as unknown;
      return Array.isArray(rows) ? rows : null;
    } catch {
      return null;
    }
  };

  /** One check; whether the Store answered every call. */
  const run = async (): Promise<boolean> => {
    if (options.connectivity.get().state === 'offline') return false;
    const installs = (await options.installs()).filter((install) => install.source === 'store');
    for (let at = 0; at < installs.length && !stopped; at += LATEST_VERSIONS_MAX_IDS) {
      const batch = installs.slice(at, at + LATEST_VERSIONS_MAX_IDS);
      const rows = await latestVersions(batch);
      if (rows === null) return false;
      // The version each install was at when the Store was asked; one install per Harness ID.
      const asked = new Map(batch.map((install) => [install.harnessId, install.version]));
      for (const row of rows) {
        const answer = parseLatestVersion(row);
        if (answer === null) continue;
        // Read and written in one step: no install or update can come in between.
        const install = options.store.get(answer.harnessId);
        if (install?.source !== 'store') continue;
        const result = resolveUpdateCheck(install.version, answer, options.platform);
        // The installed version's status is of the version asked about; another version
        // installed since keeps what its install wrote.
        const checked =
          asked.get(answer.harnessId) === install.version
            ? result
            : { ...result, installedVersionTakenDown: install.installedVersionTakenDown };
        if (options.store.recordUpdateCheck(answer.harnessId, install.version, checked)) {
          options.onChanged?.(answer.harnessId);
        }
      }
    }
    return true;
  };

  const check = (): Promise<boolean> => {
    if (stopped) return Promise.resolve(false);
    inFlight ??= run()
      .catch(() => false) // The database closed (the app quits): nothing to report.
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  /**
   * Runs a check after `delay` (none for null), reading the interval again when it is due: Never
   * by then checks nothing; otherwise the next check is scheduled a whole interval later.
   */
  const schedule = (delay: number | null) => {
    clearTimeout(timer);
    timer = undefined;
    if (delay === null) return;
    timer = setTimeout(() => {
      if (stopped) return;
      const next = intervalMs();
      schedule(next);
      if (next !== null) void check();
    }, delay);
  };

  return {
    start() {
      if (stopped || started) return;
      started = true;
      // Never skips the startup check too.
      schedule(intervalMs() === null ? null : firstDelayMs);
    },
    check,
    reschedule() {
      if (started && !stopped) schedule(intervalMs());
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}

/** One row of `latest_versions` (api.md), its Manifest validated. */
export interface LatestVersion {
  readonly harnessId: string;
  readonly storeStatus: 'available' | 'unpublished' | 'taken_down' | 'not_found';
  /** Both present exactly when `available`. */
  readonly latestVersion: string | null;
  readonly manifest: Manifest | null;
  /** The status of the installed version asked about; null when the Store does not know it. */
  readonly installedVersionStatus: 'published' | 'unpublished' | 'taken_down' | null;
}

const VERSION_STATUSES: ReadonlySet<unknown> = new Set(['published', 'unpublished', 'taken_down']);

/**
 * The row, or null when it is not what api.md says `latest_versions` answers: an unknown status
 * or installed version status, or an `available` row whose latest version is not a valid Manifest
 * of that Harness and version. Such a row is skipped, and the install keeps what the last check
 * said. A missing installed version status reads as null.
 */
export function parseLatestVersion(row: unknown): LatestVersion | null {
  if (typeof row !== 'object' || row === null) return null;
  const {
    harness_id: harnessId,
    store_status: storeStatus,
    installed_version_status: installed = null,
  } = row as Record<string, unknown>;
  if (typeof harnessId !== 'string') return null;
  if (installed !== null && !VERSION_STATUSES.has(installed)) return null;
  const installedVersionStatus = installed as LatestVersion['installedVersionStatus'];
  if (storeStatus !== 'available') {
    return storeStatus === 'unpublished' ||
      storeStatus === 'taken_down' ||
      storeStatus === 'not_found'
      ? { harnessId, storeStatus, latestVersion: null, manifest: null, installedVersionStatus }
      : null;
  }
  const { latest_version: latestVersion, manifest } = row as Record<string, unknown>;
  if (typeof latestVersion !== 'string') return null;
  const validation = validateManifest(manifest);
  if (
    !validation.ok ||
    validation.manifest.id !== harnessId ||
    validation.manifest.version !== latestVersion
  ) {
    return null;
  }
  return {
    harnessId,
    storeStatus,
    latestVersion,
    manifest: validation.manifest,
    installedVersionStatus,
  };
}

/**
 * What an update check stores for an install at `installedVersion` (P0-10 spec, "Update check"):
 * `not_found` is kept as `unpublished`; an update is offered only when the Harness is `available`,
 * its latest version is greater (semver) than the installed one, never merely different (taking
 * down or Unpublishing the latest version moves it back, possibly below the installed one), and
 * its Manifest declares this platform, with an Entry for it, so Update never asks for a package
 * the Store does not have. The installed version taken down (P0-12.2 follow-up) is stored apart
 * from the Harness's status and leaves the update offered: updating is the remedy.
 */
export function resolveUpdateCheck(
  installedVersion: string,
  answer: LatestVersion,
  platform: Platform | null,
): UpdateCheckResult {
  const storeStatus: InstallStoreStatus =
    answer.storeStatus === 'not_found' ? 'unpublished' : answer.storeStatus;
  const { latestVersion, manifest } = answer;
  const offered =
    storeStatus === 'available' &&
    latestVersion !== null &&
    manifest !== null &&
    semver.valid(latestVersion) !== null &&
    semver.valid(installedVersion) !== null &&
    semver.gt(latestVersion, installedVersion) &&
    entryFor(manifest, platform) !== null;
  return {
    storeStatus,
    available: offered ? { version: latestVersion, manifest } : null,
    installedVersionTakenDown: answer.installedVersionStatus === 'taken_down',
  };
}
