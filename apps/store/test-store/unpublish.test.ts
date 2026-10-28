/**
 * Ticket P0-07.6: the `unpublish` Edge Function, over HTTP against the local stack. The versions
 * are published through the real `publish` function; what an Unpublish changes is then checked
 * through the public reads of api.md (detail, search, download) with the anon key.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixturePackage, publish } from './packages.ts';
import {
  call,
  callFunction,
  createUser,
  deleteUser,
  insertHarness,
  insertVersion,
  mintJwt,
  rest,
  serviceRest,
} from './support.ts';
import type { TestUser } from './support.ts';

let publisher: TestUser;
let other: TestUser;
let login: string;
/** One search token only this run's Harnesses have in their name. */
const word = `u${randomUUID().replaceAll('-', '').slice(0, 12)}`;

beforeAll(async () => {
  publisher = await createUser();
  other = await createUser();
  login = publisher.userName.toLowerCase();
});

afterAll(async () => {
  await deleteUser(publisher);
  await deleteUser(other);
});

interface UnpublishReply {
  harness_id: string;
  version: string;
  status: string;
  latest_version: string | null;
}

/** POST /functions/v1/unpublish as the test Publisher, or with `as` (a token, or none at all). */
function unpublish(body: unknown, as: { token?: string } = { token: publisher.token }) {
  return callFunction<UnpublishReply>('unpublish', body, as);
}

