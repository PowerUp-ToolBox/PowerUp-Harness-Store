/**
 * Ticket P0-08.2: `publish.publish` and `publish.cancel` through the Runtime's IPC handlers,
 * against a fake Store on a real HTTP port whose `publish` function does what api.md says the
 * real one does with a package: it reads the multipart body, validates the zip with
 * `validatePackage` (the caller's login, every version it has of the Harness) and keeps the
 * version, which the Harness detail read then returns. The Harness Package uploaded is the zip
 * `publish.validateFolder` built, byte for byte, with the exclusions it listed left out. Progress
 * is reported as bytes of the request sent; Cancel aborts the request, and the Store keeps nothing.
 * The Store's refusals keep its code, its message and its problems.
 */
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveSource, validatePackage } from '@harness-store/manifest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { uploadPackage } from '../../src/main/runtime/package-upload.js';
import { createPublishService, type PublishService } from '../../src/main/runtime/publish.js';
import type { Services } from '../../src/main/runtime/services.js';
import type {
  FolderValidation,
  IpcResult,
  PublishedVersion,
  UploadProgress,
} from '../../src/shared/ipc.js';

const FIXTURE = join(import.meta.dirname, '../fixtures/harnesses/fixture-web');
const ANON_KEY = 'fake-anon-key';
const TOKEN = 'access-token-of-octo-cat';
const MAIN_WINDOW = {};

/** A publish request as the fake Store saw it. */
interface Upload {
  readonly headers: IncomingMessage['headers'];
  /** Whether the whole body arrived. */
  complete: boolean;
  /** The `package` part, once the body arrived. */
  fileName: string | null;
  bytes: Uint8Array | null;
}

/** How the fake Store's `publish` function behaves. */
interface PublishBehaviour {
  /**
   * Stops reading request bodies, calling this as it does: the upload stalls once the
   * connection's buffers are full, like a slow network.
   */
  stall: (() => void) | null;
  /** Holds the answer, once the body arrived, until the test releases it. */
  hold: Promise<void> | null;
  /** Answers this instead of publishing. */
  refuse: { status: number; body: unknown } | null;
}

