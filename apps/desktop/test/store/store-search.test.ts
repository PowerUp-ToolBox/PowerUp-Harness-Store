/**
 * Ticket P0-09.2: `store.search` through the Runtime's IPC handlers, against a fake Store on a real
 * HTTP port that answers `POST rest/v1/rpc/search_harnesses` as the RPC does (api.md): rows of the
 * visible Harnesses whose name holds the text, with every tag and the platform asked for, most
 * downloaded first, `limit` and `offset` applied. The ranking itself is the Store's, proven by the
 * store seam (apps/store/test-store/search.test.ts); here the Runtime must pass the arguments,
 * keep the Store's order and map the rows to cards.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Platform } from '@harness-store/manifest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import type { Services } from '../../src/main/runtime/services.js';
import { createStoreCatalogue } from '../../src/main/runtime/store-catalogue.js';
import type { IpcResult, StoreSearchPage, StoreSearchRequest } from '../../src/shared/ipc.js';
import { REFUSED_PORT } from '../support/refused-port.js';

const ANON_KEY = 'fake-anon-key';
const MAIN_WINDOW = {};

/** A `search_harnesses` row, as the RPC answers it. */
interface SearchRow {
  harness_id: string;
  publisher_login: string;
  name: string;
  summary: string;
  icon_path: string | null;
  tags: string[];
  platforms: string[];
  download_count: number;
  latest_version: string;
  latest_published_at: string;
}

let server: Server;
let baseUrl: string;
let rows: SearchRow[];
/** Every request the fake Store got, with its JSON body. */
let requests: { method: string; url: URL; headers: IncomingMessage['headers']; body: unknown }[];
/** Answers every request with this status instead, when set. */
let failWith: number | null;
/** Answers every request with this JSON body instead, when set. */
let answerWith: unknown;
let unreachable: ReturnType<typeof vi.fn<() => void>>;

function row(harnessId: string, fields: Partial<SearchRow> = {}): SearchRow {
  return {
    harness_id: harnessId,
    publisher_login: harnessId.split('/')[0] ?? '',
    name: harnessId,
    summary: `The ${harnessId} Harness.`,
    icon_path: `${harnessId}/1.0.0/icon.png`,
    tags: ['coding'],
    platforms: ['darwin-arm64', 'linux-x64'],
    download_count: 0,
    latest_version: '1.0.0',
    latest_published_at: '2026-10-20T09:00:00.000000+00:00',
    ...fields,
  };
}

beforeEach(async () => {
  requests = [];
  failWith = null;
  answerWith = undefined;
  unreachable = vi.fn<() => void>();
  rows = [
    row('alice/notes', { name: 'Notes Writer', tags: ['writing', 'research'], download_count: 90 }),
    row('bob/xiezuo', { name: '写作助手', tags: ['writing'], download_count: 40 }),
    // Linux only: no darwin-arm64 build.
    row('carol/linux-notes', {
      name: 'Linux Notes',
      tags: ['writing'],
      platforms: ['linux-x64'],
      download_count: 500,
    }),
  ];
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

/** The fake Store: `search_harnesses` over {@link rows}. */
function serve(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const url = new URL(request.url ?? '/', 'http://store.test');
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>);
    requests.push({ method: request.method ?? '', url, headers: request.headers, body });
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
    if (request.method !== 'POST' || url.pathname !== '/rest/v1/rpc/search_harnesses') {
      json(404, { message: 'Not here.' });
      return;
    }
    const { q, tags, platform, limit, offset } = body as {
      q: string;
      tags: string[];
      platform: string | null;
      limit: number;
      offset: number;
    };
    const found = rows
      .filter((candidate) => q.trim() === '' || candidate.name.toLowerCase().includes(q.trim()))
      .filter((candidate) => tags.every((tag) => candidate.tags.includes(tag)))
      .filter((candidate) => platform === null || candidate.platforms.includes(platform))
      .sort((a, b) => b.download_count - a.download_count);
    json(200, found.slice(offset, offset + limit));
  });
}

