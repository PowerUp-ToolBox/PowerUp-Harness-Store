/**
 * Ticket P0-10.1: installing from the Store through the Runtime's IPC handlers (the
 * Supervisor/Installer seam, architecture §8 item 3), against a fake Store on a real HTTP port.
 * Its `download` function answers as api.md says the real one does (the signed URL, the package's
 * SHA-256 and size, and the Manifest as the Store keeps it, `jsonb`, so in another key order than
 * the package's manifest.json), and the signed URL serves a real zip of a fixture Harness, built
 * with fflate. The state machine runs for real on a temp app data root: a good package ends
 * `installed` and in the Library; a tampered SHA-256, an oversized transfer, an unsafe archive (a
 * `..` entry, a symbolic link) and a Manifest that is not the Store's never reach consent and
 * leave nothing; Cancel while downloading or at the consent dialog leaves no file and no row; a
 * restart cleans up after an install the app stopped in. A Store install and "Install this folder
 * locally" of the same Harness write rows of the same shape.
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
import { validateManifest, type Manifest } from '@harness-store/manifest';
import { zipSync, type Zippable } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from '../../src/main/runtime/bootstrap.js';
import { openDatabase } from '../../src/main/runtime/database.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createInstallStore } from '../../src/main/runtime/install-store.js';
import { summarize } from '../../src/main/runtime/installer.js';
import { createSqliteSettingsStore } from '../../src/main/runtime/settings-store.js';
import { createStoreDownloader } from '../../src/main/runtime/store-download.js';
import type { DownloadProgress, IpcEventName, IpcEvents } from '../../src/shared/ipc.js';
import { createFakeCipher } from '../support/fake-cipher.js';
import { REFUSED_PORT } from '../support/refused-port.js';

const FIXTURES = join(import.meta.dirname, '../fixtures/harnesses');
const ANON_KEY = 'fake-anon-key';
const MAIN_WINDOW = {};
const NOW = '2026-10-28T09:00:00.000Z';
const WEB = 'acme/fixture-web';
const BINARY = 'acme/fixture-binary-term';

/** A Harness Version the fake Store has, and how its `download` answer and URL behave. */
interface Published {
  /** The package the signed URL serves. */
  readonly zip: Uint8Array;
  /** The Manifest `download` answers. */
  readonly manifest: Record<string, unknown>;
  /** The SHA-256 `download` reports; default: the zip's. */
  readonly sha256?: string;
  /** The size `download` reports; default: the zip's. */
  readonly size?: number;
}

let server: Server;
let baseUrl: string;
let published: Map<string, Published>;
let downloadCalls: { body: unknown; headers: IncomingMessage['headers'] }[];
let packageGets: IncomingMessage['headers'][];
/** When set, the signed URL sends the first 64 bytes, calls this, and sends nothing more. */
let stallPackage: (() => void) | null;
let root: string;
let started: Runtime[];
let events: { event: IpcEventName; payload: unknown }[];

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

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', baseUrl);
  if (request.method === 'POST' && url.pathname === '/functions/v1/download') {
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    downloadCalls.push({ body, headers: request.headers });
    const harness = published.get(String(body.harness_id));
    if (harness === undefined) {
      json(response, 404, { error: { code: 'not_found', message: 'No such Harness.' } });
      return;
    }
    const platforms = harness.manifest.platforms as string[];
    if (!platforms.includes(String(body.platform))) {
      json(response, 422, { error: { code: 'platform_not_supported', message: 'No package.' } });
      return;
    }
    json(response, 200, {
      url: `${baseUrl}/storage/v1/object/sign/harness-packages/${String(body.harness_id)}.zip?token=signed`,
      sha256: harness.sha256 ?? sha256(harness.zip),
      size: harness.size ?? harness.zip.length,
      manifest: harness.manifest,
    });
    return;
  }
  const signed = /^\/storage\/v1\/object\/sign\/harness-packages\/(.+)\.zip$/.exec(url.pathname);
  if (request.method === 'GET' && signed !== null) {
    packageGets.push(request.headers);
    const harness = published.get(signed[1] ?? '');
    if (harness === undefined || url.searchParams.get('token') !== 'signed') {
      json(response, 400, { error: 'InvalidJWT', message: 'jwt expired' });
      return;
    }
    response.writeHead(200, { 'content-type': 'application/zip' });
    if (stallPackage !== null) {
      response.write(harness.zip.subarray(0, 64));
      stallPackage();
      return; // Never ends: the client gives up or is closed with the server.
    }
    response.end(harness.zip);
    return;
  }
  json(response, 404, { error: { code: 'not_found', message: 'No route.' } });
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Every file of a fixture Harness folder, by its path inside the package. */
function folderFiles(name: string): Zippable {
  const folder = join(FIXTURES, name);
  const files: Zippable = {};
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

/** The fixture's manifest.json, parsed. */
function fixtureManifest(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** The same JSON value with its keys in the reverse order, as `jsonb` may hand them back. */
function reordered(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).reverse());
}

