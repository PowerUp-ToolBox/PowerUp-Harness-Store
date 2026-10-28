import { manifestSchema, type Platform, type Tag } from '@harness-store/manifest';
import {
  STORE_SEARCH_PAGE_SIZE,
  type IpcResult,
  type StoreHome,
  type StoreHomeRequest,
  type StoreListing,
  type StoreSearchPage,
  type StoreSearchRequest,
} from '../../shared/ipc.js';
import { fail, ok } from './ipc-result.js';
import { storeAssetUrl } from './store-assets.js';
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
  };
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
