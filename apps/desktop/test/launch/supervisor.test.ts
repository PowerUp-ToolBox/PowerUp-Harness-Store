import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstallRow } from '../../src/main/runtime/install-store.js';
import { createSupervisor } from '../../src/main/runtime/supervisor.js';
import type { LaunchStatus } from '../../src/shared/ipc.js';
import { manifestWith } from '../support/manifest.js';

/**
 * Ticket P0-05.2: the Supervisor on its own, with every collaborator faked, for what the Runtime
 * cannot reach on demand over IPC: an install of the Harness that is putting its files in place.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-supervisor-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  const manifest = { ...manifestWith({ default: {} }), ui: { kind: 'terminal' as const } };
  const install: InstallRow = {
    harnessId: 'acme/hello',
    version: '1.0.0',
    manifest,
    // No Entry there: a launch that goes ahead fails spawn_error before any token or window.
    installPath: join(root, 'harnesses', 'acme', 'hello', '1.0.0'),
    dataDir: join(root, 'data', 'acme', 'hello'),
    installedAt: '2026-10-28T09:00:00.000Z',
    lastLaunchedAt: null,
    lastWorkspace: null,
    consentedPermissions: manifest.permissions,
    source: 'local',
    storeStatus: null,
    availableVersion: null,
    availableManifest: null,
  };
  const emitted: LaunchStatus[] = [];
  const opened: string[] = [];
  let installing = true;
  const supervisor = createSupervisor({
    installs: {
      get: () => install,
      markLaunched: () => undefined,
      setLastWorkspace: () => undefined,
    },
    launches: { begin: () => undefined, end: () => undefined, closeOpen: () => 0 },
    paths: { logsDir: (harnessId) => join(root, 'logs', harnessId) },
    platform: 'linux-x64',
    gatewayUrl: 'http://127.0.0.1:1/v1',
    tokens: { issueToken: () => 'token', revokeLaunch: () => undefined },
    locale: () => 'en',
    isInstalling: () => installing,
    defaultSlotBound: () => true,
    windows: {
      openTerminal: (spec) => {
        opened.push(spec.launchId);
      },
      openWeb: (spec) => {
        opened.push(spec.launchId);
      },
      showWeb: () => undefined,
      hideWeb: () => undefined,
      reloadWeb: () => undefined,
      layoutWeb: () => undefined,
      send: () => undefined,
      focus: () => false,
      close: () => undefined,
    },
    spawnPty: () => {
      throw new Error('Nothing is spawned in these tests');
    },
    nodeCommand: { path: process.execPath, env: {} },
    emit: (status) => emitted.push(status),
    logError: () => undefined,
  });
  return {
    supervisor,
    emitted,
    opened,
    installDone: () => {
      installing = false;
    },
  };
}

describe('createSupervisor', () => {
  it('launches nothing while an install of the Harness puts its files in place', async () => {
    const { supervisor, emitted, opened, installDone } = setup();

    await expect(supervisor.start('acme/hello')).resolves.toMatchObject({
      ok: false,
      error: { code: 'harness_installing', messageKey: 'error.harness_installing' },
    });
    expect(emitted).toEqual([]);
    expect(opened).toEqual([]);
    expect(supervisor.isRunning('acme/hello')).toBe(false);

    installDone();
    const started = supervisor.start('acme/hello');
    await expect(started).resolves.toMatchObject({ ok: true, data: { outcome: 'started' } });
    await expect.poll(() => emitted.at(-1)?.state).toBe('failed');
  });
});
