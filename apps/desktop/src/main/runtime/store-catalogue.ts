import { manifestSchema, validateManifest, type Platform, type Tag } from '@harness-store/manifest';
import { isDeepStrictEqual } from 'node:util';
import {
  STORE_SEARCH_PAGE_SIZE,
  type HarnessStoreStatus,
  type IpcResult,
  type StoreDetail,
  type StoreHarness,
  type StoreHome,
  type StoreHomeRequest,
  type StoreListing,
  type StoreSearchPage,
  type StoreSearchRequest,
  type StoreVersion,
} from '../../shared/ipc.js';
import { fail, ok } from './ipc-result.js';
import { storeAssetUrl } from '../../shared/store-assets.js';
import type { StoreFetch } from './store-auth.js';

/** A Store read gives up after this long. */
const READ_TIMEOUT_MS = 15_000;

/** How long the Store home is kept in memory before it is read again. */
export const HOME_CACHE_MS = 5 * 60_000;

/**
 * api.md `<list columns>`: what a card shows, and the platforms of the Harness's published
 * versions, from which the latest one's are picked (no `search` vector).
 */
export const LIST_COLUMNS =
  'harness_id,name,summary,icon_path,tags,download_count,latest_version,latest_published_at,harness_versions(version,platforms)';

/** api.md's three home reads, in the order of {@link StoreHome}'s rows. */
const HOME_READS = {
  featured: `harnesses?featured_rank=not.is.null&order=featured_rank&limit=12&select=${LIST_COLUMNS}`,
  mostDownloaded: `harnesses?order=download_count.desc,harness_id&limit=12&select=${LIST_COLUMNS}`,
  newest: `harnesses?order=latest_published_at.desc,harness_id&limit=12&select=${LIST_COLUMNS}`,
} as const;

/**
 * api.md's Harness detail read, without the Harness ID: the list columns but the embedded
 * versions, the Harness's `id` (for the version read) and `status`, its Publisher, and every
 * published version with what the version history shows, newest first (no `search` vector).
 */
const DETAIL_COLUMNS =
  'id,harness_id,name,summary,icon_path,tags,download_count,latest_version,latest_published_at,status,' +
  'profiles(github_login,display_name,avatar_url),' +
  'harness_versions(version,changelog,published_at,platforms,status,download_count,permissions)';

/** How many screenshots a detail page shows, as the Store keeps at most that many. */
const MAX_SCREENSHOTS = 5;

const STORE_STATUSES: ReadonlySet<string> = new Set<HarnessStoreStatus>([
  'available',
  'unpublished',
  'taken_down',
  'not_found',
]);

const PLATFORMS: ReadonlySet<string> = new Set(
  (manifestSchema.$defs as { platform: { enum: readonly string[] } }).platform.enum,
);
const TAGS: ReadonlySet<string> = new Set(
  (manifestSchema.$defs as { tag: { enum: readonly string[] } }).tag.enum,
);

export interface StoreCatalogueOptions {
  /** Makes the Store calls (Electron's `net.fetch`). */
  readonly fetch: StoreFetch;
  /** The Store base URL, read on every request (the `store_base_url` setting). */
  readonly storeBaseUrl: () => string;
  /** The Store's anon key: every read is anonymous, whoever is signed in. */
  readonly anonKey: string;
  /** This machine's platform, as a Manifest names it; null when no Manifest can declare it. */
  readonly platform: Platform | null;
  /** Told when the Store did not answer at all, so connectivity is checked again. */
  readonly onStoreUnreachable?: () => void;
  /** The clock of the in-memory cache. Default: the system clock. */
  readonly now?: () => Date;
  /** How long a read, its body included, may take. Default: 15 seconds. */
  readonly readTimeoutMs?: number;
}

/** The Store's public catalogue as the Store tab reads it (P0-09). */
export interface StoreCatalogue {
  /** The Store home's rows (`store.home`). */
  home(request?: StoreHomeRequest): Promise<IpcResult<StoreHome>>;
  /** One page of a search (`store.search`). */
  search(request: StoreSearchRequest): Promise<IpcResult<StoreSearchPage>>;
  /** A Harness's detail page (`store.detail`). */
  detail(harnessId: string): Promise<IpcResult<StoreDetail>>;
}

/**
 * Reads the Store's catalogue anonymously, with api.md's PostgREST reads and the anon key alone,
 * so a signed-in Publisher sees exactly what every User sees. Row-level security decides what is
 * visible (active Harnesses with a published version); no read repeats that filter.
 *
 * A read the Store did not answer (a network error, the timeout) is `store_unreachable`, and
 * connectivity is checked again, so the Store tab shows the offline panel when the Store is in
 * fact unreachable; an answer that is not the rows asked for (a 5xx, another refusal, a body that
 * is not a list) is `store_error`.
 */
