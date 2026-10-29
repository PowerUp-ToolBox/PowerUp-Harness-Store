/**
 * Ticket P0-09.4: `store.publisher` through the Runtime's IPC handlers, against a fake Store on a
 * real HTTP port that answers api.md's Publisher page read as PostgREST does under row-level
 * security: a profile's nested `harnesses` are only its active Harnesses with a published
 * version, most downloaded first, and their embedded `harness_versions` the published versions.
 * The seed: `alice` with one active Harness, one Unpublished-only and one taken down (the hidden
 * two with the most downloads, so only the Store's visibility keeps them out), `bob` with another
 * active Harness, and `carol`, whose only Harness is taken down.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import type { Services } from '../../src/main/runtime/services.js';
import { createStoreCatalogue } from '../../src/main/runtime/store-catalogue.js';
import type { IpcResult, StorePublisherPage } from '../../src/shared/ipc.js';
import { REFUSED_PORT } from '../support/refused-port.js';

const ANON_KEY = 'fake-anon-key';
const MAIN_WINDOW = {};

/** api.md `<list columns>`, word for word. */
const LIST_COLUMNS =
  'harness_id,name,summary,icon_path,tags,download_count,latest_version,latest_published_at,harness_versions(version,platforms)';

/** api.md's Publisher page read, word for word (as the fake Store receives it, decoded). */
const publisherRead = (login: string) =>
  `/rest/v1/profiles?github_login=eq.${login}` +
  `&select=github_login,display_name,avatar_url,bio,created_at,harnesses(${LIST_COLUMNS})` +
  '&harnesses.order=download_count.desc,harness_id';

interface StoredVersion {
  version: string;
  status: 'published' | 'unpublished' | 'taken_down';
  platforms: string[];
  published_at: string;
}

interface StoredHarness {
  harness_id: string;
  status: 'active' | 'taken_down';
  name: string;
  download_count: number;
  versions: StoredVersion[];
}

interface StoredProfile {
  github_login: string;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  created_at: string;
}

let server: Server;
let baseUrl: string;
let profiles: StoredProfile[];
let harnesses: StoredHarness[];
let requests: { method: string; url: URL; apikey: string | undefined; authorization?: string }[];
let failWith: number | null;
let answerWith: unknown;
let unreachable: ReturnType<typeof vi.fn<() => void>>;

const published = (version: string, published_at: string, platforms = ['darwin-arm64']) => ({
  version,
  status: 'published' as const,
  platforms,
  published_at,
});

