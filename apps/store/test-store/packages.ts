/**
 * Harness Packages for the publish tests, zipped from the P0-01 fixture folders of
 * packages/manifest, and the `publish` Edge Function called over HTTP as the desktop app calls it.
 */
import { join } from 'node:path';
import { zipSync } from 'fflate';
import type { ZipOptions, Zippable } from 'fflate';
import { storeRoot } from '../scripts/local-stack.ts';
import { readFolder } from '../scripts/seed.ts';
import { stack } from './support.ts';
import type { Reply } from './support.ts';

const FIXTURES = join(storeRoot(), '..', '..', 'packages', 'manifest', 'fixtures');

/** A zip entry beyond the fixture's files: its bytes, and zip attributes (a symbolic link). */
export type ExtraEntry = Uint8Array | [Uint8Array, ZipOptions];

export interface PackageOptions {
  /** Manifest fields replacing the fixture's (`id`, `version`, ...). */
  manifest?: Record<string, unknown>;
  /** More zip entries, by name exactly as stored (`../escape.txt` included). */
  extra?: Record<string, ExtraEntry>;
}

/** The fixture folder `fixture` as a zipped Harness Package, with `options` applied. */
export function fixturePackage(fixture: string, options: PackageOptions = {}): Uint8Array {
  const files = readFolder(join(FIXTURES, fixture));
  const manifestFile = files.get('manifest.json');
  if (manifestFile === undefined) throw new Error(`${fixture} has no manifest.json`);
  const manifest = {
    ...(JSON.parse(new TextDecoder().decode(manifestFile)) as Record<string, unknown>),
    ...options.manifest,
  };
  files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
  const entries: Zippable = Object.fromEntries(files);
  for (const [name, entry] of Object.entries(options.extra ?? {})) entries[name] = entry;
  return zipSync(entries, { mtime: new Date('2026-01-01T00:00:00Z') });
}

/** A symbolic link entry pointing at `target` (Unix mode 0120777 in the external attributes). */
export function symlinkEntry(target: string): ExtraEntry {
  return [new TextEncoder().encode(target), { os: 3, attrs: (0o120777 << 16) >>> 0, level: 0 }];
}

export interface PublishSuccess {
  harness_id: string;
  version: string;
  url: string;
}

export interface PublishError {
  error: {
    code: string;
    message: string;
    problems?: unknown[];
  };
}

/** POST /functions/v1/publish with the zip as the multipart `package` part. */
export async function publish(
  token: string | undefined,
  zip: Uint8Array | undefined,
): Promise<Reply<PublishSuccess & PublishError>> {
  const form = new FormData();
  if (zip !== undefined) form.set('package', new Blob([zip], { type: 'application/zip' }), 'p.zip');
  const response = await fetch(`${stack.apiUrl}/functions/v1/publish`, {
    method: 'POST',
    headers: {
      apikey: stack.anonKey,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: form,
  });
  return {
    status: response.status,
    body: (await response.json()) as PublishSuccess & PublishError,
  };
}