/** Publishes `<login>/<slug>` at each version, in order, named `<word> <slug>`. */
async function published(slug: string, versions: string[]): Promise<string> {
  const harnessId = `${login}/${slug}`;
  for (const version of versions) {
    const reply = await publish(
      publisher.token,
      fixturePackage('valid-minimal-node', {
        manifest: { id: harnessId, version, name: `${word} ${slug}` },
      }),
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  }
  return harnessId;
}

/** The anon detail read of api.md: the Harness and its (published) versions. */
async function detail(harnessId: string) {
  const reply = await rest<{ latest_version: string; harness_versions: { version: string }[] }[]>(
    'anon',
    'GET',
    `harnesses?harness_id=eq.${encodeURIComponent(harnessId)}&select=*,profiles(github_login,display_name,avatar_url),harness_versions(version,changelog,published_at,platforms,status,download_count)`,
  );
  expect(reply.status).toBe(200);
  return reply.body[0];
}

async function searchIds(q: string): Promise<string[]> {
  const reply = await rest<{ harness_id: string; latest_version: string }[]>(
    'anon',
    'POST',
    'rpc/search_harnesses',
    { q },
  );
  expect(reply.status).toBe(200);
  return reply.body.map((row) => `${row.harness_id}@${row.latest_version}`);
}

async function stored(harnessId: string) {
  const [row] = await serviceRest<
    {
      status: string;
      latest_version: string | null;
      harness_versions: { version: string; status: string; unpublished_at: string | null }[];
    }[]
  >(
    'GET',
    `harnesses?harness_id=eq.${encodeURIComponent(harnessId)}&select=status,latest_version,harness_versions(version,status,unpublished_at)&harness_versions.order=version`,
  );
  if (row === undefined) throw new Error(`No Harness ${harnessId}`);
  return row;
}

describe('unpublish', () => {
  it('withdraws the newer version: the older one becomes latest_version and the newer one leaves every public read', async () => {
    const harnessId = await published('two-versions', ['1.0.0', '1.1.0']);
    expect((await detail(harnessId))?.latest_version).toBe('1.1.0');
    expect(await searchIds(`${word} two-versions`)).toEqual([`${harnessId}@1.1.0`]);

    const reply = await unpublish({ harness_id: harnessId, version: '1.1.0' });
    expect(reply).toEqual({
      status: 200,
      body: {
        harness_id: harnessId,
        version: '1.1.0',
        status: 'unpublished',
        latest_version: '1.0.0',
      },
    });

    const shown = await detail(harnessId);
    expect(shown?.latest_version).toBe('1.0.0');
    expect(shown?.harness_versions.map((version) => version.version)).toEqual(['1.0.0']);
    expect(await searchIds(`${word} two-versions`)).toEqual([`${harnessId}@1.0.0`]);
    const direct = await rest<unknown[]>(
      'anon',
      'GET',
      `harness_versions?version=eq.1.1.0&harnesses.harness_id=eq.${encodeURIComponent(harnessId)}&select=version,harnesses!inner(harness_id)`,
    );
    expect(direct).toEqual({ status: 200, body: [] });

    const asked = { harness_id: harnessId, platform: 'linux-x64', app_version: '0.1.0' };
    const newer = await callFunction('download', { ...asked, version: '1.1.0' });
    expect(newer.status).toBe(404);
    const latest = await callFunction<{ manifest: { version: string } }>('download', asked);
    expect(latest.status).toBe(200);
    expect(latest.body.manifest.version).toBe('1.0.0');

    const row = await stored(harnessId);
    expect(row.status).toBe('active');
    expect(row.harness_versions).toEqual([
      { version: '1.0.0', status: 'published', unpublished_at: null },
      { version: '1.1.0', status: 'unpublished', unpublished_at: expect.any(String) as string },
    ]);
  });

  it('is idempotent: unpublishing an already-Unpublished version succeeds and changes nothing', async () => {
    const harnessId = await published('idempotent', ['1.0.0', '2.0.0']);
    const first = await unpublish({ harness_id: harnessId, version: '2.0.0' });
    expect(first.status).toBe(200);
    const before = await stored(harnessId);

    const again = await unpublish({ harness_id: harnessId, version: '2.0.0' });
    expect(again).toEqual(first);
    expect(await stored(harnessId)).toEqual(before);
  });

  it('withdrawing the only published version leaves the Harness active but hidden, with no latest version', async () => {
    const harnessId = await published('only-one', ['0.1.0']);
    const reply = await unpublish({ harness_id: harnessId, version: '0.1.0' });
    expect(reply.body).toMatchObject({ status: 'unpublished', latest_version: null });

    expect(await detail(harnessId)).toBeUndefined();
    expect(await searchIds(`${word} only-one`)).toEqual([]);
    const row = await stored(harnessId);
    expect(row).toMatchObject({ status: 'active', latest_version: null });
    const check = await rest<{ store_status: string }[]>('anon', 'POST', 'rpc/latest_versions', {
      harness_ids: [harnessId],
    });
    expect(check.body).toEqual([expect.objectContaining({ store_status: 'unpublished' })]);
  });

  it('refuses a caller who is not signed in, or whose token Auth refuses (401)', async () => {
    const harnessId = await published('signed-out', ['1.0.0']);
    for (const token of [undefined, 'not-a-jwt', mintJwt(publisher.id, -60)]) {
      const reply = await unpublish({ harness_id: harnessId, version: '1.0.0' }, { token });
      expect(reply.status, String(token)).toBe(401);
      expect(reply.body.error?.code).toBe('unauthenticated');
    }
    expect((await stored(harnessId)).latest_version).toBe('1.0.0');
  });

  it("refuses another Publisher's Harness (403) and leaves it published", async () => {
    const harnessId = await published('not-yours', ['1.0.0']);
    const reply = await unpublish(
      { harness_id: harnessId, version: '1.0.0' },
      { token: other.token },
    );
    expect(reply.status).toBe(403);
    expect(reply.body.error?.code).toBe('forbidden');
    expect((await stored(harnessId)).harness_versions[0]?.status).toBe('published');
  });

  it('answers 404 for an unknown Harness or version, and 400 for a malformed body', async () => {
    const harnessId = await published('lookups', ['1.0.0']);
    for (const body of [
      { harness_id: `${login}/no-such-harness`, version: '1.0.0' },
      { harness_id: harnessId, version: '9.9.9' },
    ]) {
      const reply = await unpublish(body);
      expect(reply.status, JSON.stringify(body)).toBe(404);
      expect(reply.body.error?.code).toBe('not_found');
    }
    for (const body of [
      {},
      { harness_id: harnessId },
      { harness_id: harnessId, version: 1 },
      'x',
    ]) {
      const reply = await unpublish(body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(reply.body.error?.code).toBe('invalid_request');
    }
  });

  it('refuses a taken-down version (409 harness_taken_down) and leaves its status as it is', async () => {
    const harness = await insertHarness(publisher, 'taken-down-version');
    await insertVersion(harness, '1.0.0');
    const version = await insertVersion(harness, '2.0.0');
    await serviceRest('PATCH', `harness_versions?id=eq.${version.id}`, { status: 'taken_down' });

    const reply = await unpublish({ harness_id: harness.harness_id, version: '2.0.0' });
    expect(reply.status).toBe(409);
    expect(reply.body.error?.code).toBe('harness_taken_down');
    const [row] = await serviceRest<{ status: string }[]>(
      'GET',
      `harness_versions?id=eq.${version.id}&select=status`,
    );
    expect(row?.status).toBe('taken_down');
  });

  it('only answers POST', async () => {
    const reply = await call('anon', 'GET', 'functions/v1/unpublish');
    expect(reply.status).toBe(405);
  });
});
