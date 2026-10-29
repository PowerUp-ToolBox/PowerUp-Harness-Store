/**
 * `POST /functions/v1/report` (docs/tech/api.md): anyone, with no account, files a Report on a
 * Harness (or one of its versions) for a Store administrator to review.
 *
 * Order: the body (400) -> the per-IP counter (429) -> the reporter, when the request carries a
 * signed-in Publisher's session (otherwise, or when Auth cannot tell, the Report is anonymous) ->
 * submit_report, which checks that the Harness and version exist (404, any status) and that the
 * install has sent fewer than five Reports in the last hour (429), and stores the Report.
 *
 * Rate limit, best effort by design (a deterrent, not a guarantee): 5 Reports an hour per IP
 * address, counted in this worker's memory only (the first X-Forwarded-For address, which a
 * client can choose; never stored), and 5 an hour per `client_info.install_id`, checked against
 * the stored Reports (exact, but a client can leave the install id out or change it).
 */
import { createClient } from '@supabase/supabase-js';
import { callerLookups, signedInUser } from '../_shared/caller.ts';
import { errorResponse, failure, jsonBody, jsonResponse, raisedError } from '../_shared/http.ts';
import {
  clientIp,
  RATE_LIMITED,
  REPORT_ERRORS,
  ReportCounter,
  reportRequest,
} from '../_shared/report.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const lookups = callerLookups(admin);

/** Reports per IP address in this worker (config.toml: `policy = "per_worker"` keeps it). */
const perIp = new ReportCounter();

function serverError(what: string, cause: unknown): Response {
  console.error(what, cause);
  return errorResponse(500, 'internal_error', 'The Store could not take this Report.');
}

/**
 * The signed-in Publisher's id, or null: a Report needs no account, so no token, a refused one
 * (the anon key the desktop app sends) and Auth not answering all make it anonymous.
 */
async function reporterOf(request: Request): Promise<string | null> {
  try {
    return (await signedInUser(request.headers.get('authorization'), lookups))?.id ?? null;
  } catch (error) {
    console.error('reporter lookup', error);
    return null;
  }
}

async function report(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }
  const asked = reportRequest(await jsonBody(request));
  if ('status' in asked) return failure(asked);

  const ip = clientIp(request.headers.get('x-forwarded-for'));
  if (ip !== undefined && !perIp.allows(ip, Date.now())) return failure(RATE_LIMITED);

  const result = await admin.rpc('submit_report', {
    harness: asked.harness_id,
    target_version: asked.version ?? null,
    reason: asked.reason,
    details: asked.details,
    client_info: asked.client_info,
    reporter: await reporterOf(request),
  });
  if (result.error !== null) {
    const known = raisedError(result.error.code, result.error.message, REPORT_ERRORS);
    if (known !== undefined) return failure(known);
    return serverError('submit_report', result.error);
  }
  if (ip !== undefined) perIp.record(ip, Date.now());
  return jsonResponse(201, { id: result.data as string });
}

Deno.serve(async (request) => {
  try {
    return await report(request);
  } catch (error) {
    return serverError('report', error);
  }
});
