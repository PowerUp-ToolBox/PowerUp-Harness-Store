/**
 * Where a Harness Version's objects live in Storage. Every path is relative to its bucket (no
 * bucket prefix), and that is what the database stores:
 *
 * - `harness-packages`: `<publisher>/<slug>/<version>.zip`
 * - `harness-assets`: `<publisher>/<slug>/<version>/icon.png` and
 *   `<publisher>/<slug>/<version>/screenshots/<n>.<ext>`
 *
 * Plain TypeScript with no imports, so the Deno Edge Functions, the Node seed script and the
 * unit tests all use this one module.
 */

export const PACKAGES_BUCKET = 'harness-packages';
export const ASSETS_BUCKET = 'harness-assets';

/** The icon every valid Harness Package has (validatePackage requires it). */
export const ICON_FILE = 'assets/icon.png';

/**
 * The Store keeps at most this many screenshots of a Harness Version: the detail page shows up to
 * five (docs/ux/design-principles.md). `PACKAGE_LIMITS.maxScreenshots`; more is only a warning
 * for validatePackage.
 */
export const MAX_SCREENSHOTS = 5;

/**
 * A larger screenshot is not kept. `PACKAGE_LIMITS.maxScreenshotBytes`; a larger one is only a
 * warning for validatePackage, which reads no more than its signature.
 */
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

/**
 * The largest object `harness-assets` accepts (its `file_size_limit`), and so the largest icon a
 * Harness Version can have in the Store. An honest 512×512 PNG is at most about 2 MB.
 */
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;

/** One file of a Harness Package to copy into the `harness-assets` bucket. */
export interface AssetUpload {
  /** Path inside the Harness Package. */
  file: string;
  /** Path in the `harness-assets` bucket. */
  path: string;
  contentType: 'image/png' | 'image/jpeg';
}

/** One entry of a Harness Package listing (`PackageEntry` of @harness-store/manifest). */
export interface ListedEntry {
  name: string;
  kind: string;
  size: number;
}

/** `harnessId` is the Harness ID, `<publisher>/<slug>`. */
export function packagePath(harnessId: string, version: string): string {
  return `${harnessId}/${version}.zip`;
}

export function iconPath(harnessId: string, version: string): string {
  return `${harnessId}/${version}/icon.png`;
}

/**
 * The declared size of every file of a valid Harness Package, by its path as `listFiles()` gives
 * it: the entry name without empty or `.` segments (a valid package has no unsafe or duplicate
 * name). A full read of a file checks that its size is the declared one.
 */
export function fileSizes(entries: Iterable<ListedEntry>): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    const path = entry.name
      .split('/')
      .filter((segment) => segment !== '' && segment !== '.')
      .join('/');
    if (path !== '' && !sizes.has(path)) sizes.set(path, entry.size);
  }
  return sizes;
}

/**
 * The screenshots the Store keeps, from a valid Harness Package's files and their sizes: those
 * directly in `assets/` other than the icon, ignoring hidden files, as validatePackage counts them
 * (which has already checked that each is a PNG or JPEG matching its extension). A screenshot
 * over {@link MAX_SCREENSHOT_BYTES} is skipped, and only the first {@link MAX_SCREENSHOTS} in
 * package path order are kept. They are numbered from 0 in that order; the extension is the
 * original one, lower-cased.
 */
export function screenshotUploads(
  harnessId: string,
  version: string,
  sizes: ReadonlyMap<string, number>,
): AssetUpload[] {
  const screenshots = [...sizes]
    .filter(
      ([file, size]) =>
        /^assets\/[^/.][^/]*\.(?:png|jpe?g)$/i.test(file) &&
        file !== ICON_FILE &&
        size <= MAX_SCREENSHOT_BYTES,
    )
    .map(([file]) => file)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_SCREENSHOTS);
  return screenshots.map((file, index) => {
    const extension = (/\.([^.]+)$/.exec(file)?.[1] ?? '').toLowerCase();
    return {
      file,
      path: `${harnessId}/${version}/screenshots/${String(index)}.${extension}`,
      contentType: extension === 'png' ? 'image/png' : 'image/jpeg',
    };
  });
}

/** The icon and the screenshots the Store keeps of a valid Harness Package, in upload order. */
export function assetUploads(
  harnessId: string,
  version: string,
  sizes: ReadonlyMap<string, number>,
): AssetUpload[] {
  return [
    { file: ICON_FILE, path: iconPath(harnessId, version), contentType: 'image/png' },
    ...screenshotUploads(harnessId, version, sizes),
  ];
}
