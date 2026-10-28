import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/main/runtime/database.js';
import { entryFor, harnessPaths, platformOf } from '../../src/main/runtime/harness-paths.js';
import { createInstallStore, type InstallStore } from '../../src/main/runtime/install-store.js';
import { createInstaller } from '../../src/main/runtime/installer.js';
import { manifestWith } from '../support/manifest.js';

/**
 * The installer on its own, against a temp SQLite file: what the Runtime does not reach over IPC
 * yet (a running Harness, an install that came from the Store) and the executable bit.
 */

const FIXTURE = join(import.meta.dirname, '../fixtures/harnesses/fixture-web');

let root: string;
let folder: string;
let db: DatabaseSync;
let store: InstallStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-installer-'));
  folder = join(root, 'my-harness');
  cpSync(FIXTURE, folder, { recursive: true });
  db = openDatabase(join(root, 'harness-store.sqlite'));
  store = createInstallStore(db);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function installer(
  options: {
    isRunning?: (harnessId: string) => boolean;
    store?: InstallStore;
    onChanged?: (harnessId: string) => void;
    logError?: (message: string, error: unknown) => void;
  } = {},
) {
  return createInstaller({
    store,
    root: join(root, 'userData'),
    platform: 'linux-x64',
    pickFolder: () => Promise.resolve(null),
    now: () => new Date('2026-10-28T09:00:00.000Z'),
    logError: () => undefined,
    ...options,
  });
}

/** The real store, except that writing a row throws, as a full or locked database would. */
function storeThatCannotWrite(): InstallStore {
  return {
    all: () => store.all(),
    get: (harnessId) => store.get(harnessId),
    put: () => {
      throw new Error('database is locked');
    },
    markLaunched: (harnessId, at) => {
      store.markLaunched(harnessId, at);
    },
  };
}

const userData = () => join(root, 'userData');
const installedAt = (version: string) =>
  harnessPaths(userData()).installPath('acme/fixture-web', version);
const versionFolders = () => readdirSync(join(userData(), 'harnesses', 'acme', 'fixture-web'));
const downloads = () => readdirSync(join(userData(), 'downloads'));

