/**
 * Ticket P0-10.2: the background update check on its own, against a temp SQLite file and a fake
 * `latest_versions` (api.md): when it runs (10 s after start, then every 6 hours), what it asks
 * (the Store installs only, never a local one, at most 1000 IDs a call, with the anon key), that
 * it does nothing offline and shows nothing when the Store does not answer, and what it stores
 * per install (an update only when the latest version is greater and runs here; `not_found` kept
 * as `unpublished`; a Takedown of the installed version, which it sends, apart from the Store
 * status), reporting exactly the rows it changed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Manifest } from '@harness-store/manifest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/main/runtime/database.js';
import { createInstallStore, type InstallStore } from '../../src/main/runtime/install-store.js';
import {
  createUpdateChecker,
  FIRST_UPDATE_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateCheckOptions,
} from '../../src/main/runtime/update-check.js';
import type { ConnectivityState, InstallSource } from '../../src/shared/ipc.js';
import { manifestWith } from '../support/manifest.js';

const BASE_URL = 'http://store.test';
const ANON_KEY = 'fake-anon-key';

let root: string;
let db: DatabaseSync;
let store: InstallStore;
/** The `latest_versions` calls: their headers, the IDs and the installed versions asked for. */
let calls: { headers: Record<string, string>; ids: string[]; installed: unknown }[];
/** What `latest_versions` answers for an ID; unknown IDs are `not_found`. */
let latest: Map<string, Record<string, unknown>>;
/** When set, the fake Store fails every call this way. */
let failure: 'network' | 'server' | null;
let connectivity: ConnectivityState;
let reportedFailures: number;
let changed: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-update-check-'));
  db = openDatabase(join(root, 'harness-store.sqlite'));
  store = createInstallStore(db);
  calls = [];
  latest = new Map();
  failure = null;
  connectivity = 'online';
  reportedFailures = 0;
  changed = [];
});
afterEach(() => {
  vi.useRealTimers();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** The Manifest of `id` at `version`, declaring `platforms`. */
function manifestOf(id: string, version: string, platforms = ['linux-x64', 'darwin-arm64']) {
  return { ...manifestWith({ default: {} }), id, version, platforms } as Manifest;
}

/** Installs `id` at `version` from `source`, as the installer records it. */
function installed(id: string, version: string, source: InstallSource = 'store') {
  const manifest = manifestOf(id, version);
  store.put({
    harnessId: id,
    version,
    manifest,
    installPath: join(root, 'harnesses', id, version),
    dataDir: join(root, 'data', id),
    installedAt: '2026-10-28T09:00:00.000Z',
    consentedPermissions: manifest.permissions,
    source,
  });
}

/** The Store offers `version` of `id` as its latest. */
function offers(id: string, version: string, platforms?: string[]) {
  latest.set(id, {
    harness_id: id,
    store_status: 'available',
    latest_version: version,
    manifest: manifestOf(id, version, platforms),
  });
}

const fakeFetch: UpdateCheckOptions['fetch'] = (url, init) => {
  if (failure === 'network') return Promise.reject(new TypeError('fetch failed'));
  expect(url).toBe(`${BASE_URL}/rest/v1/rpc/latest_versions`);
  expect(init.method).toBe('POST');
  const { harness_ids: ids, installed_versions: installed } = JSON.parse(init.body as string) as {
    harness_ids: string[];
    installed_versions: unknown;
  };
  calls.push({ headers: init.headers as Record<string, string>, ids, installed });
  if (failure === 'server') return Promise.resolve(new Response('{}', { status: 503 }));
  const rows = ids.map(
    (id) =>
      latest.get(id) ?? {
        harness_id: id,
        store_status: 'not_found',
        latest_version: null,
        manifest: null,
      },
  );
  return Promise.resolve(Response.json(rows));
};

function checker(options: Partial<UpdateCheckOptions> = {}) {
  return createUpdateChecker({
    store,
    installs: () => Promise.resolve(store.all()),
    fetch: fakeFetch,
    storeBaseUrl: () => `${BASE_URL}/`,
    anonKey: ANON_KEY,
    platform: 'linux-x64',
    connectivity: {
      get: () => ({ state: connectivity }),
      reportFailure: () => {
        reportedFailures += 1;
      },
    },
    onChanged: (harnessId) => changed.push(harnessId),
    ...options,
  });
}

/** What the check stored for `id`. */
function checked(id: string) {
  const row = store.get(id);
  return {
    storeStatus: row?.storeStatus,
    availableVersion: row?.availableVersion,
    availableManifestVersion: row?.availableManifest?.version ?? null,
  };
}

describe('scheduling (acceptance: 10 s after start, then every interval, 6 hours by default)', () => {
  it('checks first 10 seconds after start, then every 6 hours, until stopped', async () => {
    vi.useFakeTimers();
    installed('acme/alpha', '1.0.0');
    const updates = checker();
    updates.start();

    await vi.advanceTimersByTimeAsync(FIRST_UPDATE_CHECK_DELAY_MS - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(calls).toHaveLength(3);

    updates.stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(calls).toHaveLength(3);
  });

  it('Never schedules nothing, not even the first check; check() still runs one', async () => {
    vi.useFakeTimers();
    installed('acme/alpha', '1.0.0');
    const updates = checker({ intervalMs: () => null });
    updates.start();
    await vi.advanceTimersByTimeAsync(30 * 60 * 60 * 1000);
    expect(calls).toHaveLength(0);
    await expect(updates.check()).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    updates.stop();
  });

  it('reads the interval each time a check is due: Never by then checks nothing', async () => {
    vi.useFakeTimers();
    installed('acme/alpha', '1.0.0');
    let interval: number | null = UPDATE_CHECK_INTERVAL_MS;
    const updates = checker({ intervalMs: () => interval });
    updates.start();
    interval = null;
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 5);
    expect(calls).toHaveLength(0);
    updates.stop();
  });

  it('reschedule() puts the next check a whole new interval from now, checking nothing now', async () => {
    vi.useFakeTimers();
    installed('acme/alpha', '1.0.0');
    let interval: number | null = UPDATE_CHECK_INTERVAL_MS;
    const updates = checker({ intervalMs: () => interval });
    updates.reschedule(); // Not started: nothing.
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(calls).toHaveLength(0);

    updates.start();
    await vi.advanceTimersByTimeAsync(FIRST_UPDATE_CHECK_DELAY_MS);
    expect(calls).toHaveLength(1);
    interval = 60 * 60 * 1000;
    updates.reschedule();
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(interval);
    expect(calls).toHaveLength(2);

    interval = null;
    updates.reschedule();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 5);
    expect(calls).toHaveLength(2);

    // From Never to an interval: the first check comes a whole interval later.
    interval = 24 * 60 * 60 * 1000;
    updates.reschedule();
    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    updates.stop();
  });

  it('starting twice schedules one check', async () => {
    vi.useFakeTimers();
    installed('acme/alpha', '1.0.0');
    const updates = checker();
    updates.start();
    updates.start();
    await vi.advanceTimersByTimeAsync(FIRST_UPDATE_CHECK_DELAY_MS);
    expect(calls).toHaveLength(1);
    updates.stop();
  });
});

describe('what it asks', () => {
  it('asks about Store installs only, never a local install, with the anon key and each installed version', async () => {
    installed('acme/store', '1.0.0');
    installed('acme/local', '1.0.0', 'local');
    installed('acme/other', '2.3.4');
    await checker().check();
    expect(calls).toEqual([
      {
        headers: expect.objectContaining({
          apikey: ANON_KEY,
          authorization: `Bearer ${ANON_KEY}`,
        }) as unknown,
        ids: expect.arrayContaining(['acme/store', 'acme/other']) as unknown,
        installed: expect.any(Array) as unknown,
      },
    ]);
    // Aligned by position.
    const [call] = calls;
    expect(call?.ids).toHaveLength(2);
    expect(call?.ids.map((id) => store.get(id)?.version)).toEqual(call?.installed);
    expect(checked('acme/local')).toEqual({
      storeStatus: null,
      availableVersion: null,
      availableManifestVersion: null,
    });
  });

  it('makes no call when there is no Store install', async () => {
    installed('acme/local', '1.0.0', 'local');
    await checker().check();
    expect(calls).toEqual([]);
  });

  it('asks in calls of at most 1000 IDs', async () => {
    const ids = Array.from({ length: 2001 }, (_, i) => `acme/h${String(i).padStart(4, '0')}`);
    db.exec('BEGIN');
    for (const id of ids) installed(id, '1.0.0');
    db.exec('COMMIT');
    await checker().check();
    expect(calls.map((call) => call.ids.length)).toEqual([1000, 1000, 1]);
    expect(new Set(calls.flatMap((call) => call.ids))).toEqual(new Set(ids));
  });
});

describe('offline (acceptance: does nothing and shows no error)', () => {
  it('skips the check while the Store is known to be offline', async () => {
    installed('acme/alpha', '1.0.0');
    offers('acme/alpha', '2.0.0');
    connectivity = 'offline';
    await expect(checker().check()).resolves.toBe(false);
    expect(calls).toEqual([]);
    expect(checked('acme/alpha').availableVersion).toBeNull();
    expect(changed).toEqual([]);
  });

  it('a check without an answer has connectivity checked again and changes nothing', async () => {
    installed('acme/alpha', '1.0.0');
    offers('acme/alpha', '2.0.0');
    await checker().check();
    expect(checked('acme/alpha').availableVersion).toBe('2.0.0');
    changed = [];

    failure = 'network';
    await expect(checker().check()).resolves.toBe(false);
    expect(reportedFailures).toBe(1);
    expect(checked('acme/alpha').availableVersion).toBe('2.0.0');
    expect(changed).toEqual([]);
  });

  it('check() resolves whether the Store answered', async () => {
    installed('acme/alpha', '1.0.0');
    await expect(checker().check()).resolves.toBe(true);
    failure = 'server';
    await expect(checker().check()).resolves.toBe(false);
  });

  it('an answer that is not the rows changes nothing and is not a connectivity failure', async () => {
    installed('acme/alpha', '1.0.0');
    failure = 'server';
    await checker().check();
    expect(reportedFailures).toBe(0);
    expect(checked('acme/alpha').storeStatus).toBeNull();
  });
});

describe('what it stores', () => {
  it('stores a greater version that runs here as the update, and reports the row', async () => {
    installed('acme/alpha', '1.0.0');
    offers('acme/alpha', '1.1.0');
    await checker().check();
    expect(checked('acme/alpha')).toEqual({
      storeStatus: 'available',
      availableVersion: '1.1.0',
      availableManifestVersion: '1.1.0',
    });
    expect(store.get('acme/alpha')?.availableManifest).toEqual(manifestOf('acme/alpha', '1.1.0'));
    expect(changed).toEqual(['acme/alpha']);

    // The same answer again changes nothing, so nothing is reported.
    changed = [];
    await checker().check();
    expect(changed).toEqual([]);
  });

  it.each<[string, string, string, string[] | undefined]>([
    ['the same version', '1.0.0', '1.0.0', undefined],
    // Taking down or Unpublishing the latest version moves it back below the installed one.
    ['a lower version', '1.2.0', '1.1.0', undefined],
    ['a pre-release of the installed version', '1.0.0', '1.0.0-beta.2', undefined],
    ['a greater version that does not declare this platform', '1.0.0', '2.0.0', ['win32-x64']],
  ])('offers no update for %s', async (_, installedVersion, latestVersion, platforms) => {
    installed('acme/alpha', installedVersion);
    offers('acme/alpha', latestVersion, platforms);
    await checker().check();
    expect(checked('acme/alpha')).toEqual({
      storeStatus: 'available',
      availableVersion: null,
      availableManifestVersion: null,
    });
  });

  it.each<[string, string]>([
    ['unpublished', 'unpublished'],
    ['taken_down', 'taken_down'],
    ['not_found', 'unpublished'],
  ])('stores %s as %s, with no update', async (status, stored) => {
    installed('acme/alpha', '1.0.0');
    offers('acme/alpha', '2.0.0');
    await checker().check();
    changed = [];
    latest.set('acme/alpha', {
      harness_id: 'acme/alpha',
      store_status: status,
      latest_version: null,
      manifest: null,
    });
    await checker().check();
    expect(checked('acme/alpha')).toEqual({
      storeStatus: stored,
      availableVersion: null,
      availableManifestVersion: null,
    });
    expect(changed).toEqual(['acme/alpha']);
  });

  it('skips a row that is not what api.md says, keeping what the last check stored', async () => {
    installed('acme/alpha', '1.0.0');
    installed('acme/bravo', '1.0.0');
    installed('acme/charlie', '1.0.0');
    offers('acme/alpha', '2.0.0');
    offers('acme/bravo', '2.0.0');
    offers('acme/charlie', '2.0.0');
    await checker().check();
    changed = [];
    // An unknown status, a Manifest of another version, and one of another Harness.
    latest.set('acme/alpha', { harness_id: 'acme/alpha', store_status: 'gone' });
    latest.set('acme/bravo', {
      harness_id: 'acme/bravo',
      store_status: 'available',
      latest_version: '3.0.0',
      manifest: manifestOf('acme/bravo', '2.5.0'),
    });
    latest.set('acme/charlie', {
      harness_id: 'acme/charlie',
      store_status: 'available',
      latest_version: '3.0.0',
      manifest: manifestOf('acme/other', '3.0.0'),
    });
    await checker().check();
    expect(changed).toEqual([]);
    for (const id of ['acme/alpha', 'acme/bravo', 'acme/charlie']) {
      expect(checked(id).availableVersion).toBe('2.0.0');
    }
  });

  it('stores a Takedown of the installed version apart from the Store status, keeping the update', async () => {
    installed('acme/alpha', '1.0.0');
    latest.set('acme/alpha', {
      harness_id: 'acme/alpha',
      store_status: 'available',
      latest_version: '2.0.0',
      manifest: manifestOf('acme/alpha', '2.0.0'),
      installed_version_status: 'taken_down',
    });
    await checker().check();
    expect(changed).toEqual(['acme/alpha']);
    expect(checked('acme/alpha')).toEqual({
      storeStatus: 'available',
      availableVersion: '2.0.0',
      availableManifestVersion: '2.0.0',
    });
    expect(store.get('acme/alpha')?.installedVersionTakenDown).toBe(true);

    // Published again: the mark goes. An unknown installed version status is not what api.md
    // says, so that row is skipped.
    latest.set('acme/alpha', {
      ...latest.get('acme/alpha'),
      installed_version_status: 'published',
    });
    await checker().check();
    expect(store.get('acme/alpha')?.installedVersionTakenDown).toBe(false);
    latest.set('acme/alpha', { ...latest.get('acme/alpha'), installed_version_status: 'gone' });
    changed = [];
    await checker().check();
    expect(changed).toEqual([]);
  });

  it('judges an install updated between the list and the answer by its new version', async () => {
    installed('acme/alpha', '1.0.0');
    offers('acme/alpha', '2.0.0');
    // The list said 1.0.0; the answer arrives once 2.0.0 is installed.
    await checker({
      installs: () => {
        const listed = store.all();
        installed('acme/alpha', '2.0.0');
        return Promise.resolve(listed);
      },
    }).check();
    expect(checked('acme/alpha')).toEqual({
      storeStatus: 'available',
      availableVersion: null,
      availableManifestVersion: null,
    });
    // A Takedown of 1.0.0, the version asked about, is not 2.0.0's.
    latest.set('acme/alpha', {
      ...latest.get('acme/alpha'),
      installed_version_status: 'taken_down',
    });
    await checker({
      installs: () => {
        const listed = store.all();
        installed('acme/alpha', '2.1.0');
        return Promise.resolve(listed);
      },
    }).check();
    expect(store.get('acme/alpha')?.installedVersionTakenDown).toBe(false);
  });

  it('an install clears the update, keeps the Store status, and a local one clears both', async () => {
    installed('acme/alpha', '1.0.0');
    offers('acme/alpha', '2.0.0');
    await checker().check();
    installed('acme/alpha', '2.0.0');
    expect(checked('acme/alpha')).toEqual({
      storeStatus: 'available',
      availableVersion: null,
      availableManifestVersion: null,
    });
    installed('acme/alpha', '2.0.0', 'local');
    expect(checked('acme/alpha').storeStatus).toBeNull();
  });
});
