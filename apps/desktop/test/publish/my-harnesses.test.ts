/**
 * Ticket P0-08.3: `publish.myHarnesses` and `publish.unpublish` through the Runtime's IPC
 * handlers, against a fake Store on a real HTTP port that does what api.md says the real one
 * does: the "Own versions" read answers what the Publisher-only read policy lets the session see
 * (the caller's own versions in any status, the takedown note on their taken-down ones, and
 * everybody's published versions), filtered by `manifest->>id`; `latest_versions` reports each
 * Harness's status and latest published version; `unpublish` checks the owner, refuses a
 * taken-down version, is idempotent and moves the latest version back.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import semver from 'semver';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createPublishService, type PublishService } from '../../src/main/runtime/publish.js';
import type { Services } from '../../src/main/runtime/services.js';
import type { IpcResult, OwnHarness, UnpublishedVersion } from '../../src/shared/ipc.js';
import { REFUSED_PORT } from '../support/refused-port.js';

const ANON_KEY = 'fake-anon-key';
const MAIN_WINDOW = {};
/** The Publishers' access tokens, by login. */
const TOKENS: Readonly<Record<string, string>> = {
  'octo-cat': 'access-token-of-octo-cat',
  mona: 'access-token-of-mona',
};

/** A Harness Version as the fake Store keeps it. */
interface StoredVersion {
  version: string;
  name: string;
  status: 'published' | 'unpublished' | 'taken_down';
  takedown_note: string | null;
  download_count: number;
  published_at: string;
  unpublished_at: string | null;
}

/** A Harness as the fake Store keeps it. */
interface StoredHarness {
  owner: string;
  status: 'active' | 'taken_down';
  versions: StoredVersion[];
}

let server: Server;
let baseUrl: string;
let harnesses: Map<string, StoredHarness>;
/** Every request the fake Store got. */
let requests: { method: string; url: URL; authorization: string | undefined }[];
/** Answers every request with this status instead, when set. */
let failWith: number | null;
/** Who is signed in to the app; null when nobody. */
let signedIn: string | null;
/** The access token of a session the Store no longer accepts, when set. */
let staleToken: string | null;
let sessionRejected: ReturnType<typeof vi.fn<(accessToken: string) => Promise<void>>>;
let unreachable: ReturnType<typeof vi.fn<() => void>>;
let service: PublishService;

