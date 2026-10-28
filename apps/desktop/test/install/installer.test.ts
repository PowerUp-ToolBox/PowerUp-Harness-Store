import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function installer(options: { isRunning?: (harnessId: string) => boolean } = {}) {
  return createInstaller({
    store,
    root: join(root, 'userData'),
    platform: 'linux-x64',
    pickFolder: () => Promise.resolve(null),
    now: () => new Date('2026-10-28T09:00:00.000Z'),
    ...options,
  });
}

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

  // A file validation never reads (the Entry is only looked for) that cannot be opened stands in
  // for one removed or swapped between validation and copying. Root reads it anyway.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a file that cannot be read while copying is package_invalid, and nothing is left behind',
    async () => {
      chmodSync(join(folder, 'index.mjs'), 0o000);
      try {
        await expect(installer().installFromFolder(folder)).resolves.toMatchObject({
          ok: false,
          error: { code: 'package_invalid' },
        });
      } finally {
        chmodSync(join(folder, 'index.mjs'), 0o644);
      }
      expect(store.all()).toEqual([]);
      expect(readdirSync(join(root, 'userData', 'downloads'))).toEqual([]);
      expect(existsSync(join(root, 'userData', 'harnesses'))).toBe(false);
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
