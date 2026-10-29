/**
 * Ticket P0-07.4: the `download` Edge Function and the `latest_versions` RPC, over HTTP against
 * the seed catalogue (scripts/seed.ts), with the anon key only, as the desktop app calls them.
 *
 * The signed URL's expiry is tested with the short lifetime the local stack sets in
 * supabase/functions/.env (`DOWNLOAD_URL_TTL_SECONDS`, a few seconds; 60 when unset, as in a
 * deployed Store): the test reads the lifetime from the URL's own token and fetches the URL again
 * once it has passed. The downloads here change the seed's counters, so the seed runs again after.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { diffForReconsent } from '@harness-store/manifest';
import type { Manifest } from '@harness-store/manifest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storeRoot } from '../scripts/local-stack.ts';
import { seed } from '../scripts/seed.ts';
import {
  call,
  createUser,
  deleteUser,
  insertHarness,
  insertVersion,
  isPermissionDenied,
  rest,
  serviceRest,
  sql,
  stack,
} from './support.ts';
import type { Reply, TestUser } from './support.ts';

/** The caller whose token the privacy test sends; it owns nothing. */
let user: TestUser;
/** The Publisher of the Harnesses the tests insert, kept apart from `user` for the privacy scan. */
let owner: TestUser;

beforeAll(async () => {
  user = await createUser();
  owner = await createUser();
});

afterAll(async () => {
  await deleteUser(user);
  await deleteUser(owner);
  await seed();
});

interface DownloadReply {
  url: string;
  sha256: string;
  size: number;
  manifest: Record<string, unknown>;
  error?: { code: string; message: string };
}

