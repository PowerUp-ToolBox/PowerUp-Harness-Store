import { isAbsolute, join, relative } from 'node:path';
import { manifestSchema, type Manifest, type Platform } from '@harness-store/manifest';

/** The platform names, read from the Manifest schema so the two can never disagree. */
const PLATFORMS = (manifestSchema.$defs as { platform: { enum: readonly string[] } }).platform.enum;

/**
 * A machine's platform as the Manifest names it (`darwin-arm64`, `win32-x64`, …), from
 * `<process.platform>-<process.arch>`; null for a platform no Manifest can declare.
 */
export function platformOf(name: string): Platform | null {
  return PLATFORMS.includes(name) ? (name as Platform) : null;
}

/**
 * The Entry the Runtime runs on `platform`, relative to the installed Harness: the Manifest's
 * `entry` for a Node Harness, the platform's path for a binary one. Null when the Harness cannot
 * run here: the platform is not in `platforms` (an Entry for an undeclared platform is ignored,
 * as the Manifest rules say), or a binary Harness has no Entry for it.
 */
export function entryFor(manifest: Manifest, platform: Platform | null): string | null {
  if (platform === null || !manifest.platforms.includes(platform)) return null;
  if (typeof manifest.entry === 'string') return manifest.entry;
  return manifest.entry[platform] ?? null;
}

/**
 * Where the Runtime keeps Harnesses under the app data root (data-model.md, install layout):
 * the unpacked Harness Package in `harnesses/<publisher>/<slug>/<version>/`, the Data Directory
 * in `data/<publisher>/<slug>/` (it survives updates) and temporary files in `downloads/`.
 */
export interface HarnessPaths {
  readonly harnesses: string;
  readonly data: string;
  readonly downloads: string;
  /** The folder a version of a Harness is installed in. */
  installPath(harnessId: string, version: string): string;
  /** The Harness's Data Directory. */
  dataDir(harnessId: string): string;
}

/**
 * The layout under `root`. A Harness ID is `publisher/slug` and a version is semver, which the
 * Manifest schema guarantees, so they are safe path segments; a value that would still leave its
 * folder throws instead.
 */
export function harnessPaths(root: string): HarnessPaths {
  const harnesses = join(root, 'harnesses');
  const data = join(root, 'data');
  const under = (base: string, ...segments: string[]) => {
    const path = join(base, ...segments);
    if (!isInside(base, path) || segments.some((segment) => segment.includes('..'))) {
      throw new Error(`Refusing a path outside ${base}: ${segments.join('/')}`);
    }
    return path;
  };
  return {
    harnesses,
    data,
    downloads: join(root, 'downloads'),
    installPath: (harnessId, version) => under(harnesses, ...harnessId.split('/'), version),
    dataDir: (harnessId) => under(data, ...harnessId.split('/')),
  };
}

/** Whether `path` is strictly inside the folder `base` (both absolute). */
export function isInside(base: string, path: string): boolean {
  const between = relative(base, path);
  return between !== '' && !between.startsWith('..') && !isAbsolute(between);
}
