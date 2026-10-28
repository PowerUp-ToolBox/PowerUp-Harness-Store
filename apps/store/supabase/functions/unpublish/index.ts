/**
 * `POST /functions/v1/unpublish` (docs/tech/api.md): a signed-in Publisher withdraws one of their
 * Harness Versions. It disappears from every public read and from download, the Harness's
 * latest_version moves back to the previous published version (or to none, which hides the
 * Harness), and existing installs keep working. Unpublishing a version again is a success.
 *
 * Order: authenticate (401) -> the body (400) -> unpublish_version, which checks in one
 * transaction that the Harness and version exist (404), that the caller publishes the Harness
 * (403) and that neither was taken down (409), then changes the status.
 */
import { createClient } from '@supabase/supabase-js';
import { signedInUser } from '../_shared/caller.ts';
import type { CallerLookups } from '../_shared/caller.ts';
import { errorResponse, failure, jsonBody, jsonResponse, raisedError } from '../_shared/http.ts';
import { UNAUTHENTICATED, UNPUBLISH_ERRORS, unpublishRequest } from '../_shared/unpublish.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const lookups: CallerLookups = {
  getUser: (token) => admin.auth.getUser(token),
  profile: (id) =>
    admin
      .from('profiles')
      .select('github_login, is_admin')
      .eq('id', id)
      .maybeSingle<{ github_login: string | null; is_admin: boolean }>(),
};

function serverError(what: string, cause: unknown): Response {
  console.error(what, cause);
  return errorResponse(500, 'internal_error', 'The Store could not Unpublish this version.');
}

async function unpublish(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }
  const publisher = await signedInUser(request.headers.get('authorization'), lookups);
  if (publisher === undefined) return failure(UNAUTHENTICATED);

  const asked = unpublishRequest(await jsonBody(request));
  if ('status' in asked) return failure(asked);

  const result = await admin.rpc('unpublish_version', {
    publisher: publisher.id,
    harness: asked.harness_id,
    target_version: asked.version,
  });
  if (result.error !== null) {
    const known = raisedError(result.error.code, result.error.message, UNPUBLISH_ERRORS);
    if (known !== undefined) return failure(known);
    return serverError('unpublish_version', result.error);
  }
  return jsonResponse(200, result.data);
}

Deno.serve(async (request) => {
  try {
    return await unpublish(request);
  } catch (error) {
    return serverError('unpublish', error);
  }
});
