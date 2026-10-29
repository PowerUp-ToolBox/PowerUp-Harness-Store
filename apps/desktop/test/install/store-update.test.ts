/**
 * Tickets P0-10.2 and P0-12.2: the update check and updating a Store install, through the
 * Runtime's IPC handlers (the Supervisor/Installer seam, architecture §8 item 3) against a fake
 * Store on a real HTTP port.
 * The fake Store answers `latest_versions` and `download` as api.md says, and serves real zips
 * built here with fflate from the `fixture-term` folder, its manifest.json changed per version:
 * the v1/v2 pairs of "How to verify" step 2 (v2 narrowing a permission, widening one with
 * `shell: true`, changing the Entry) and a v2 whose SHA-256 the Store misreports. The Harness runs
 * for real in a pty, its window faked, so "running" is the Supervisor's own.
 *
 * Asserted on the filesystem and the `installs` rows: an update that needs no consent again goes
 * through in one call; one that does is refused without `reconsented` before anything is
 * unpacked; a failed, cancelled or refused update leaves the old version installed and launchable;
 * the Data Directory's files are untouched by an update; a running Harness is not updated; local
 * installs are never asked about nor updated.
 *
 * P0-12.2 (How to verify, step 4): a `store_status` of `taken_down` reaching an existing install
 * through the update check marks it, drops the update it had and offers none (the Store's
 * `download` refuses it too), and leaves it launchable; the one-time launch confirmation's
 * acknowledgement (`installs.acknowledgeTakedown`) is kept in its row until the check finds
 * another status. P0-12.2 follow-up: the check sends the installed version, and a Takedown of that
 * version alone marks the install too, while a newer published version stays offered as Update;
 * updating to it clears the mark.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGateway } from '@harness-store/gateway';
import { startFakeProvider, type FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { zipSync, type Zippable } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from '../../src/main/runtime/bootstrap.js';
import { openDatabase } from '../../src/main/runtime/database.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createHarnessWindowHandlers } from '../../src/main/runtime/harness-window-handlers.js';
import { createSqliteSettingsStore } from '../../src/main/runtime/settings-store.js';
import type { HarnessWindows } from '../../src/main/runtime/supervisor.js';
import type {
  InstalledHarness,
  IpcEventName,
  IpcEvents,
  IpcResult,
  LaunchStatus,
} from '../../src/shared/ipc.js';
import { createFakeCipher } from '../support/fake-cipher.js';

const FIXTURES = join(import.meta.dirname, '../fixtures/harnesses');
const ANON_KEY = 'fake-anon-key';
const MAIN_WINDOW = {};
const PLATFORM = `${process.platform}-${process.arch}`;
const NOW = '2026-10-28T09:00:00.000Z';
const TERM = 'acme/fixture-term';

/** One Harness Version the fake Store has. */
interface Published {
  readonly zip: Uint8Array;
  readonly manifest: Record<string, unknown>;
  /** The SHA-256 `download` reports; default: the zip's. */
  readonly sha256?: string;
}

