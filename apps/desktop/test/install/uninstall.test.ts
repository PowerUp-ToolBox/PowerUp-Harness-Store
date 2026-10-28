/**
 * Ticket P0-10.3: uninstall and the Data Directory's size, through the Runtime's IPC handlers (the
 * Supervisor/Installer seam, architecture §8 item 3): the real Runtime with its SQLite file in a
 * temp app data root, the real Model Gateway, `fixture-term` installed from its folder and run for
 * real in a pty, its window faked. Asserted on the filesystem and the SQLite rows: an uninstall
 * deletes the install folder, the Data Directory, the `installs` row and the Model Overrides, and
 * keeps the launch logs and the `launches` rows; a running Harness is refused with nothing
 * changed; an uninstall that stopped partway finishes when asked again.
 *
 * Then the installer on its own: it counts as installing while it deletes (so nothing launches
 * it), an update under way refuses it, and the launch logs of uninstalled Harnesses are deleted 30
 * days after they were written, at a later start.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Manifest } from '@harness-store/manifest';
import { startFakeProvider, type FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from '../../src/main/runtime/bootstrap.js';
import { openDatabase } from '../../src/main/runtime/database.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createHarnessWindowHandlers } from '../../src/main/runtime/harness-window-handlers.js';
import { harnessPaths } from '../../src/main/runtime/harness-paths.js';
import { createInstallStore, type InstallStore } from '../../src/main/runtime/install-store.js';
import {
  createInstaller,
  pruneUninstalledLogs,
  UNINSTALLED_LOG_RETENTION_MS,
} from '../../src/main/runtime/installer.js';
import type { StoreDownloader } from '../../src/main/runtime/store-download.js';
import type { HarnessWindows } from '../../src/main/runtime/supervisor.js';
import type { IpcEventName, IpcEvents, IpcResult, LaunchStatus } from '../../src/shared/ipc.js';
import { createFakeCipher } from '../support/fake-cipher.js';

const FIXTURES = join(import.meta.dirname, '../fixtures/harnesses');
const PLATFORM = `${process.platform}-${process.arch}`;
const MAIN_WINDOW = {};
const TERM = 'acme/fixture-term';

describe('uninstall over IPC', () => {
  let root: string;
  let userData: string;
  let fake: FakeProvider;
  let runtime: Runtime;
  let windows: ReturnType<typeof createFakeWindows>;
  let states: LaunchStatus[];
  let changed: string[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'harness-store-uninstall-'));
    userData = join(root, 'userData');
    fake = await startFakeProvider({ aliases: { 'model-a': 'fake/echo' } });
    states = [];
    changed = [];
    windows = createFakeWindows();
    runtime = await startRuntime({
      dataDir: userData,
      version: '1.0.0',
      osLocale: () => 'en',
      quit: () => undefined,
      logError: () => undefined,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
      providerFetch: globalThis.fetch,
      secretCipher: createFakeCipher(),
      platform: PLATFORM,
      harnessWindows: windows,
      emit: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => {
        if (event === 'launch.state') states.push(payload as LaunchStatus);
        if (event === 'installs.changed') {
          changed.push((payload as IpcEvents['installs.changed']).harnessId);
        }
      },
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
    await expect(
      call('installs.installFromFolder', join(FIXTURES, 'fixture-term')),
    ).resolves.toMatchObject({ ok: true });
  });
  afterEach(async () => {
    await runtime.shutdown();
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  });

  function call(method: string, input?: unknown) {
    return createDispatcher({
      handlers: createHandlers(runtime.services),
      isTrustedSender: (sender) => sender === MAIN_WINDOW,
    })(MAIN_WINDOW, { method, input });
  }

  /** Harness windows without Electron, each reporting its terminal ready at once. */
  function createFakeWindows() {
    const open = new Map<string, () => void>();
    return {
      openTerminal(spec, onClosed) {
        open.set(spec.launchId, onClosed);
        queueMicrotask(() => {
          void createDispatcher({
            handlers: createHarnessWindowHandlers(spec.launchId, {
              supervisor: runtime.supervisor,
              bindings: runtime.services.bindings,
              clipboard: {
                readText: () => Promise.resolve(''),
                writeText: () => Promise.resolve(),
              },
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
    } satisfies HarnessWindows;
  }

  async function waitForState(launchId: string, state: LaunchStatus['state']) {
    const deadline = Date.now() + 5000;
    while (!states.some((each) => each.launchId === launchId && each.state === state)) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${state}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Launches fixture-term and waits until it runs; its launch ID. */
  async function launch(): Promise<string> {
    const started = (await call('launch.start', { harnessId: TERM })) as IpcResult<{
      launchId: string;
    }>;
    if (!started.ok) throw new Error(started.error.message);
    await waitForState(started.data.launchId, 'ready');
    return started.data.launchId;
  }

  const installFolder = () => join(userData, 'harnesses', 'acme', 'fixture-term', '1.0.0');
  const dataDir = () => join(userData, 'data', 'acme', 'fixture-term');
  const logsDir = () => join(userData, 'logs', 'acme', 'fixture-term');

  /** Every row of `table` as SQLite holds it. */
  function rows(table: 'installs' | 'slot_bindings' | 'launches') {
    const db = new DatabaseSync(join(userData, 'harness-store.sqlite'), { readOnly: true });
    try {
      return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    } finally {
      db.close();
    }
  }

  /** Writes files into the Data Directory: 1000 + 500 bytes, and one link not to be followed. */
  function seedDataDirectory() {
    mkdirSync(join(dataDir(), 'nested'), { recursive: true });
    writeFileSync(join(dataDir(), 'state.json'), 'x'.repeat(1000));
    writeFileSync(join(dataDir(), 'nested', 'notes.txt'), 'y'.repeat(500));
    // A file of the User's own, outside the Data Directory, reached through a link inside it.
    const own = join(root, 'my-own-file.txt');
    writeFileSync(own, 'z'.repeat(100_000));
    symlinkSync(own, join(dataDir(), 'link-to-my-file'));
    return own;
  }

  it('deletes the install folder, the Data Directory, the row and the Model Overrides, and keeps the logs', async () => {
    const own = seedDataDirectory();
    await expect(
      call('bindings.setOverride', {
        harnessId: TERM,
        slot: 'default',
        target: { connectionId: 'ollama', model: 'model-a' },
      }),
    ).resolves.toMatchObject({ ok: true });
    // A launch, ended, whose log must outlive the uninstall.
    const launchId = await launch();
    windows.close(launchId);
    await waitForState(launchId, 'stopped');
    const log = join(logsDir(), `${launchId}.log`);
    const logged = readFileSync(log, 'utf8');
    expect(logged).not.toBe('');
    changed = [];

    // The confirmation's size: the two files, not the file the link points to.
    await expect(call('installs.dataSize', TERM)).resolves.toEqual({ ok: true, data: 1500 });

    await expect(call('installs.uninstall', TERM)).resolves.toEqual({ ok: true, data: null });
    expect(existsSync(installFolder())).toBe(false);
    // The Harness's now-empty folders of the install layout are gone too.
    expect(readdirSync(join(userData, 'harnesses'))).toEqual([]);
    expect(existsSync(dataDir())).toBe(false);
    expect(readdirSync(join(userData, 'data'))).toEqual([]);
    expect(rows('installs')).toEqual([]);
    expect(rows('slot_bindings')).toEqual([
      expect.objectContaining({ scope: 'global', slot: 'default' }),
    ]);
    await expect(call('installs.list')).resolves.toEqual({ ok: true, data: [] });
    expect(changed).toEqual([TERM]);
    // Kept: the log, the launch's row, and the User's file the link pointed to.
    expect(readFileSync(log, 'utf8')).toBe(logged);
    expect(rows('launches')).toMatchObject([{ launch_id: launchId, harness_id: TERM }]);
    expect(readFileSync(own, 'utf8')).toHaveLength(100_000);

    // It is not installed any more.
    await expect(call('installs.uninstall', TERM)).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_installed' },
    });
    await expect(call('installs.dataSize', TERM)).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_installed' },
    });
    await expect(call('launch.start', { harnessId: TERM })).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_installed' },
    });
  });

  it('refuses while the Harness runs, deleting nothing', async () => {
    seedDataDirectory();
    const launchId = await launch();
    const before = {
      install: readdirSync(installFolder(), { recursive: true }).map(String).sort(),
      data: readdirSync(dataDir(), { recursive: true }).map(String).sort(),
      installs: rows('installs'),
    };
    changed = [];

    await expect(call('installs.uninstall', TERM)).resolves.toMatchObject({
      ok: false,
      error: { code: 'harness_running' },
    });
    expect(readdirSync(installFolder(), { recursive: true }).map(String).sort()).toEqual(
      before.install,
    );
    expect(readdirSync(dataDir(), { recursive: true }).map(String).sort()).toEqual(before.data);
    expect(rows('installs')).toEqual(before.installs);
    expect(changed).toEqual([]);

    // Once its window is closed and it stopped, it can be uninstalled.
    windows.close(launchId);
    await waitForState(launchId, 'stopped');
    await expect(call('installs.uninstall', TERM)).resolves.toEqual({ ok: true, data: null });
  });

  it('finishes an uninstall that stopped partway, as the folders already gone count as deleted', async () => {
    // The install folder was deleted, then the app stopped: the row is still there.
    rmSync(installFolder(), { recursive: true });
    await expect(call('installs.uninstall', TERM)).resolves.toEqual({ ok: true, data: null });
    expect(existsSync(dataDir())).toBe(false);
    expect(rows('installs')).toEqual([]);
  });

  it('sizes a missing Data Directory as 0, and refuses an input that is not a Harness ID', async () => {
    rmSync(dataDir(), { recursive: true, force: true });
    await expect(call('installs.dataSize', TERM)).resolves.toEqual({ ok: true, data: 0 });
    for (const method of ['installs.uninstall', 'installs.dataSize']) {
      for (const input of [undefined, 42, '', 'acme']) {
        await expect(call(method, input)).resolves.toMatchObject({
          ok: false,
          error: { code: 'invalid_input' },
        });
      }
    }
  });
});

