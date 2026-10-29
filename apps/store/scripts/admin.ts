/**
 * The Store administrator's command line (P0-12.2): there is no web admin UI in P0 (that is
 * P1-05). Run from an administrator's machine against a Store (`pnpm --filter
 * @harness-store/store admin <command>`, after `pnpm build`):
 *
 * - `reports list [--open]`: every Report (only the open ones with `--open`), newest first,
 *   grouped by Harness with its count per reason and its latest details. One service-role
 *   PostgREST read of `reports`.
 * - `reports dismiss <id> --note "..."`: marks an open Report `dismissed` with the note, without
 *   touching the Harness. A service-role PostgREST update; not logged in `admin_actions`, whose
 *   actions are Takedowns only.
 * - `takedown <harness_id> [--version <v>] --note "..."`: takes down that version, or the whole
 *   Harness, through the `admin/takedown` Edge Function (docs/tech/api.md), which resolves the
 *   open Reports on the Harness and writes one `admin_actions` row.
 *
 * Every command needs `STORE_URL` and `STORE_SERVICE_ROLE_KEY`; `takedown` also needs
 * `STORE_JWT_SECRET` (the project's HS256 JWT secret) and `STORE_ADMIN_LOGIN` (the GitHub login of
 * a profile with `is_admin`). GitHub OAuth is the only sign-in, so `takedown` mints that
 * administrator a 5-minute session JWT itself, after checking `is_admin` with the service role.
 * They come from the environment only and are never printed. Exit codes: 0 done, 1 the Store
 * refused or did not answer (its status, code and message are printed), 2 a usage error or a
 * missing variable.
 */
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MAX_NOTE_LENGTH } from '../supabase/functions/_shared/takedown.ts';

/** A command line the CLI understood. */
export type AdminCommand =
  | { readonly kind: 'reports-list'; readonly open: boolean }
  | { readonly kind: 'reports-dismiss'; readonly id: string; readonly note: string }
  | {
      readonly kind: 'takedown';
      readonly harnessId: string;
      /** Null: the whole Harness. */
      readonly version: string | null;
      readonly note: string;
    }
  | { readonly kind: 'help' };

/** Where the CLI writes: standard output and standard error, a line at a time. */
export interface AdminOutput {
  log(line: string): void;
  error(line: string): void;
}

/** What the CLI reads from the environment. */
export interface AdminEnv {
  readonly storeUrl: string;
  readonly serviceRoleKey: string;
  /** Set for `takedown` only. */
  readonly jwtSecret?: string;
  readonly adminLogin?: string;
}

/** A command line or environment the CLI refuses (exit code 2). */
export class UsageError extends Error {}

/** A Store that refused or did not answer (exit code 1). */
class StoreError extends Error {}

export const USAGE = `Usage:
  admin reports list [--open]
  admin reports dismiss <report-id> --note "<why>"
  admin takedown <publisher/slug> [--version <version>] --note "<why>"

Environment: STORE_URL and STORE_SERVICE_ROLE_KEY; takedown also STORE_JWT_SECRET and
STORE_ADMIN_LOGIN (a profile with is_admin).`;

/** How long the administrator JWT that `takedown` mints is valid. */
export const ADMIN_JWT_LIFETIME_SECONDS = 5 * 60;

/** How much of a Report's details its line in `reports list` shows. */
export const DETAILS_PREVIEW_LENGTH = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HARNESS_ID = /^[^/\s]+\/[^/\s]+$/;

/** The note of a dismissal or a Takedown: 1 to 2000 characters, not only whitespace. */
function parseNote(note: string | undefined): string {
  if (note === undefined) throw new UsageError('--note "<why>" is required.');
  if (note.trim() === '' || note.length > MAX_NOTE_LENGTH || note.includes('\u0000')) {
    throw new UsageError(
      `--note must be 1 to ${String(MAX_NOTE_LENGTH)} characters, not only whitespace.`,
    );
  }
  return note;
}

