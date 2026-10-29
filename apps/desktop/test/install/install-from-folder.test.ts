import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGateway, type Gateway } from '@harness-store/gateway';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRuntime, type Runtime } from '../../src/main/runtime/bootstrap.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import type { IpcEventName, IpcEvents } from '../../src/shared/ipc.js';
import { createFakeCipher } from '../support/fake-cipher.js';

/**
 * Ticket P0-05.1, "Install this folder locally", through the real Runtime over IPC: a temp app
 * data root with its SQLite file, the fixture Harness folder (copied, so a test can edit it as a
 * Publisher would) and the folder picker faked. Validation, copying and recording run for real.
 */

const FIXTURE = join(import.meta.dirname, '../fixtures/harnesses/fixture-web');
const HARNESS_ID = 'acme/fixture-web';
const MAIN_WINDOW = {};

let root: string;
let dataDir: string;
let folder: string;
let runtime: Runtime;
let gateway: Gateway | undefined;
let picked: string | null;
let events: { event: IpcEventName; payload: unknown }[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-install-'));
  dataDir = join(root, 'userData');
  folder = join(root, 'my-harness');
  cpSync(FIXTURE, folder, { recursive: true });
  picked = folder;
  events = [];
  runtime = await startRuntime({
    dataDir,
    version: '1.0.0',
    osLocale: () => 'en-US',
    quit: () => undefined,
    logError: () => undefined,
    fetch: () => Promise.reject(new TypeError('fetch failed')),
    providerFetch: globalThis.fetch,
    secretCipher: createFakeCipher(),
    platform: 'linux-x64',
    pickFolder: () => Promise.resolve(picked),
    // Only the install events: the Store's connectivity check reports offline meanwhile.
    emit: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => {
      if (event === 'installs.changed') events.push({ event, payload });
    },
    createGateway: (options) => {
      gateway = createGateway({
        ...options,
        logger: { debug: () => undefined, error: () => undefined },
      });
      return gateway;
    },
  });
});
afterEach(async () => {
  await runtime.shutdown();
  rmSync(root, { recursive: true, force: true });
});