let server: Server;
let baseUrl: string;
/** Every version the Store has of each Harness, the latest last. */
let published: Map<string, Published[]>;
/** Harnesses the Store no longer offers: `latest_versions` says so, and `download` refuses them. */
let withdrawn: Map<string, 'taken_down' | 'unpublished'>;
/** Versions taken down on their own, as `<harness ID>@<version>`: no longer latest nor downloaded. */
let takenDownVersions: Set<string>;
let downloadCalls: Record<string, unknown>[];
let latestCalls: string[][];
/** The `installed_versions` of each `latest_versions` call. */
let installedCalls: unknown[];
/** When set, the signed URL sends the first 64 bytes and then nothing. */
let stallPackage: boolean;
/** When set, the signed URL waits for it before sending the package. */
let beforePackage: (() => Promise<unknown>) | null;
let root: string;
let userData: string;
let runtime: Runtime;
let fake: FakeProvider;
let events: { event: IpcEventName; payload: unknown }[];
let states: LaunchStatus[];
let windows: ReturnType<typeof createFakeWindows>;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', baseUrl);
  if (request.method === 'POST' && url.pathname === '/rest/v1/rpc/latest_versions') {
    const { harness_ids: ids, installed_versions: installed } = JSON.parse(
      await readBody(request),
    ) as { harness_ids: string[]; installed_versions?: (string | null)[] };
    latestCalls.push(ids);
    installedCalls.push(installed);
    if (installed !== undefined && installed.length !== ids.length) {
      json(response, 400, { code: '22023', message: 'Not as many installed versions.' });
      return;
    }
    json(
      response,
      200,
      ids.map((id, index) => {
        const versions = published.get(id);
        const asked = installed?.[index] ?? null;
        const installedVersionStatus =
          asked === null || !versions?.some((each) => each.manifest.version === asked)
            ? null
            : takenDownVersions.has(`${id}@${asked}`)
              ? 'taken_down'
              : 'published';
        const row = { harness_id: id, latest_version: null, manifest: null };
        const status = withdrawn.get(id);
        if (status !== undefined) {
          return {
            ...row,
            store_status: status,
            installed_version_status: installedVersionStatus,
          };
        }
        if (versions === undefined) {
          return { ...row, store_status: 'not_found', installed_version_status: null };
        }
        const latest = offered(id).at(-1);
        return latest === undefined
          ? {
              ...row,
              store_status: 'unpublished',
              installed_version_status: installedVersionStatus,
            }
          : {
              harness_id: id,
              store_status: 'available',
              latest_version: latest.manifest.version,
              manifest: latest.manifest,
              installed_version_status: installedVersionStatus,
            };
      }),
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/functions/v1/download') {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    downloadCalls.push(body);
    const versions = withdrawn.has(String(body.harness_id)) ? [] : offered(String(body.harness_id));
    const found =
      body.version === null
        ? versions.at(-1)
        : versions.find((each) => each.manifest.version === body.version);
    if (found === undefined) {
      json(response, 404, { error: { code: 'not_found', message: 'No such version.' } });
      return;
    }
    const version = String(found.manifest.version);
    json(response, 200, {
      url: `${baseUrl}/storage/v1/object/sign/harness-packages/${String(body.harness_id)}/${version}.zip?token=signed`,
      sha256: found.sha256 ?? sha256(found.zip),
      size: found.zip.length,
      manifest: found.manifest,
    });
    return;
  }
  const signed = /^\/storage\/v1\/object\/sign\/harness-packages\/(.+)\/([^/]+)\.zip$/.exec(
    url.pathname,
  );
  if (request.method === 'GET' && signed !== null) {
    const found = published
      .get(signed[1] ?? '')
      ?.find((each) => each.manifest.version === signed[2]);
    if (found === undefined) {
      json(response, 400, { error: 'InvalidJWT', message: 'jwt expired' });
      return;
    }
    if (beforePackage !== null) await beforePackage();
    response.writeHead(200, { 'content-type': 'application/zip' });
    if (stallPackage) {
      response.write(found.zip.subarray(0, 64));
      return; // Never ends: the client cancels, or the server closes it.
    }
    response.end(found.zip);
    return;
  }
  json(response, 404, { error: { code: 'not_found', message: 'No route.' } });
}

/** The versions of a Harness the Store still offers: published, not taken down on their own. */
function offered(harnessId: string): Published[] {
  return (published.get(harnessId) ?? []).filter(
    (each) => !takenDownVersions.has(`${harnessId}@${String(each.manifest.version)}`),
  );
}

/** Every file of `fixture-term`, by its path inside the package. */
function fixtureFiles(): Record<string, Uint8Array> {
  const folder = join(FIXTURES, 'fixture-term');
  const files: Record<string, Uint8Array> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(folder, path).split('\\').join('/')] = readFileSync(path);
    }
  };
  walk(folder);
  return files;
}

/** The Declared Permissions of v1 of every pair. */
const V1_PERMISSIONS = {
  filesystem: { scope: 'none' },
  shell: false,
  network: { domains: ['api.github.com', 'example.com'] },
};

/**
 * Publishes `fixture-term` at `version` in the fake Store, its Manifest changed by `changes` (with
 * {@link V1_PERMISSIONS} unless they say otherwise), its files plus `extra`.
 */