let root: string;
let folder: string;
let server: Server;
let baseUrl: string;
let uploads: Upload[];
let behaviour: PublishBehaviour;
/** The Harness Versions the fake Store has, by Harness ID. */
let versions: Map<string, string[]>;
let token: string | null;
let sessionRejected: ReturnType<typeof vi.fn<(accessToken: string) => Promise<void>>>;
let unreachable: ReturnType<typeof vi.fn<() => void>>;
let progress: Map<string, UploadProgress[]>;
let onProgress: ((jobId: string, report: UploadProgress) => void) | null;
let service: PublishService;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-upload-'));
  folder = join(root, 'my-harness');
  cpSync(FIXTURE, folder, { recursive: true });
  editManifest({ id: 'octo-cat/fixture-web' });
  uploads = [];
  behaviour = { stall: null, hold: null, refuse: null };
  versions = new Map();
  token = TOKEN;
  sessionRejected = vi.fn<(accessToken: string) => Promise<void>>(() => Promise.resolve());
  unreachable = vi.fn<() => void>();
  progress = new Map();
  onProgress = null;
  server = createServer((request, response) => {
    void serve(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  service = createPublishService({
    fetch: (url, init) => globalThis.fetch(url, init),
    storeBaseUrl: () => baseUrl,
    anonKey: ANON_KEY,
    auth: {
      login: () => Promise.resolve(token === null ? null : 'octo-cat'),
      accessToken: () => Promise.resolve(token),
      sessionRejected,
    },
    onProgress: (jobId, report) => {
      progress.set(jobId, [...(progress.get(jobId) ?? []), report]);
      onProgress?.(jobId, report);
    },
    onStoreUnreachable: unreachable,
  });
});
afterEach(async () => {
  service.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

/** The fake Store: the "Own versions" read, the Harness detail read and the `publish` function. */
async function serve(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://store.test');
  const json = (status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (request.method === 'GET' && url.pathname === '/rest/v1/harness_versions') {
    const id = (url.searchParams.get('manifest->>id') ?? '').replace(/^eq\./, '');
    json(
      200,
      (versions.get(id) ?? []).map((version) => ({ version })),
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/rest/v1/harnesses') {
    const id = (url.searchParams.get('harness_id') ?? '').replace(/^eq\./, '');
    const published = versions.get(id) ?? [];
    json(200, published.length === 0 ? [] : [{ harness_id: id, latest_version: published.at(-1) }]);
    return;
  }
  if (request.method !== 'POST' || url.pathname !== '/functions/v1/publish') {
    json(404, { error: { code: 'not_found', message: 'Not found' } });
    return;
  }

  const upload: Upload = { headers: request.headers, complete: false, fileName: null, bytes: null };
  uploads.push(upload);
  if (behaviour.stall !== null) {
    request.pause();
    behaviour.stall();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) chunks.push(chunk);
  upload.complete = true;
  if (request.headers.authorization !== `Bearer ${TOKEN}`) {
    json(401, { error: { code: 'unauthenticated', message: 'Sign in again.' } });
    return;
  }
  const part = packagePart(request.headers['content-type'] ?? '', Buffer.concat(chunks));
  if (part === null) {
    json(400, { error: { code: 'invalid_request', message: 'No package part.' } });
    return;
  }
  upload.fileName = part.fileName;
  upload.bytes = part.bytes;
  if (behaviour.hold !== null) await behaviour.hold;
  if (behaviour.refuse !== null) {
    json(behaviour.refuse.status, behaviour.refuse.body);
    return;
  }
  const source = await ArchiveSource.open(upload.bytes);
  const id = await readId(source);
  const result = await validatePackage(source, {
    publisher: 'octo-cat',
    publishedVersions: versions.get(id) ?? [],
  });
  if (!result.ok) {
    json(422, {
      error: { code: 'invalid_manifest', message: 'Invalid.', problems: result.problems },
    });
    return;
  }
  versions.set(id, [...(versions.get(id) ?? []), result.manifest.version]);
  json(201, {
    harness_id: id,
    version: result.manifest.version,
    url: `/store/h/${id}`,
  });
}

/** The `package` part of a multipart body with that one part, as the app sends it. */
function packagePart(
  contentType: string,
  body: Buffer,
): { fileName: string; bytes: Uint8Array } | null {
  const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(contentType)?.[1];
  if (
    boundary === undefined ||
    !body.subarray(0, boundary.length + 4).equals(Buffer.from(`--${boundary}\r\n`))
  ) {
    return null;
  }
  const headerEnd = body.indexOf('\r\n\r\n');
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
  if (headerEnd < 0 || !body.subarray(body.length - closing.length).equals(closing)) return null;
  const headers = body.subarray(0, headerEnd).toString('utf8');
  const fileName = /Content-Disposition: form-data; name="package"; filename="([^"]+)"/.exec(
    headers,
  )?.[1];
  if (fileName === undefined || !headers.includes('Content-Type: application/zip')) return null;
  return {
    fileName,
    bytes: new Uint8Array(body.subarray(headerEnd + 4, body.length - closing.length)),
  };
}

async function readId(source: ArchiveSource): Promise<string> {
  const manifest = JSON.parse(new TextDecoder().decode(await source.readFile('manifest.json'))) as {
    id: string;
  };
  return manifest.id;
}

function editManifest(patch: Record<string, unknown>) {
  const path = join(folder, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...manifest, ...patch }, null, 2));
}