/** POST /functions/v1/download with the anon key and nothing else, unless `headers` add more. */
async function download(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Reply<DownloadReply>> {
  const response = await fetch(`${stack.apiUrl}/functions/v1/download`, {
    method: 'POST',
    headers: { apikey: stack.anonKey, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as DownloadReply };
}

interface Counters {
  harness: number;
  versions: Record<string, number>;
  events: number;
}

/** A Harness's download counters and the number of download events of all its versions. */
async function counters(harnessId: string): Promise<Counters> {
  const [harness] = await serviceRest<
    {
      download_count: number;
      harness_versions: { id: string; version: string; download_count: number }[];
    }[]
  >(
    'GET',
    `harnesses?harness_id=eq.${encodeURIComponent(harnessId)}&select=download_count,harness_versions(id,version,download_count)`,
  );
  if (harness === undefined) throw new Error(`No Harness ${harnessId}`);
  const ids = harness.harness_versions.map((version) => version.id);
  const events = await serviceRest<unknown[]>(
    'GET',
    `download_events?version_id=in.(${ids.join(',')})&select=id`,
  );
  return {
    harness: harness.download_count,
    versions: Object.fromEntries(
      harness.harness_versions.map((version) => [version.version, version.download_count]),
    ),
    events: events.length,
  };
}

/** The stored row of a Harness Version (service role, any status). */
async function storedVersion(harnessId: string, version: string) {
  const [row] = await serviceRest<
    {
      id: string;
      manifest: Record<string, unknown>;
      package_sha256: string;
      package_size: number;
    }[]
  >(
    'GET',
    `harness_versions?select=id,manifest,package_sha256,package_size,harnesses!inner(harness_id)&harnesses.harness_id=eq.${encodeURIComponent(harnessId)}&version=eq.${encodeURIComponent(version)}`,
  );
  if (row === undefined) throw new Error(`No version ${harnessId}@${version}`);
  return row;
}

/** The claims of the token in a signed URL's query (`iat`, `exp`, in seconds). */
function tokenClaims(url: string): { iat: number; exp: number } {
  const token = new URL(url).searchParams.get('token') ?? '';
  const payload = token.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    iat: number;
    exp: number;
  };
}

/** DOWNLOAD_URL_TTL_SECONDS as supabase/functions/.env sets it for the local stack. */
function localTtlSeconds(): number {
  const env = readFileSync(join(storeRoot(), 'supabase', 'functions', '.env'), 'utf8');
  return Number(/^DOWNLOAD_URL_TTL_SECONDS=(\d+)$/m.exec(env)?.[1]);
}

const ASK = { platform: 'linux-x64', app_version: '0.1.0' };

describe('download: which version', () => {
  it('without a version, resolves the latest published version (an Unpublished newer one is skipped)', async () => {
    // alice/hello-web: 0.1.0 published, 0.2.0 Unpublished.
    const reply = await download({ harness_id: 'alice/hello-web', ...ASK });
    expect(reply.status).toBe(200);
    expect(reply.body.manifest.version).toBe('0.1.0');
    const stored = await storedVersion('alice/hello-web', '0.1.0');
    expect(reply.body).toEqual({
      url: expect.any(String) as string,
      sha256: stored.package_sha256,
      size: stored.package_size,
      manifest: stored.manifest,
    });

    // alice/code-reviewer: 2.0.0 and 2.1.0-beta.3, which sorts above it.
    const latest = await download({ harness_id: 'alice/code-reviewer', ...ASK });
    expect(latest.status).toBe(200);
    expect(latest.body.manifest.version).toBe('2.1.0-beta.3');
  });

  it('downloads a named published version that is not the latest', async () => {
    const reply = await download({ harness_id: 'alice/code-reviewer', version: '2.0.0', ...ASK });
    expect(reply.status).toBe(200);
    expect(reply.body.manifest.version).toBe('2.0.0');
  });

  it('is 404 for an Unpublished or taken-down version, an Unpublished-only or taken-down Harness and an unknown one, counting nothing', async () => {
    const before = await counters('alice/hello-web');
    for (const request of [
      { harness_id: 'alice/hello-web', version: '0.2.0' },
      { harness_id: 'alice/hello-web', version: '9.9.9' },
      { harness_id: 'bob/retired-tool' },
      { harness_id: 'bob/retired-tool', version: '1.0.0' },
      { harness_id: 'carol/bad-tool' },
      { harness_id: 'carol/bad-tool', version: '1.0.0' },
      { harness_id: `nobody-${randomUUID().slice(0, 8)}/missing` },
    ]) {
      const reply = await download({ ...request, ...ASK });
      expect({ request, status: reply.status, code: reply.body.error?.code }).toEqual({
        request,
        status: 404,
        code: 'not_found',
      });
    }
    expect(await counters('alice/hello-web')).toEqual(before);
    expect((await counters('bob/retired-tool')).events).toBe(0);
    expect((await counters('carol/bad-tool')).events).toBe(0);
  });
});

describe('download: platform and counters', () => {
  it('counts a download for a supported platform exactly once, on the version and on the Harness', async () => {
    const before = await counters('alice/code-reviewer');
    const reply = await download({
      harness_id: 'alice/code-reviewer',
      version: '2.0.0',
      platform: 'darwin-arm64',
      app_version: '0.3.1',
    });
    expect(reply.status).toBe(200);
    const after = await counters('alice/code-reviewer');
    expect(after).toEqual({
      harness: before.harness + 1,
      versions: { ...before.versions, '2.0.0': (before.versions['2.0.0'] ?? 0) + 1 },
      events: before.events + 1,
    });

    const { id } = await storedVersion('alice/code-reviewer', '2.0.0');
    const events = await serviceRest<Record<string, unknown>[]>(
      'GET',
      `download_events?version_id=eq.${id}&order=id.desc&limit=1`,
    );
    expect(events[0]).toEqual({
      id: expect.any(Number) as number,
      version_id: id,
      platform: 'darwin-arm64',
      app_version: '0.3.1',
      created_at: expect.any(String) as string,
    });
  });

  it('refuses a platform the version does not declare with 422, before any URL and counting nothing', async () => {
    // alice/code-reviewer declares darwin-arm64, win32-x64 and linux-x64 only.
    const before = await counters('alice/code-reviewer');
    for (const version of [undefined, '2.0.0']) {
      const reply = await download({
        harness_id: 'alice/code-reviewer',
        ...(version === undefined ? {} : { version }),
        platform: 'darwin-x64',
        app_version: '0.3.1',
      });
      expect(reply).toEqual({
        status: 422,
        body: { error: { code: 'platform_not_supported', message: expect.any(String) as string } },
      });
    }
    expect(await counters('alice/code-reviewer')).toEqual(before);
  });

  it('refuses a malformed request with 400, counting nothing', async () => {
    const before = await counters('alice/hello-web');
    for (const body of [
      'not json',
      [],
      { platform: 'linux-x64', app_version: '1' },
      { harness_id: 'alice/hello-web', app_version: '1' },
      { harness_id: 'alice/hello-web', platform: 'linux', app_version: '1' },
      { harness_id: 'alice/hello-web', platform: 'linux-x64' },
      { harness_id: 'alice/hello-web', platform: 'linux-x64', app_version: 'x'.repeat(65) },
      { harness_id: 'alice/hello-web', version: 1, platform: 'linux-x64', app_version: '1' },
    ]) {
      const reply = await download(body);
      expect({ body, status: reply.status, code: reply.body.error?.code }).toEqual({
        body,
        status: 400,
        code: 'invalid_request',
      });
    }
    expect(await counters('alice/hello-web')).toEqual(before);
  });

  it('answers anything but POST with 405', async () => {
    const reply = await call('anon', 'GET', 'functions/v1/download');
    expect(reply.status).toBe(405);
  });

  it('counts nothing when the version stopped being published after it was resolved (record_download)', async () => {
    // What the function does last, called directly: the version is Unpublished by then.
    const before = await counters('alice/hello-web');
    const { id } = await storedVersion('alice/hello-web', '0.2.0');
    const reply = await rest('service', 'POST', 'rpc/record_download', {
      version_id: id,
      platform: 'linux-x64',
      app_version: '0.1.0',
    });
    expect(reply.status).toBe(404);
    expect(reply.body).toMatchObject({ code: 'PT404', message: 'not_found' });
    expect(await counters('alice/hello-web')).toEqual(before);
  });

  it('counts nothing when the Harness was taken down after the version was resolved (record_download)', async () => {
    // The Takedown commits between the function's lookup and its count: the Harness is taken down
    // while its version is still published, so only record_download's Harness check can refuse.
    const harness = await insertHarness(owner, 'taken-down-while-counting');
    const version = await insertVersion(harness, '1.0.0');
    await serviceRest('PATCH', `harnesses?id=eq.${harness.id}`, { status: 'taken_down' });
    const before = await counters(harness.harness_id);
    expect(before).toEqual({ harness: 0, versions: { '1.0.0': 0 }, events: 0 });

    const reply = await rest('service', 'POST', 'rpc/record_download', {
      version_id: version.id,
      platform: 'linux-x64',
      app_version: '0.1.0',
    });
    expect(reply.status).toBe(404);
    expect(reply.body).toMatchObject({ code: 'PT404', message: 'not_found' });
    expect(await counters(harness.harness_id)).toEqual(before);
  });

  it('record_download is not an RPC for anon or a Publisher', async () => {
    const { id } = await storedVersion('alice/hello-web', '0.1.0');
    for (const caller of ['anon', { token: user.token }] as const) {
      const reply = await rest(caller, 'POST', 'rpc/record_download', {
        version_id: id,
        platform: 'linux-x64',
        app_version: '0.1.0',
      });
      expect(isPermissionDenied(reply)).toBe(true);
    }
  });
});

describe('download: the signed URL', () => {
  it('is valid at once, on the public origin, for the package whose checksum and size it gave', async () => {
    const reply = await download({ harness_id: 'alice/hello-web', ...ASK });
    expect(reply.status).toBe(200);
    expect(
      reply.body.url.startsWith(`${stack.apiUrl}/storage/v1/object/sign/harness-packages/`),
    ).toBe(true);
    const response = await fetch(reply.body.url);
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBe(reply.body.size);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(reply.body.sha256);
  });

  it('stops working once its lifetime has passed', async () => {
    const reply = await download({ harness_id: 'alice/hello-web', ...ASK });
    expect(reply.status).toBe(200);
    const { iat, exp } = tokenClaims(reply.body.url);
    // The local stack's short test lifetime; a deployed Store's is 60 s (signedUrlTtl).
    expect(exp - iat).toBe(localTtlSeconds());
    expect(exp - iat).toBeLessThanOrEqual(60);
    expect((await fetch(reply.body.url)).status).toBe(200);

    // Past `exp`, with a margin for the clocks of the test and of the Storage container.
    await sleep(Math.max(0, exp * 1000 - Date.now()) + 2000);
    const expired = await fetch(reply.body.url);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ error: 'InvalidJWT' });
  });
});

