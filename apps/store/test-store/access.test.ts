/**
 * Ticket P0-07.1: what anon (the desktop app) and an authenticated Publisher may read and write
 * through PostgREST, against the seed catalogue (scripts/seed.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, deleteUser, isPermissionDenied, rest, serviceRest } from './support.ts';
import type { Caller, TestUser } from './support.ts';

interface Profile {
  id: string;
  github_login: string;
  display_name: string | null;
  bio: string | null;
}

let publisher: TestUser;
let other: TestUser;

beforeAll(async () => {
  publisher = await createUser('Mixed-Case-Login');
  other = await createUser();
});

afterAll(async () => {
  await deleteUser(publisher);
  await deleteUser(other);
});

// is_admin is not readable, so writes ask for the readable columns back instead of `*`.
const OWN_COLUMNS = 'select=id,github_login,display_name,bio';

const VISIBLE = ['alice/code-reviewer', 'alice/hello-web', 'bob/xiezuo'];

describe('reads of the seed catalogue', () => {
  for (const [who, caller] of [
    ['anon', 'anon'],
    ['a Publisher', 'publisher'],
  ] as const) {
    const as = (): Caller => (caller === 'anon' ? 'anon' : { token: publisher.token });

    it(`${who} sees only active Harnesses with a published version`, async () => {
      const reply = await rest<{ harness_id: string }[]>(
        as(),
        'GET',
        'harnesses?select=harness_id&order=harness_id',
      );
      expect(reply.status).toBe(200);
      // Not bob/retired-tool (its only version is Unpublished) nor carol/bad-tool (taken down).
      expect(reply.body.map((row) => row.harness_id)).toEqual(VISIBLE);
    });

    it(`${who} sees only published versions of active Harnesses`, async () => {
      const reply = await rest<
        { version: string; status: string; harnesses: { harness_id: string } }[]
      >(as(), 'GET', 'harness_versions?select=version,status,harnesses(harness_id)');
      expect(reply.status).toBe(200);
      const seen = reply.body.map((row) => `${row.harnesses.harness_id}@${row.version}`).sort();
      expect(seen).toEqual([
        'alice/code-reviewer@2.0.0',
        'alice/code-reviewer@2.1.0-beta.3',
        'alice/hello-web@0.1.0',
        'bob/xiezuo@1.0.0',
      ]);
    });
  }

  it('the Unpublished-only Harness and its version exist, but anon cannot read them', async () => {
    const [retired] = await serviceRest<{ id: string }[]>(
      'GET',
      'harnesses?harness_id=eq.bob/retired-tool',
    );
    expect(retired).toBeDefined();
    expect(await rest('anon', 'GET', 'harnesses?harness_id=eq.bob/retired-tool')).toEqual({
      status: 200,
      body: [],
    });
    expect(
      await rest('anon', 'GET', `harness_versions?harness_id=eq.${retired?.id ?? ''}`),
    ).toEqual({
      status: 200,
      body: [],
    });
  });

  it('the latest version of a Harness whose newest version is Unpublished is the previous one', async () => {
    const reply = await rest<{ latest_version: string; harness_versions: { version: string }[] }[]>(
      'anon',
      'GET',
      'harnesses?harness_id=eq.alice/hello-web&select=latest_version,harness_versions(version)',
    );
    expect(reply.body).toEqual([
      { latest_version: '0.1.0', harness_versions: [{ version: '0.1.0' }] },
    ]);
  });

  // The calls docs/tech/api.md documents, exactly as written there.
  const LIST_COLUMNS =
    'harness_id,name,summary,icon_path,tags,download_count,latest_version,latest_published_at';

  it('Featured (api.md) is the Harnesses with a featured_rank, in rank order', async () => {
    const reply = await rest<{ harness_id: string; icon_path: string }[]>(
      'anon',
      'GET',
      `harnesses?featured_rank=not.is.null&order=featured_rank&select=${LIST_COLUMNS}`,
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject([
      {
        harness_id: 'alice/code-reviewer',
        icon_path: 'alice/code-reviewer/2.1.0-beta.3/icon.png',
        latest_version: '2.1.0-beta.3',
        download_count: 1260,
      },
    ]);
  });

  it('the Publisher page (api.md) lists only the visible Harnesses of that Publisher', async () => {
    const page = (login: string) =>
      rest<{ github_login: string; harnesses: { harness_id: string }[] }[]>(
        'anon',
        'GET',
        `profiles?github_login=eq.${login}&select=github_login,display_name,avatar_url,bio,created_at,harnesses(${LIST_COLUMNS})`,
      );
    const bob = await page('bob');
    expect(bob.status).toBe(200);
    expect(bob.body[0]?.harnesses.map((row) => row.harness_id)).toEqual(['bob/xiezuo']);
    expect((await page('carol')).body).toMatchObject([{ github_login: 'carol', harnesses: [] }]);
  });

  it('the Harness detail (api.md) lists its published versions only', async () => {
    const reply = await rest<
      { profiles: { github_login: string }; harness_versions: { version: string }[] }[]
    >(
      'anon',
      'GET',
      'harnesses?harness_id=eq.alice/hello-web&select=*,profiles(github_login,display_name,avatar_url),harness_versions(version,changelog,published_at,platforms,status,download_count)',
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject([
      { profiles: { github_login: 'alice' }, harness_versions: [{ version: '0.1.0' }] },
    ]);
    const hidden = await rest('anon', 'GET', 'harnesses?harness_id=eq.carol/bad-tool&select=*');
    expect(hidden).toEqual({ status: 200, body: [] });
  });

  it('anon and Publishers cannot read Reports or download events at all', async () => {
    for (const caller of ['anon', { token: publisher.token }] as const) {
      for (const table of ['reports', 'download_events']) {
        const reply = await rest(caller, 'GET', table);
        expect(isPermissionDenied(reply)).toBe(true);
      }
    }
  });
});

describe('writes to the catalogue', () => {
  const callers = (): [string, Caller][] => [
    ['anon', 'anon'],
    ['a Publisher', { token: publisher.token }],
  ];

  it('anon and Publishers cannot INSERT, UPDATE or DELETE Harnesses or Harness Versions', async () => {
    const [harness] = await serviceRest<{ id: string; name: string }[]>(
      'GET',
      'harnesses?harness_id=eq.alice/hello-web',
    );
    const [version] = await serviceRest<{ id: string }[]>(
      'GET',
      `harness_versions?harness_id=eq.${harness?.id ?? ''}&version=eq.0.1.0`,
    );
    for (const [who, caller] of callers()) {
      const attempts = [
        rest(caller, 'POST', 'harnesses', {
          publisher_id: publisher.id,
          slug: 'sneaky',
          name: 'S',
          summary: 'S',
        }),
        rest(caller, 'PATCH', `harnesses?id=eq.${harness?.id ?? ''}`, { name: 'Defaced' }),
        rest(caller, 'DELETE', `harnesses?id=eq.${harness?.id ?? ''}`),
        rest(caller, 'POST', 'harness_versions', { harness_id: harness?.id, version: '9.0.0' }),
        rest(caller, 'PATCH', `harness_versions?id=eq.${version?.id ?? ''}`, {
          download_count: 999,
        }),
        rest(caller, 'DELETE', `harness_versions?id=eq.${version?.id ?? ''}`),
        rest(caller, 'POST', 'reports', { harness_id: harness?.id, reason: 'spam' }),
        rest(caller, 'POST', 'download_events', {
          version_id: version?.id,
          platform: 'linux-x64',
          app_version: '1',
        }),
      ];
      for (const reply of await Promise.all(attempts)) {
        expect(isPermissionDenied(reply), who).toBe(true);
      }
    }
    const [after] = await serviceRest<{ name: string; download_count: number }[]>(
      'GET',
      `harnesses?id=eq.${harness?.id ?? ''}`,
    );
    expect(after?.name).toBe(harness?.name);
    expect(await serviceRest<unknown[]>('GET', 'harnesses?slug=eq.sneaky')).toEqual([]);
  });

  it('the internal SQL functions are not RPCs for anon or Publishers', async () => {
    for (const [, caller] of callers()) {
      for (const [name, args] of [
        ['refresh_harness', { target: '00000000-0000-0000-0000-000000000000' }],
        ['semver_key', { version: '1.0.0' }],
      ] as const) {
        const reply = await rest(caller, 'POST', `rpc/${name}`, args);
        expect(reply.status).toBeGreaterThanOrEqual(400);
        expect(reply.status).toBeLessThan(500);
      }
    }
  });
});

describe('profiles', () => {
  it('a GitHub user gets a profile with the lower-cased login, display name from full_name', async () => {
    const [profile] = await serviceRest<Profile[]>('GET', `profiles?id=eq.${publisher.id}`);
    expect(profile).toMatchObject({
      github_login: 'mixed-case-login',
      display_name: 'Test Mixed-Case-Login',
    });
  });

  it('a user of another provider gets no profile', async () => {
    const emailUser = await createUser(undefined, 'email');
    try {
      expect(await serviceRest<unknown[]>('GET', `profiles?id=eq.${emailUser.id}`)).toEqual([]);
    } finally {
      await deleteUser(emailUser);
    }
  });

  it('the public columns are readable by anyone, is_admin is not', async () => {
    const reply = await rest<Profile[]>(
      'anon',
      'GET',
      `profiles?id=eq.${publisher.id}&select=id,github_login,display_name,avatar_url,bio,created_at`,
    );
    expect(reply.body).toHaveLength(1);
    for (const caller of ['anon', { token: publisher.token }] as const) {
      const admin = await rest(caller, 'GET', `profiles?id=eq.${publisher.id}&select=is_admin`);
      expect(isPermissionDenied(admin)).toBe(true);
    }
  });

  it("a Publisher can edit their own display name and bio, not another Publisher's", async () => {
    const own = await rest<Profile[]>(
      { token: publisher.token },
      'PATCH',
      `profiles?id=eq.${publisher.id}&${OWN_COLUMNS}`,
      {
        display_name: 'New Name',
        bio: 'Builds Harnesses.',
      },
    );
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject([{ display_name: 'New Name', bio: 'Builds Harnesses.' }]);

    const theirs = await rest<Profile[]>(
      { token: publisher.token },
      'PATCH',
      `profiles?id=eq.${other.id}&${OWN_COLUMNS}`,
      {
        display_name: 'Hijacked',
      },
    );
    // No row matches the owner policy, so nothing changes.
    expect(theirs).toEqual({ status: 200, body: [] });
    const [unchanged] = await serviceRest<Profile[]>('GET', `profiles?id=eq.${other.id}`);
    expect(unchanged?.display_name).toBe(`Test ${other.userName}`);

    const anon = await rest('anon', 'PATCH', `profiles?id=eq.${publisher.id}&${OWN_COLUMNS}`, {
      display_name: 'Anon',
    });
    expect(anon.status).toBe(401);
  });

  it('a Publisher cannot make themselves an admin or change their login', async () => {
    for (const change of [{ is_admin: true }, { github_login: 'alice' }, { id: other.id }]) {
      const reply = await rest(
        { token: publisher.token },
        'PATCH',
        `profiles?id=eq.${publisher.id}&${OWN_COLUMNS}`,
        change,
      );
      expect(isPermissionDenied(reply)).toBe(true);
    }
    const [profile] = await serviceRest<(Profile & { is_admin: boolean })[]>(
      'GET',
      `profiles?id=eq.${publisher.id}`,
    );
    expect(profile).toMatchObject({ is_admin: false, github_login: 'mixed-case-login' });
  });

  it('a bio over 500 characters is refused', async () => {
    const reply = await rest(
      { token: publisher.token },
      'PATCH',
      `profiles?id=eq.${publisher.id}&${OWN_COLUMNS}`,
      {
        bio: 'x'.repeat(501),
      },
    );
    expect(reply.status).toBe(400);
  });
});
