/**
 * Ticket P0-08.1: `publish.validateFolder` through the Runtime's IPC handlers, against a fake
 * Store on a real HTTP port. A folder is built into the zip the upload would send and that zip is
 * validated, with the signed-in Publisher's login and the versions the Store has of the Harness
 * (the "Own versions" read with the session JWT), so `publisher_mismatch` and
 * `version_not_greater` show before any upload: the fake Store asserts no `publish` call is made.
 * The folder watcher reports changes after its debounce.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createPublishService, type PublishService } from '../../src/main/runtime/publish.js';
import type { Services } from '../../src/main/runtime/services.js';
import type { FolderValidation, IpcResult } from '../../src/shared/ipc.js';

const FIXTURE = join(import.meta.dirname, '../fixtures/harnesses/fixture-web');
const ANON_KEY = 'fake-anon-key';
const TOKEN = 'access-token-of-octo-cat';
const MAIN_WINDOW = {};

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
}

let root: string;
let folder: string;
let server: Server;
let baseUrl: string;
let requests: Recorded[];
/** What the fake Store answers to the "Own versions" read: rows, or a status with no rows. */
let versionsAnswer: { status: number; rows: { version: string; status: string }[] };
let login: string | null;
let sessionRejected: ReturnType<typeof vi.fn<(accessToken: string) => Promise<void>>>;
let changes: string[];
let service: PublishService;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-publish-'));
  folder = join(root, 'my-harness');
  cpSync(FIXTURE, folder, { recursive: true });
  editManifest({ id: 'octo-cat/fixture-web' });
  requests = [];
  versionsAnswer = { status: 200, rows: [] };
  login = 'octo-cat';
  sessionRejected = vi.fn<(accessToken: string) => Promise<void>>(() => Promise.resolve());
  changes = [];
  server = createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
    });
    const url = new URL(request.url ?? '/', 'http://store.test');
    if (request.method === 'GET' && url.pathname === '/rest/v1/harness_versions') {
      response.writeHead(versionsAnswer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(versionsAnswer.status === 200 ? versionsAnswer.rows : {}));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  service = createPublishService({
    fetch: (url, init) => globalThis.fetch(url, init),
    storeBaseUrl: () => baseUrl,
    anonKey: ANON_KEY,
    auth: {
      login: () => Promise.resolve(login),
      accessToken: () => Promise.resolve(login === null ? null : TOKEN),
      sessionRejected,
    },
    onFolderChanged: (path) => changes.push(path),
  });
});
afterEach(async () => {
  service.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

function editManifest(patch: Record<string, unknown>) {
  const path = join(folder, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...manifest, ...patch }, null, 2));
}