describe('download: privacy', () => {
  it('download_events has no column that could hold an IP address or a user', async () => {
    const columns = await sql(`
      select column_name || ':' || data_type
      from information_schema.columns
      where table_schema = 'public' and table_name = 'download_events'
      order by ordinal_position;
    `);
    expect(columns.split('\n')).toEqual([
      'id:bigint',
      'version_id:uuid',
      'platform:text',
      'app_version:text',
      'created_at:timestamp with time zone',
    ]);
    // Its only reference is to the Harness Version.
    const references = await sql(`
      select confrelid::regclass::text
      from pg_constraint
      where conrelid = 'public.download_events'::regclass and contype = 'f';
    `);
    expect(references).toBe('harness_versions');
  });

  it("stores neither the caller's IP address nor their user, wherever in the database", async () => {
    const ip = '203.0.113.77';
    const reply = await download(
      { harness_id: 'bob/xiezuo', ...ASK },
      { 'x-forwarded-for': ip, 'x-real-ip': ip, authorization: `Bearer ${user.token}` },
    );
    expect(reply.status).toBe(200);
    expect((await counters('bob/xiezuo')).events).toBe(1);

    // Every row of every table of the Store's schema and of Storage, as text. The user's id is
    // only in their own profile, which the test created.
    const found = await sql(`
      select n.nspname || '.' || c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'storage') and c.relkind = 'r'
        and (
          query_to_xml(format('select * from %I.%I', n.nspname, c.relname), true, false, '')::text
            like '%${ip}%'
          or (
            (n.nspname, c.relname) <> ('public', 'profiles')
            and query_to_xml(format('select * from %I.%I', n.nspname, c.relname), true, false, '')::text
              like '%${user.id}%'
          )
        );
    `);
    expect(found).toBe('');
  });
});

