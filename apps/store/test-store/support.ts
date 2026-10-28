/**
 * Talks to the local Supabase stack the way its clients do: PostgREST, Auth and Storage over
 * HTTP, as anon (the desktop app's key), as a Publisher (a session JWT) or as the service role
 * (what the Edge Functions use). Test Publishers are created through the Auth admin API with the
 * metadata a GitHub sign-in gives, and their JWTs are minted with the stack's JWT secret, so no
 * test ever reaches GitHub.
 */
import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { localStack, storeRoot } from '../scripts/local-stack.ts';

export const stack = localStack();

/** Who makes a request: anon, the service role, or a Publisher's session JWT. */
export type Caller = 'anon' | 'service' | { token: string };

export interface Reply<T = unknown> {
  status: number;
  body: T;
}

function headersFor(caller: Caller): Record<string, string> {
  const apikey = caller === 'service' ? stack.serviceRoleKey : stack.anonKey;
  const bearer = caller === 'anon' ? stack.anonKey : caller === 'service' ? apikey : caller.token;
  return { apikey, authorization: `Bearer ${bearer}` };
}

/** A request to `/<path>` on the stack's gateway (`rest/v1/...`, `auth/v1/...`, `storage/v1/...`). */
export async function call<T = unknown>(
  caller: Caller,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply<T>> {
  const response = await fetch(`${stack.apiUrl}/${path}`, {
    method,
    headers: {
      ...headersFor(caller),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    // Not JSON (a file from Storage): keep the text.
  }
  return { status: response.status, body: parsed as T };
}

/** A PostgREST call that returns the affected rows. */
export function rest<T = unknown>(
  caller: Caller,
  method: string,
  path: string,
  body?: unknown,
): Promise<Reply<T>> {
  return call<T>(caller, method, `rest/v1/${path}`, body, { prefer: 'return=representation' });
}

/** A service-role PostgREST call that must succeed. */
export async function serviceRest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const reply = await rest<T>('service', method, path, body);
  if (reply.status >= 300) {
    throw new Error(
      `${method} ${path} failed (${String(reply.status)}): ${JSON.stringify(reply.body)}`,
    );
  }
  return reply.body;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/** An HS256 session JWT for `userId`, as Auth would issue it after sign-in. */
export function mintJwt(userId: string, lifetimeSeconds = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub: userId,
      role: 'authenticated',
      aud: 'authenticated',
      iat: now,
      exp: now + lifetimeSeconds,
    }),
  );
  const signature = createHmac('sha256', stack.jwtSecret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${base64url(signature)}`;
}

export interface TestUser {
  id: string;
  /** The GitHub login as given to Auth (the profile stores it lower-cased). */
  userName: string;
  token: string;
}

/**
 * An auth user like the one a GitHub sign-in creates (`provider = github` in app metadata, the
 * login in `user_name`), or another provider's user when `provider` says so.
 */
export async function createUser(
  userName = `t-${randomUUID().slice(0, 8)}`,
  provider = 'github',
): Promise<TestUser> {
  const reply = await call<{ id: string }>('service', 'POST', 'auth/v1/admin/users', {
    email: `${userName.toLowerCase()}-${randomUUID().slice(0, 8)}@test.harness-store.invalid`,
    email_confirm: true,
    app_metadata: { provider },
    user_metadata: { user_name: userName, full_name: `Test ${userName}` },
  });
  if (reply.status !== 200)
    throw new Error(`Creating ${userName} failed: ${JSON.stringify(reply.body)}`);
  return { id: reply.body.id, userName, token: mintJwt(reply.body.id) };
}

/**
 * Removes a test user and every Harness they published. Does nothing for a user that was never
 * created, so an `afterAll` after a failed `beforeAll` does not hide that failure.
 */
export async function deleteUser(user: TestUser | undefined): Promise<void> {
  if (user === undefined) return;
  await serviceRest('DELETE', `harnesses?publisher_id=eq.${user.id}`);
  const reply = await call('service', 'DELETE', `auth/v1/admin/users/${user.id}`);
  if (reply.status !== 200)
    throw new Error(`Deleting ${user.userName} failed: ${JSON.stringify(reply.body)}`);
}

export interface HarnessRow {
  id: string;
  harness_id: string;
  name: string;
  summary: string;
  tags: string[];
  icon_path: string | null;
  latest_version: string | null;
  latest_published_at: string | null;
  status: 'active' | 'taken_down';
  download_count: number;
}

export interface VersionRow {
  id: string;
  version: string;
  status: 'published' | 'unpublished' | 'taken_down';
  semver_key: number[];
  download_count: number;
  published_at: string;
}

/** A Harness of `user` with no version yet, written with the service role. */
export async function insertHarness(user: TestUser, slug: string): Promise<HarnessRow> {
  const [row] = await serviceRest<HarnessRow[]>('POST', 'harnesses', {
    publisher_id: user.id,
    slug,
    name: slug,
    summary: `Summary of ${slug}`,
  });
  if (row === undefined) throw new Error('No row returned');
  return row;
}

/** The columns of a Harness Version row; the Manifest is only as complete as the test needs. */
export function versionRow(
  harness: HarnessRow,
  version: string,
  fields: Record<string, unknown> = {},
) {
  return {
    harness_id: harness.id,
    version,
    manifest: {
      id: harness.harness_id,
      version,
      name: `${harness.name} ${version}`,
      summary: 'S',
      tags: ['coding'],
    },
    readme: `# ${harness.name}`,
    platforms: ['linux-x64'],
    permissions: { shell: false },
    package_path: `${harness.harness_id}/${version}.zip`,
    package_sha256: '0'.repeat(64),
    package_size: 1,
    ...fields,
  };
}

/** Inserts a published Harness Version with the service role. */
export async function insertVersion(
  harness: HarnessRow,
  version: string,
  fields: Record<string, unknown> = {},
): Promise<VersionRow> {
  const [row] = await serviceRest<VersionRow[]>(
    'POST',
    'harness_versions',
    versionRow(harness, version, fields),
  );
  if (row === undefined) throw new Error('No row returned');
  return row;
}

export async function readHarness(id: string): Promise<HarnessRow> {
  const [row] = await serviceRest<HarnessRow[]>('GET', `harnesses?id=eq.${id}`);
  if (row === undefined) throw new Error(`No Harness ${id}`);
  return row;
}

/**
 * PostgREST's answer to a missing privilege (SQLSTATE 42501): 401 for anon, 403 for an
 * authenticated caller.
 */
export function isPermissionDenied(reply: Reply): boolean {
  return (
    (reply.status === 401 || reply.status === 403) &&
    (reply.body as { code?: unknown } | null)?.code === '42501'
  );
}

/** The local stack's database container, named by the CLI after config.toml's `project_id`. */
function databaseContainer(): string {
  const config = readFileSync(join(storeRoot(), 'supabase', 'config.toml'), 'utf8');
  const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  if (projectId === undefined) throw new Error('No project_id in supabase/config.toml');
  return `supabase_db_${projectId}`;
}

/**
 * Runs `script` as the `postgres` superuser in its own database session, through psql inside the
 * stack's database container (the store tests need Docker anyway), and resolves with psql's
 * unaligned output. Only for what HTTP cannot do: a test that interleaves two open transactions.
 */
export function sql(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const psql = spawn(
      'docker',
      [
        'exec',
        '-i',
        databaseContainer(),
        'psql',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-X',
        '-q',
        '-A',
        '-t',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    psql.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    psql.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    psql.on('error', reject);
    psql.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`psql failed (${String(code)}): ${stderr}`));
    });
    psql.stdin.end(script);
  });
}