describe('the installer on its own', () => {
  let root: string;
  let db: DatabaseSync;
  let store: InstallStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-store-uninstall-unit-'));
    db = openDatabase(join(root, 'harness-store.sqlite'));
    store = createInstallStore(db);
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const paths = () => harnessPaths(join(root, 'userData'));

  /** Records `fixture-term` as an installed Store Harness, with its folder and Data Directory. */
  function recordInstall(harnessId = TERM) {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURES, 'fixture-term', 'manifest.json'), 'utf8'),
    ) as Manifest;
    const installPath = paths().installPath(harnessId, manifest.version);
    mkdirSync(installPath, { recursive: true });
    writeFileSync(join(installPath, 'index.mjs'), '');
    mkdirSync(paths().dataDir(harnessId), { recursive: true });
    store.put({
      harnessId,
      version: manifest.version,
      manifest: { ...manifest, id: harnessId },
      installPath,
      dataDir: paths().dataDir(harnessId),
      installedAt: '2026-10-01T00:00:00.000Z',
      consentedPermissions: manifest.permissions,
      source: 'store',
    });
  }

  it('counts as installing from its running check until the row is gone, so nothing launches it', async () => {
    recordInstall();
    const seen: string[] = [];
    const installing = () => service.isInstalling(TERM);
    const service = createInstaller({
      store: {
        ...store,
        remove: (harnessId) => {
          seen.push(`remove while installing: ${String(installing())}`);
          return store.remove(harnessId);
        },
      },
      root: join(root, 'userData'),
      platform: null,
      pickFolder: () => Promise.resolve(null),
      isRunning: () => {
        seen.push(`running check while installing: ${String(installing())}`);
        return false;
      },
    });
    await expect(service.uninstall(TERM)).resolves.toEqual({ ok: true, data: null });
    expect(seen).toEqual([
      'running check while installing: false',
      'remove while installing: true',
    ]);
    expect(installing()).toBe(false);
  });

  it('refuses with harness_installing while an update of it downloads, deleting nothing', async () => {
    recordInstall();
    // A Store that never answers the `download` call until the update is cancelled.
    const downloader: StoreDownloader = {
      ticket: (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            resolve({
              ok: false,
              error: {
                code: 'download_cancelled',
                messageKey: 'error.download_cancelled',
                message: 'Download cancelled.',
              },
            });
          });
        }),
      fetchPackage: () => Promise.reject(new Error('not reached')),
    };
    const service = createInstaller({
      store,
      root: join(root, 'userData'),
      platform: 'linux-x64',
      pickFolder: () => Promise.resolve(null),
      downloader,
    });
    const updating = service.update({
      harnessId: TERM,
      version: '9.0.0',
      jobId: 'update-job',
      reconsented: false,
    });
    await expect(service.uninstall(TERM)).resolves.toMatchObject({
      ok: false,
      error: { code: 'harness_installing' },
    });
    expect(store.get(TERM)).toBeDefined();
    expect(existsSync(paths().installPath(TERM, '1.0.0'))).toBe(true);
    await service.cancel('update-job');
    await expect(updating).resolves.toMatchObject({
      ok: false,
      error: { code: 'download_cancelled' },
    });
    await expect(service.uninstall(TERM)).resolves.toEqual({ ok: true, data: null });
  });

  it('deletes, at startup, the logs of uninstalled Harnesses written over 30 days ago, and nothing of installed ones', async () => {
    const NOW = new Date('2026-10-28T09:00:00.000Z');
    const logs = paths().logs;
    const old = new Date(NOW.getTime() - UNINSTALLED_LOG_RETENTION_MS - 60_000);
    const recent = new Date(NOW.getTime() - UNINSTALLED_LOG_RETENTION_MS + 60_000);
    const writeLog = (harnessId: string, name: string, at: Date) => {
      const folder = join(logs, ...harnessId.split('/'));
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, name), 'a line\n');
      utimesSync(join(folder, name), at, at);
    };
    recordInstall('acme/kept');
    writeLog('acme/kept', 'old.log', old);
    writeLog('acme/gone-recent', 'old.log', old);
    writeLog('acme/gone-recent', 'recent.log', recent);
    writeLog('bob/gone-old', 'old.log', old);
    // Not a launch log: left alone, and so is its folder.
    writeLog('carol/gone-other', 'notes.txt', old);

    const installer = createInstaller({
      store,
      root: join(root, 'userData'),
      platform: null,
      pickFolder: () => Promise.resolve(null),
      now: () => NOW,
    });
    // The startup cleanup runs before the first listing.
    await installer.list();
    const left = readdirSync(logs, { recursive: true }).map(String).sort();
    expect(left).toEqual(
      [
        'acme',
        join('acme', 'gone-recent'),
        join('acme', 'gone-recent', 'recent.log'),
        join('acme', 'kept'),
        join('acme', 'kept', 'old.log'),
        'carol',
        join('carol', 'gone-other'),
        join('carol', 'gone-other', 'notes.txt'),
      ].sort(),
    );
  });

  it('never throws when the logs folder is missing', async () => {
    await expect(
      pruneUninstalledLogs(join(root, 'no-such-folder'), () => false, new Date()),
    ).resolves.toBeUndefined();
  });
});