beforeEach(async () => {
  requests = [];
  failWith = null;
  answerWith = undefined;
  unreachable = vi.fn<() => void>();
  profiles = [
    {
      github_login: 'alice',
      display_name: 'Alice Liddell',
      avatar_url: 'https://avatars.githubusercontent.com/u/1',
      bio: 'Writes tools for writers.',
      created_at: '2026-03-14T09:00:00.000000+00:00',
    },
    {
      github_login: 'bob',
      display_name: null,
      avatar_url: null,
      bio: null,
      created_at: '2026-04-01T09:00:00.000000+00:00',
    },
    {
      github_login: 'carol',
      display_name: 'Carol',
      avatar_url: null,
      bio: null,
      created_at: '2026-05-01T09:00:00.000000+00:00',
    },
  ];
  harnesses = [
    {
      harness_id: 'alice/writer',
      status: 'active',
      name: 'Writer',
      download_count: 120,
      // An older version declared other platforms: the card shows the latest one's.
      versions: [
        published('1.0.0', '2026-10-01T09:00:00Z', ['linux-x64']),
        published('1.1.0', '2026-10-10T09:00:00Z', ['darwin-arm64', 'win32-x64']),
        { ...published('1.2.0', '2026-10-20T09:00:00Z'), status: 'unpublished' },
      ],
    },
    {
      harness_id: 'alice/retired',
      status: 'active',
      name: 'Retired',
      download_count: 9000,
      versions: [{ ...published('1.0.0', '2026-09-01T09:00:00Z'), status: 'unpublished' }],
    },
    {
      harness_id: 'alice/bad-tool',
      status: 'taken_down',
      name: 'Bad Tool',
      download_count: 50_000,
      versions: [{ ...published('1.0.0', '2026-09-01T09:00:00Z'), status: 'taken_down' }],
    },
    {
      harness_id: 'bob/xiezuo',
      status: 'active',
      name: '写作助手',
      download_count: 7,
      versions: [published('0.1.0', '2026-10-05T09:00:00Z')],
    },
    {
      harness_id: 'carol/gone',
      status: 'taken_down',
      name: 'Gone',
      download_count: 3,
      versions: [{ ...published('1.0.0', '2026-09-01T09:00:00Z'), status: 'taken_down' }],
    },
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

/** The latest published version of a Harness; null for none. */
function latestOf(stored: StoredHarness): StoredVersion | null {
  return (
    stored.versions
      .filter((version) => version.status === 'published')
      .sort((a, b) => (a.published_at < b.published_at ? 1 : -1))[0] ?? null
  );
}

/** The fake Store: GET `profiles` by login with nested `harnesses`, under RLS. */
function serve(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://store.test');
  requests.push({
    method: request.method ?? '',
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
  if (request.method !== 'GET' || url.pathname !== '/rest/v1/profiles') {
    json(404, { message: 'Not here.' });
    return;
  }
  const login = (url.searchParams.get('github_login') ?? '').replace(/^eq\./, '');
  json(
    200,
    profiles
      .filter((profile) => profile.github_login === login)
      .map((profile) => ({
        ...profile,
        harnesses: harnesses
          // Row-level security: active, with a published version.
          .filter(
            (row) =>
              row.harness_id.startsWith(`${login}/`) &&
              row.status === 'active' &&
              latestOf(row) !== null,
          )
          .sort(
            (a, b) => b.download_count - a.download_count || (a.harness_id < b.harness_id ? -1 : 1),
          )
          .map((row) => ({
            harness_id: row.harness_id,
            name: row.name,
            summary: `The ${row.name} Harness.`,
            icon_path: `${row.harness_id}/icon.png`,
            tags: ['writing'],
            download_count: row.download_count,
            latest_version: latestOf(row)?.version ?? null,
            latest_published_at: latestOf(row)?.published_at ?? null,
            harness_versions: row.versions
              .filter((version) => version.status === 'published')
              .map(({ version, platforms }) => ({ version, platforms })),
          })),
      })),
  );
}

function dispatcherFor(storeBaseUrl = () => baseUrl) {
  const store = createStoreCatalogue({
    fetch: (url, init) => globalThis.fetch(url, init),
    storeBaseUrl,
    anonKey: ANON_KEY,
    platform: 'darwin-arm64',
    onStoreUnreachable: unreachable,
    readTimeoutMs: 1000,
  });
  const dispatch = createDispatcher({
    handlers: createHandlers({ store } as unknown as Services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
    onHandlerError: (method, error) => {
      throw new Error(`${method} threw`, { cause: error });
    },
  });
  return (login: string) =>
    dispatch(MAIN_WINDOW, { method: 'store.publisher', input: login }) as Promise<
      IpcResult<StorePublisherPage>
    >;
}

async function pageOf(login: string) {
  const result = await dispatcherFor()(login);
  if (!result.ok) throw new Error(`store.publisher failed: ${result.error.code}`);
  return result.data;
}

describe('store.publisher', () => {
  it('lists only the active Harness of a Publisher with Unpublished-only and taken-down ones', async () => {
    const page = await pageOf('alice');
    expect(page).toEqual({
      platform: 'darwin-arm64',
      publisher: {
        login: 'alice',
        displayName: 'Alice Liddell',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1',
        bio: 'Writes tools for writers.',
        joinedAt: '2026-03-14T09:00:00.000000+00:00',
        harnesses: [
          {
            harnessId: 'alice/writer',
            publisher: 'alice',
            name: 'Writer',
            summary: 'The Writer Harness.',
            iconUrl: 'store-asset://harness-assets/alice/writer/icon.png',
            tags: ['writing'],
            downloadCount: 120,
            latestVersion: '1.1.0',
            latestPublishedAt: '2026-10-10T09:00:00Z',
            platforms: ['darwin-arm64', 'win32-x64'],
          },
        ],
      },
    });
  });

  it('reads the Store anonymously with api.md’s Publisher page read, once, and keeps nothing', async () => {
    const publisher = dispatcherFor();
    await publisher('alice');
    await publisher('alice');
    expect(
      requests.map(({ url }) => `${url.pathname}?${decodeURIComponent(url.search.slice(1))}`),
    ).toEqual([publisherRead('alice'), publisherRead('alice')]);
    for (const request of requests) {
      expect(request.method).toBe('GET');
      expect(request.apikey).toBe(ANON_KEY);
      expect(request.authorization).toBe(`Bearer ${ANON_KEY}`);
    }
  });

  it('has no Harnesses for a Publisher whose Harnesses are all hidden', async () => {
    expect((await pageOf('carol')).publisher).toMatchObject({
      login: 'carol',
      displayName: 'Carol',
      harnesses: [],
    });
  });

  it('names a Publisher without a display name, avatar or bio with nulls', async () => {
    expect((await pageOf('bob')).publisher).toMatchObject({
      login: 'bob',
      displayName: null,
      avatarUrl: null,
      bio: null,
      harnesses: [{ harnessId: 'bob/xiezuo', name: '写作助手' }],
    });
  });

  it('answers no Publisher for a login with no profile', async () => {
    await expect(pageOf('nobody')).resolves.toEqual({ platform: 'darwin-arm64', publisher: null });
  });

  it('keeps only an https avatar and a bio with text', async () => {
    answerWith = [
      {
        github_login: 'alice',
        display_name: ' ',
        avatar_url: 'javascript:alert(1)',
        bio: '  ',
        created_at: 7,
        harnesses: 'none',
      },
    ];
    expect((await pageOf('alice')).publisher).toEqual({
      login: 'alice',
      displayName: null,
      avatarUrl: null,
      bio: null,
      joinedAt: null,
      harnesses: [],
    });
  });

  it.each(['https://example.com/me.png', 'https://avatars.githubusercontent.com.evil.test/u/1'])(
    'leaves out an avatar the CSP would block (%s), so the monogram shows',
    async (avatarUrl) => {
      const alice = profiles[0];
      if (alice === undefined) throw new Error('No seed');
      alice.avatar_url = avatarUrl;
      expect((await pageOf('alice')).publisher?.avatarUrl).toBeNull();
    },
  );

  it.each(['', 'not-a-date'])(
    'has no join date for a created_at that does not parse (%j), rather than one the page cannot format',
    async (createdAt) => {
      const alice = profiles[0];
      if (alice === undefined) throw new Error('No seed');
      alice.created_at = createdAt;
      expect((await pageOf('alice')).publisher).toMatchObject({
        login: 'alice',
        joinedAt: null,
      });
    },
  );

  describe('when it fails', () => {
    it('is store_unreachable when the Store does not answer, and has connectivity checked again', async () => {
      const result = await dispatcherFor(() => `http://127.0.0.1:${String(REFUSED_PORT)}`)('alice');
      expect(result).toMatchObject({ ok: false, error: { code: 'store_unreachable' } });
      expect(unreachable).toHaveBeenCalledOnce();
    });

    it.each([500, 503, 400])('is store_error when the Store answers %i', async (status) => {
      failWith = status;
      await expect(dispatcherFor()('alice')).resolves.toMatchObject({
        ok: false,
        error: { code: 'store_error' },
      });
      expect(unreachable).not.toHaveBeenCalled();
    });

    it.each([{ rows: [] }, [{ github_login: 'mallory', harnesses: [] }], ['alice']])(
      'is store_error when the body is not the profile asked for (%j)',
      async (body) => {
        answerWith = body;
        await expect(dispatcherFor()('alice')).resolves.toMatchObject({
          ok: false,
          error: { code: 'store_error' },
        });
      },
    );
  });
});
