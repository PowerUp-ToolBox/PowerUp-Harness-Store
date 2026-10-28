/**
 * Ticket P0-09.1: `store.home` through the Runtime's IPC handlers, against a fake Store on a real
 * HTTP port that answers api.md's three home reads as PostgREST does under row-level security:
 * only active Harnesses with a published version are rows at all, and the embedded
 * `harness_versions` are their published versions only. The seed has one Featured Harness, one
 * with a high download count, one recently published, one Unpublished-only and one taken down,
 * the hidden two Featured with the lowest ranks, the most downloads and the newest version, so
 * that only the Store's visibility can keep them out.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import type { Services } from '../../src/main/runtime/services.js';
import { createStoreCatalogue, HOME_CACHE_MS } from '../../src/main/runtime/store-catalogue.js';
import type { IpcResult, StoreHome, StoreListing } from '../../src/shared/ipc.js';
import { REFUSED_PORT } from '../support/refused-port.js';

const ANON_KEY = 'fake-anon-key';
const MAIN_WINDOW = {};

/** api.md `<list columns>`, word for word. */
const LIST_COLUMNS =
  'harness_id,name,summary,icon_path,tags,download_count,latest_version,latest_published_at,harness_versions(version,platforms)';

/** api.md's home reads, word for word (as the fake Store receives them, decoded). */
const FEATURED = `featured_rank=not.is.null&order=featured_rank&limit=12&select=${LIST_COLUMNS}`;
const MOST_DOWNLOADED = `order=download_count.desc,harness_id&limit=12&select=${LIST_COLUMNS}`;
const NEWEST = `order=latest_published_at.desc,harness_id&limit=12&select=${LIST_COLUMNS}`;

/** A Harness Version as the fake Store keeps it. */
interface StoredVersion {
  version: string;
  status: 'published' | 'unpublished' | 'taken_down';
  platforms: string[];
  published_at: string;
}

/** A Harness as the fake Store keeps it; its listing fields are those of its latest version. */
interface StoredHarness {
  harness_id: string;
  status: 'active' | 'taken_down';
  featured_rank: number | null;
  name: string;
  summary: string;
  icon_path: string | null;
  tags: string[];
  download_count: number;
  versions: StoredVersion[];
}

let server: Server;
let baseUrl: string;
let harnesses: StoredHarness[];
/** Every request the fake Store got. */
let requests: { url: URL; apikey: string | undefined; authorization: string | undefined }[];
/** Answers every request with this status instead, when set. */
let failWith: number | null;
/** Answers every request with this JSON body instead, when set. */
let answerWith: unknown;
/** Answers every request with this raw body instead, when set. */
let answerRaw: string | undefined;
/** Sends 200 and the start of a body, then stalls ('stall') or drops the connection ('reset'). */
let breakBody: 'stall' | 'reset' | null;
let clock: Date;
let unreachable: ReturnType<typeof vi.fn<() => void>>;

