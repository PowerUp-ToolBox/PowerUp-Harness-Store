/**
 * `POST /functions/v1/publish` (docs/tech/api.md): a signed-in Publisher uploads a Harness
 * Package; the Store checks it with validatePackage, the same code the desktop app ran, stores
 * the package and its assets, and records an immutable Harness Version.
 *
 * Order: authenticate -> Content-Length (411, 413) -> rate limit -> read the multipart body ->
 * validatePackage with the caller's login and every earlier version of the Harness (413, 422,
 * 403, 409 with the validator's problems) -> read in full what the Store keeps besides the zip
 * (the icon, at most five screenshots of at most 2 MB, README.md), so a corrupt entry is a 422
 * before anything is uploaded -> upload the package, then the assets, never overwriting (an
 * object already there is another publish of this version) -> publish_version writes the rows in
 * one transaction under a lock. On any failure after the first upload, the objects this request
 * created are deleted.
 *
 * Known limitation: the package is held in memory (an Edge Function has no disk to stream to),
 * so the 500 MB package limit is above what a hosted Edge Function's memory and request size
 * allow; the P0-07 spec records it.
 */
import { createClient } from '@supabase/supabase-js';
import { errorResponse, bearerToken, jsonResponse } from '../_shared/http.ts';
import {
  ArchiveSource,
  interpolate,
  MESSAGES_EN,
  PACKAGE_LIMITS,
  PackageReadError,
  validatePackage,
} from '../_shared/manifest.js';
import {
  contentLengthError,
  HARNESS_TAKEN_DOWN,
  ICON_TOO_LARGE,
  isBadToken,
  ownHarnessId,
  publishVersionError,
  RATE_LIMITED,
  rejection,
  storeRoute,
  VERSION_NOT_GREATER,
} from '../_shared/publish.ts';
import type { ApiError, Problem } from '../_shared/publish.ts';
import { README_MAX_BYTES, storedReadme } from '../_shared/readme.ts';
import {
  ASSETS_BUCKET,
  assetUploads,
  fileSizes,
  ICON_FILE,
  MAX_ASSET_BYTES,
  PACKAGES_BUCKET,
  packagePath,
} from '../_shared/storage-paths.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const UNAUTHENTICATED: ApiError = {
  status: 401,
  code: 'unauthenticated',
  message: 'Sign in with GitHub to publish.',
};

function fail(error: ApiError, details?: Record<string, unknown>): Response {
  return errorResponse(error.status, error.code, error.message, details);
}

function serverError(what: string, cause: unknown): Response {
  console.error(what, cause);
  return errorResponse(500, 'internal_error', 'The Store could not publish this package.');
}

/**
 * The signed-in Publisher: their user id and GitHub login, or undefined for no or a bad token.
 * Throws when Auth cannot answer, so an outage is a 500 and never ends the caller's session.
 */
async function publisherOf(request: Request) {
  const token = bearerToken(request.headers.get('authorization'));
  if (token === undefined) return undefined;
  const { data, error } = await admin.auth.getUser(token);
  if (error !== null) {
    if (isBadToken(error)) return undefined;
    throw error;
  }
  const profile = await admin
    .from('profiles')
    .select('github_login')
    .eq('id', data.user.id)
    .maybeSingle<{ github_login: string | null }>();
  if (profile.error !== null) throw profile.error;
  const login = profile.data?.github_login;
  return login ? { id: data.user.id, login } : undefined;
}

/** manifest.json's bytes, if the package has one that can be read. */
async function manifestBytes(source: ArchiveSource): Promise<Uint8Array | undefined> {
  if (!source.listFiles().includes('manifest.json')) return undefined;
  try {
    return await source.readFile('manifest.json', { maxBytes: PACKAGE_LIMITS.maxManifestBytes });
  } catch {
    return undefined;
  }
}

/**
 * Reads files in full, which checks each one's CRC-32 and size: validatePackage reads no more
 * than the start of the icon and the screenshots, and nothing of README.md. A file that cannot be
 * read is the problem validatePackage reports for an unreadable entry (`archive_invalid.entry`).
 */
async function readInFull(
  source: ArchiveSource,
  files: readonly { file: string; maxBytes?: number }[],
): Promise<{ contents: Uint8Array[] } | { problems: Problem[] }> {
  const contents: Uint8Array[] = [];
  const problems: Problem[] = [];
  for (const { file, maxBytes } of files) {
    try {
      contents.push(await source.readFile(file, { maxBytes }));
    } catch (error) {
      if (!(error instanceof PackageReadError)) throw error;
      const params = { detail: error.message };
      problems.push({
        path: file,
        code: 'archive_invalid',
        message: interpolate(MESSAGES_EN['archive_invalid.entry'], params),
        messageKey: 'archive_invalid.entry',
        params,
      });
    }
  }
  return problems.length > 0 ? { problems } : { contents };
}