function dispatcherFor(
  storeBaseUrl: () => string = () => baseUrl,
  platform: Platform | null = 'darwin-arm64',
) {
  const store = createStoreCatalogue({
    fetch: (url, init) => globalThis.fetch(url, init),
    storeBaseUrl,
    anonKey: ANON_KEY,
    platform,
    onStoreUnreachable: unreachable,
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
  return (input: unknown) =>
    dispatch(MAIN_WINDOW, { method: 'store.search', input }) as Promise<IpcResult<StoreSearchPage>>;
}

const SEARCH: StoreSearchRequest = { q: '', tags: [], allPlatforms: false, offset: 0 };

async function pageOf(
  search: (input: unknown) => Promise<IpcResult<StoreSearchPage>>,
  request: Partial<StoreSearchRequest>,
) {
  const result = await search({ ...SEARCH, ...request });
  if (!result.ok) throw new Error(`store.search failed: ${result.error.code}`);
  return result.data;
}

const ids = (page: StoreSearchPage) => page.listings.map((listing) => listing.harnessId);

describe('store.search', () => {
  it('calls search_harnesses anonymously with POST and api.md’s arguments, one page of 24', async () => {
    await pageOf(dispatcherFor(), { q: 'notes', tags: ['writing'], offset: 24 });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe('POST');
    expect(request?.url.pathname).toBe('/rest/v1/rpc/search_harnesses');
    expect(request?.url.search).toBe('');
    expect(request?.headers.apikey).toBe(ANON_KEY);
    expect(request?.headers.authorization).toBe(`Bearer ${ANON_KEY}`);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.body).toEqual({
      q: 'notes',
      tags: ['writing'],
      platform: 'darwin-arm64',
      limit: 24,
      offset: 24,
    });
  });

  it('keeps out a Harness not built for this machine, unless every platform is asked for', async () => {
    const search = dispatcherFor();
    const mine = await pageOf(search, { q: 'notes' });
    expect(ids(mine)).toEqual(['alice/notes']);
    expect(mine.platform).toBe('darwin-arm64');

    const all = await pageOf(search, { q: 'notes', allPlatforms: true });
    expect(requests[1]?.body).toMatchObject({ platform: null });
    // The Store's order, never re-sorted: the Linux-only one has the most downloads.
    expect(ids(all)).toEqual(['carol/linux-notes', 'alice/notes']);
    // The card has the platforms it declares; the renderer greys this machine's badge.
    expect(all.listings[0]?.platforms).toEqual(['linux-x64']);
    expect(all.platform).toBe('darwin-arm64');
  });

  it('narrows by text and every tag at once', async () => {
    const search = dispatcherFor();
    expect(ids(await pageOf(search, { tags: ['writing'], allPlatforms: true }))).toEqual([
      'carol/linux-notes',
      'alice/notes',
      'bob/xiezuo',
    ]);
    expect(ids(await pageOf(search, { tags: ['writing', 'research'] }))).toEqual(['alice/notes']);
    expect(ids(await pageOf(search, { q: '写作' }))).toEqual(['bob/xiezuo']);
    expect(ids(await pageOf(search, { q: 'nothing like it' }))).toEqual([]);
  });

  it('gives each result what its card shows', async () => {
    const page = await pageOf(dispatcherFor(), { q: '写作' });
    expect(page.listings).toEqual([
      {
        harnessId: 'bob/xiezuo',
        publisher: 'bob',
        name: '写作助手',
        summary: 'The bob/xiezuo Harness.',
        iconUrl: 'store-asset://harness-assets/bob/xiezuo/1.0.0/icon.png',
        tags: ['writing'],
        downloadCount: 40,
        latestVersion: '1.0.0',
        latestPublishedAt: '2026-10-20T09:00:00.000000+00:00',
        platforms: ['darwin-arm64', 'linux-x64'],
      },
    ]);
    expect(page.hasMore).toBe(false);
  });

  it('says a full page of 24 may have more, and pages on with the offset', async () => {
    rows = Array.from({ length: 30 }, (_, index) =>
      row(`dave/tool-${String(index).padStart(2, '0')}`, { download_count: 100 - index }),
    );
    const search = dispatcherFor();
    const first = await pageOf(search, {});
    expect(first.listings).toHaveLength(24);
    expect(first.hasMore).toBe(true);
    const second = await pageOf(search, { offset: 24 });
    expect(ids(second)).toEqual(rows.slice(24).map((stored) => stored.harness_id));
    expect(second.hasMore).toBe(false);
  });

  it('skips a row that is not a listing, and counts it for the page', async () => {
    answerWith = [
      ...Array.from({ length: 23 }, (_, index) => row(`erin/tool-${String(index)}`)),
      { name: 'No ID' },
    ];
    const page = await pageOf(dispatcherFor(), {});
    expect(page.listings).toHaveLength(23);
    expect(page.hasMore).toBe(true);
  });

  it('searches every platform on a machine no Manifest can declare', async () => {
    const page = await pageOf(dispatcherFor(undefined, null), { q: 'notes' });
    expect(requests[0]?.body).toMatchObject({ platform: null });
    expect(page.platform).toBeNull();
    expect(ids(page)).toEqual(['carol/linux-notes', 'alice/notes']);
  });

  it('is never kept in memory', async () => {
    const search = dispatcherFor();
    await pageOf(search, { q: 'notes' });
    await pageOf(search, { q: 'notes' });
    expect(requests).toHaveLength(2);
  });

  describe('when it fails', () => {
    it('is store_unreachable when the Store does not answer, and has connectivity checked again', async () => {
      const result = await dispatcherFor(() => `http://127.0.0.1:${String(REFUSED_PORT)}`)(SEARCH);
      expect(result).toMatchObject({ ok: false, error: { code: 'store_unreachable' } });
      expect(unreachable).toHaveBeenCalledOnce();
    });

    it.each([500, 400])('is store_error when the Store answers %i', async (status) => {
      failWith = status;
      await expect(dispatcherFor()(SEARCH)).resolves.toMatchObject({
        ok: false,
        error: { code: 'store_error' },
      });
      expect(unreachable).not.toHaveBeenCalled();
    });

    it('is store_error when the body is not a list of rows', async () => {
      answerWith = { rows: [] };
      await expect(dispatcherFor()(SEARCH)).resolves.toMatchObject({
        ok: false,
        error: { code: 'store_error' },
      });
    });
  });
});