beforeEach(async () => {
  requests = [];
  failWith = null;
  answerWith = undefined;
  answerRaw = undefined;
  breakBody = null;
  clock = new Date('2026-10-28T09:00:00.000Z');
  unreachable = vi.fn<() => void>();
  harnesses = seed();
  server = createServer((request, response) => {
    serve(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}T09:00:00.000000+00:00`;

function harness(
  id: string,
  fields: Partial<StoredHarness> & Pick<StoredHarness, 'versions'>,
): StoredHarness {
  return {
    harness_id: id,
    status: 'active',
    featured_rank: null,
    name: id,
    summary: `The ${id} Harness.`,
    icon_path: `${id}/1.0.0/icon.png`,
    tags: ['coding'],
    download_count: 0,
    ...fields,
  };
}

const published = (version: string, published_at: string, platforms = ['darwin-arm64']) => ({
  version,
  status: 'published' as const,
  platforms,
  published_at,
});

function seed(): StoredHarness[] {
  return [
    harness('alice/featured', {
      featured_rank: 20,
      name: 'Featured Pick',
      tags: ['writing', 'research'],
      download_count: 50,
      // An older version declared other platforms: the card shows the latest one's.
      versions: [
        published('1.0.0', day(1), ['linux-x64']),
        published('1.1.0', day(5), ['darwin-arm64', 'win32-x64']),
      ],
    }),
    harness('alice/popular', {
      featured_rank: 30,
      download_count: 9000,
      icon_path: null,
      versions: [published('2.0.0', day(2), ['linux-x64'])],
    }),
    harness('bob/fresh', {
      download_count: 3,
      versions: [published('0.1.0', day(20))],
    }),
    // Hidden: the lowest ranks, the most downloads and the newest versions.
    harness('carol/unpublished-only', {
      featured_rank: 1,
      download_count: 50_000,
      versions: [{ ...published('1.0.0', day(27)), status: 'unpublished' }],
    }),
    harness('dave/taken-down', {
      status: 'taken_down',
      featured_rank: 2,
      download_count: 60_000,
      versions: [{ ...published('1.0.0', day(27)), status: 'taken_down' }],
    }),
  ];
}

/** The latest published version of a Harness, as `refresh_harness` keeps it; null for none. */
function latestOf(stored: StoredHarness): StoredVersion | null {
  return (
    stored.versions
      .filter((version) => version.status === 'published')
      .sort((a, b) => (a.published_at < b.published_at ? 1 : -1))[0] ?? null
  );
}

/** The fake Store: GET `harnesses` with api.md's filters, order and limit, under RLS. */
function serve(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://store.test');
  requests.push({
    url,
    apikey: request.headers.apikey as string | undefined,
    authorization: request.headers.authorization,
  });
  const json = (status: number, answer: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer));
  };
  if (failWith !== null) {
    json(failWith, { message: 'Down.' });
    return;
  }
  if (answerWith !== undefined) {
    json(200, answerWith);
    return;
  }
  if (answerRaw !== undefined) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(answerRaw);
    return;
  }
  if (breakBody !== null) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('[{"harness_id":');
    if (breakBody === 'reset') setTimeout(() => response.destroy(), 20);
    return;
  }
  if (request.method !== 'GET' || url.pathname !== '/rest/v1/harnesses') {
    json(404, { message: 'Not here.' });
    return;
  }
  // Row-level security: active, with a published version.
  let rows = harnesses.filter((row) => row.status === 'active' && latestOf(row) !== null);
  if (url.searchParams.get('featured_rank') === 'not.is.null') {
    rows = rows.filter((row) => row.featured_rank !== null);
  }
  const sortKey = (row: StoredHarness, column: string): string | number => {
    if (column === 'latest_published_at') return latestOf(row)?.published_at ?? '';
    return (row as unknown as Record<string, string | number>)[column] ?? '';
  };
  const order = (url.searchParams.get('order') ?? '').split(',').map((term) => {
    const [column = '', direction] = term.split('.');
    return { column, sign: direction === 'desc' ? -1 : 1 };
  });
  rows = [...rows].sort((a, b) => {
    for (const { column, sign } of order) {
      const [left, right] = [sortKey(a, column), sortKey(b, column)];
      if (left !== right) return (left < right ? -1 : 1) * sign;
    }
    return 0;
  });
  rows = rows.slice(0, Number(url.searchParams.get('limit') ?? rows.length));
  json(
    200,
    rows.map((row) => ({
      harness_id: row.harness_id,
      name: row.name,
      summary: row.summary,
      icon_path: row.icon_path,
      tags: row.tags,
      download_count: row.download_count,
      latest_version: latestOf(row)?.version ?? null,
      latest_published_at: latestOf(row)?.published_at ?? null,
      // Embedded rows are filtered by the versions' read policy too.
      harness_versions: row.versions
        .filter((version) => version.status === 'published')
        .map(({ version, platforms }) => ({ version, platforms })),
    })),
  );
}

function dispatcherFor(storeBaseUrl: () => string = () => baseUrl) {
  const store = createStoreCatalogue({
    fetch: (url, init) => globalThis.fetch(url, init),
    storeBaseUrl,
    anonKey: ANON_KEY,
    platform: 'darwin-arm64',
    onStoreUnreachable: unreachable,
    now: () => clock,
    readTimeoutMs: 1000,
  });
  const handlers = createHandlers({ store } as unknown as Services);
  const dispatch = createDispatcher({
    handlers,
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
    onHandlerError: (method, error) => {
      throw new Error(`${method} threw`, { cause: error });
    },
  });
  return (input?: unknown) =>
    dispatch(MAIN_WINDOW, { method: 'store.home', input }) as Promise<IpcResult<StoreHome>>;
}

async function homeOf(home: (input?: unknown) => Promise<IpcResult<StoreHome>>, input?: unknown) {
  const result = await home(input);
  if (!result.ok) throw new Error(`store.home failed: ${result.error.code}`);
  return result.data;
}

const ids = (listings: readonly StoreListing[]) => listings.map((listing) => listing.harnessId);

describe('store.home', () => {
  it('answers Featured, Most downloaded and New exactly by the rules, without hidden Harnesses', async () => {
    const home = await homeOf(dispatcherFor());
    // Ascending featured_rank; ranks 1 and 2 are Unpublished-only and taken down.
    expect(ids(home.featured)).toEqual(['alice/featured', 'alice/popular']);
    expect(ids(home.mostDownloaded)).toEqual(['alice/popular', 'alice/featured', 'bob/fresh']);
    expect(ids(home.newest)).toEqual(['bob/fresh', 'alice/featured', 'alice/popular']);
    for (const row of [home.featured, home.mostDownloaded, home.newest]) {
      expect(ids(row)).not.toContain('carol/unpublished-only');
      expect(ids(row)).not.toContain('dave/taken-down');
    }
    expect(home.platform).toBe('darwin-arm64');
  });

  it('reads the Store anonymously with api.md’s three home reads, at once', async () => {
    await homeOf(dispatcherFor());
    expect(
      requests.map(({ url }) => `${url.pathname}?${decodeURIComponent(url.search.slice(1))}`),
    ).toEqual(
      expect.arrayContaining([
        `/rest/v1/harnesses?${FEATURED}`,
        `/rest/v1/harnesses?${MOST_DOWNLOADED}`,
        `/rest/v1/harnesses?${NEWEST}`,
      ]),
    );
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.apikey).toBe(ANON_KEY);
      expect(request.authorization).toBe(`Bearer ${ANON_KEY}`);
    }
  });

  it('gives each card what it shows: the latest version’s platforms and an icon URL in the asset bucket', async () => {
    const home = await homeOf(dispatcherFor());
    expect(home.featured[0]).toEqual({
      harnessId: 'alice/featured',
      publisher: 'alice',
      name: 'Featured Pick',
      summary: 'The alice/featured Harness.',
      iconUrl: 'store-asset://harness-assets/alice/featured/1.0.0/icon.png',
      tags: ['writing', 'research'],
      downloadCount: 50,
      latestVersion: '1.1.0',
      latestPublishedAt: day(5),
      platforms: ['darwin-arm64', 'win32-x64'],
    });
    // No icon: the monogram.
    expect(home.featured[1]).toMatchObject({ harnessId: 'alice/popular', iconUrl: null });
  });

  it('skips a row that is not a listing and keeps only known tags and platforms', async () => {
    answerWith = [
      { name: 'No ID', latest_version: '1.0.0' },
      {
        harness_id: 'eve/odd',
        name: 'Odd',
        latest_version: '1.0.0',
        tags: ['coding', 'not-a-tag', 3],
        icon_path: 'eve/odd/../../secret.png',
        harness_versions: [{ version: '1.0.0', platforms: ['plan9-mips', 'linux-x64'] }],
      },
    ];
    const home = await homeOf(dispatcherFor());
    expect(home.featured).toEqual([
      {
        harnessId: 'eve/odd',
        publisher: 'eve',
        name: 'Odd',
        summary: '',
        iconUrl: null,
        tags: ['coding'],
        downloadCount: 0,
        latestVersion: '1.0.0',
        latestPublishedAt: '',
        platforms: ['linux-x64'],
      },
    ]);
  });

  describe('the 5-minute cache', () => {
    it('answers from memory for 5 minutes, then reads the Store again', async () => {
      const home = dispatcherFor();
      const first = await homeOf(home);
      clock = new Date(clock.getTime() + HOME_CACHE_MS - 1);
      harnesses.push(
        harness('frank/newer', { download_count: 1, versions: [published('1.0.0', day(28))] }),
      );
      expect(await homeOf(home)).toEqual(first);
      expect(requests).toHaveLength(3);

      clock = new Date(clock.getTime() + 1);
      expect(ids((await homeOf(home)).newest)[0]).toBe('frank/newer');
      expect(requests).toHaveLength(6);
    });

    it('reads again at once on { refresh: true } (Retry)', async () => {
      const home = dispatcherFor();
      await homeOf(home);
      await homeOf(home, { refresh: true });
      expect(requests).toHaveLength(6);
    });

    it('is kept per Store base URL', async () => {
      let url = baseUrl;
      const home = dispatcherFor(() => url);
      await homeOf(home);
      url = `${baseUrl}/`;
      await homeOf(home);
      expect(requests).toHaveLength(6);
    });

    it('never keeps a failure', async () => {
      const home = dispatcherFor();
      failWith = 503;
      expect((await home()).ok).toBe(false);
      failWith = null;
      expect((await homeOf(home)).featured).toHaveLength(2);
    });
  });

  describe('when it fails', () => {
    it('is store_unreachable when the Store does not answer, and has connectivity checked again', async () => {
      const result = await dispatcherFor(() => `http://127.0.0.1:${String(REFUSED_PORT)}`)();
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'store_unreachable', messageKey: 'error.store_unreachable' },
      });
      // Once for the three reads, which fail together.
      expect(unreachable).toHaveBeenCalledOnce();
    });

    it.each(['stall', 'reset'] as const)(
      'is store_unreachable when the Store answers 200 and its body then %ss',
      async (how) => {
        breakBody = how;
        await expect(dispatcherFor()()).resolves.toMatchObject({
          ok: false,
          error: { code: 'store_unreachable' },
        });
        expect(unreachable).toHaveBeenCalledOnce();
      },
    );

    it.each([500, 503, 400, 404])(
      'is store_error when the Store answers %i; the Store is not offline',
      async (status) => {
        failWith = status;
        await expect(dispatcherFor()()).resolves.toMatchObject({
          ok: false,
          error: { code: 'store_error', messageKey: 'error.store_error' },
        });
        expect(unreachable).not.toHaveBeenCalled();
      },
    );

    it.each([{ rows: [] }, 'rows', null])(
      'is store_error when the body is not a list of rows (%j)',
      async (body) => {
        answerWith = body;
        await expect(dispatcherFor()()).resolves.toMatchObject({
          ok: false,
          error: { code: 'store_error' },
        });
        expect(unreachable).not.toHaveBeenCalled();
      },
    );

    it('is store_error when the body is not JSON', async () => {
      answerRaw = '<html>Bad gateway</html>';
      await expect(dispatcherFor()()).resolves.toMatchObject({
        ok: false,
        error: { code: 'store_error' },
      });
      expect(unreachable).not.toHaveBeenCalled();
    });
  });
});
