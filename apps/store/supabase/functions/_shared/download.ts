/**
 * The request rules of the `download` Edge Function that need no network: the request body, which
 * version a request asks for, the platform check, the signed URL's lifetime and the public URL the
 * desktop app can reach. Plain TypeScript with relative imports only (see storage-paths.ts).
 */
import { invalidRequest, isText } from './http.ts';
import type { ApiError } from './http.ts';

/** A valid `download` request body (docs/tech/api.md). */
export interface DownloadRequest {
  harness_id: string;
  /** Undefined: the Harness's latest published version. */
  version?: string;
  platform: string;
  app_version: string;
}

/** The longest `app_version` the Store records. */
export const MAX_APP_VERSION_LENGTH = 64;

/** The longest Harness ID or version the function looks up; anything longer cannot exist. */
const MAX_LOOKUP_LENGTH = 256;

/** How long a signed package URL is valid, in seconds (P0-07: "a leaked URL is worthless within a minute"). */
export const SIGNED_URL_TTL_SECONDS = 60;

export const NOT_FOUND: ApiError = {
  status: 404,
  code: 'not_found',
  message: 'No published version of this Harness was found.',
};

export const PLATFORM_NOT_SUPPORTED: ApiError = {
  status: 422,
  code: 'platform_not_supported',
  message: 'This Harness Version does not run on the requested platform.',
};

/**
 * The request, or the 400 that refuses it: `harness_id` a non-empty string, `version` absent,
 * null or a non-empty string, `platform` one of `platforms` (the Manifest schema's platform enum),
 * `app_version` a non-empty string of at most {@link MAX_APP_VERSION_LENGTH} characters. Other
 * fields are ignored.
 */
export function downloadRequest(
  body: unknown,
  platforms: readonly string[],
): DownloadRequest | ApiError {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return invalidRequest('The body must be a JSON object.');
  }
  const { harness_id, version, platform, app_version } = body as Record<string, unknown>;
  if (!isText(harness_id, MAX_LOOKUP_LENGTH)) {
    return invalidRequest('"harness_id" must be a Harness ID.');
  }
  if (version !== undefined && version !== null && !isText(version, MAX_LOOKUP_LENGTH)) {
    return invalidRequest(
      '"version" must be a version, or left out for the latest published version.',
    );
  }
  if (typeof platform !== 'string' || !platforms.includes(platform)) {
    return invalidRequest(`"platform" must be one of ${platforms.join(', ')}.`);
  }
  if (!isText(app_version, MAX_APP_VERSION_LENGTH)) {
    return invalidRequest(
      `"app_version" must be a string of 1 to ${String(MAX_APP_VERSION_LENGTH)} characters.`,
    );
  }
  return {
    harness_id,
    ...(typeof version === 'string' ? { version } : {}),
    platform,
    app_version,
  };
}

/** What the function reads of the Harness a request names (service role, so any status). */
export interface HarnessLookup {
  status: string;
  latest_version: string | null;
}

/**
 * The version a request downloads, or undefined (404) when there is none to download: the Harness
 * must be active and have a published version; the version asked for, or else its latest
 * published one. Whether that version is itself published is checked on its row.
 */
export function resolveVersion(
  harness: HarnessLookup | null,
  requested: string | undefined,
): string | undefined {
  if (harness?.status !== 'active' || harness.latest_version === null) {
    return undefined;
  }
  return requested ?? harness.latest_version;
}

/**
 * The lifetime of a signed URL from the `DOWNLOAD_URL_TTL_SECONDS` environment variable: a whole
 * number of seconds from 1 to {@link SIGNED_URL_TTL_SECONDS}, else (unset or anything else) 60. The
 * local stack sets a few seconds in supabase/functions/.env so that the store tests can watch a
 * URL expire; a deployed Store never sets it, and nothing can make a URL live longer than 60 s.
 */
export function signedUrlTtl(raw: string | undefined): number {
  const seconds = /^\d+$/.test(raw?.trim() ?? '') ? Number(raw?.trim()) : NaN;
  return seconds >= 1 && seconds <= SIGNED_URL_TTL_SECONDS ? seconds : SIGNED_URL_TTL_SECONDS;
}

/**
 * The signed URL with the Store's public origin (`STORE_PUBLIC_URL`, else `SUPABASE_URL`) in place
 * of the one Storage gave it: inside the edge runtime `SUPABASE_URL` is the gateway's address on
 * the stack's network, which the desktop app cannot reach. Path and query (the token) are kept.
 */
export function publicSignedUrl(signedUrl: string, publicBase: string): string {
  const url = new URL(signedUrl);
  return `${publicBase.replace(/\/+$/, '')}${url.pathname}${url.search}`;
}
