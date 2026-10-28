/**
 * Ticket P0-09.3: `store.detail` through the Runtime's IPC handlers, against a fake Store on a real
 * HTTP port that answers api.md's Harness detail read, its "Version manifest" read and
 * `latest_versions` as PostgREST does under row-level security: a Harness is a row only while it
 * is active with a published version, and its embedded `harness_versions` are its published
 * versions only, in the order asked for. The seed: `alice/writer` with three published versions
 * (their permissions changed once) and an Unpublished one, a taken-down Harness and an
 * Unpublished-only one.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import type { Services } from '../../src/main/runtime/services.js';
import { createStoreCatalogue } from '../../src/main/runtime/store-catalogue.js';
import type { IpcResult, StoreDetail } from '../../src/shared/ipc.js';
import { REFUSED_PORT } from '../support/refused-port.js';

const ANON_KEY = 'fake-anon-key';
const MAIN_WINDOW = {};
const WRITER_UUID = '0b5f7a52-3c39-4a55-9d39-0b0b6d1e2f10';

/** api.md's detail read, decoded, without the Harness ID. */
const DETAIL_SELECT =
  'select=id,harness_id,name,summary,icon_path,tags,download_count,latest_version,latest_published_at,status,' +
  'profiles(github_login,display_name,avatar_url),' +
  'harness_versions(version,changelog,published_at,platforms,status,download_count,permissions)' +
  '&harness_versions.order=published_at.desc';

const NO_ACCESS = { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } };
const WITH_SHELL = { filesystem: { scope: 'workspace' }, shell: true, network: { domains: [] } };

/** The full Manifest the Store keeps for a version of `alice/writer`. */
function writerManifest(version: string, permissions: unknown) {
  return {
    manifestVersion: 1,
    id: 'alice/writer',
    version,
    name: 'Writer',
    summary: 'Drafts and edits long texts.',
    tags: ['writing'],
    license: 'MIT',
    homepage: 'https://writer.example.com',
    platforms: ['darwin-arm64', 'linux-x64'],
    runtime: { kind: 'node', node: '22' },
    entry: 'dist/index.js',
    ui: { kind: 'web' },
    workspace: 'required',
    models: { slots: { default: { recommended: ['ollama/qwen3:8b'] } } },
    permissions,
    changelog: `Changes in ${version}.`,
  };
}

interface StoredVersion {
  version: string;
  status: 'published' | 'unpublished' | 'taken_down';
  published_at: string;
  changelog: string | null;
  permissions: unknown;
  manifest: unknown;
  readme: string;
  screenshot_paths: string[];
}

interface StoredHarness {
  id: string;
  harness_id: string;
  status: 'active' | 'taken_down';
  icon_path: string | null;
  download_count: number;
  versions: StoredVersion[];
}

let server: Server;
let baseUrl: string;
let harnesses: StoredHarness[];
let requests: { method: string; url: URL; body: string; apikey: string | undefined }[];
let failWith: number | null;
let avatarUrl: string;
let unreachable: ReturnType<typeof vi.fn<() => void>>;

const day = (n: number) => `2026-10-${String(n).padStart(2, '0')}T09:00:00.000000+00:00`;

function writerVersion(
  version: string,
  publishedDay: number,
  permissions: unknown,
  status: StoredVersion['status'] = 'published',
): StoredVersion {
  return {
    version,
    status,
    published_at: day(publishedDay),
    changelog: `Changes in ${version}.`,
    permissions,
    manifest: writerManifest(version, permissions),
    readme: `# Writer ${version}\n\nIt writes.`,
    screenshot_paths: [
      `alice/writer/${version}/screenshots/1.png`,
      // A path that would leave the bucket is never shown.
      'alice/../../etc/passwd',
      `alice/writer/${version}/screenshots/2.png`,
    ],
  };
}

function seed(): StoredHarness[] {
  return [
    {
      id: WRITER_UUID,
      harness_id: 'alice/writer',
      status: 'active',
      icon_path: 'alice/writer/1.2.0/icon.png',
      download_count: 1260,
      // Stored out of order: only the read's order may sort them.
      versions: [
        writerVersion('1.1.0', 10, WITH_SHELL),
        writerVersion('1.0.0', 1, NO_ACCESS),
        writerVersion('1.2.0', 20, { ...WITH_SHELL }),
        writerVersion('1.3.0', 25, NO_ACCESS, 'unpublished'),
      ],
    },
    {
      id: 'c0ffee00-0000-4000-8000-000000000001',
      harness_id: 'carol/taken-down',
      status: 'taken_down',
      icon_path: null,
      download_count: 5,
      versions: [{ ...writerVersion('1.0.0', 1, NO_ACCESS), status: 'taken_down' }],
    },
    {
      id: 'c0ffee00-0000-4000-8000-000000000002',
      harness_id: 'bob/retired',
      status: 'active',
      icon_path: null,
      download_count: 5,
      versions: [{ ...writerVersion('1.0.0', 1, NO_ACCESS), status: 'unpublished' }],
    },
  ];
}