/** Refuses the options a command does not take. */
function only(values: Record<string, unknown>, allowed: readonly string[], command: string): void {
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined && !allowed.includes(name)) {
      throw new UsageError(`${command} does not take --${name}.`);
    }
  }
}

/** The command of `argv` (the arguments after the script); throws {@link UsageError}. */
export function parseCommand(argv: readonly string[]): AdminCommand {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        open: { type: 'boolean' },
        note: { type: 'string' },
        version: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: 'help' };
  const [command, ...rest] = positionals;
  if (command === 'reports') {
    const [action, ...more] = rest;
    if (action === 'list') {
      if (more.length > 0) throw new UsageError('reports list takes no argument.');
      only(values, ['open'], 'reports list');
      return { kind: 'reports-list', open: values.open === true };
    }
    if (action === 'dismiss') {
      const [id, ...extra] = more;
      if (id === undefined || extra.length > 0 || !UUID.test(id)) {
        throw new UsageError('reports dismiss takes one Report ID (a UUID).');
      }
      only(values, ['note'], 'reports dismiss');
      return { kind: 'reports-dismiss', id: id.toLowerCase(), note: parseNote(values.note) };
    }
    throw new UsageError('Use reports list or reports dismiss.');
  }
  if (command === 'takedown') {
    const [harnessId, ...extra] = rest;
    if (harnessId === undefined || extra.length > 0 || !HARNESS_ID.test(harnessId)) {
      throw new UsageError('takedown takes one Harness ID, <publisher>/<slug>.');
    }
    only(values, ['note', 'version'], 'takedown');
    const version = values.version;
    if (version?.trim() === '') {
      throw new UsageError('--version must name a version; leave it out for the whole Harness.');
    }
    return { kind: 'takedown', harnessId, version: version ?? null, note: parseNote(values.note) };
  }
  throw new UsageError(command === undefined ? 'No command.' : `Unknown command: ${command}.`);
}

/**
 * The variables `command` needs, read from `env`; throws {@link UsageError} naming every one that
 * is missing, never a value.
 */
export function readEnv(command: AdminCommand, env: NodeJS.ProcessEnv): AdminEnv {
  const names = ['STORE_URL', 'STORE_SERVICE_ROLE_KEY'];
  if (command.kind === 'takedown') names.push('STORE_JWT_SECRET', 'STORE_ADMIN_LOGIN');
  const missing = names.filter((name) => (env[name] ?? '').trim() === '');
  if (missing.length > 0) throw new UsageError(`Set ${missing.join(', ')}.`);
  const storeUrl = (env.STORE_URL ?? '').trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(storeUrl);
  } catch {
    throw new UsageError('STORE_URL must be the Store URL, like https://<project>.supabase.co.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UsageError('STORE_URL must be an http or https URL.');
  }
  return {
    storeUrl,
    serviceRoleKey: (env.STORE_SERVICE_ROLE_KEY ?? '').trim(),
    ...(command.kind === 'takedown'
      ? {
          jwtSecret: (env.STORE_JWT_SECRET ?? '').trim(),
          adminLogin: (env.STORE_ADMIN_LOGIN ?? '').trim().toLowerCase(),
        }
      : {}),
  };
}

/** Whether a terminal could act on this code point: a control character or a bidi override. */
function isUnsafe(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * `text` with what a terminal would act on made visible as `\u{...}`: control characters and the
 * bidirectional overrides. A Report's details are anyone's text. Line breaks and tabs become
 * spaces, unless `keepLines` keeps them.
 */
export function printable(text: string, keepLines = false): string {
  let result = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (!isUnsafe(code) || (keepLines && (char === '\n' || char === '\t'))) result += char;
    else if (!keepLines && (char === '\n' || char === '\r' || char === '\t')) result += ' ';
    else result += `\\u{${code.toString(16)}}`;
  }
  return result;
}