/** A Storage error that says the object exists already (upsert is off). */
function alreadyExists(error: { message?: string; statusCode?: string; status?: number }): boolean {
  return (
    error.statusCode === '409' ||
    error.status === 409 ||
    /already exists|duplicate/i.test(error.message ?? '')
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function publish(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }
  const publisher = await publisherOf(request);
  if (publisher === undefined) return fail(UNAUTHENTICATED);

  const lengthError = contentLengthError(request.headers.get('content-length'));
  if (lengthError !== undefined) return fail(lengthError);

  const remaining = await admin.rpc('publishes_remaining', { publisher: publisher.id });
  if (remaining.error !== null) return serverError('publishes_remaining', remaining.error);
  if (remaining.data === 0) return fail(RATE_LIMITED);

  let upload: unknown;
  try {
    upload = (await request.formData()).get('package');
  } catch {
    upload = undefined;
  }
  if (!(upload instanceof Blob)) {
    return errorResponse(
      400,
      'invalid_request',
      'The body must be multipart/form-data with the Harness Package zip in a "package" part.',
    );
  }
  const zip = new Uint8Array(await upload.arrayBuffer());
  const source = await ArchiveSource.open(zip);

  // Every earlier version of this Harness, any status: a withdrawn version number is never reused.
  const harnessId = ownHarnessId(await manifestBytes(source), publisher.login);
  let harness: { status: string; harness_versions: { version: string }[] } | null = null;
  if (harnessId !== undefined) {
    const found = await admin
      .from('harnesses')
      .select('status, harness_versions(version)')
      .eq('harness_id', harnessId)
      .maybeSingle<{ status: string; harness_versions: { version: string }[] }>();
    if (found.error !== null) return serverError('harnesses', found.error);
    harness = found.data;
  }
  const publishedVersions = (harness?.harness_versions ?? []).map((row) => row.version);

  const result = await validatePackage(source, { publisher: publisher.login, publishedVersions });
  if (!result.ok) return fail(rejection(result.problems), { problems: result.problems });
  const { manifest } = result;
  if (harness?.status === 'taken_down') return fail(HARNESS_TAKEN_DOWN);

  // What the Store keeps besides the zip, read before anything is uploaded.
  const sizes = fileSizes(source.listEntries().entries);
  if ((sizes.get(ICON_FILE) ?? 0) > MAX_ASSET_BYTES) return fail(ICON_TOO_LARGE);
  const assets = assetUploads(manifest.id, manifest.version, sizes);
  const read = await readInFull(source, [
    ...assets,
    // The 3 extra bytes complete a character cut at the limit, which storedReadme then drops.
    ...(sizes.has('README.md') ? [{ file: 'README.md', maxBytes: README_MAX_BYTES + 3 }] : []),
  ]);
  if ('problems' in read) return fail(rejection(read.problems), { problems: read.problems });
  const assetBytes = read.contents.slice(0, assets.length);
  const readme = read.contents[assets.length] ?? new Uint8Array();

  const created: { bucket: string; path: string }[] = [];
  let committed = false;
  try {
    const zipPath = packagePath(manifest.id, manifest.version);
    const stored = await admin.storage
      .from(PACKAGES_BUCKET)
      .upload(zipPath, zip, { contentType: 'application/zip', upsert: false });
    if (stored.error !== null) {
      // Another publish of this version got there first (or a crashed one left it): not ours.
      if (alreadyExists(stored.error)) return fail(VERSION_NOT_GREATER);
      return serverError(`upload ${zipPath}`, stored.error);
    }
    created.push({ bucket: PACKAGES_BUCKET, path: zipPath });

    for (const [index, asset] of assets.entries()) {
      const put = await admin.storage
        .from(ASSETS_BUCKET)
        .upload(asset.path, assetBytes[index] ?? new Uint8Array(), {
          contentType: asset.contentType,
          upsert: false,
        });
      if (put.error !== null) {
        if (alreadyExists(put.error)) return fail(VERSION_NOT_GREATER);
        return serverError(`upload ${asset.path}`, put.error);
      }
      created.push({ bucket: ASSETS_BUCKET, path: asset.path });
    }

    const inserted = await admin.rpc('publish_version', {
      publisher: publisher.id,
      manifest,
      readme: storedReadme(readme),
      package_path: zipPath,
      package_sha256: await sha256Hex(zip),
      package_size: zip.length,
      screenshot_paths: assets.slice(1).map((asset) => asset.path),
      known_versions: publishedVersions.length,
    });
    if (inserted.error !== null) {
      const known = publishVersionError(inserted.error.code, inserted.error.message);
      if (known !== undefined) return fail(known);
      // A lost connection can fail the call after the transaction committed: then the objects
      // belong to a published version and must stay.
      committed = await versionExists(manifest.id, manifest.version);
      return serverError('publish_version', inserted.error);
    }
    committed = true;
    return jsonResponse(201, {
      harness_id: manifest.id,
      version: manifest.version,
      url: storeRoute(manifest.id),
    });
  } finally {
    if (!committed) await removeCreated(created);
  }
}

/** Whether the Harness Version exists; true when that cannot be told (keep its objects). */
async function versionExists(harnessId: string, version: string): Promise<boolean> {
  const { data, error } = await admin
    .from('harness_versions')
    .select('id, harnesses!inner(harness_id)')
    .eq('harnesses.harness_id', harnessId)
    .eq('version', version);
  return error !== null || data.length > 0;
}

/** Deletes the objects this request uploaded; never one it did not create. */
async function removeCreated(created: { bucket: string; path: string }[]): Promise<void> {
  for (const bucket of [PACKAGES_BUCKET, ASSETS_BUCKET]) {
    const paths = created.filter((object) => object.bucket === bucket).map((object) => object.path);
    if (paths.length === 0) continue;
    const { error } = await admin.storage.from(bucket).remove(paths);
    if (error !== null) console.error(`Could not delete ${paths.join(', ')}`, error);
  }
}

Deno.serve(async (request) => {
  try {
    return await publish(request);
  } catch (error) {
    return serverError('publish', error);
  }
});