function dispatcher() {
  return createDispatcher({
    handlers: createHandlers({ publish: service } as unknown as Services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
}

async function validation(): Promise<FolderValidation> {
  const result = (await dispatcher()(MAIN_WINDOW, {
    method: 'publish.validateFolder',
    input: folder,
  })) as IpcResult<FolderValidation>;
  if (!result.ok) throw new Error(`validateFolder failed: ${result.error.code}`);
  return result.data;
}

function publish(archiveId: string, jobId = 'job-1'): Promise<IpcResult<PublishedVersion>> {
  return dispatcher()(MAIN_WINDOW, {
    method: 'publish.publish',
    input: { archiveId, jobId },
  }) as Promise<IpcResult<PublishedVersion>>;
}

function cancel(jobId = 'job-1') {
  return dispatcher()(MAIN_WINDOW, { method: 'publish.cancel', input: jobId });
}

/** The listing the Harness detail read returns, as the success link's page reads it. */
async function listing(harnessId: string): Promise<unknown[]> {
  const response = await fetch(`${baseUrl}/rest/v1/harnesses?harness_id=eq.${harnessId}`);
  return (await response.json()) as unknown[];
}

/** A file of incompressible bytes, so the Harness Package is about `size` bytes too. */
function addLargeFile(size: number) {
  mkdirSync(join(folder, 'data'));
  writeFileSync(join(folder, 'data', 'large.bin'), randomBytes(size));
}

describe('publish.publish', () => {
  it('publishes the validated folder: a live listing the success link names', async () => {
    const data = await validation();
    expect(data.problems).toEqual([]);
    const result = await publish(data.archiveId ?? '');
    expect(result).toEqual({
      ok: true,
      data: {
        harnessId: 'octo-cat/fixture-web',
        version: '1.0.0',
        url: '/store/h/octo-cat/fixture-web',
      },
    });
    expect(versions.get('octo-cat/fixture-web')).toEqual(['1.0.0']);
    // The link is the in-app route of the Harness detail page, which reads this listing.
    expect(await listing('octo-cat/fixture-web')).toEqual([
      { harness_id: 'octo-cat/fixture-web', latest_version: '1.0.0' },
    ]);
  });

  it('sends the validated zip unchanged, as the multipart part `package`, with the session JWT', async () => {
    const data = await validation();
    await publish(data.archiveId ?? '');
    const [upload] = uploads;
    expect(upload?.headers).toMatchObject({
      apikey: ANON_KEY,
      authorization: `Bearer ${TOKEN}`,
      'content-type': expect.stringMatching(/^multipart\/form-data; boundary=/) as unknown,
    });
    expect(Number(upload?.headers['content-length'])).toBeGreaterThan(data.archiveSize);
    expect(upload?.fileName).toBe('fixture-web-1.0.0.zip');
    expect(upload?.bytes).toEqual(service.archive(data.archiveId ?? ''));
    expect(upload?.bytes?.length).toBe(data.archiveSize);
  });

  it('uploads byte-identical archives for the same folder, built twice', async () => {
    const first = await validation();
    const firstBytes = service.archive(first.archiveId ?? '');
    const second = await validation();
    expect(second.archiveId).not.toBe(first.archiveId);
    await publish(second.archiveId ?? '');
    expect(uploads[0]?.bytes).toEqual(firstBytes);
  });

  it('leaves .git, .DS_Store and the like out of the upload, exactly as the exclusion list says', async () => {
    mkdirSync(join(folder, '.git', 'objects'), { recursive: true });
    writeFileSync(join(folder, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(folder, '.DS_Store'), 'junk');
    writeFileSync(join(folder, 'assets', 'Thumbs.db'), 'junk');
    writeFileSync(join(folder, '.index.mjs.swp'), 'junk');
    mkdirSync(join(folder, 'node_modules', '.cache', 'tool'), { recursive: true });
    writeFileSync(join(folder, 'node_modules', '.cache', 'tool', 'x'), 'junk');
    writeFileSync(join(folder, 'node_modules', 'kept.js'), 'export {};\n');
    const data = await validation();
    expect(data.excluded).toEqual([
      '.DS_Store',
      '.git/',
      '.index.mjs.swp',
      'assets/Thumbs.db',
      'node_modules/.cache/',
    ]);
    await publish(data.archiveId ?? '');
    const sent = (await ArchiveSource.open(uploads[0]?.bytes ?? new Uint8Array())).listFiles();
    expect([...sent].sort()).toEqual([
      'README.md',
      'assets/icon.png',
      'index.mjs',
      'manifest.json',
      'node_modules/kept.js',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a folder with a symbolic link before any upload',
    async () => {
      symlinkSync(join(folder, 'README.md'), join(folder, 'notes.md'));
      const data = await validation();
      expect(data.problems.map((problem) => [problem.path, problem.code])).toEqual([
        ['notes.md', 'archive_symlink'],
      ]);
      await expect(publish(data.archiveId ?? '')).resolves.toMatchObject({
        ok: false,
        error: { code: 'package_invalid' },
      });
      expect(uploads).toEqual([]);
    },
  );

  it('reports the bytes sent as it goes, up to the whole request', async () => {
    addLargeFile(512 * 1024);
    const data = await validation();
    await publish(data.archiveId ?? '');
    const reports = progress.get('job-1') ?? [];
    expect(reports.length).toBeGreaterThan(8);
    const total = Number(uploads[0]?.headers['content-length']);
    expect(reports.every((report) => report.total === total)).toBe(true);
    const sent = reports.map((report) => report.sent);
    expect(sent).toEqual([...sent].sort((a, b) => a - b));
    expect(sent.at(-1)).toBe(total);
  });

  it('Cancel aborts the request while it is sent: upload_cancelled, and the Store keeps nothing', async () => {
    addLargeFile(4 * 1024 * 1024);
    const data = await validation();
    const stalled = new Promise<void>((resolve) => {
      behaviour.stall = resolve;
    });
    const result = publish(data.archiveId ?? '');
    await stalled;
    await cancel();
    await expect(result).resolves.toMatchObject({
      ok: false,
      error: { code: 'upload_cancelled', messageKey: 'error.upload_cancelled' },
    });
    const reports = progress.get('job-1') ?? [];
    expect(reports.at(-1)?.sent).toBeLessThan(reports.at(-1)?.total ?? 0);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.complete).toBe(false);
    expect(versions.get('octo-cat/fixture-web')).toBeUndefined();
    expect(await listing('octo-cat/fixture-web')).toEqual([]);
    expect(unreachable).not.toHaveBeenCalled();
  });

  it('Cancel changes nothing once the whole request is sent: the Store’s answer stands', async () => {
    let release: () => void = () => undefined;
    behaviour.hold = new Promise((resolve) => {
      release = resolve;
    });
    const data = await validation();
    onProgress = (jobId, report) => {
      if (report.sent < report.total) return;
      onProgress = null;
      // The Store has it all: cancelling now must not drop an answer that may be a success.
      void cancel(jobId).then(release);
    };
    await expect(publish(data.archiveId ?? '')).resolves.toMatchObject({
      ok: true,
      data: { version: '1.0.0' },
    });
    expect(versions.get('octo-cat/fixture-web')).toEqual(['1.0.0']);
  });

  it('a refusal keeps the Store’s code, message and problems; Retry sends the same archive', async () => {
    versions.set('octo-cat/fixture-web', ['0.9.0']);
    const data = await validation();
    const problem = {
      path: 'version',
      code: 'version_not_greater',
      messageKey: 'version_not_greater',
      params: { version: '1.0.0', latest: '1.0.0' },
      message: 'Version 1.0.0 must be greater than every published version; the latest is 1.0.0.',
    };
    behaviour.refuse = {
      status: 409,
      body: {
        error: { code: 'version_not_greater', message: 'Not greater.', problems: [problem] },
      },
    };
    await expect(publish(data.archiveId ?? '')).resolves.toEqual({
      ok: false,
      error: {
        code: 'version_not_greater',
        messageKey: 'error.version_not_greater',
        message: 'Not greater.',
        problems: [problem],
      },
    });

    behaviour.refuse = null;
    await expect(publish(data.archiveId ?? '', 'job-2')).resolves.toMatchObject({ ok: true });
    expect(uploads).toHaveLength(2);
    expect(uploads[1]?.bytes).toEqual(uploads[0]?.bytes);
  });

  it.each([
    [403, 'publisher_mismatch', 'publisher_mismatch'],
    [409, 'harness_taken_down', 'harness_taken_down'],
    [413, 'package_too_large', 'package_too_large'],
    [413, undefined, 'package_too_large'],
    [422, 'invalid_manifest', 'invalid_manifest'],
    [429, 'rate_limited', 'rate_limited'],
    [403, 'forbidden', 'forbidden'],
    [400, 'invalid_request', 'internal_error'],
    [500, 'internal_error', 'store_unreachable'],
    [502, undefined, 'store_unreachable'],
  ] as const)('a %i %s answer is %s', async (status, code, expected) => {
    behaviour.refuse = {
      status,
      body: code === undefined ? 'Bad gateway' : { error: { code, message: 'From the Store.' } },
    };
    const data = await validation();
    const result = await publish(data.archiveId ?? '');
    expect(result).toMatchObject({
      ok: false,
      error: { code: expected, messageKey: `error.${expected}` },
    });
    if (!result.ok && code !== undefined && status < 500) {
      expect(result.error.message).toBe('From the Store.');
    }
  });

  it('a 401 is unauthenticated and ends the session it was sent with', async () => {
    const data = await validation();
    token = 'access-token-the-store-refuses';
    await expect(publish(data.archiveId ?? '')).resolves.toMatchObject({
      ok: false,
      error: { code: 'unauthenticated' },
    });
    expect(sessionRejected).toHaveBeenCalledExactlyOnceWith('access-token-the-store-refuses');
  });

  it('signed out (or the refresh refused) is unauthenticated, with nothing sent', async () => {
    const data = await validation();
    token = null;
    await expect(publish(data.archiveId ?? '')).resolves.toMatchObject({
      ok: false,
      error: { code: 'unauthenticated' },
    });
    expect(uploads).toEqual([]);
  });

  it('a Store that does not answer is store_unreachable, and connectivity is checked again', async () => {
    const data = await validation();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await expect(publish(data.archiveId ?? '')).resolves.toMatchObject({
      ok: false,
      error: { code: 'store_unreachable' },
    });
    expect(unreachable).toHaveBeenCalledOnce();
    // afterEach closes it again.
    server = createServer();
  });

  it('an archive that is no longer the latest validation’s is package_invalid', async () => {
    const first = await validation();
    await validation();
    await expect(publish(first.archiveId ?? '')).resolves.toMatchObject({
      ok: false,
      error: { code: 'package_invalid' },
    });
    expect(uploads).toEqual([]);
  });
});

describe('uploadPackage', () => {
  it('gives up on a Store that takes the request but never answers', async () => {
    behaviour.hold = new Promise(() => undefined);
    const outcome = await uploadPackage({
      url: `${baseUrl}/functions/v1/publish`,
      headers: { apikey: ANON_KEY, authorization: `Bearer ${TOKEN}` },
      fileName: 'x-1.0.0.zip',
      bytes: new Uint8Array(10),
      onProgress: () => undefined,
      signal: new AbortController().signal,
      idleTimeoutMs: 200,
    });
    expect(outcome).toEqual({ kind: 'unreachable' });
  });
});