/** One row of the `reports list` read. */
export interface ReportRow {
  readonly id: string;
  readonly created_at: string;
  readonly reason: string;
  readonly status: string;
  readonly details: string;
  readonly harnesses: { readonly harness_id: string } | null;
  readonly harness_versions: { readonly version: string } | null;
}

/**
 * The text of `reports list`: per Harness, in the order of its newest Report, a header with its
 * count and its count per reason, the latest Report's details, then one line per Report (ID,
 * time, version or "all versions", reason, status and the start of its details).
 */
export function formatReports(rows: readonly ReportRow[], open: boolean): string[] {
  if (rows.length === 0) return [open ? 'No open Reports.' : 'No Reports.'];
  const groups = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const harnessId = row.harnesses?.harness_id ?? '(unknown Harness)';
    const group = groups.get(harnessId) ?? [];
    group.push(row);
    groups.set(harnessId, group);
  }
  const lines: string[] = [];
  for (const [harnessId, reports] of groups) {
    const reasons = new Map<string, number>();
    for (const report of reports) reasons.set(report.reason, (reasons.get(report.reason) ?? 0) + 1);
    const perReason = [...reasons]
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
      .map(([reason, count]) => `${reason} ${String(count)}`)
      .join(', ');
    const noun = `${open ? 'open ' : ''}Report${reports.length === 1 ? '' : 's'}`;
    if (lines.length > 0) lines.push('');
    lines.push(`${printable(harnessId)}: ${String(reports.length)} ${noun} (${perReason})`);
    const latest = printable((reports[0]?.details ?? '').trim(), true).split('\n');
    lines.push(
      `  Latest details: ${latest[0] === '' ? '(none)' : (latest[0] ?? '')}`,
      ...latest.slice(1).map((line) => `    ${line}`),
    );
    for (const report of reports) {
      const details = printable(report.details).trim();
      const preview =
        details.length > DETAILS_PREVIEW_LENGTH
          ? `${details.slice(0, DETAILS_PREVIEW_LENGTH)}…`
          : details;
      lines.push(
        [
          `  ${report.id}`,
          report.created_at,
          report.harness_versions === null
            ? 'all versions'
            : printable(report.harness_versions.version),
          report.reason,
          report.status,
          preview,
        ]
          .join('  ')
          .trimEnd(),
      );
    }
  }
  return lines;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/** An HS256 session JWT for the profile `userId`, as Auth would issue one after sign-in. */
export function mintAdminJwt(userId: string, secret: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub: userId,
      role: 'authenticated',
      aud: 'authenticated',
      iat,
      exp: iat + ADMIN_JWT_LIFETIME_SECONDS,
    }),
  );
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${base64url(signature)}`;
}

/**
 * A request to the Store; its parsed JSON body. A refusal is a {@link StoreError} with its status
 * and the API's code and message only, never a header or the request.
 */
async function request<T>(
  env: AdminEnv,
  method: string,
  path: string,
  { bearer, body, prefer }: { bearer?: string; body?: unknown; prefer?: string } = {},
): Promise<T> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(`${env.storeUrl}/${path}`, {
      method,
      headers: {
        apikey: env.serviceRoleKey,
        authorization: `Bearer ${bearer ?? env.serviceRoleKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(prefer === undefined ? {} : { prefer }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    text = await response.text();
  } catch {
    throw new StoreError(`The Store at ${env.storeUrl} did not answer.`);
  }
  let parsed: unknown = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    // Not JSON: only the status is shown.
  }
  if (!response.ok) {
    // An Edge Function answers { error: { code, message } }, PostgREST { code, message }.
    const source = (parsed as { error?: unknown } | null)?.error ?? parsed;
    const { code, message } = (typeof source === 'object' && source !== null ? source : {}) as {
      code?: unknown;
      message?: unknown;
    };
    const parts = [
      typeof code === 'string' ? code : null,
      typeof message === 'string' ? message : null,
    ]
      .filter((part) => part !== null)
      .map((part) => printable(part));
    throw new StoreError(
      `The Store refused (${String(response.status)})${parts.length > 0 ? `: ${parts.join(': ')}` : '.'}`,
    );
  }
  return parsed as T;
}