function editManifest(change: (manifest: Record<string, unknown>) => void) {
  const path = join(folder, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  change(manifest);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

describe('createInstaller', () => {
  it('refuses with harness_running while the Harness runs, writing nothing', async () => {
    const result = await installer({
      isRunning: (id) => id === 'acme/fixture-web',
    }).installFromFolder(folder);
    expect(result).toMatchObject({ ok: false, error: { code: 'harness_running' } });
    expect(store.all()).toEqual([]);
    expect(existsSync(join(root, 'userData', 'harnesses'))).toBe(false);
  });

  it('a local install over a Store install of the same ID replaces it and becomes local', async () => {
    const paths = harnessPaths(join(root, 'userData'));
    const storeInstall = paths.installPath('acme/fixture-web', '0.5.0');
    mkdirSync(storeInstall, { recursive: true });
    writeFileSync(join(storeInstall, 'manifest.json'), '{}');
    store.put({
      harnessId: 'acme/fixture-web',
      version: '0.5.0',
      manifest: manifestWith({ default: {} }),
      installPath: storeInstall,
      dataDir: paths.dataDir('acme/fixture-web'),
      installedAt: '2026-01-01T00:00:00.000Z',
      consentedPermissions: manifestWith({ default: {} }).permissions,
      source: 'store',
    });
    db.prepare(
      "UPDATE installs SET last_launched_at = '2026-02-01T00:00:00.000Z', last_workspace = '/w', available_version = '0.6.0'",
    ).run();

    await expect(installer().installFromFolder(folder)).resolves.toMatchObject({ ok: true });
    expect(store.get('acme/fixture-web')).toMatchObject({
      version: '1.0.0',
      source: 'local',
      installedAt: '2026-10-28T09:00:00.000Z',
      // The launch history stays; a local install never has a Store update.
      lastLaunchedAt: '2026-02-01T00:00:00.000Z',
      lastWorkspace: '/w',
      availableVersion: null,
    });
    expect(existsSync(storeInstall)).toBe(false);
  });

  it('a failed row write on a reinstall of the same version keeps the installed files', async () => {
    await expect(installer().installFromFolder(folder)).resolves.toMatchObject({ ok: true });
    const before = store.get('acme/fixture-web');
    writeFileSync(join(folder, 'index.mjs'), '// changed\n');

    await expect(
      installer({ store: storeThatCannotWrite() }).installFromFolder(folder),
    ).rejects.toThrow('database is locked');
    expect(store.get('acme/fixture-web')).toEqual(before);
    expect(readFileSync(join(installedAt('1.0.0'), 'index.mjs'), 'utf8')).toBe(
      readFileSync(join(FIXTURE, 'index.mjs'), 'utf8'),
    );
    expect(versionFolders()).toEqual(['1.0.0']);
    expect(downloads()).toEqual([]);
  });

  it('a failed row write on a version change keeps the previous version', async () => {
    await expect(installer().installFromFolder(folder)).resolves.toMatchObject({ ok: true });
    const before = store.get('acme/fixture-web');
    editManifest((manifest) => {
      manifest.version = '1.1.0';
    });

    await expect(
      installer({ store: storeThatCannotWrite() }).installFromFolder(folder),
    ).rejects.toThrow('database is locked');
    expect(store.get('acme/fixture-web')).toEqual(before);
    expect(existsSync(join(installedAt('1.0.0'), 'manifest.json'))).toBe(true);
    expect(versionFolders()).toEqual(['1.0.0']);
    expect(downloads()).toEqual([]);
  });

  it('a version change replaces the previous version folder', async () => {
    await expect(installer().installFromFolder(folder)).resolves.toMatchObject({ ok: true });
    editManifest((manifest) => {
      manifest.version = '0.9.0';
    });
    await expect(installer().installFromFolder(folder)).resolves.toMatchObject({ ok: true });
    expect(store.get('acme/fixture-web')).toMatchObject({
      version: '0.9.0',
      installPath: installedAt('0.9.0'),
    });
    expect(versionFolders()).toEqual(['0.9.0']);
    expect(downloads()).toEqual([]);
  });

  // On a case-insensitive file system (the macOS and Windows defaults) both versions name one
  // folder: the previous path is then the folder just installed and must not be deleted.
  it('a version that differs only in letter case leaves the new install in place', async () => {
    editManifest((manifest) => {
      manifest.version = '1.0.0-beta';
    });
    await expect(installer().installFromFolder(folder)).resolves.toMatchObject({ ok: true });
    editManifest((manifest) => {
      manifest.version = '1.0.0-Beta';
    });
    await expect(installer().installFromFolder(folder)).resolves.toMatchObject({ ok: true });

    const row = store.get('acme/fixture-web');
    expect(row).toMatchObject({ version: '1.0.0-Beta', installPath: installedAt('1.0.0-Beta') });
    expect(
      JSON.parse(readFileSync(join(row?.installPath ?? '', 'manifest.json'), 'utf8')),
    ).toMatchObject({ version: '1.0.0-Beta' });
    expect(versionFolders()).toHaveLength(1);
    expect(downloads()).toEqual([]);
  });

  // The previous row's path is compared by the folder it names, not as a string: the case-only
  // test above catches a string comparison only on a case-insensitive file system, this one on any.
  it('a reinstall keeps the folder when the row spells its path differently', async () => {
    await expect(installer().installFromFolder(folder)).resolves.toMatchObject({ ok: true });
    const spelled = [userData(), 'harnesses', 'acme', '.', 'fixture-web', '1.0.0'].join(sep);
    db.prepare('UPDATE installs SET install_path = ?').run(spelled);

    await expect(installer().installFromFolder(folder)).resolves.toMatchObject({ ok: true });
    expect(store.get('acme/fixture-web')).toMatchObject({ installPath: installedAt('1.0.0') });
    expect(existsSync(join(installedAt('1.0.0'), 'manifest.json'))).toBe(true);
    expect(versionFolders()).toEqual(['1.0.0']);
    expect(downloads()).toEqual([]);
  });

  it('runs two installs of one folder one after the other', async () => {
    const both = installer();
    const results = await Promise.all([
      both.installFromFolder(folder),
      both.installFromFolder(folder),
    ]);
    expect(results).toEqual([
      { ok: true, data: { harnessId: 'acme/fixture-web', version: '1.0.0' } },
      { ok: true, data: { harnessId: 'acme/fixture-web', version: '1.0.0' } },
    ]);
    expect(store.all()).toHaveLength(1);
    expect(versionFolders()).toEqual(['1.0.0']);
    expect(existsSync(join(installedAt('1.0.0'), 'manifest.json'))).toBe(true);
    expect(downloads()).toEqual([]);
  });

  // A folder the OS will not let go of (Windows antivirus, a file indexer) stands in as a folder
  // whose subfolder cannot be written. Root deletes it anyway.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an install is reported once recorded, even when the replaced folder cannot be deleted',
    async () => {
      await expect(installer().installFromFolder(folder)).resolves.toMatchObject({ ok: true });
      const stuck = join(installedAt('1.0.0'), 'stuck');
      mkdirSync(stuck);
      writeFileSync(join(stuck, 'file'), '');
      chmodSync(stuck, 0o555);
      editManifest((manifest) => {
        manifest.version = '2.0.0';
      });
      const changed: string[] = [];
      const logged: string[] = [];
      try {
        await expect(
          installer({
            onChanged: (harnessId) => changed.push(harnessId),
            logError: (message) => logged.push(message),
          }).installFromFolder(folder),
        ).resolves.toEqual({ ok: true, data: { harnessId: 'acme/fixture-web', version: '2.0.0' } });
      } finally {
        chmodSync(stuck, 0o755);
      }
      expect(store.get('acme/fixture-web')).toMatchObject({ version: '2.0.0' });
      expect(changed).toEqual(['acme/fixture-web']);
      expect(logged).toEqual([
        `Could not delete the replaced install folder ${installedAt('1.0.0')}`,
      ]);
    },
  );

  it('an install is reported once recorded, even when the Data Directory cannot be made', async () => {
    mkdirSync(userData(), { recursive: true });
    writeFileSync(join(userData(), 'data'), 'not a folder');
    const changed: string[] = [];
    const logged: string[] = [];
    await expect(
      installer({
        onChanged: (harnessId) => changed.push(harnessId),
        logError: (message) => logged.push(message),
      }).installFromFolder(folder),
    ).resolves.toMatchObject({ ok: true });
    expect(store.get('acme/fixture-web')).toMatchObject({ version: '1.0.0' });
    expect(changed).toEqual(['acme/fixture-web']);
    expect(logged).toEqual(['Could not create the Data Directory of acme/fixture-web']);
  });

  it.skipIf(process.platform === 'win32')(
    'makes the Entry of every declared platform of a binary Harness executable',
    async () => {
      mkdirSync(join(folder, 'bin'));
      writeFileSync(join(folder, 'bin/run-linux'), '#!/bin/sh\n', { mode: 0o644 });
      writeFileSync(join(folder, 'bin/run-mac'), '#!/bin/sh\n', { mode: 0o644 });
      editManifest((manifest) => {
        manifest.platforms = ['linux-x64', 'darwin-arm64'];
        manifest.runtime = { kind: 'binary' };
        manifest.entry = { 'linux-x64': 'bin/run-linux', 'darwin-arm64': 'bin/run-mac' };
      });
      await expect(installer().installFromFolder(folder)).resolves.toMatchObject({ ok: true });
      const installed = harnessPaths(join(root, 'userData')).installPath(
        'acme/fixture-web',
        '1.0.0',
      );
      expect(statSync(join(installed, 'bin/run-linux')).mode & 0o777).toBe(0o755);
      expect(statSync(join(installed, 'bin/run-mac')).mode & 0o777).toBe(0o755);
      expect(statSync(join(installed, 'manifest.json')).mode & 0o111).toBe(0);
    },
  );

  // Validation never opens the Entry (it only looks for it), so the folder inspects valid; the
  // copy then cannot open it. It is file_unreadable, naming the file: package_invalid would make
  // the dialog inspect again, find the folder valid again, and loop. Root reads it anyway.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a file that cannot be read while copying is file_unreadable, and nothing is left behind',
    async () => {
      chmodSync(join(folder, 'index.mjs'), 0o000);
      try {
        const install = installer();
        await expect(install.inspectFolder(folder)).resolves.toMatchObject({
          ok: true,
          data: { valid: true },
        });
        await expect(install.installFromFolder(folder)).resolves.toMatchObject({
          ok: false,
          error: { code: 'file_unreadable', params: { path: 'index.mjs' } },
        });
      } finally {
        chmodSync(join(folder, 'index.mjs'), 0o644);
      }
      expect(store.all()).toEqual([]);
      expect(readdirSync(join(root, 'userData', 'downloads'))).toEqual([]);
      expect(existsSync(join(root, 'userData', 'harnesses'))).toBe(false);
    },
  );

  // A file validation reads (manifest.json, the icon) that cannot be opened: validatePackage
  // throws the I/O error, which must not escape as internal_error. Root reads it anyway.
  it
    .skipIf(process.platform === 'win32' || process.getuid?.() === 0)
    .each(['manifest.json', 'assets/icon.png'])(
    'a folder whose %s cannot be read is package_invalid',
    async (file) => {
      chmodSync(join(folder, file), 0o000);
      try {
        const install = installer();
        const refused = { ok: false, error: { code: 'package_invalid' } };
        await expect(install.inspectFolder(folder)).resolves.toMatchObject(refused);
        await expect(install.installFromFolder(folder)).resolves.toMatchObject(refused);
      } finally {
        chmodSync(join(folder, file), 0o644);
      }
      expect(store.all()).toEqual([]);
    },
  );

  it('lists the most recently launched first, then the others by name', async () => {
    const put = (harnessId: string, name: string) => {
      const manifest = { ...manifestWith({ default: {} }), id: harnessId, name };
      store.put({
        harnessId,
        version: '1.0.0',
        manifest,
        installPath: join(root, harnessId),
        dataDir: join(root, 'data', harnessId),
        installedAt: '2026-01-01T00:00:00.000Z',
        consentedPermissions: manifest.permissions,
        source: 'store',
      });
    };
    put('acme/zeta', 'Zeta');
    put('acme/alpha', 'alpha');
    put('acme/beta', 'Beta');
    put('acme/old', 'Old');
    db.prepare(
      "UPDATE installs SET last_launched_at = '2026-03-01T00:00:00.000Z' WHERE harness_id = 'acme/zeta'",
    ).run();
    db.prepare(
      "UPDATE installs SET last_launched_at = '2026-02-01T00:00:00.000Z' WHERE harness_id = 'acme/old'",
    ).run();
    const listed = await installer().list();
    expect(listed.map((install) => install.harnessId)).toEqual([
      'acme/zeta',
      'acme/old',
      'acme/alpha',
      'acme/beta',
    ]);
    // No icon file in these installs.
    expect(listed.every((install) => install.iconDataUrl === null)).toBe(true);
  });
});