export function createStoreCatalogue(options: StoreCatalogueOptions): StoreCatalogue {
  const now = options.now ?? (() => new Date());
  const readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  /** The last Store home read, with when and from which Store. */
  let cachedHome: { baseUrl: string; at: number; home: StoreHome } | null = null;

  /** A PostgREST read: a GET of `path`, or with `body` a POST of it as JSON (an RPC). */
  const read = async (path: string, body?: unknown): Promise<IpcResult<unknown[]>> => {
    const base = options.storeBaseUrl().replace(/\/+$/, '');
    const headers: Record<string, string> = {
      apikey: options.anonKey,
      authorization: `Bearer ${options.anonKey}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    let text = '';
    try {
      // The timeout covers the body too: a Store that answers and then stalls did not answer.
      response = await options.fetch(`${base}/rest/v1/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(readTimeoutMs),
      });
      if (response.ok) text = await response.text();
    } catch {
      return fail('store_unreachable');
    }
    if (!response.ok) return fail('store_error');
    let rows: unknown;
    try {
      rows = JSON.parse(text);
    } catch {
      return fail('store_error');
    }
    return Array.isArray(rows) ? ok(rows) : fail('store_error');
  };

  /**
   * api.md's detail read, then the latest version's Manifest, README and screenshots ("Version
   * manifest"). A Harness the detail read does not show (taken down, Unpublished-only or unknown)
   * gets its status from `latest_versions` instead, and no page.
   */
  const readDetail = async (harnessId: string): Promise<IpcResult<StoreDetail>> => {
    const rows = await read(
      `harnesses?harness_id=eq.${encodeURIComponent(harnessId)}&select=${DETAIL_COLUMNS}` +
        '&harness_versions.order=published_at.desc',
    );
    if (!rows.ok) return rows;
    const row = rows.data[0];
    if (row === undefined) {
      const status = await read('rpc/latest_versions?select=harness_id,store_status', {
        harness_ids: [harnessId],
      });
      if (!status.ok) return status;
      const storeStatus = (status.data[0] as Record<string, unknown> | undefined)?.store_status;
      if (typeof storeStatus !== 'string' || !STORE_STATUSES.has(storeStatus)) {
        return fail('store_error');
      }
      return ok({
        platform: options.platform,
        // The detail read would have shown an available Harness: it went away in between.
        storeStatus:
          storeStatus === 'available' ? 'not_found' : (storeStatus as HarnessStoreStatus),
        harness: null,
      });
    }
    if (!isRecord(row) || typeof row.id !== 'string' || typeof row.latest_version !== 'string') {
      return fail('store_error');
    }
    const latest = await read(
      `harness_versions?harness_id=eq.${encodeURIComponent(row.id)}` +
        `&version=eq.${encodeURIComponent(row.latest_version)}` +
        '&select=manifest,readme,screenshot_paths',
    );
    if (!latest.ok) return latest;
    const harness = harnessOf(harnessId, row, latest.data[0]);
    return harness === null
      ? fail('store_error')
      : ok({ platform: options.platform, storeStatus: 'available', harness });
  };

  return {
    async home(request = {}) {
      const baseUrl = options.storeBaseUrl();
      const at = now().getTime();
      if (
        request.refresh !== true &&
        cachedHome !== null &&
        cachedHome.baseUrl === baseUrl &&
        at - cachedHome.at >= 0 &&
        at - cachedHome.at < HOME_CACHE_MS
      ) {
        return ok(cachedHome.home);
      }
      const [featured, mostDownloaded, newest] = await Promise.all([
        read(HOME_READS.featured),
        read(HOME_READS.mostDownloaded),
        read(HOME_READS.newest),
      ]);
      // The three rows fail together: a home with one row missing would look complete.
      for (const result of [featured, mostDownloaded, newest]) {
        if (result.ok) continue;
        if (result.error.code === 'store_unreachable') options.onStoreUnreachable?.();
        return result;
      }
      const rows = (result: IpcResult<unknown[]>): readonly StoreListing[] =>
        result.ok ? listingsOf(result.data) : [];
      const home: StoreHome = {
        platform: options.platform,
        featured: rows(featured),
        mostDownloaded: rows(mostDownloaded),
        newest: rows(newest),
      };
      cachedHome = { baseUrl, at, home };
      return ok(home);
    },

    async search(request) {
      // POST: in a GET, PostgREST would take `limit` and `offset` as its own paging (api.md).
      const result = await read('rpc/search_harnesses', {
        q: request.q,
        tags: request.tags,
        platform: request.allPlatforms ? null : options.platform,
        limit: STORE_SEARCH_PAGE_SIZE,
        offset: request.offset,
      });
      if (!result.ok) {
        if (result.error.code === 'store_unreachable') options.onStoreUnreachable?.();
        return result;
      }
      return ok({
        platform: options.platform,
        listings: searchListingsOf(result.data),
        // Counted before a malformed row is skipped: a full page from the Store may have a next.
        hasMore: result.data.length >= STORE_SEARCH_PAGE_SIZE,
      });
    },

    async detail(harnessId) {
      const answer = await readDetail(harnessId);
      if (!answer.ok && answer.error.code === 'store_unreachable') options.onStoreUnreachable?.();
      return answer;
    },
  };
}

