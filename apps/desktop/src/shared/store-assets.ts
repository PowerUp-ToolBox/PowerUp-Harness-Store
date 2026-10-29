/**
 * The Store's images (icons, screenshots) in the main window. They live in the public
 * `harness-assets` bucket, on the Store's origin, which the renderer's Content Security Policy
 * does not allow, and which changes with the `store_base_url` setting. So the Runtime hands the
 * renderer `store-asset://harness-assets/<path>` URLs, and src/main/index.ts serves that scheme by
 * fetching `<store_base_url>/storage/v1/object/public/harness-assets/<path>`, and nothing else:
 * no other bucket, no other host, no path that leaves the bucket.
 */

/** The scheme of the Store's images; `img-src` in src/renderer/index.html allows it. */
export const STORE_ASSET_SCHEME = 'store-asset';

/** The only host of a `store-asset:` URL: the bucket. */
const BUCKET = 'harness-assets';

/**
 * The `store-asset:` URL of a path in the `harness-assets` bucket (as the Store's `icon_path` and
 * `screenshot_paths` hold it), or null for a path that could leave the bucket or is empty.
 */
export function storeAssetUrl(path: string): string | null {
  const segments = path.split('/');
  if (!segments.every(isPlainSegment)) return null;
  return `${STORE_ASSET_SCHEME}://${BUCKET}/${segments.map(encodeURIComponent).join('/')}`;
}

/** The path of the bucket's public objects on a Store, after its origin. */
const PUBLIC_BUCKET_PATH = `/storage/v1/object/public/${BUCKET}/`;

/**
 * The `store-asset:` URL of an image a README names in the `harness-assets` bucket: a
 * `store-asset:` URL itself, or the bucket's public URL on any http(s) origin, which only names
 * the path (the image is always fetched from the Store at `store_base_url`, never from that
 * origin). Null for any other URL, and for one with a query, fragment, credentials or a path that
 * could leave the bucket.
 */
export function storeAssetUrlOf(url: string): string | null {
  if (url.startsWith(`${STORE_ASSET_SCHEME}:`)) {
    return storeAssetSource(url, 'https://store.invalid') === null ? null : url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  if (!parsed.pathname.startsWith(PUBLIC_BUCKET_PATH)) return null;
  // `new URL` resolves dot segments: a path it changed had some, and is refused.
  const raw = /^[^:]+:\/\/[^/?#]*([^?#]*)/.exec(url)?.[1];
  if (raw !== parsed.pathname) return null;
  const segments = parsed.pathname.slice(PUBLIC_BUCKET_PATH.length).split('/').map(decodeSegment);
  if (!segments.every((segment) => segment !== null)) return null;
  return storeAssetUrl(segments.join('/'));
}

/**
 * Where a `store-asset:` URL's image is fetched from: the bucket's public URL on the Store at
 * `storeBaseUrl`. Null for anything else: another scheme or host, a query or fragment, a path
 * with an empty, `.` or `..` segment (encoded or not) or a backslash.
 */
export function storeAssetSource(url: string, storeBaseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${STORE_ASSET_SCHEME}:` || parsed.host !== BUCKET) return null;
  if (parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;
  // `new URL` resolves dot segments: a path it changed had some, and is refused.
  const raw = /^[^:]+:\/\/[^/?#]*([^?#]*)/.exec(url)?.[1];
  if (raw !== parsed.pathname) return null;
  const segments = parsed.pathname.slice(1).split('/').map(decodeSegment);
  if (!segments.every((segment) => segment !== null && isPlainSegment(segment))) return null;
  const base = storeBaseUrl.replace(/\/+$/, '');
  const path = (segments as string[]).map(encodeURIComponent).join('/');
  return `${base}/storage/v1/object/public/${BUCKET}/${path}`;
}

/** A percent-decoded path segment; null when it is not valid percent-encoding. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** A path segment that stays where it is: not empty, `.` or `..`, without slashes or controls. */
function isPlainSegment(segment: string): boolean {
  return (
    segment !== '' &&
    segment !== '.' &&
    segment !== '..' &&
    !/[/\\]/.test(segment) &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(segment)
  );
}