// An install the app quit or crashed in: its folders stay in downloads/, cleaned up by the next
// installer before it installs or lists anything.
describe('an interrupted install', () => {
  const download = (name: string) => join(userData(), 'downloads', name);

  it('deletes partial copies and folders moved aside whose install is in place', async () => {
    await expect(installer().installFromFolder(folder)).resolves.toMatchObject({ ok: true });
    const before = store.get('acme/fixture-web');
    mkdirSync(download('install-partial'), { recursive: true });
    writeFileSync(download('install-partial/index.mjs'), '// half');
    cpSync(installedAt('1.0.0'), download('replaced-stale'), { recursive: true });
    writeFileSync(download('kept.zip'), 'not an install folder');

    await installer().list();
    expect(downloads()).toEqual(['kept.zip']);
    expect(store.get('acme/fixture-web')).toEqual(before);
    expect(readFileSync(join(installedAt('1.0.0'), 'index.mjs'), 'utf8')).toBe(
      readFileSync(join(FIXTURE, 'index.mjs'), 'utf8'),
    );
  });

  it('moves back the installed version a same-version reinstall had moved aside', async () => {
    await expect(installer().installFromFolder(folder)).resolves.toMatchObject({ ok: true });
    // Stopped between moving the installed folder aside and moving the new copy in.
    renameSync(installedAt('1.0.0'), download('replaced-interrupted'));
    mkdirSync(download('install-interrupted'));
    writeFileSync(download('install-interrupted/index.mjs'), '// half');

    const [listed] = await installer().list();
    expect(downloads()).toEqual([]);
    expect(readFileSync(join(installedAt('1.0.0'), 'index.mjs'), 'utf8')).toBe(
      readFileSync(join(FIXTURE, 'index.mjs'), 'utf8'),
    );
    expect(listed).toMatchObject({ harnessId: 'acme/fixture-web', version: '1.0.0' });
    expect(listed?.iconDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('cleans up before the first install runs', async () => {
    mkdirSync(download('install-partial'), { recursive: true });
    await expect(installer().installFromFolder(folder)).resolves.toMatchObject({ ok: true });
    expect(downloads()).toEqual([]);
  });

  it('deletes a folder moved aside that belongs to no install', async () => {
    cpSync(folder, download('replaced-orphan'), { recursive: true });
    await installer().list();
    expect(downloads()).toEqual([]);
    expect(existsSync(join(userData(), 'harnesses'))).toBe(false);
  });
});

describe('platforms and Entries', () => {
  it('names this machine as the Manifest does, null for a platform no Manifest declares', () => {
    expect(platformOf('darwin-arm64')).toBe('darwin-arm64');
    expect(platformOf('win32-x64')).toBe('win32-x64');
    expect(platformOf('linux-ia32')).toBeNull();
    expect(platformOf('freebsd-x64')).toBeNull();
  });

  it('runs a Node Entry only on a declared platform', () => {
    const manifest = manifestWith({ default: {} }); // darwin-arm64, linux-x64, win32-x64
    expect(entryFor(manifest, 'linux-x64')).toBe('dist/index.js');
    expect(entryFor(manifest, 'linux-arm64')).toBeNull();
    expect(entryFor(manifest, null)).toBeNull();
  });

  it('ignores a binary Entry for an undeclared platform', () => {
    const manifest = {
      ...manifestWith({ default: {} }),
      platforms: ['linux-x64' as const],
      runtime: { kind: 'binary' as const },
      entry: { 'linux-x64': 'bin/linux', 'darwin-arm64': 'bin/mac' },
    };
    expect(entryFor(manifest, 'linux-x64')).toBe('bin/linux');
    expect(entryFor(manifest, 'darwin-arm64')).toBeNull();
  });

  it('keeps every install path inside its folder', () => {
    const paths = harnessPaths('/data');
    expect(paths.installPath('acme/hello', '1.0.0')).toBe(join('/data/harnesses/acme/hello/1.0.0'));
    expect(paths.dataDir('acme/hello')).toBe(join('/data/data/acme/hello'));
    expect(() => paths.installPath('acme/..', '1.0.0')).toThrow();
    expect(() => paths.dataDir('../x')).toThrow();
  });
});