interface LatestVersion {
  harness_id: string;
  store_status: 'available' | 'unpublished' | 'taken_down' | 'not_found';
  latest_version: string | null;
  manifest: Record<string, unknown> | null;
}

function latestVersions(
  caller: 'anon' | { token: string },
  ids: unknown,
): Promise<Reply<LatestVersion[]>> {
  return rest<LatestVersion[]>(caller, 'POST', 'rpc/latest_versions', { harness_ids: ids });
}

describe('latest_versions', () => {
  it('reports each Harness of a mixed batch, in the order asked, from what is in the database', async () => {
    const missing = `nobody-${randomUUID().slice(0, 8)}/missing`;
    const ids = [
      'alice/hello-web',
      'bob/retired-tool',
      'carol/bad-tool',
      missing,
      'alice/code-reviewer',
    ];
    const helloWeb = await storedVersion('alice/hello-web', '0.1.0');
    const reviewer = await storedVersion('alice/code-reviewer', '2.1.0-beta.3');
    for (const caller of ['anon', { token: user.token }] as const) {
      const reply = await latestVersions(caller, ids);
      expect(reply).toEqual({
        status: 200,
        body: [
          // 0.2.0 is Unpublished: the latest published version is 0.1.0.
          {
            harness_id: 'alice/hello-web',
            store_status: 'available',
            latest_version: '0.1.0',
            manifest: helloWeb.manifest,
          },
          {
            harness_id: 'bob/retired-tool',
            store_status: 'unpublished',
            latest_version: null,
            manifest: null,
          },
          {
            harness_id: 'carol/bad-tool',
            store_status: 'taken_down',
            latest_version: null,
            manifest: null,
          },
          { harness_id: missing, store_status: 'not_found', latest_version: null, manifest: null },
          {
            harness_id: 'alice/code-reviewer',
            store_status: 'available',
            latest_version: '2.1.0-beta.3',
            manifest: reviewer.manifest,
          },
        ],
      });
    }
  });

  it('gives what the re-consent diff needs: permissions, runtime and Entry of the latest version', async () => {
    const [row] = (await latestVersions('anon', ['alice/code-reviewer'])).body;
    const installed = await storedVersion('alice/code-reviewer', '2.0.0');
    expect(row?.manifest).toMatchObject({
      permissions: installed.manifest.permissions,
      runtime: { kind: 'binary' },
      entry: installed.manifest.entry,
    });
    const diff = diffForReconsent(
      installed.manifest as unknown as Manifest,
      row?.manifest as unknown as Manifest,
    );
    expect(diff.required).toBe(false);
  });

  it('reports a taken-down Harness as taken down even while a version of it is still published', async () => {
    const harness = await insertHarness(owner, 'taken-down-later');
    await insertVersion(harness, '1.0.0');
    const [before] = (await latestVersions('anon', [harness.harness_id])).body;
    expect(before).toMatchObject({ store_status: 'available', latest_version: '1.0.0' });

    await serviceRest('PATCH', `harnesses?id=eq.${harness.id}`, { status: 'taken_down' });
    const [after] = (await latestVersions('anon', [harness.harness_id])).body;
    expect(after).toEqual({
      harness_id: harness.harness_id,
      store_status: 'taken_down',
      latest_version: null,
      manifest: null,
    });
    const blocked = await download({ harness_id: harness.harness_id, ...ASK });
    expect(blocked.status).toBe(404);
  });

  it('does not report a version-level Takedown of the latest version: it falls back to the previous one, then to unpublished', async () => {
    const harness = await insertHarness(owner, 'version-taken-down');
    const first = await insertVersion(harness, '1.0.0');
    const second = await insertVersion(harness, '2.0.0');
    const [before] = (await latestVersions('anon', [harness.harness_id])).body;
    expect(before).toMatchObject({ store_status: 'available', latest_version: '2.0.0' });

    // A User with 2.0.0 installed is told 1.0.0 is the latest: lower than theirs, not an update.
    await serviceRest('PATCH', `harness_versions?id=eq.${second.id}`, { status: 'taken_down' });
    const [previous] = (await latestVersions('anon', [harness.harness_id])).body;
    expect(previous).toMatchObject({ store_status: 'available', latest_version: '1.0.0' });
    expect(previous?.manifest).toMatchObject({ version: '1.0.0' });

    // With no published version left, the Harness reads as Unpublished, not taken down.
    await serviceRest('PATCH', `harness_versions?id=eq.${first.id}`, { status: 'taken_down' });
    const [none] = (await latestVersions('anon', [harness.harness_id])).body;
    expect(none).toEqual({
      harness_id: harness.harness_id,
      store_status: 'unpublished',
      latest_version: null,
      manifest: null,
    });
  });

  it('answers every ID it is given, duplicates included, and nothing for an empty batch', async () => {
    const reply = await latestVersions('anon', ['bob/xiezuo', 'bob/xiezuo']);
    expect(reply.body.map((row) => [row.harness_id, row.latest_version])).toEqual([
      ['bob/xiezuo', '1.0.0'],
      ['bob/xiezuo', '1.0.0'],
    ]);
    expect(await latestVersions('anon', [])).toEqual({ status: 200, body: [] });
  });

  it('takes at most 1000 Harness IDs', async () => {
    const ids = Array.from({ length: 1000 }, (_, index) => `nobody/h-${String(index)}`);
    const most = await latestVersions('anon', ids);
    expect(most.status).toBe(200);
    expect(most.body).toHaveLength(1000);
    const tooMany = await latestVersions('anon', [...ids, 'nobody/one-more']);
    expect(tooMany.status).toBe(400);
  });
});