async function validate(path = folder): Promise<IpcResult<FolderValidation>> {
  const dispatch = createDispatcher({
    handlers: createHandlers({ publish: service } as unknown as Services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return (await dispatch(MAIN_WINDOW, {
    method: 'publish.validateFolder',
    input: path,
  })) as IpcResult<FolderValidation>;
}

async function validation(path = folder): Promise<FolderValidation> {
  const result = await validate(path);
  if (!result.ok) throw new Error(`validateFolder failed: ${result.error.code}`);
  return result.data;
}

const problemsOf = (data: FolderValidation) =>
  data.problems.map((problem) => [problem.path, problem.code]);

/** No upload was attempted: the fake Store saw no call to the `publish` function. */
function expectNoUpload() {
  expect(requests.filter((request) => request.url.startsWith('/functions/'))).toEqual([]);
}

describe('publish.validateFolder', () => {
  it('a valid folder of a new Harness: no problems, the Manifest, its icon and README, "New Harness"', async () => {
    const data = await validation();
    expect(data).toMatchObject({
      problems: [],
      warnings: [],
      manifest: { id: 'octo-cat/fixture-web', version: '1.0.0', name: 'Fixture Web' },
      excluded: [],
      versionCheck: 'checked',
      lastPublishedVersion: null,
      isNew: true,
    });
    expect(data.archiveId).toEqual(expect.any(String));
    expect(data.iconDataUrl).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
    expect(data.readme).toBe(readFileSync(join(folder, 'README.md'), 'utf8'));
    expect(data.archiveSize).toBe(service.archive(data.archiveId ?? '')?.length);
  });

  it('reads the Publisher’s own versions of this Harness with the session JWT and the anon key', async () => {
    await validation();
    expect(requests).toHaveLength(1);
    const [read] = requests;
    const url = new URL(read?.url ?? '', baseUrl);
    expect(url.pathname).toBe('/rest/v1/harness_versions');
    expect(url.searchParams.get('manifest->>id')).toBe('eq.octo-cat/fixture-web');
    expect(url.searchParams.get('select')).toBe('version');
    expect(read?.headers.apikey).toBe(ANON_KEY);
    expect(read?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it.each(['1.0.0', '0.9.0'])(
    'version %s when the Store has 1.0.0: version_not_greater, without any upload',
    async (version) => {
      versionsAnswer.rows = [{ version: '1.0.0', status: 'published' }];
      editManifest({ version });
      const data = await validation();
      expect(problemsOf(data)).toEqual([['version', 'version_not_greater']]);
      expect(data.problems[0]?.params).toEqual({ version, latest: '1.0.0' });
      expect(data).toMatchObject({ lastPublishedVersion: '1.0.0', isNew: false, manifest: null });
      expectNoUpload();
    },
  );

  it('counts Unpublished and taken-down versions too, and names the highest', async () => {
    versionsAnswer.rows = [
      { version: '1.0.0', status: 'published' },
      { version: '1.2.0', status: 'taken_down' },
      { version: '1.1.0', status: 'unpublished' },
    ];
    editManifest({ version: '1.1.5' });
    const data = await validation();
    expect(problemsOf(data)).toEqual([['version', 'version_not_greater']]);
    expect(data.lastPublishedVersion).toBe('1.2.0');
  });

  it('a greater version is fine, and says which version was last', async () => {
    versionsAnswer.rows = [{ version: '1.0.0', status: 'published' }];
    editManifest({ version: '1.0.1' });
    const data = await validation();
    expect(data.problems).toEqual([]);
    expect(data).toMatchObject({ lastPublishedVersion: '1.0.0', isNew: false });
  });

  it('another Publisher’s Harness ID: publisher_mismatch, and the Store is not asked', async () => {
    editManifest({ id: 'someone-else/fixture-web' });
    const data = await validation();
    expect(problemsOf(data)).toEqual([['id', 'publisher_mismatch']]);
    expect(data.problems[0]?.params).toEqual({
      idPublisher: 'someone-else',
      publisher: 'octo-cat',
    });
    expect(data.versionCheck).toBe('skipped');
    expect(requests).toEqual([]);
  });

  it('signed out: no Publisher checks and no Store call', async () => {
    login = null;
    editManifest({ id: 'someone-else/fixture-web' });
    const data = await validation();
    expect(data).toMatchObject({ problems: [], versionCheck: 'skipped', isNew: false });
    expect(requests).toEqual([]);
  });

  it('a Store that fails the read: validation still ends, without the version check', async () => {
    versionsAnswer = { status: 503, rows: [] };
    editManifest({ version: '0.1.0' });
    const data = await validation();
    expect(data).toMatchObject({ problems: [], versionCheck: 'failed', isNew: false });
  });

  it('a Store that does not answer at all counts as failed too', async () => {
    await new Promise((resolve) => server.close(resolve));
    server.listen(0);
    const data = await validation();
    expect(data.versionCheck).toBe('failed');
  });

  it('a 401 ends the session with the token it was made with', async () => {
    versionsAnswer = { status: 401, rows: [] };
    const data = await validation();
    expect(data.versionCheck).toBe('failed');
    expect(sessionRejected).toHaveBeenCalledExactlyOnceWith(TOKEN);
  });

  it('a missing icon is exactly one problem, at assets/icon.png', async () => {
    rmSync(join(folder, 'assets/icon.png'));
    const data = await validation();
    expect(problemsOf(data)).toEqual([['assets/icon.png', 'file_missing']]);
    expect(data.iconDataUrl).toBeNull();
  });

  it('an invalid icon is exactly one problem, at assets/icon.png', async () => {
    writeFileSync(join(folder, 'assets/icon.png'), 'not a png');
    const data = await validation();
    expect(problemsOf(data)).toEqual([['assets/icon.png', 'file_type']]);
    expect(data.problems[0]?.messageKey).toBe('file_type.icon');
  });

  it('orders problems by path', async () => {
    rmSync(join(folder, 'README.md'));
    rmSync(join(folder, 'assets/icon.png'));
    editManifest({ version: '1.0', name: 'X' });
    const data = await validation();
    const paths = data.problems.map((problem) => problem.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual(['README.md', 'assets/icon.png', 'name', 'version']);
  });

  it('validates the zip, not the folder: an excluded manifest.json is missing', async () => {
    writeFileSync(join(folder, '.harnessignore'), 'manifest.json\n');
    const data = await validation();
    expect(problemsOf(data)).toEqual([['manifest.json', 'file_missing']]);
    expect(data.excluded).toEqual(['.harnessignore', 'manifest.json']);
  });

  it('a dropped file is invalid_input; a missing folder package_invalid', async () => {
    await expect(validate(join(folder, 'manifest.json'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    await expect(validate(join(root, 'gone'))).resolves.toMatchObject({
      ok: false,
      error: { code: 'package_invalid' },
    });
  });

  it('the newest run wins: an older one still going answers package_invalid', async () => {
    const [older, newer] = await Promise.all([validate(), validate()]);
    expect(older).toMatchObject({ ok: false, error: { code: 'package_invalid' } });
    expect(newer.ok).toBe(true);
  });

  it('keeps only the latest run’s zip', async () => {
    const first = await validation();
    const second = await validation();
    expect(service.archive(first.archiveId ?? '')).toBeNull();
    expect(service.archive(second.archiveId ?? '')).not.toBeNull();
  });
});

describe('the folder watcher', () => {
  const settled = () => new Promise((resolve) => setTimeout(resolve, 800));

  it('reports a change about 500 ms after a file is edited, once for a burst of edits', async () => {
    await validation();
    await settled();
    changes.length = 0;
    const started = Date.now();
    writeFileSync(join(folder, 'README.md'), '# Changed\n');
    writeFileSync(join(folder, 'index.mjs'), '// changed\n');
    await vi.waitFor(
      () => {
        expect(changes).toEqual([folder]);
      },
      { timeout: 3000, interval: 20 },
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    await settled();
    expect(changes).toEqual([folder]);
  });

  it('ignores changes under excluded paths, but not to .harnessignore', async () => {
    mkdirSync(join(folder, '.git'));
    await validation();
    await settled();
    changes.length = 0;
    writeFileSync(join(folder, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(folder, '.DS_Store'), 'x');
    await settled();
    expect(changes).toEqual([]);
    writeFileSync(join(folder, '.harnessignore'), 'dist/\n');
    await vi.waitFor(
      () => {
        expect(changes).toEqual([folder]);
      },
      { timeout: 3000, interval: 20 },
    );
  });

  it('stopWatching stops the reports', async () => {
    await validation();
    await settled();
    service.stopWatching();
    changes.length = 0;
    writeFileSync(join(folder, 'README.md'), '# Changed\n');
    await settled();
    expect(changes).toEqual([]);
  });
});