function publish(
  version: string,
  changes: Record<string, unknown> = {},
  options: { extra?: Zippable; sha256?: string } = {},
) {
  const fixture = JSON.parse(
    readFileSync(join(FIXTURES, 'fixture-term', 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  const manifest = {
    ...fixture,
    version,
    permissions: V1_PERMISSIONS,
    changelog: `What is new in ${version}.`,
    ...changes,
  };
  const zip = zipSync({
    ...fixtureFiles(),
    ...options.extra,
    'manifest.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  });
  const versions = published.get(TERM) ?? [];
  published.set(TERM, [
    ...versions,
    { zip, manifest, ...(options.sha256 === undefined ? {} : { sha256: options.sha256 }) },
  ]);
}

/** Harness windows without Electron, each reporting its terminal ready at once. */
function createFakeWindows() {
  const open = new Map<string, () => void>();
  return {
    open,
    openTerminal(spec, onClosed) {
      open.set(spec.launchId, onClosed);
      queueMicrotask(() => {
        void createDispatcher({
          handlers: createHarnessWindowHandlers(spec.launchId, {
            supervisor: runtime.supervisor,
            bindings: runtime.services.bindings,
            clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() },
            openModels: () => undefined,
          }),
          isTrustedSender: () => true,
        })(spec.launchId, { method: 'terminal.ready', input: { cols: 100, rows: 30 } });
      });
    },
    openWeb() {
      throw new Error('No web window in these tests');
    },
    showWeb: () => undefined,
    hideWeb: () => undefined,
    reloadWeb: () => undefined,
    layoutWeb: () => undefined,
    send: () => undefined,
    focus: (launchId) => open.has(launchId),
    close(launchId) {
      const onClosed = open.get(launchId);
      open.delete(launchId);
      onClosed?.();
    },
  } satisfies HarnessWindows & Record<string, unknown>;
}

beforeEach(async () => {
  published = new Map();
  withdrawn = new Map();
  takenDownVersions = new Set();
  downloadCalls = [];
  latestCalls = [];
  installedCalls = [];
  stallPackage = false;
  beforePackage = null;
  events = [];
  states = [];
  server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  root = mkdtempSync(join(tmpdir(), 'harness-store-store-update-'));
  userData = join(root, 'userData');
  mkdirSync(userData, { recursive: true });
  const db = openDatabase(join(userData, 'harness-store.sqlite'));
  try {
    createSqliteSettingsStore(db).write('store_base_url', baseUrl);
  } finally {
    db.close();
  }
  fake = await startFakeProvider({ aliases: { 'model-a': 'fake/echo' } });
  windows = createFakeWindows();
  runtime = await startRuntime({
    dataDir: userData,
    version: '1.4.2',
    osLocale: () => 'en-US',
    quit: () => undefined,
    logError: () => undefined,
    // The Store answers the connectivity check: the update check runs only when not offline.
    fetch: () => Promise.resolve({ status: 200 }),
    storeFetch: (url, init) => globalThis.fetch(url, init),
    storeAnonKey: ANON_KEY,
    providerFetch: globalThis.fetch,
    secretCipher: createFakeCipher(),
    platform: PLATFORM,
    now: () => new Date(NOW),
    pickFolder: () => Promise.resolve(null),
    harnessWindows: windows,
    emit: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => {
      if (event === 'launch.state') states.push(payload as LaunchStatus);
      else events.push({ event, payload });
    },
    createGateway: (options) =>
      createGateway({ ...options, logger: { debug: () => undefined, error: () => undefined } }),
  });
  // A model for the `default` Slot: a launch without one is refused.
  await expect(
    call('connections.add', { providerId: 'ollama', baseUrl: fake.url }),
  ).resolves.toMatchObject({ ok: true });
  await expect(
    call('bindings.setGlobal', {
      slot: 'default',
      target: { connectionId: 'ollama', model: 'model-a' },
    }),
  ).resolves.toMatchObject({ ok: true });
});
afterEach(async () => {
  await runtime.shutdown();
  await fake.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

function call(method: string, input?: unknown) {
  return createDispatcher({
    handlers: createHandlers(runtime.services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  })(MAIN_WINDOW, { method, input });
}

/** Installs the Store's latest version of fixture-term, as Install and the consent dialog do. */
async function installFromStore() {
  await expect(
    call('installs.install', { harnessId: TERM, jobId: 'install-job' }),
  ).resolves.toMatchObject({ ok: true });
  await expect(call('installs.confirm', 'install-job')).resolves.toMatchObject({ ok: true });
}

/** fixture-term as `installs.list` answers it. */
async function listed(): Promise<InstalledHarness | undefined> {
  const result = (await call('installs.list')) as IpcResult<readonly InstalledHarness[]>;
  if (!result.ok) throw new Error(result.error.message);
  return result.data.find((install) => install.harnessId === TERM);
}

/** Every `installs` row as SQLite holds it. */
function installRows() {
  const db = new DatabaseSync(join(userData, 'harness-store.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT * FROM installs').all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

const versionFolder = (version: string) =>
  join(userData, 'harnesses', 'acme', 'fixture-term', version);
const versionFolders = () => readdirSync(join(userData, 'harnesses', 'acme', 'fixture-term'));
/** The Data Directory, relative to the app data root. */
const DATA_DIR = join('data', 'acme', 'fixture-term');
const downloads = () => {
  const folder = join(userData, 'downloads');
  return existsSync(folder) ? readdirSync(folder) : [];
};

const update = (version: string, reconsented: boolean, jobId = 'update-job') =>
  call('installs.update', { harnessId: TERM, version, jobId, reconsented });

/** Writes files into the Data Directory, and reads them back. */
function seedDataDirectory() {
  const folder = join(userData, DATA_DIR);
  mkdirSync(join(folder, 'nested'), { recursive: true });
  writeFileSync(join(folder, 'state.json'), '{"conversations":3}');
  writeFileSync(join(folder, 'nested', 'notes.txt'), 'kept across updates');
  return () => ({
    files: readdirSync(folder, { recursive: true }).map(String).sort(),
    state: readFileSync(join(folder, 'state.json'), 'utf8'),
    notes: readFileSync(join(folder, 'nested', 'notes.txt'), 'utf8'),
  });
}

/** The old version is still what is installed, with all its files, and nothing else is left. */
async function expectStillV1() {
  await expect(listed()).resolves.toMatchObject({ version: '1.0.0', source: 'store' });
  expect(installRows()).toMatchObject([{ harness_id: TERM, version: '1.0.0', state: 'installed' }]);
  expect(versionFolders()).toEqual(['1.0.0']);
  expect(readFileSync(join(versionFolder('1.0.0'), 'index.mjs'))).toEqual(
    readFileSync(join(FIXTURES, 'fixture-term', 'index.mjs')),
  );
  expect(downloads()).toEqual([]);
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Launches fixture-term and waits until it runs; its launch ID. */
async function launchAndWait(): Promise<string> {
  const started = (await call('launch.start', { harnessId: TERM })) as IpcResult<{
    outcome: string;
    launchId: string;
  }>;
  if (!started.ok) throw new Error(started.error.message);
  expect(started.data.outcome).toBe('started');
  const { launchId } = started.data;
  await waitFor(() =>
    states.some((state) => state.launchId === launchId && state.state === 'ready')
      ? true
      : undefined,
  );
  return launchId;
}

describe('the update check (acceptance: a newer version shows as an update)', () => {
  it('stores a newer version of a Store install and reports it, asking about no local install', async () => {
    publish('1.0.0');
    await installFromStore();
    // A local install of another Harness: never asked about.
    await expect(
      call('installs.installFromFolder', join(FIXTURES, 'fixture-web')),
    ).resolves.toMatchObject({ ok: true });
    publish('1.1.0');
    events = [];

    await runtime.updates.check();
    expect(latestCalls).toEqual([[TERM]]);
    const install = await listed();
    expect(install).toMatchObject({
      storeStatus: 'available',
      availableUpdate: { version: '1.1.0', manifest: { version: '1.1.0' } },
    });
    expect(events).toEqual([{ event: 'installs.changed', payload: { harnessId: TERM } }]);
  });
});

describe('installs.update (How to verify, step 2)', () => {
  it('a v2 that only narrows a permission updates in one call, without re-consent', async () => {
    publish('1.0.0');
    await installFromStore();
    const dataDirectory = seedDataDirectory();
    const before = dataDirectory();
    publish('1.1.0', {
      permissions: { ...V1_PERMISSIONS, network: { domains: ['api.github.com'] } },
    });
    await runtime.updates.check();
    events = [];

    await expect(update('1.1.0', false)).resolves.toEqual({
      ok: true,
      data: { harnessId: TERM, version: '1.1.0' },
    });
    // The pinned version was downloaded, not merely the latest.
    expect(downloadCalls.at(-1)).toEqual({
      harness_id: TERM,
      version: '1.1.0',
      platform: PLATFORM,
      app_version: '1.4.2',
    });
    // The row points at the new version, the old folder is gone, the update is no longer offered.
    await expect(listed()).resolves.toMatchObject({
      version: '1.1.0',
      installPath: versionFolder('1.1.0'),
      manifest: { version: '1.1.0', permissions: { network: { domains: ['api.github.com'] } } },
      storeStatus: 'available',
      availableUpdate: null,
    });
    expect(installRows()).toMatchObject([
      {
        version: '1.1.0',
        consented_permissions: JSON.stringify({
          ...V1_PERMISSIONS,
          network: { domains: ['api.github.com'] },
        }),
        state: 'installed',
      },
    ]);
    expect(versionFolders()).toEqual(['1.1.0']);
    expect(
      JSON.parse(readFileSync(join(versionFolder('1.1.0'), 'manifest.json'), 'utf8')),
    ).toMatchObject({
      version: '1.1.0',
    });
    expect(downloads()).toEqual([]);
    expect(events).toContainEqual({ event: 'installs.changed', payload: { harnessId: TERM } });
    // The Data Directory's files and their content are what they were.
    expect(dataDirectory()).toEqual(before);
  });

  it('a v2 that turns shell on is refused without re-consent, then goes through with it', async () => {
    publish('1.0.0');
    await installFromStore();
    publish('1.1.0', { permissions: { ...V1_PERMISSIONS, shell: true } });

    await expect(update('1.1.0', false)).resolves.toMatchObject({
      ok: false,
      error: { code: 'reconsent_required' },
    });
    await expectStillV1();

    await expect(update('1.1.0', true, 'update-job-2')).resolves.toMatchObject({ ok: true });
    await expect(listed()).resolves.toMatchObject({
      version: '1.1.0',
      manifest: { permissions: { shell: true } },
    });
  });

  it('a v2 whose Entry changed needs re-consent, with permissions unchanged', async () => {
    publish('1.0.0');
    await installFromStore();
    const entry = fixtureFiles()['index.mjs'] ?? new Uint8Array();
    publish('1.1.0', { entry: 'main.mjs' }, { extra: { 'main.mjs': entry } });

    await expect(update('1.1.0', false)).resolves.toMatchObject({
      ok: false,
      error: { code: 'reconsent_required' },
    });
    await expectStillV1();
  });

  it('a corrupted v2 (its SHA-256 misreported) leaves v1 installed and launchable', async () => {
    publish('1.0.0');
    await installFromStore();
    const dataDirectory = seedDataDirectory();
    const before = dataDirectory();
    publish('1.1.0', {}, { sha256: 'a'.repeat(64) });

    await expect(update('1.1.0', false)).resolves.toMatchObject({
      ok: false,
      error: { code: 'checksum_mismatch' },
    });
    await expectStillV1();
    expect(dataDirectory()).toEqual(before);
    await launchAndWait();
  });

  it('Cancel during the download leaves v1 installed', async () => {
    publish('1.0.0');
    await installFromStore();
    publish('1.1.0');
    stallPackage = true;

    const updating = update('1.1.0', false);
    await waitFor(() =>
      events.some((each) => each.event === 'progress:update-job') ? true : undefined,
    );
    // Another install or update of it waits for this one.
    await expect(update('1.1.0', false, 'update-job-2')).resolves.toMatchObject({
      ok: false,
      error: { code: 'harness_installing' },
    });
    await expect(call('installs.cancel', 'update-job')).resolves.toEqual({ ok: true, data: null });
    await expect(updating).resolves.toMatchObject({
      ok: false,
      error: { code: 'download_cancelled' },
    });
    await expectStillV1();
  });

  it('refuses a version that is not newer, and a Harness that is not a Store install', async () => {
    publish('1.0.0');
    await installFromStore();
    for (const version of ['1.0.0', '0.9.0', 'not-a-version']) {
      await expect(update(version, true)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
    }
    // A local install never gets Store updates.
    await expect(
      call('installs.installFromFolder', join(FIXTURES, 'fixture-term')),
    ).resolves.toMatchObject({ ok: true });
    publish('1.1.0');
    await expect(update('1.1.0', true)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    await expect(
      call('installs.update', {
        harnessId: 'acme/not-installed',
        version: '1.0.0',
        jobId: 'job',
        reconsented: false,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'not_installed' } });
    expect(downloadCalls).toHaveLength(1);
  });
});

describe('a running Harness (How to verify, step 4)', () => {
  it('is not updated: Update is refused with a message, and nothing is downloaded', async () => {
    publish('1.0.0');
    await installFromStore();
    const launchId = await launchAndWait();
    publish('1.1.0');
    await runtime.updates.check();
    await expect(listed()).resolves.toMatchObject({ availableUpdate: { version: '1.1.0' } });

    await expect(update('1.1.0', false)).resolves.toMatchObject({
      ok: false,
      error: { code: 'harness_running', messageKey: 'error.harness_running' },
    });
    expect(downloadCalls).toHaveLength(1);
    await expectStillV1();

    // Once its window closed and it stopped, Update goes through.
    windows.close(launchId);
    await waitFor(() =>
      states.some((state) => state.launchId === launchId && state.state === 'stopped')
        ? true
        : undefined,
    );
    await expect(update('1.1.0', false, 'update-job-2')).resolves.toMatchObject({ ok: true });
  });

  it('a launch that starts during the download stops the update before the swap', async () => {
    publish('1.0.0');
    await installFromStore();
    publish('1.1.0');
    // The launch begins after Update was accepted and before the package arrives.
    beforePackage = launchAndWait;

    await expect(update('1.1.0', false)).resolves.toMatchObject({
      ok: false,
      error: { code: 'harness_running' },
    });
    await expectStillV1();
  });
});

describe('a Takedown reaching an existing install (P0-12.2, How to verify step 4)', () => {
  it('marks it taken down, drops and offers no update, and leaves it launchable', async () => {
    publish('1.0.0');
    await installFromStore();
    publish('1.1.0');
    await runtime.updates.check();
    await expect(listed()).resolves.toMatchObject({ availableUpdate: { version: '1.1.0' } });
    events = [];

    withdrawn.set(TERM, 'taken_down');
    await runtime.updates.check();
    await expect(listed()).resolves.toMatchObject({
      version: '1.0.0',
      storeStatus: 'taken_down',
      takedownAcknowledged: false,
      availableUpdate: null,
    });
    expect(installRows()).toMatchObject([
      {
        store_status: 'taken_down',
        available_version: null,
        available_manifest: null,
        takedown_acknowledged: 0,
      },
    ]);
    expect(events).toEqual([{ event: 'installs.changed', payload: { harnessId: TERM } }]);

    // The Store's download refuses it, and v1 stays.
    await expect(update('1.1.0', false)).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    await expectStillV1();

    // Main does not enforce the confirmation: the renderer asks it before launch.start.
    const launchId = await launchAndWait();
    windows.close(launchId);
  });

  it('keeps the acknowledgement until the update check finds another status', async () => {
    publish('1.0.0');
    await installFromStore();
    withdrawn.set(TERM, 'taken_down');
    await runtime.updates.check();
    events = [];

    await expect(call('installs.acknowledgeTakedown', TERM)).resolves.toEqual({
      ok: true,
      data: null,
    });
    await expect(listed()).resolves.toMatchObject({
      storeStatus: 'taken_down',
      takedownAcknowledged: true,
    });
    // Kept in SQLite, so a restart asks no more.
    expect(installRows()).toMatchObject([{ takedown_acknowledged: 1 }]);
    expect(events).toEqual([{ event: 'installs.changed', payload: { harnessId: TERM } }]);

    // Acknowledging again, or a check that finds it still taken down, changes nothing.
    events = [];
    await expect(call('installs.acknowledgeTakedown', TERM)).resolves.toMatchObject({ ok: true });
    await runtime.updates.check();
    await expect(listed()).resolves.toMatchObject({ takedownAcknowledged: true });
    expect(events).toEqual([]);

    // Reinstated, then taken down again: a new Takedown asks again.
    withdrawn.delete(TERM);
    await runtime.updates.check();
    await expect(listed()).resolves.toMatchObject({
      storeStatus: 'available',
      takedownAcknowledged: false,
    });
    withdrawn.set(TERM, 'taken_down');
    await runtime.updates.check();
    await expect(listed()).resolves.toMatchObject({
      storeStatus: 'taken_down',
      takedownAcknowledged: false,
    });
  });

  it('records nothing for an install that is not taken down, and refuses one not installed', async () => {
    publish('1.0.0');
    await installFromStore();
    withdrawn.set(TERM, 'unpublished');
    await runtime.updates.check();
    events = [];

    await expect(call('installs.acknowledgeTakedown', TERM)).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(installRows()).toMatchObject([
      { store_status: 'unpublished', takedown_acknowledged: 0 },
    ]);
    expect(events).toEqual([]);
    await expect(call('installs.acknowledgeTakedown', 'acme/not-installed')).resolves.toMatchObject(
      { ok: false, error: { code: 'not_installed' } },
    );
  });

  it('sends the installed version, marks a Takedown of it alone, keeps Update, and clears the mark once updated', async () => {
    publish('1.0.0');
    await installFromStore();
    publish('1.1.0');
    takenDownVersions.add(`${TERM}@1.0.0`);
    events = [];

    await runtime.updates.check();
    expect(latestCalls).toEqual([[TERM]]);
    expect(installedCalls).toEqual([['1.0.0']]);
    // The Harness stays available, and its newer version is the remedy.
    await expect(listed()).resolves.toMatchObject({
      version: '1.0.0',
      storeStatus: 'available',
      installedVersionTakenDown: true,
      takedownAcknowledged: false,
      availableUpdate: { version: '1.1.0' },
    });
    expect(installRows()).toMatchObject([
      {
        store_status: 'available',
        available_version: '1.1.0',
        installed_version_taken_down: 1,
        takedown_acknowledged: 0,
      },
    ]);
    expect(events).toEqual([{ event: 'installs.changed', payload: { harnessId: TERM } }]);

    // Still launchable; the acknowledgement is kept by a check that finds the same.
    const launchId = await launchAndWait();
    windows.close(launchId);
    await waitFor(() =>
      states.some((state) => state.launchId === launchId && state.state === 'stopped')
        ? true
        : undefined,
    );
    await expect(call('installs.acknowledgeTakedown', TERM)).resolves.toEqual({
      ok: true,
      data: null,
    });
    events = [];
    await runtime.updates.check();
    await expect(listed()).resolves.toMatchObject({
      installedVersionTakenDown: true,
      takedownAcknowledged: true,
    });
    expect(events).toEqual([]);

    // Updating to the newer version clears the mark and its acknowledgement.
    await expect(update('1.1.0', false)).resolves.toMatchObject({ ok: true });
    await expect(listed()).resolves.toMatchObject({
      version: '1.1.0',
      storeStatus: 'available',
      installedVersionTakenDown: false,
      takedownAcknowledged: false,
      availableUpdate: null,
    });
    expect(installRows()).toMatchObject([
      { version: '1.1.0', installed_version_taken_down: 0, takedown_acknowledged: 0 },
    ]);
    await runtime.updates.check();
    expect(installedCalls.at(-1)).toEqual(['1.1.0']);
    await expect(listed()).resolves.toMatchObject({ installedVersionTakenDown: false });
  });

  it('marks the installed version taken down with no published version left, and resets the acknowledgement when it changes', async () => {
    publish('1.0.0');
    await installFromStore();
    takenDownVersions.add(`${TERM}@1.0.0`);
    await runtime.updates.check();
    await expect(listed()).resolves.toMatchObject({
      storeStatus: 'unpublished',
      installedVersionTakenDown: true,
      availableUpdate: null,
    });
    await expect(call('installs.acknowledgeTakedown', TERM)).resolves.toMatchObject({ ok: true });
    await expect(listed()).resolves.toMatchObject({ takedownAcknowledged: true });

    // Reinstated: no mark, and a later Takedown of it asks again.
    takenDownVersions.delete(`${TERM}@1.0.0`);
    await runtime.updates.check();
    await expect(listed()).resolves.toMatchObject({
      storeStatus: 'available',
      installedVersionTakenDown: false,
      takedownAcknowledged: false,
    });
    takenDownVersions.add(`${TERM}@1.0.0`);
    await runtime.updates.check();
    await expect(listed()).resolves.toMatchObject({
      installedVersionTakenDown: true,
      takedownAcknowledged: false,
    });
  });
});
