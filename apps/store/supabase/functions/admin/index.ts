/**
 * `POST /functions/v1/admin/takedown` (docs/tech/api.md): a Store administrator takes down a
 * Harness Version, or a whole Harness and every one of its versions, resolving the open Reports
 * on it and logging the action. A function's name cannot hold a `/`, so this `admin` function
 * serves the route by its path; any other path is a 404.
 *
 * Order: the route (404) -> authenticate (401) -> `profiles.is_admin`, looked up here and not
 * read from a JWT claim (403) -> the body (400) -> take_down, which does all of it in one
 * transaction (404 for an unknown Harness or version).
 */
import { createClient } from '@supabase/supabase-js';
import { signedInUser } from '../_shared/caller.ts';
import type { CallerLookups } from '../_shared/caller.ts';
import { errorResponse, failure, jsonBody, jsonResponse, raisedError } from '../_shared/http.ts';
import {
  FORBIDDEN,
  isTakedownRoute,
  ROUTE_NOT_FOUND,
  TAKEDOWN_ERRORS,
  takedownRequest,
  UNAUTHENTICATED,
} from '../_shared/takedown.ts';

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
  return errorResponse(500, 'internal_error', 'The Store could not take this content down.');
}

async function takedown(request: Request): Promise<Response> {
  if (!isTakedownRoute(new URL(request.url).pathname)) return failure(ROUTE_NOT_FOUND);
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }
  const caller = await signedInUser(request.headers.get('authorization'), lookups);
  if (caller === undefined) return failure(UNAUTHENTICATED);
  if (!caller.isAdmin) return failure(FORBIDDEN);

  const asked = takedownRequest(await jsonBody(request));
  if ('status' in asked) return failure(asked);

  const result = await admin.rpc('take_down', {
    admin_id: caller.id,
    harness: asked.harness_id,
    target_version: asked.version ?? null,
    note: asked.note,
  });
  if (result.error !== null) {
    const known = raisedError(result.error.code, result.error.message, TAKEDOWN_ERRORS);
    if (known !== undefined) return failure(known);
    return serverError('take_down', result.error);
  }
  return jsonResponse(200, result.data);
}

Deno.serve(async (request) => {
  try {
    return await takedown(request);
  } catch (error) {
    return serverError('admin', error);
  }
});
