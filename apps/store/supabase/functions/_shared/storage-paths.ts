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

/** One file of a Harness Package to copy into the `harness-assets` bucket. */
export interface AssetUpload {
  /** Path inside the Harness Package. */
  file: string;
  /** Path in the `harness-assets` bucket. */
  path: string;
  contentType: 'image/png' | 'image/jpeg';
}

/** `harnessId` is the Harness ID, `<publisher>/<slug>`. */
export function packagePath(harnessId: string, version: string): string {
  return `${harnessId}/${version}.zip`;
}

export function iconPath(harnessId: string, version: string): string {
  return `${harnessId}/${version}/icon.png`;
}

/**
 * The screenshots among a valid Harness Package's files: those directly in `assets/` other than
 * the icon, ignoring hidden files, as validatePackage counts them (which has already checked that
 * each is a PNG or JPEG matching its extension). They are numbered from 0 in package path order;
 * the extension is the original one, lower-cased.
 */
export function screenshotUploads(
  harnessId: string,
  version: string,
  files: Iterable<string>,
): AssetUpload[] {
  const screenshots = [...files]
    .filter((file) => /^assets\/[^/.][^/]*\.(?:png|jpe?g)$/i.test(file) && file !== ICON_FILE)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return screenshots.map((file, index) => {
    const extension = (/\.([^.]+)$/.exec(file)?.[1] ?? '').toLowerCase();
    return {
      file,
      path: `${harnessId}/${version}/screenshots/${String(index)}.${extension}`,
      contentType: extension === 'png' ? 'image/png' : 'image/jpeg',
    };
  });
}

/** The icon and the screenshots of a valid Harness Package, in upload order. */
export function assetUploads(
  harnessId: string,
  version: string,
  files: Iterable<string>,
): AssetUpload[] {
  return [
    { file: ICON_FILE, path: iconPath(harnessId, version), contentType: 'image/png' },
    ...screenshotUploads(harnessId, version, files),
  ];
}