async function listReports(env: AdminEnv, open: boolean, out: AdminOutput): Promise<void> {
  const select =
    'id,created_at,reason,status,details,harnesses(harness_id),harness_versions(version)';
  const rows = await request<ReportRow[]>(
    env,
    'GET',
    `rest/v1/reports?select=${select}${open ? '&status=eq.open' : ''}&order=created_at.desc,id`,
  );
  for (const line of formatReports(rows, open)) out.log(line);
}

async function dismissReport(
  env: AdminEnv,
  id: string,
  note: string,
  out: AdminOutput,
): Promise<boolean> {
  const rows = await request<{ id: string }[]>(
    env,
    'PATCH',
    `rest/v1/reports?id=eq.${id}&status=eq.open&select=id`,
    {
      body: { status: 'dismissed', resolution_note: note, resolved_at: new Date().toISOString() },
      prefer: 'return=representation',
    },
  );
  if (rows.length === 0) {
    out.error(`No open Report ${id}.`);
    return false;
  }
  out.log(`Dismissed Report ${id}.`);
  return true;
}

async function takeDown(
  env: AdminEnv,
  command: Extract<AdminCommand, { kind: 'takedown' }>,
  out: AdminOutput,
): Promise<boolean> {
  const login = env.adminLogin ?? '';
  const [profile] = await request<{ id: string; is_admin: boolean }[]>(
    env,
    'GET',
    `rest/v1/profiles?github_login=eq.${encodeURIComponent(login)}&select=id,is_admin`,
  );
  if (profile === undefined) {
    out.error(`STORE_ADMIN_LOGIN names no profile in this Store.`);
    return false;
  }
  if (!profile.is_admin) {
    out.error('STORE_ADMIN_LOGIN is not a Store administrator (profiles.is_admin is not set).');
    return false;
  }
  const reply = await request<{
    harness_id: string;
    version: string | null;
    resolved_reports: number;
  }>(env, 'POST', 'functions/v1/admin/takedown', {
    bearer: mintAdminJwt(profile.id, env.jwtSecret ?? ''),
    body: {
      harness_id: command.harnessId,
      ...(command.version === null ? {} : { version: command.version }),
      note: command.note,
    },
  });
  const what =
    reply.version === null
      ? `the whole Harness ${printable(reply.harness_id)}`
      : `version ${printable(reply.version)} of ${printable(reply.harness_id)}`;
  const resolved = reply.resolved_reports;
  out.log(
    `Took down ${what}; resolved ${String(resolved)} open Report${resolved === 1 ? '' : 's'}.`,
  );
  return true;
}

/**
 * Runs the CLI on `argv` (the arguments after the script) with the variables of `env`, writing to
 * `out`; resolves its exit code. Never rejects.
 */
export async function runAdmin(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  out: AdminOutput,
): Promise<number> {
  let command: AdminCommand;
  let config: AdminEnv;
  try {
    command = parseCommand(argv);
    if (command.kind === 'help') {
      out.log(USAGE);
      return 0;
    }
    config = readEnv(command, env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    out.error(error.message);
    out.error(USAGE);
    return 2;
  }
  try {
    switch (command.kind) {
      case 'reports-list':
        await listReports(config, command.open, out);
        return 0;
      case 'reports-dismiss':
        return (await dismissReport(config, command.id, command.note, out)) ? 0 : 1;
      case 'takedown':
        return (await takeDown(config, command, out)) ? 0 : 1;
    }
  } catch (error) {
    out.error(error instanceof StoreError ? error.message : 'Something went wrong.');
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runAdmin(process.argv.slice(2), process.env, {
    log: (line) => {
      console.log(line);
    },
    error: (line) => {
      console.error(line);
    },
  });
}