/** Publishes the fixture `name` in the fake Store: its zip, `extra` entries added. */
function publish(name: string, overrides: Partial<Published> = {}, extra: Zippable = {}) {
  const manifest = fixtureManifest(name);
  const zip = zipSync({ ...folderFiles(name), ...extra });
  published.set(String(manifest.id), { zip, manifest: reordered(manifest), ...overrides });
}

beforeEach(async () => {
  published = new Map();
  downloadCalls = [];
  packageGets = [];
  stallPackage = null;
  events = [];
  started = [];
  server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  root = mkdtempSync(join(tmpdir(), 'harness-store-store-install-'));
});
afterEach(async () => {
  await Promise.all(started.map((runtime) => runtime.shutdown()));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

/** One app launch on `userData` (default `<root>/userData`) with the fake Store as its Store. */
async function launch(userData = join(root, 'userData'), storeUrl = baseUrl) {
  mkdirSync(userData, { recursive: true });
  const db = openDatabase(join(userData, 'harness-store.sqlite'));
  try {
    createSqliteSettingsStore(db).write('store_base_url', storeUrl);
  } finally {
    db.close();
  }
  const runtime = await startRuntime({
    dataDir: userData,
    version: '1.4.2',
    osLocale: () => 'en-US',
    quit: () => undefined,
    logError: () => undefined,
    // Connectivity checks never reach anything; the Store calls go to the fake Store.
    fetch: () => Promise.reject(new TypeError('fetch failed')),
    storeFetch: (url, init) => globalThis.fetch(url, init),
    storeAnonKey: ANON_KEY,
    providerFetch: globalThis.fetch,
    secretCipher: createFakeCipher(),
    platform: 'linux-x64',
    now: () => new Date(NOW),
    pickFolder: () => Promise.resolve(null),
    emit: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => {
      if (event === 'installs.changed' || event.startsWith('progress:')) {
        events.push({ event, payload });
      }
    },
    createGateway: (options) =>
      createGateway({ ...options, logger: { debug: () => undefined, error: () => undefined } }),
  });
  started.push(runtime);
  const dispatch = createDispatcher({
    handlers: createHandlers(runtime.services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return {
    runtime,
    call: (method: string, input?: unknown) => dispatch(MAIN_WINDOW, { method, input }),
  };
}

const userDataDir = () => join(root, 'userData');

/** Every `installs` row, whatever its state, as SQLite holds it. */
function installRows(userData = userDataDir()) {
  const db = new DatabaseSync(join(userData, 'harness-store.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT * FROM installs').all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** What is in `downloads/` (nothing when it was never made). */
function downloads(userData = userDataDir()): string[] {
  const folder = join(userData, 'downloads');
  return existsSync(folder) ? readdirSync(folder) : [];
}

const harnessesFolder = (userData = userDataDir()) => join(userData, 'harnesses');

const progressOf = (jobId: string) =>
  events
    .filter((event) => event.event === `progress:${jobId}`)
    .map((event) => event.payload as DownloadProgress);

/** Resolves once the job reported its first bytes. */
async function firstProgress(jobId: string) {
  await expect.poll(() => progressOf(jobId).length).toBeGreaterThan(0);
}

/** The validated Manifest of a fixture, as the consent dialog's facts are made from. */
function validated(name: string): Manifest {
  const result = validateManifest(fixtureManifest(name));
  if (!result.ok) throw new Error('fixture Manifest is invalid');
  return result.manifest;
}

describe('installs.install and installs.confirm', () => {
  it('downloads with progress, verifies, waits for consent, then installs into the Library', async () => {
    publish('fixture-web');
    const { call } = await launch();

    const answer = await call('installs.install', { harnessId: WEB, jobId: 'job-1' });
    expect(answer).toEqual({ ok: true, data: summarize(validated('fixture-web'), 'linux-x64') });

    // The Store was asked for the latest version on this platform, with the anon key only.
    expect(downloadCalls).toEqual([
      {
        body: { harness_id: WEB, version: null, platform: 'linux-x64', app_version: '1.4.2' },
        headers: expect.objectContaining({ apikey: ANON_KEY }) as unknown,
      },
    ]);
    expect(downloadCalls[0]?.headers.authorization).toBeUndefined();
    // Nothing but the signed URL itself goes to the package's host.
    expect(packageGets).toHaveLength(1);
    expect(packageGets[0]?.apikey).toBeUndefined();
    expect(packageGets[0]?.authorization).toBeUndefined();

    const size = published.get(WEB)?.zip.length ?? 0;
    const progress = progressOf('job-1');
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((report) => report.total === size)).toBe(true);
    expect(progress.at(-1)).toEqual({ received: size, total: size });

    // Waiting for consent: a transient row the Library does not list, and the download.
    expect(installRows()).toMatchObject([{ harness_id: WEB, state: 'awaiting_consent' }]);
    expect(downloads()).toEqual(['download-job-1.zip']);
    expect(existsSync(harnessesFolder())).toBe(false);
    await expect(call('installs.list')).resolves.toEqual({ ok: true, data: [] });
    expect(events.filter((event) => event.event === 'installs.changed')).toEqual([]);

    await expect(call('installs.confirm', 'job-1')).resolves.toEqual({
      ok: true,
      data: { harnessId: WEB, version: '1.0.0' },
    });
    const installPath = join(harnessesFolder(), 'acme', 'fixture-web', '1.0.0');
    for (const file of ['manifest.json', 'README.md', 'assets/icon.png', 'index.mjs']) {
      expect(readFileSync(join(installPath, file))).toEqual(
        readFileSync(join(FIXTURES, 'fixture-web', file)),
      );
    }
    expect(existsSync(join(userDataDir(), 'data', 'acme', 'fixture-web'))).toBe(true);
    expect(downloads()).toEqual([]);
    expect(installRows()).toEqual([
      expect.objectContaining({
        harness_id: WEB,
        version: '1.0.0',
        install_path: installPath,
        installed_at: NOW,
        consented_permissions: JSON.stringify(validated('fixture-web').permissions),
        source: 'store',
        state: 'installed',
      }),
    ]);
    expect(events.filter((event) => event.event === 'installs.changed')).toEqual([
      { event: 'installs.changed', payload: { harnessId: WEB } },
    ]);
    await expect(call('installs.list')).resolves.toMatchObject({
      ok: true,
      data: [{ harnessId: WEB, version: '1.0.0', source: 'store', platformSupported: true }],
    });
  });

  it.skipIf(process.platform === 'win32')(
    'makes the Entry of a binary Harness executable',
    async () => {
      publish('fixture-binary-term');
      const { call } = await launch();
      await expect(
        call('installs.install', { harnessId: BINARY, jobId: 'job-1' }),
      ).resolves.toMatchObject({ ok: true, data: { runtimeKind: 'binary' } });
      await expect(call('installs.confirm', 'job-1')).resolves.toMatchObject({ ok: true });
      const entry = join(harnessesFolder(), 'acme', 'fixture-binary-term', '1.0.0', 'bin');
      expect(statSync(join(entry, 'fixture-binary-term')).mode & 0o777).toBe(0o755);
    },
  );

  it('a package whose bytes are not the SHA-256 the Store reported never reaches consent', async () => {
    publish('fixture-web', { sha256: 'a'.repeat(64) });
    const { call } = await launch();
    await expect(
      call('installs.install', { harnessId: WEB, jobId: 'job-1' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'checksum_mismatch' } });
    expect(installRows()).toEqual([]);
    expect(downloads()).toEqual([]);
    expect(existsSync(harnessesFolder())).toBe(false);
    // Retry is another download.
    publish('fixture-web');
    await expect(
      call('installs.install', { harnessId: WEB, jobId: 'job-2' }),
    ).resolves.toMatchObject({ ok: true });
    expect(downloadCalls).toHaveLength(2);
  });

  it('stops a transfer larger than the size the Store reported', async () => {
    publish('fixture-web');
    const zip = published.get(WEB)?.zip ?? new Uint8Array();
    publish('fixture-web', { size: zip.length - 1 });
    const { call } = await launch();
    await expect(
      call('installs.install', { harnessId: WEB, jobId: 'job-1' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'checksum_mismatch' } });
    expect(installRows()).toEqual([]);
    expect(downloads()).toEqual([]);
    expect(progressOf('job-1').every((report) => report.received <= zip.length - 1)).toBe(true);
  });

  it.each<[string, Zippable]>([
    ['a `..` entry', { '../escaped.txt': new TextEncoder().encode('outside') }],
    [
      'a symbolic link',
      {
        'link-to-passwd': [
          new TextEncoder().encode('/etc/passwd'),
          // Unix (made by 3), a symbolic link's mode in the external attributes.
          { os: 3, attrs: 0o120777 << 16, level: 0 },
        ],
      },
    ],
  ])('refuses a package with %s as integrity_error, writing nothing', async (_, extra) => {
    publish('fixture-web', {}, extra);
    const { call } = await launch();
    await expect(
      call('installs.install', { harnessId: WEB, jobId: 'job-1' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'integrity_error' } });
    expect(installRows()).toEqual([]);
    expect(downloads()).toEqual([]);
    expect(existsSync(harnessesFolder())).toBe(false);
    expect(existsSync(join(userDataDir(), 'escaped.txt'))).toBe(false);
  });

  it('refuses a package whose Manifest is not the one the Store answered with', async () => {
    publish('fixture-web');
    const harness = published.get(WEB);
    if (harness === undefined) throw new Error('not published');
    published.set(WEB, { ...harness, manifest: { ...harness.manifest, summary: 'Another one.' } });
    const { call } = await launch();
    await expect(
      call('installs.install', { harnessId: WEB, jobId: 'job-1' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'integrity_error' } });
    expect(installRows()).toEqual([]);
    expect(downloads()).toEqual([]);
  });

  it('Cancel during the download stops it and leaves no file and no row', async () => {
    publish('fixture-web');
    stallPackage = () => undefined;
    const { call } = await launch();
    const install = call('installs.install', { harnessId: WEB, jobId: 'job-1' });
    await firstProgress('job-1');
    expect(installRows()).toMatchObject([{ harness_id: WEB, state: 'downloading' }]);
    expect(downloads()).toEqual(['download-job-1.zip']);

    await expect(call('installs.cancel', 'job-1')).resolves.toEqual({ ok: true, data: null });
    await expect(install).resolves.toMatchObject({
      ok: false,
      error: { code: 'download_cancelled' },
    });
    expect(installRows()).toEqual([]);
    expect(downloads()).toEqual([]);
    expect(existsSync(harnessesFolder())).toBe(false);
  });

  it('Cancel at the consent dialog discards the download and the row', async () => {
    publish('fixture-web');
    const { call } = await launch();
    await expect(
      call('installs.install', { harnessId: WEB, jobId: 'job-1' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(call('installs.cancel', 'job-1')).resolves.toEqual({ ok: true, data: null });
    expect(installRows()).toEqual([]);
    expect(downloads()).toEqual([]);
    // The job is gone: confirming it is refused, cancelling it again changes nothing.
    await expect(call('installs.confirm', 'job-1')).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    await expect(call('installs.cancel', 'job-1')).resolves.toEqual({ ok: true, data: null });
    expect(existsSync(harnessesFolder())).toBe(false);
  });

  it('answers the Store refusals by their codes, leaving nothing', async () => {
    publish('fixture-web');
    const harness = published.get(WEB);
    if (harness === undefined) throw new Error('not published');
    published.set(WEB, {
      ...harness,
      manifest: { ...harness.manifest, platforms: ['darwin-arm64'] },
    });
    const { call } = await launch();
    await expect(
      call('installs.install', { harnessId: WEB, jobId: 'job-1' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'platform_not_supported' } });
    await expect(
      call('installs.install', { harnessId: 'acme/unknown', jobId: 'job-2' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(installRows()).toEqual([]);
    expect(downloads()).toEqual([]);
  });

  it('answers store_unreachable when the Store does not answer', async () => {
    const { call } = await launch(userDataDir(), `http://127.0.0.1:${String(REFUSED_PORT)}`);
    await expect(
      call('installs.install', { harnessId: WEB, jobId: 'job-1' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'store_unreachable' } });
    expect(installRows()).toEqual([]);
  });

  it('refuses a second install of a Harness being installed, and one already installed', async () => {
    publish('fixture-web');
    const { call } = await launch();
    await expect(
      call('installs.install', { harnessId: WEB, jobId: 'job-1' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      call('installs.install', { harnessId: WEB, jobId: 'job-2' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'harness_installing' } });
    // A job ID in use is refused too, whatever the Harness.
    publish('fixture-binary-term');
    await expect(
      call('installs.install', { harnessId: BINARY, jobId: 'job-1' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    // "Install this folder locally" waits for the Store install too.
    const folder = join(root, 'my-harness');
    mkdirSync(folder);
    for (const [path, bytes] of Object.entries(folderFiles('fixture-web'))) {
      mkdirSync(join(folder, path, '..'), { recursive: true });
      writeFileSync(join(folder, path), bytes as Uint8Array);
    }
    await expect(call('installs.installFromFolder', folder)).resolves.toMatchObject({
      ok: false,
      error: { code: 'harness_installing' },
    });

    await expect(call('installs.confirm', 'job-1')).resolves.toMatchObject({ ok: true });
    // Installed: no Store install over it (Update is P0-10.2's).
    await expect(
      call('installs.install', { harnessId: WEB, jobId: 'job-3' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    // Only the first install reached the Store.
    expect(downloadCalls).toHaveLength(1);
  });

  it('downloads two Harnesses side by side', async () => {
    publish('fixture-web');
    publish('fixture-binary-term');
    const { call } = await launch();
    const [web, binary] = await Promise.all([
      call('installs.install', { harnessId: WEB, jobId: 'job-1' }),
      call('installs.install', { harnessId: BINARY, jobId: 'job-2' }),
    ]);
    expect([web.ok, binary.ok]).toEqual([true, true]);
    const [first, second] = await Promise.all([
      call('installs.confirm', 'job-1'),
      call('installs.confirm', 'job-2'),
    ]);
    expect([first.ok, second.ok]).toEqual([true, true]);
    expect(installRows().map((row) => [row.harness_id, row.state])).toEqual(
      expect.arrayContaining([
        [WEB, 'installed'],
        [BINARY, 'installed'],
      ]),
    );
  });

  it.each([
    { harnessId: 'no-slash', jobId: 'job-1' },
    { harnessId: WEB },
    { harnessId: WEB, jobId: '../escape' },
    { harnessId: WEB, jobId: 'job-1', version: '1.0.0' },
  ])('installs.install refuses %j as invalid_input', async (input) => {
    const { call } = await launch();
    await expect(call('installs.install', input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(downloadCalls).toEqual([]);
  });
});

describe('restart after an interrupted install', () => {
  it('deletes transient rows and their downloads at startup, keeping installed rows', async () => {
    // What a crash mid-download leaves: a `downloading` row, a partial download and a staging
    // copy, next to an installed Harness.
    const userData = userDataDir();
    mkdirSync(join(userData, 'downloads', 'install-1234'), { recursive: true });
    writeFileSync(join(userData, 'downloads', 'download-job-1.zip'), 'partial');
    writeFileSync(join(userData, 'downloads', 'unrelated.txt'), 'kept');
    const db = openDatabase(join(userData, 'harness-store.sqlite'));
    try {
      const store = createInstallStore(db);
      const base = {
        manifest: validated('fixture-web'),
        dataDir: join(userData, 'data', 'acme', 'x'),
        installedAt: NOW,
        consentedPermissions: validated('fixture-web').permissions,
        source: 'store' as const,
        version: '1.0.0',
      };
      store.begin({ ...base, harnessId: WEB, installPath: join(userData, 'harnesses', 'a') });
      store.begin({ ...base, harnessId: BINARY, installPath: join(userData, 'harnesses', 'b') });
      store.setState(BINARY, 'awaiting_consent');
      store.put({ ...base, harnessId: 'acme/kept', installPath: join(userData, 'harnesses', 'c') });
    } finally {
      db.close();
    }

    const { call } = await launch();
    await call('installs.list');
    expect(installRows().map((row) => [row.harness_id, row.state])).toEqual([
      ['acme/kept', 'installed'],
    ]);
    expect(downloads()).toEqual(['unrelated.txt']);

    // The Harness can be installed again at once.
    publish('fixture-web');
    await expect(
      call('installs.install', { harnessId: WEB, jobId: 'job-1' }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('cleans up an install the app stopped at the consent dialog', async () => {
    publish('fixture-web');
    const first = await launch();
    await expect(
      first.call('installs.install', { harnessId: WEB, jobId: 'job-1' }),
    ).resolves.toMatchObject({ ok: true });
    // The app is killed: nothing runs its cleanup.
    await first.runtime.shutdown();
    expect(installRows()).toMatchObject([{ state: 'awaiting_consent' }]);
    expect(downloads()).toEqual(['download-job-1.zip']);

    const second = await launch();
    await expect(second.call('installs.list')).resolves.toEqual({ ok: true, data: [] });
    expect(installRows()).toEqual([]);
    expect(downloads()).toEqual([]);
  });
});

describe('one install path, two entry points', () => {
  it('a Store install and a folder install write rows of the same shape', async () => {
    publish('fixture-web');
    const storeData = join(root, 'store-install');
    const { call: fromStore } = await launch(storeData);
    await fromStore('installs.install', { harnessId: WEB, jobId: 'job-1' });
    await expect(fromStore('installs.confirm', 'job-1')).resolves.toMatchObject({ ok: true });

    const folderData = join(root, 'folder-install');
    const { call: fromFolder } = await launch(folderData);
    await expect(
      fromFolder('installs.installFromFolder', join(FIXTURES, 'fixture-web')),
    ).resolves.toMatchObject({ ok: true });

    /** A row with its paths relative to its app data root, and without `source`. */
    const shape = (row: Record<string, unknown> | undefined, userData: string) => {
      if (row === undefined) throw new Error('no row');
      return {
        ...row,
        source: undefined,
        manifest: JSON.parse(String(row.manifest)) as unknown,
        install_path: relative(userData, String(row.install_path)),
        data_dir: relative(userData, String(row.data_dir)),
      };
    };
    const [storeRow] = installRows(storeData);
    const [folderRow] = installRows(folderData);
    expect(shape(storeRow, storeData)).toEqual(shape(folderRow, folderData));
    expect([storeRow?.source, folderRow?.source]).toEqual(['store', 'local']);
  });
});

describe('createStoreDownloader', () => {
  const downloader = (idleTimeoutMs?: number) =>
    createStoreDownloader({
      fetch: (url, init) => globalThis.fetch(url, init),
      storeBaseUrl: () => baseUrl,
      anonKey: ANON_KEY,
      appVersion: '1.4.2',
      ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
    });

  it('gives a transfer that receives nothing for the idle timeout up as store_unreachable', async () => {
    publish('fixture-web');
    const ticket = await downloader().ticket(
      { harnessId: WEB, version: null, platform: 'linux-x64' },
      new AbortController().signal,
    );
    if (!ticket.ok) throw new Error('no ticket');
    stallPackage = () => undefined;
    const file = join(root, 'package.zip');
    await expect(
      downloader(200).fetchPackage(ticket.data, file, {
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'store_unreachable' } });
  });

  it('answers store_error for an expired URL, and for a Manifest of another Harness', async () => {
    publish('fixture-web');
    const ticket = await downloader().ticket(
      { harnessId: WEB, version: null, platform: 'linux-x64' },
      new AbortController().signal,
    );
    if (!ticket.ok) throw new Error('no ticket');
    await expect(
      downloader().fetchPackage(
        { ...ticket.data, url: ticket.data.url.replace('token=signed', 'token=expired') },
        join(root, 'package.zip'),
        { signal: new AbortController().signal, onProgress: () => undefined },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'store_error' } });

    const harness = published.get(WEB);
    if (harness === undefined) throw new Error('not published');
    published.set('acme/other', harness);
    await expect(
      downloader().ticket(
        { harnessId: 'acme/other', version: null, platform: 'linux-x64' },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'store_error' } });
    // A version asked for must be the one answered.
    await expect(
      downloader().ticket(
        { harnessId: WEB, version: '2.0.0', platform: 'linux-x64' },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'store_error' } });
  });
});
