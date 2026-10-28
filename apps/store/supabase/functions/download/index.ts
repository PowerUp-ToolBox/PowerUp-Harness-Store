/**
 * `POST /functions/v1/download` (docs/tech/api.md): anyone, with no account, gets a short-lived
 * signed URL to a published Harness Version's package, with its checksum, size and Manifest, and
 * the download is counted without storing who made it.
 *
 * Order: the request body (400) -> the Harness and the version, the latest published one when none
 * is named (404 unless the Harness is visible and the version published) -> the platform (422,
 * nothing counted, no URL) -> sign the URL -> record_download counts it in one transaction (a 404
 * when an Unpublish or a Takedown committed in between). The function reads no Authorization
 * header, and nothing of the request but its body reaches the database: no IP address, no user.
 */
import { createClient } from '@supabase/supabase-js';
import {
  downloadRequest,
  NOT_FOUND,
  PLATFORM_NOT_SUPPORTED,
  publicSignedUrl,
  resolveVersion,
  signedUrlTtl,
} from '../_shared/download.ts';
import type { DownloadError, HarnessLookup } from '../_shared/download.ts';
import { errorResponse, jsonResponse } from '../_shared/http.ts';
import { manifestSchema } from '../_shared/manifest.js';
import { PACKAGES_BUCKET } from '../_shared/storage-paths.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const admin = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
  auth: { persistSession: false, autoRefreshToken: false },
});
const PUBLIC_URL = Deno.env.get('STORE_PUBLIC_URL') || SUPABASE_URL;
const TTL_SECONDS = signedUrlTtl(Deno.env.get('DOWNLOAD_URL_TTL_SECONDS'));

/** The platforms a Manifest may declare (the schema's enum). */
const PLATFORMS = (manifestSchema.$defs as { platform: { enum: readonly string[] } }).platform.enum;

interface VersionLookup {
  id: string;
  status: string;
  platforms: string[];
  manifest: Record<string, unknown>;
  package_path: string;
  package_sha256: string;
  package_size: number;
}

function fail(error: DownloadError): Response {
  return errorResponse(error.status, error.code, error.message);
}

function serverError(what: string, cause: unknown): Response {
  console.error(what, cause);
  return errorResponse(500, 'internal_error', 'The Store could not prepare this download.');
}

async function download(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }
  const asked = downloadRequest(body, PLATFORMS);
  if ('status' in asked) return fail(asked);

  const harness = await admin
    .from('harnesses')
    .select('id, status, latest_version')
    .eq('harness_id', asked.harness_id)
    .maybeSingle<HarnessLookup & { id: string }>();
  if (harness.error !== null) return serverError('harnesses', harness.error);
  const version = resolveVersion(harness.data, asked.version);
  if (harness.data === null || version === undefined) return fail(NOT_FOUND);

  const row = await admin
    .from('harness_versions')
    .select('id, status, platforms, manifest, package_path, package_sha256, package_size')
    .eq('harness_id', harness.data.id)
    .eq('version', version)
    .maybeSingle<VersionLookup>();
  if (row.error !== null) return serverError('harness_versions', row.error);
  if (row.data === null || row.data.status !== 'published') return fail(NOT_FOUND);
  if (!row.data.platforms.includes(asked.platform)) return fail(PLATFORM_NOT_SUPPORTED);

  const signed = await admin.storage
    .from(PACKAGES_BUCKET)
    .createSignedUrl(row.data.package_path, TTL_SECONDS);
  if (signed.error !== null) return serverError(`sign ${row.data.package_path}`, signed.error);

  const counted = await admin.rpc('record_download', {
    version_id: row.data.id,
    platform: asked.platform,
    app_version: asked.app_version,
  });
  if (counted.error !== null) {
    if (counted.error.code === 'PT404') return fail(NOT_FOUND);
    return serverError('record_download', counted.error);
  }

  return jsonResponse(200, {
    url: publicSignedUrl(signed.data.signedUrl, PUBLIC_URL),
    sha256: row.data.package_sha256,
    size: row.data.package_size,
    manifest: row.data.manifest,
  });
}

Deno.serve(async (request) => {
  try {
    return await download(request);
  } catch (error) {
    return serverError('download', error);
  }
});