beforeEach(async () => {
  requests = [];
  failWith = null;
  avatarUrl = 'https://avatars.githubusercontent.com/u/1';
  unreachable = vi.fn<() => void>();
  harnesses = seed();
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      serve(request, body, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const published = (stored: StoredHarness) =>
  stored.versions.filter((version) => version.status === 'published');

/** The latest published version, as `refresh_harness` keeps it. */
const latestOf = (stored: StoredHarness) =>
  [...published(stored)].sort((a, b) => (a.published_at < b.published_at ? 1 : -1))[0];

/** Visible to anon: active, with a published version. */
const visible = (stored: StoredHarness) =>
  stored.status === 'active' && latestOf(stored) !== undefined;

function serve(request: IncomingMessage, body: string, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://store.test');
  requests.push({
    method: request.method ?? '',
    url,
    body,
    apikey: request.headers.apikey as string | undefined,
  });
  const json = (status: number, answer: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(answer));
  };
  if (failWith !== null) {
    json(failWith, { message: 'Down.' });
    return;
  }
  const params = url.searchParams;
  if (request.method === 'GET' && url.pathname === '/rest/v1/harnesses') {
    const id = params.get('harness_id')?.replace(/^eq\./, '');
    const rows = harnesses.filter((row) => row.harness_id === id && visible(row));
    const descending = params.get('harness_versions.order') === 'published_at.desc';
    json(
      200,
      rows.map((row) => {
        const latest = latestOf(row);
        const versions = [...published(row)].sort(
          (a, b) => (a.published_at < b.published_at ? 1 : -1) * (descending ? 1 : -1),
        );
        return {
          id: row.id,
          harness_id: row.harness_id,
          name: 'Writer',
          summary: 'Drafts and edits long texts.',
          icon_path: row.icon_path,
          tags: ['writing'],
          download_count: row.download_count,
          latest_version: latest?.version,
          latest_published_at: latest?.published_at,
          status: row.status,
          profiles: {
            github_login: 'alice',
            display_name: 'Alice Liddell',
            avatar_url: avatarUrl,
          },
          harness_versions: versions.map((version) => ({
            version: version.version,
            changelog: version.changelog,
            published_at: version.published_at,
            platforms: ['darwin-arm64', 'linux-x64'],
            status: version.status,
            download_count: 1,
            permissions: version.permissions,
          })),
        };
      }),
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/rest/v1/harness_versions') {
    const uuid = params.get('harness_id')?.replace(/^eq\./, '');
    const version = params.get('version')?.replace(/^eq\./, '');
    const harness = harnesses.find((row) => row.id === uuid);
    const rows =
      harness === undefined || !visible(harness)
        ? []
        : published(harness).filter((row) => row.version === version);
    json(
      200,
      rows.map(({ manifest, readme, screenshot_paths }) => ({
        manifest,
        readme,
        screenshot_paths,
      })),
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/rest/v1/rpc/latest_versions') {
    const { harness_ids: ids } = JSON.parse(body) as { harness_ids: string[] };
    json(
      200,
      ids.map((id) => {
        const harness = harnesses.find((row) => row.harness_id === id);
        const status =
          harness === undefined
            ? 'not_found'
            : harness.status === 'taken_down'
              ? 'taken_down'
              : latestOf(harness) === undefined
                ? 'unpublished'
                : 'available';
        return { harness_id: id, store_status: status };
      }),
    );
    return;
  }
  json(404, { message: 'Not here.' });
}

function dispatcherFor(storeBaseUrl: () => string = () => baseUrl) {
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
  return (input: unknown) =>
    dispatch(MAIN_WINDOW, { method: 'store.detail', input }) as Promise<IpcResult<StoreDetail>>;
}

async function detailOf(harnessId: string): Promise<StoreDetail> {
  const result = await dispatcherFor()(harnessId);
  if (!result.ok) throw new Error(`store.detail failed: ${result.error.code}`);
  return result.data;
}

/** A request as the fake Store got it, decoded. */
const decoded = ({ url }: { url: URL }) =>
  `${url.pathname}?${decodeURIComponent(url.search.slice(1))}`;

describe('store.detail', () => {
  it('lists the published versions only, newest first, each with its changelog', async () => {
    const detail = await detailOf('alice/writer');
    expect(detail.storeStatus).toBe('available');
    expect(detail.harness?.versions).toEqual([
      {
        version: '1.2.0',
        publishedAt: day(20),
        changelog: 'Changes in 1.2.0.',
        permissionsChanged: false,
      },
      {
        version: '1.1.0',
        publishedAt: day(10),
        changelog: 'Changes in 1.1.0.',
        permissionsChanged: true,
      },
      {
        version: '1.0.0',
        publishedAt: day(1),
        changelog: 'Changes in 1.0.0.',
        permissionsChanged: false,
      },
    ]);
  });

  it('gives the page the latest version’s Manifest, README, screenshots, and the Publisher', async () => {
    const detail = await detailOf('alice/writer');
    expect(detail.platform).toBe('darwin-arm64');
    expect(detail.harness).toMatchObject({
      harnessId: 'alice/writer',
      publisher: {
        login: 'alice',
        displayName: 'Alice Liddell',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1',
      },
      iconUrl: 'store-asset://harness-assets/alice/writer/1.2.0/icon.png',
      downloadCount: 1260,
      readme: '# Writer 1.2.0\n\nIt writes.',
      screenshotUrls: [
        'store-asset://harness-assets/alice/writer/1.2.0/screenshots/1.png',
        'store-asset://harness-assets/alice/writer/1.2.0/screenshots/2.png',
      ],
    });
    expect(detail.harness?.manifest).toEqual(writerManifest('1.2.0', WITH_SHELL));
  });

  it('leaves out a version whose publish date does not parse', async () => {
    const writer = harnesses[0];
    const middle = writer?.versions.find((version) => version.version === '1.1.0');
    if (middle === undefined) throw new Error('No 1.1.0');
    middle.published_at = 'not-a-date';
    const detail = await detailOf('alice/writer');
    expect(detail.harness?.versions.map(({ version }) => version)).toEqual(['1.2.0', '1.0.0']);
  });

  it('leaves out a Publisher avatar off GitHub’s avatar host, which the CSP would block', async () => {
    avatarUrl = 'https://example.com/me.png';
    expect((await detailOf('alice/writer')).harness?.publisher.avatarUrl).toBeNull();
  });

  it('makes api.md’s detail read, then the Version manifest read of the latest version, anonymously', async () => {
    await detailOf('alice/writer');
    expect(requests.map(decoded)).toEqual([
      `/rest/v1/harnesses?harness_id=eq.alice/writer&${DETAIL_SELECT}`,
      `/rest/v1/harness_versions?harness_id=eq.${WRITER_UUID}&version=eq.1.2.0&select=manifest,readme,screenshot_paths`,
    ]);
    for (const request of requests) expect(request.apikey).toBe(ANON_KEY);
  });

  it('reads the Store again each time: a detail page is never kept', async () => {
    const detail = dispatcherFor();
    await detail('alice/writer');
    await detail('alice/writer');
    expect(requests).toHaveLength(4);
  });

  it.each([
    ['carol/taken-down', 'taken_down'],
    ['bob/retired', 'unpublished'],
    ['dave/unknown', 'not_found'],
  ])('answers %s with its status from latest_versions and no page', async (harnessId, status) => {
    await expect(detailOf(harnessId)).resolves.toEqual({
      platform: 'darwin-arm64',
      storeStatus: status,
      harness: null,
    });
    expect(requests.map((request) => [request.method, decoded(request)])).toEqual([
      ['GET', `/rest/v1/harnesses?harness_id=eq.${harnessId}&${DETAIL_SELECT}`],
      ['POST', '/rest/v1/rpc/latest_versions?select=harness_id,store_status'],
    ]);
    expect(JSON.parse(requests[1]?.body ?? '')).toEqual({ harness_ids: [harnessId] });
  });

  it('answers store_error for a stored Manifest that does not validate', async () => {
    const writer = harnesses[0];
    if (writer === undefined) throw new Error('No seed');
    const latest = writer.versions.find((version) => version.version === '1.2.0');
    if (latest === undefined) throw new Error('No 1.2.0');
    latest.manifest = { ...writerManifest('1.2.0', WITH_SHELL), permissions: undefined };
    await expect(dispatcherFor()('alice/writer')).resolves.toMatchObject({
      ok: false,
      error: { code: 'store_error' },
    });
    expect(unreachable).not.toHaveBeenCalled();
  });

  it('answers store_error for a 5xx, and store_unreachable (connectivity checked) for no answer', async () => {
    failWith = 503;
    await expect(dispatcherFor()('alice/writer')).resolves.toMatchObject({
      ok: false,
      error: { code: 'store_error' },
    });
    expect(unreachable).not.toHaveBeenCalled();
    await expect(
      dispatcherFor(() => `http://127.0.0.1:${String(REFUSED_PORT)}`)('alice/writer'),
    ).resolves.toMatchObject({ ok: false, error: { code: 'store_unreachable' } });
    expect(unreachable).toHaveBeenCalledTimes(1);
  });
});