function call(method: string, input?: unknown) {
  const dispatch = createDispatcher({
    handlers: createHandlers(runtime.services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return dispatch(MAIN_WINDOW, { method, input });
}

/** Edits the copied fixture's manifest.json as a Publisher would. */
function editManifest(change: (manifest: Record<string, unknown>) => void) {
  const path = join(folder, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  change(manifest);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

const installPath = (version: string) => join(dataDir, 'harnesses', 'acme', 'fixture-web', version);

/** The `installs` rows as SQLite holds them. */
function installRows() {
  const db = new DatabaseSync(join(dataDir, 'harness-store.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT * FROM installs').all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

describe('installs.installFromFolder', () => {
  it('copies the fixture into the install layout, records it as local and lists it', async () => {
    await expect(call('installs.chooseFolder')).resolves.toEqual({ ok: true, data: folder });
    await expect(call('installs.installFromFolder', folder)).resolves.toEqual({
      ok: true,
      data: { harnessId: HARNESS_ID, version: '1.0.0' },
    });

    for (const file of ['manifest.json', 'README.md', 'assets/icon.png', 'index.mjs']) {
      expect(readFileSync(join(installPath('1.0.0'), file))).toEqual(
        readFileSync(join(folder, file)),
      );
    }
    expect(existsSync(join(dataDir, 'data', 'acme', 'fixture-web'))).toBe(true);
    expect(events).toEqual([{ event: 'installs.changed', payload: { harnessId: HARNESS_ID } }]);

    const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as {
      permissions: unknown;
    };
    expect(installRows()).toEqual([
      expect.objectContaining({
        harness_id: HARNESS_ID,
        version: '1.0.0',
        install_path: installPath('1.0.0'),
        data_dir: join(dataDir, 'data', 'acme', 'fixture-web'),
        source: 'local',
        last_launched_at: null,
        consented_permissions: JSON.stringify(manifest.permissions),
      }),
    ]);

    const listed = await call('installs.list');
    expect(listed).toMatchObject({
      ok: true,
      data: [
        {
          harnessId: HARNESS_ID,
          version: '1.0.0',
          name: 'Fixture Web',
          publisher: 'acme',
          source: 'local',
          manifest: { id: HARNESS_ID, version: '1.0.0', entry: 'index.mjs' },
          installPath: installPath('1.0.0'),
          lastLaunchedAt: null,
          platformSupported: true,
        },
      ],
    });
    const icon = readFileSync(join(folder, 'assets/icon.png')).toString('base64');
    expect(listed).toMatchObject({ data: [{ iconDataUrl: `data:image/png;base64,${icon}` }] });
  });

  it('re-running it after a version change installs the new version in place of the old one', async () => {
    await call('installs.installFromFolder', folder);
    const dataFile = join(dataDir, 'data', 'acme', 'fixture-web', 'state.json');
    writeFileSync(dataFile, '{"kept":true}');

    editManifest((manifest) => {
      manifest.version = '1.1.0';
    });
    await expect(call('installs.installFromFolder', folder)).resolves.toEqual({
      ok: true,
      data: { harnessId: HARNESS_ID, version: '1.1.0' },
    });
    expect(existsSync(join(installPath('1.1.0'), 'manifest.json'))).toBe(true);
    expect(existsSync(installPath('1.0.0'))).toBe(false);
    expect(installRows()).toEqual([
      expect.objectContaining({ version: '1.1.0', install_path: installPath('1.1.0') }),
    ]);
    // The Data Directory survives a reinstall untouched.
    expect(readFileSync(dataFile, 'utf8')).toBe('{"kept":true}');

    // A lower version replaces it too: the Publisher's own iteration loop.
    editManifest((manifest) => {
      manifest.version = '0.9.0';
    });
    await expect(call('installs.installFromFolder', folder)).resolves.toMatchObject({
      ok: true,
      data: { version: '0.9.0' },
    });
    expect(existsSync(installPath('1.1.0'))).toBe(false);
    expect(installRows()).toEqual([expect.objectContaining({ version: '0.9.0' })]);
  });

  it('re-running it with the same version overwrites the installed files in place', async () => {
    writeFileSync(join(folder, 'notes.txt'), 'first');
    await call('installs.installFromFolder', folder);
    expect(readFileSync(join(installPath('1.0.0'), 'notes.txt'), 'utf8')).toBe('first');

    writeFileSync(join(folder, 'index.mjs'), '// changed\n');
    rmSync(join(folder, 'notes.txt'));
    await expect(call('installs.installFromFolder', folder)).resolves.toMatchObject({
      ok: true,
      data: { version: '1.0.0' },
    });
    expect(readFileSync(join(installPath('1.0.0'), 'index.mjs'), 'utf8')).toBe('// changed\n');
    // Exactly the folder's files: one deleted there is gone from the install too.
    expect(existsSync(join(installPath('1.0.0'), 'notes.txt'))).toBe(false);
    expect(installRows()).toHaveLength(1);
    // Nothing is left behind in the temporary folder.
    expect(readdirOrEmpty(join(dataDir, 'downloads'))).toEqual([]);
  });

  it.each([
    [
      'missing manifest.json',
      () => {
        rmSync(join(folder, 'manifest.json'));
      },
      [{ code: 'file_missing', path: 'manifest.json' }],
    ],
    [
      'manifest.json that is not JSON',
      () => {
        writeFileSync(join(folder, 'manifest.json'), '{ "id": "acme/fixture-web", }');
      },
      [{ code: 'schema_invalid_json', path: '$' }],
    ],
    [
      'a bad Harness ID',
      () => {
        editManifest((manifest) => {
          manifest.id = 'Acme/Fixture Web';
        });
      },
      [{ code: 'schema_pattern', path: 'id' }],
    ],
    [
      'a bad version',
      () => {
        editManifest((manifest) => {
          manifest.version = '1.0';
        });
      },
      [{ code: 'version_invalid', path: 'version' }],
    ],
    [
      'a missing Entry file',
      () => {
        rmSync(join(folder, 'index.mjs'));
      },
      [{ code: 'entry_missing_for_platform', path: 'entry' }],
    ],
  ])(
    'rejects a folder with %s, showing its problems and installing nothing',
    async (_name, breakIt, expected) => {
      breakIt();
      const inspection = await call('installs.inspectFolder', folder);
      expect(inspection).toMatchObject({ ok: true, data: { valid: false, manifestSummary: null } });
      const { problems } = (
        inspection as {
          data: {
            problems: { code: string; path: string; message: unknown; messageKey: unknown }[];
          };
        }
      ).data;
      expect(problems.map(({ code, path }) => ({ code, path }))).toEqual(expected);
      for (const problem of problems) {
        expect(typeof problem.message).toBe('string');
        expect(typeof problem.messageKey).toBe('string');
      }

      await expect(call('installs.installFromFolder', folder)).resolves.toMatchObject({
        ok: false,
        error: { code: 'package_invalid' },
      });
      expect(installRows()).toEqual([]);
      expect(existsSync(join(dataDir, 'harnesses'))).toBe(false);
      await expect(call('installs.list')).resolves.toEqual({ ok: true, data: [] });
      expect(events).toEqual([]);
    },
  );

  it('refuses a folder whose Manifest changed since it was inspected, so consent covers it', async () => {
    await expect(call('installs.inspectFolder', folder)).resolves.toMatchObject({
      ok: true,
      data: { valid: true },
    });
    editManifest((manifest) => {
      manifest.permissions = {
        filesystem: { scope: 'home' },
        shell: true,
        network: { any: true },
      };
    });
    await expect(call('installs.installFromFolder', folder)).resolves.toMatchObject({
      ok: false,
      error: { code: 'package_invalid' },
    });
    expect(installRows()).toEqual([]);

    // Inspected again (the consent dialog shows the new permissions), it installs.
    await call('installs.inspectFolder', folder);
    await expect(call('installs.installFromFolder', folder)).resolves.toMatchObject({ ok: true });
  });

  it('a folder that does not exist is package_invalid', async () => {
    const missing = join(root, 'nowhere');
    await expect(call('installs.inspectFolder', missing)).resolves.toMatchObject({
      ok: false,
      error: { code: 'package_invalid' },
    });
    await expect(call('installs.installFromFolder', missing)).resolves.toMatchObject({
      ok: false,
      error: { code: 'package_invalid' },
    });
  });

  it('the Model Gateway reads the installed Manifest: its Slots are declared', async () => {
    await call('installs.installFromFolder', folder);
    if (gateway === undefined) throw new Error('The Runtime did not create a Gateway');
    const token = gateway.issueToken({
      harnessId: HARNESS_ID,
      harnessVersion: '1.0.0',
      launchId: 'launch-1',
      locale: 'en',
    });
    const { gateway: running } = runtime.services.diagnostics.get();
    if (!running.running) throw new Error('The Model Gateway is not running');
    const response = await fetch(`http://127.0.0.1:${String(running.port)}/v1/harness/context`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      harnessId: HARNESS_ID,
      slots: { default: { description: "Answers the test's messages." } },
    });
  });
});

describe('installs.inspectFolder', () => {
  it('reports what the consent dialog shows and writes nothing', async () => {
    await expect(call('installs.inspectFolder', folder)).resolves.toEqual({
      ok: true,
      data: {
        valid: true,
        manifestSummary: {
          harnessId: HARNESS_ID,
          version: '1.0.0',
          name: 'Fixture Web',
          runtimeKind: 'node',
          uiKind: 'web',
          workspace: 'none',
          platforms: [
            'darwin-arm64',
            'darwin-x64',
            'linux-x64',
            'linux-arm64',
            'win32-x64',
            'win32-arm64',
          ],
          entry: 'index.mjs',
          permissions: {
            filesystem: { scope: 'none' },
            shell: false,
            network: { domains: [] },
          },
          platformSupported: true,
        },
        problems: [],
        warnings: [],
      },
    });
    for (const folderName of ['harnesses', 'data', 'downloads']) {
      expect(existsSync(join(dataDir, folderName))).toBe(false);
    }
    expect(installRows()).toEqual([]);
  });

  it('passes warnings on without blocking the install', async () => {
    editManifest((manifest) => {
      manifest.ui = { kind: 'terminal', path: '/app' };
    });
    const inspection = await call('installs.inspectFolder', folder);
    expect(inspection).toMatchObject({
      ok: true,
      data: { valid: true, warnings: [{ code: 'ignored_key', path: 'ui.path' }] },
    });
  });

  it('a Harness that does not declare this platform still installs, marked unsupported', async () => {
    editManifest((manifest) => {
      manifest.platforms = ['win32-x64'];
    });
    await expect(call('installs.inspectFolder', folder)).resolves.toMatchObject({
      ok: true,
      data: { valid: true, manifestSummary: { platformSupported: false, entry: 'index.mjs' } },
    });
    await expect(call('installs.installFromFolder', folder)).resolves.toMatchObject({ ok: true });
    await expect(call('installs.list')).resolves.toMatchObject({
      ok: true,
      data: [{ harnessId: HARNESS_ID, platformSupported: false }],
    });
  });
});

describe('installs.chooseFolder', () => {
  it('answers null when the User cancels the picker', async () => {
    picked = null;
    await expect(call('installs.chooseFolder')).resolves.toEqual({ ok: true, data: null });
  });
});

function readdirOrEmpty(path: string): string[] {
  return existsSync(path) ? readdirSync(path) : [];
}