beforeEach(async () => {
  harnesses = new Map();
  requests = [];
  failWith = null;
  signedIn = 'octo-cat';
  staleToken = null;
  sessionRejected = vi.fn<(accessToken: string) => Promise<void>>(() => Promise.resolve());
  unreachable = vi.fn<() => void>();
  server = createServer((request, response) => {
    void serve(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  service = serviceFor(() => baseUrl);
  seed();
});
afterEach(async () => {
  service.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

function serviceFor(storeBaseUrl: () => string): PublishService {
  return createPublishService({
    fetch: (url, init) => globalThis.fetch(url, init),
    storeBaseUrl,
    anonKey: ANON_KEY,
    auth: {
      login: () => Promise.resolve(signedIn),
      accessToken: () =>
        Promise.resolve(signedIn === null ? null : (staleToken ?? TOKENS[signedIn] ?? null)),
      sessionRejected,
    },
    onStoreUnreachable: unreachable,
  });
}

/**
 * Two Harnesses of octo-cat, one with a published, an Unpublished and a taken-down version, the
 * other with two published ones; and one of mona's, published.
 */
function seed() {
  const version = (
    harnessName: string,
    number: string,
    day: number,
    fields: Partial<StoredVersion> = {},
  ): StoredVersion => ({
    version: number,
    name: harnessName,
    status: 'published',
    takedown_note: null,
    download_count: 0,
    published_at: `2026-10-${String(day).padStart(2, '0')}T09:00:00.000000+00:00`,
    unpublished_at: null,
    ...fields,
  });
  harnesses.set('octo-cat/hello-web', {
    owner: 'octo-cat',
    status: 'active',
    versions: [
      version('Hello Web', '1.0.0', 1, { download_count: 120 }),
      version('Hello Web', '1.1.0', 5, {
        status: 'unpublished',
        download_count: 7,
        unpublished_at: '2026-10-06T10:00:00.000000+00:00',
      }),
      version('Hello Web', '2.0.0', 9, {
        status: 'taken_down',
        takedown_note: 'Taken down: it sends files to an unlisted domain.',
        download_count: 3,
      }),
    ],
  });
  harnesses.set('octo-cat/hello-term', {
    owner: 'octo-cat',
    status: 'active',
    versions: [
      version('Hello Term (old name)', '0.1.0', 2, { download_count: 40 }),
      version('Hello Term', '0.2.0', 12, { download_count: 2 }),
    ],
  });
  harnesses.set('mona/writer', {
    owner: 'mona',
    status: 'active',
    versions: [version('Writer', '1.0.0', 3, { download_count: 9 })],
  });
}

/** The fake Store: the "Own versions" read, `latest_versions` and the `unpublish` function. */
async function serve(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://store.test');
  requests.push({
    method: request.method ?? '',
    url,
    authorization: request.headers.authorization,
  });
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body: unknown = chunks.length === 0 ? null : JSON.parse(Buffer.concat(chunks).toString());
  const json = (status: number, answer: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer));
  };
  if (failWith !== null) {
    json(failWith, { error: { code: 'internal_error', message: 'Down.' } });
    return;
  }
  if (request.headers.apikey !== ANON_KEY) {
    json(401, { message: 'No API key found in request' });
    return;
  }
  const caller = Object.entries(TOKENS).find(
    ([, token]) => request.headers.authorization === `Bearer ${token}`,
  )?.[0];
  if (caller === undefined) {
    json(401, { error: { code: 'unauthenticated', message: 'Sign in again.' } });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/rest/v1/harness_versions') {
    expect(url.searchParams.get('select')).toBe(
      'harness_id:manifest->>id,name:manifest->>name,version,status,takedown_note,download_count,published_at,unpublished_at',
    );
    expect(url.searchParams.get('order')).toBe('published_at.desc');
    const filter = url.searchParams.get('manifest->>id') ?? '';
    const prefix = /^like\.(.+)\*$/.exec(filter)?.[1];
    if (prefix === undefined) throw new Error(`Unexpected filter ${filter}`);
    const rows = [...harnesses.entries()]
      .filter(([id]) => id.startsWith(prefix))
      .flatMap(([id, harness]) =>
        harness.versions
          // The read policies: published versions of active Harnesses, and the owner's own.
          .filter(
            (version) =>
              harness.owner === caller ||
              (version.status === 'published' && harness.status === 'active'),
          )
          .map((version) => ({ harness_id: id, ...version })),
      )
      .sort((a, b) => (a.published_at < b.published_at ? 1 : -1));
    json(200, rows);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/rest/v1/rpc/latest_versions') {
    expect(url.searchParams.get('select')).toBe('harness_id,store_status,latest_version');
    const ids = (body as { harness_ids: string[] }).harness_ids;
    json(
      200,
      ids.map((id) => {
        const harness = harnesses.get(id);
        const latest = harness === undefined ? null : latestOf(harness);
        const storeStatus =
          harness === undefined
            ? 'not_found'
            : harness.status === 'taken_down'
              ? 'taken_down'
              : latest === null
                ? 'unpublished'
                : 'available';
        return {
          harness_id: id,
          store_status: storeStatus,
          latest_version: storeStatus === 'available' ? latest : null,
        };
      }),
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/functions/v1/unpublish') {
    const { harness_id: id, version: number } = body as { harness_id: string; version: string };
    const harness = harnesses.get(id);
    if (harness === undefined) {
      json(404, { error: { code: 'not_found', message: 'No such Harness.' } });
      return;
    }
    if (harness.owner !== caller) {
      json(403, { error: { code: 'forbidden', message: 'Not your Harness.' } });
      return;
    }
    const version = harness.versions.find((row) => row.version === number);
    if (version === undefined) {
      json(404, { error: { code: 'not_found', message: 'No such version.' } });
      return;
    }
    if (harness.status === 'taken_down' || version.status === 'taken_down') {
      json(409, { error: { code: 'harness_taken_down', message: 'It was taken down.' } });
      return;
    }
    if (version.status === 'published') {
      version.status = 'unpublished';
      version.unpublished_at = '2026-10-28T12:00:00.000000+00:00';
    }
    json(200, {
      harness_id: id,
      version: number,
      status: 'unpublished',
      latest_version: latestOf(harness),
    });
    return;
  }
  json(404, { error: { code: 'not_found', message: 'Not found' } });
}

/** The highest published version, as the Store's status trigger keeps it. */
function latestOf(harness: StoredHarness): string | null {
  const published = harness.versions.filter((row) => row.status === 'published');
  return semver.rsort(published.map((row) => row.version))[0] ?? null;
}

/** The Runtime's IPC dispatcher, with the real Publish service behind it. */
function dispatcher() {
  const services = { publish: service } as unknown as Services;
  return createDispatcher({
    handlers: createHandlers(services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
}

async function myHarnesses(): Promise<IpcResult<readonly OwnHarness[]>> {
  return (await dispatcher()(MAIN_WINDOW, { method: 'publish.myHarnesses' })) as IpcResult<
    readonly OwnHarness[]
  >;
}

async function unpublish(harnessId: string, version: string) {
  return (await dispatcher()(MAIN_WINDOW, {
    method: 'publish.unpublish',
    input: { harnessId, version },
  })) as IpcResult<UnpublishedVersion>;
}

/** The Harnesses listed, or the test fails. */
async function listed(): Promise<readonly OwnHarness[]> {
  const result = await myHarnesses();
  if (!result.ok) throw new Error(`publish.myHarnesses failed: ${result.error.code}`);
  return result.data;
}

describe('publish.myHarnesses', () => {
  it("lists every one of the Publisher's Harnesses and versions, in any status, with the Store's counts", async () => {
    expect(await listed()).toEqual([
      {
        harnessId: 'octo-cat/hello-term',
        name: 'Hello Term',
        storeStatus: 'available',
        latestVersion: '0.2.0',
        downloadCount: 42,
        versions: [
          {
            version: '0.2.0',
            status: 'published',
            publishedAt: '2026-10-12T09:00:00.000000+00:00',
            unpublishedAt: null,
            takedownNote: null,
            downloadCount: 2,
          },
          {
            version: '0.1.0',
            status: 'published',
            publishedAt: '2026-10-02T09:00:00.000000+00:00',
            unpublishedAt: null,
            takedownNote: null,
            downloadCount: 40,
          },
        ],
      },
      {
        harnessId: 'octo-cat/hello-web',
        name: 'Hello Web',
        storeStatus: 'available',
        latestVersion: '1.0.0',
        downloadCount: 130,
        versions: [
          {
            version: '2.0.0',
            status: 'taken_down',
            publishedAt: '2026-10-09T09:00:00.000000+00:00',
            unpublishedAt: null,
            takedownNote: 'Taken down: it sends files to an unlisted domain.',
            downloadCount: 3,
          },
          {
            version: '1.1.0',
            status: 'unpublished',
            publishedAt: '2026-10-05T09:00:00.000000+00:00',
            unpublishedAt: '2026-10-06T10:00:00.000000+00:00',
            takedownNote: null,
            downloadCount: 7,
          },
          {
            version: '1.0.0',
            status: 'published',
            publishedAt: '2026-10-01T09:00:00.000000+00:00',
            unpublishedAt: null,
            takedownNote: null,
            downloadCount: 120,
          },
        ],
      },
    ]);
    // The "Own versions" read with the Publisher's session, then one latest_versions call.
    expect(requests.map(({ method, url }) => `${method} ${url.pathname}`)).toEqual([
      'GET /rest/v1/harness_versions',
      'POST /rest/v1/rpc/latest_versions',
    ]);
    expect(requests[0]?.url.searchParams.get('manifest->>id')).toBe('like.octo-cat/*');
    for (const request of requests) {
      expect(request.authorization).toBe(`Bearer ${TOKENS['octo-cat'] ?? ''}`);
    }
  });

  it("never shows another Publisher this Publisher's versions", async () => {
    signedIn = 'mona';
    const list = await listed();
    expect(list.map((harness) => harness.harnessId)).toEqual(['mona/writer']);
    expect(list.flatMap((harness) => harness.versions.map((row) => row.version))).toEqual([
      '1.0.0',
    ]);
    expect(requests[0]?.url.searchParams.get('manifest->>id')).toBe('like.mona/*');
  });

  it("reports a taken-down Harness's own status, and one with no published version left", async () => {
    const web = harnesses.get('octo-cat/hello-web');
    const term = harnesses.get('octo-cat/hello-term');
    if (web === undefined || term === undefined) throw new Error('not seeded');
    web.status = 'taken_down';
    for (const row of term.versions) row.status = 'unpublished';
    const list = await listed();
    expect(
      list.map(({ harnessId, storeStatus, latestVersion }) => [
        harnessId,
        storeStatus,
        latestVersion,
      ]),
    ).toEqual([
      ['octo-cat/hello-term', 'unpublished', null],
      ['octo-cat/hello-web', 'taken_down', null],
    ]);
  });

  it('answers an empty list for a Publisher with no Harness, without asking for statuses', async () => {
    harnesses.delete('mona/writer');
    signedIn = 'mona';
    expect(await listed()).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('is unauthenticated with nobody signed in, and asks the Store nothing', async () => {
    signedIn = null;
    expect(await myHarnesses()).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
    expect(requests).toEqual([]);
  });
});

describe('publish.unpublish', () => {
  it('Unpublishes the latest version: the list shows it Unpublished and the previous version current', async () => {
    expect(await unpublish('octo-cat/hello-term', '0.2.0')).toEqual({
      ok: true,
      data: { harnessId: 'octo-cat/hello-term', version: '0.2.0', latestVersion: '0.1.0' },
    });
    const unpublishCall = requests.at(-1);
    expect(unpublishCall?.authorization).toBe(`Bearer ${TOKENS['octo-cat'] ?? ''}`);

    const term = (await listed()).find((harness) => harness.harnessId === 'octo-cat/hello-term');
    expect(term?.latestVersion).toBe('0.1.0');
    expect(term?.versions[0]).toMatchObject({
      version: '0.2.0',
      status: 'unpublished',
      unpublishedAt: '2026-10-28T12:00:00.000000+00:00',
      downloadCount: 2,
    });
  });

  it('Unpublishing the last published version leaves the Harness with none', async () => {
    expect(await unpublish('octo-cat/hello-web', '1.0.0')).toMatchObject({
      ok: true,
      data: { latestVersion: null },
    });
    const web = (await listed()).find((harness) => harness.harnessId === 'octo-cat/hello-web');
    expect(web).toMatchObject({ storeStatus: 'unpublished', latestVersion: null });
  });

  it('succeeds twice on the same version, one after the other or both at once', async () => {
    const expected = {
      ok: true,
      data: { harnessId: 'octo-cat/hello-term', version: '0.1.0', latestVersion: '0.2.0' },
    };
    expect(await unpublish('octo-cat/hello-term', '0.1.0')).toEqual(expected);
    expect(await unpublish('octo-cat/hello-term', '0.1.0')).toEqual(expected);
    // A stale list: the version was already Unpublished elsewhere.
    expect(await unpublish('octo-cat/hello-web', '1.1.0')).toMatchObject({ ok: true });
    // A double click that got past the disabled button.
    const both = await Promise.all([
      unpublish('octo-cat/hello-term', '0.2.0'),
      unpublish('octo-cat/hello-term', '0.2.0'),
    ]);
    expect(both).toEqual([
      {
        ok: true,
        data: { harnessId: 'octo-cat/hello-term', version: '0.2.0', latestVersion: null },
      },
      {
        ok: true,
        data: { harnessId: 'octo-cat/hello-term', version: '0.2.0', latestVersion: null },
      },
    ]);
  });

  it("keeps the Store's refusals by their code, with its message", async () => {
    expect(await unpublish('octo-cat/hello-web', '2.0.0')).toMatchObject({
      ok: false,
      error: {
        code: 'harness_taken_down',
        messageKey: 'error.harness_taken_down',
        message: 'It was taken down.',
      },
    });
    expect(await unpublish('mona/writer', '1.0.0')).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await unpublish('octo-cat/hello-web', '9.9.9')).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(harnesses.get('mona/writer')?.versions[0]?.status).toBe('published');
  });

  it('ends a session the Store refuses (401) and answers unauthenticated', async () => {
    staleToken = 'stale';
    expect(await unpublish('octo-cat/hello-term', '0.2.0')).toMatchObject({
      ok: false,
      error: { code: 'unauthenticated' },
    });
    expect(await myHarnesses()).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
    expect(sessionRejected).toHaveBeenCalledWith('stale');
    expect(harnesses.get('octo-cat/hello-term')?.versions[1]?.status).toBe('published');
  });

  it('is store_unreachable when the Store does not answer, or answers a 5xx', async () => {
    failWith = 503;
    expect(await unpublish('octo-cat/hello-term', '0.2.0')).toMatchObject({
      ok: false,
      error: { code: 'store_unreachable' },
    });
    expect(await myHarnesses()).toMatchObject({ ok: false, error: { code: 'store_unreachable' } });
    expect(unreachable).not.toHaveBeenCalled();

    service = serviceFor(() => `http://127.0.0.1:${String(REFUSED_PORT)}`);
    expect(await myHarnesses()).toMatchObject({ ok: false, error: { code: 'store_unreachable' } });
    expect(await unpublish('octo-cat/hello-term', '0.2.0')).toMatchObject({
      ok: false,
      error: { code: 'store_unreachable' },
    });
    expect(unreachable).toHaveBeenCalledTimes(2);
  });
});