/**
 * The detail page of the detail read's `row` and its latest version's `latest` row, or null when
 * either is not what api.md says it is: another Harness, a Manifest that does not validate, or not
 * the latest version's.
 */
function harnessOf(
  harnessId: string,
  row: Record<string, unknown>,
  latest: unknown,
): StoreHarness | null {
  if (row.harness_id !== harnessId || !isRecord(latest)) return null;
  const validation = validateManifest(latest.manifest);
  if (!validation.ok) return null;
  const { manifest } = validation;
  if (manifest.id !== harnessId || manifest.version !== row.latest_version) return null;
  const profile = isRecord(row.profiles) ? row.profiles : {};
  const login = harnessId.slice(0, harnessId.indexOf('/'));
  const screenshots = Array.isArray(latest.screenshot_paths) ? latest.screenshot_paths : [];
  return {
    harnessId,
    publisher: {
      login,
      displayName: typeof profile.display_name === 'string' ? profile.display_name : null,
      avatarUrl: isHttpsUrl(profile.avatar_url) ? profile.avatar_url : null,
    },
    iconUrl: typeof row.icon_path === 'string' ? storeAssetUrl(row.icon_path) : null,
    downloadCount: typeof row.download_count === 'number' ? row.download_count : 0,
    manifest,
    readme: typeof latest.readme === 'string' && latest.readme.trim() !== '' ? latest.readme : null,
    screenshotUrls: screenshots
      .map((path) => (typeof path === 'string' ? storeAssetUrl(path) : null))
      .filter((url) => url !== null)
      .slice(0, MAX_SCREENSHOTS),
    versions: versionsOf(row.harness_versions),
  };
}

/**
 * The version history: the published versions, newest first as the read orders them, each marked
 * when its Declared Permissions are not those of the next older one. A row that is not a version
 * is skipped.
 */
function versionsOf(rows: unknown): StoreVersion[] {
  const published = (Array.isArray(rows) ? rows : []).filter(
    (row): row is Record<string, unknown> =>
      isRecord(row) &&
      typeof row.version === 'string' &&
      typeof row.published_at === 'string' &&
      // Row-level security shows anon the published ones only.
      row.status === 'published',
  );
  return published.map((row, index) => {
    const older = published[index + 1];
    return {
      version: row.version as string,
      publishedAt: row.published_at as string,
      changelog: typeof row.changelog === 'string' && row.changelog !== '' ? row.changelog : null,
      permissionsChanged:
        older !== undefined && !isDeepStrictEqual(row.permissions, older.permissions),
    };
  });
}

/** An absolute https URL, such as a GitHub avatar. */
function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The cards of a list read's rows; a row that is not one (no ID, name or version) is skipped. */
export function listingsOf(rows: readonly unknown[]): readonly StoreListing[] {
  return rows.map(listingOf).filter((listing) => listing !== null);
}

/**
 * The cards of `search_harnesses` rows, which carry the latest version's `platforms` themselves
 * instead of embedding `harness_versions`; otherwise they are list rows.
 */
export function searchListingsOf(rows: readonly unknown[]): readonly StoreListing[] {
  return listingsOf(
    rows.map((row) =>
      isRecord(row)
        ? { ...row, harness_versions: [{ version: row.latest_version, platforms: row.platforms }] }
        : row,
    ),
  );
}

/** One row of `<list columns>` as a card shows it, or null when it is not such a row. */
function listingOf(row: unknown): StoreListing | null {
  if (!isRecord(row)) return null;
  const {
    harness_id: harnessId,
    name,
    summary,
    icon_path: iconPath,
    latest_version: latestVersion,
  } = row;
  if (typeof harnessId !== 'string' || !harnessId.includes('/')) return null;
  if (typeof name !== 'string' || typeof latestVersion !== 'string') return null;
  const latest = Array.isArray(row.harness_versions)
    ? row.harness_versions.find(
        (version): version is Record<string, unknown> =>
          isRecord(version) && version.version === latestVersion,
      )
    : undefined;
  return {
    harnessId,
    publisher: harnessId.slice(0, harnessId.indexOf('/')),
    name,
    summary: typeof summary === 'string' ? summary : '',
    iconUrl: typeof iconPath === 'string' ? storeAssetUrl(iconPath) : null,
    tags: stringsIn(row.tags, TAGS) as Tag[],
    downloadCount: typeof row.download_count === 'number' ? row.download_count : 0,
    latestVersion,
    latestPublishedAt: typeof row.latest_published_at === 'string' ? row.latest_published_at : '',
    platforms: stringsIn(latest?.platforms, PLATFORMS) as Platform[],
  };
}

/** The strings of `value` that `known` holds, in order; none when it is not a list. */
function stringsIn(value: unknown, known: ReadonlySet<string>): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && known.has(item))
    : [];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
