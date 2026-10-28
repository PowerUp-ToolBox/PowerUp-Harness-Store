/**
 * Ticket P0-07.6: the `admin` Edge Function's `admin/takedown`, over HTTP against the local stack,
 * and the Publisher-only read policy that shows the owning Publisher the takedown note. The
 * administrator is a test Publisher with `profiles.is_admin` set, as an administrator is set by
 * hand in the real Store.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  callFunction,
  createUser,
  deleteUser,
  insertHarness,
  insertVersion,
  isPermissionDenied,
  makeAdmin,
  mintJwt,
  rest,
  serviceRest,
  sql,
  versionRow,
} from './support.ts';
import type { HarnessRow, TestUser } from './support.ts';

let owner: TestUser;
let other: TestUser;
let admin: TestUser;

beforeAll(async () => {
  owner = await createUser();
  other = await createUser();
  admin = await createUser();
  await makeAdmin(admin);
});

afterAll(async () => {
  await deleteUser(owner);
  await deleteUser(other);
  await deleteUser(admin);
});

interface TakedownReply {
  harness_id: string;
  version: string | null;
  status: string;
  resolved_reports: number;
}

function takedown(body: unknown, token: string | undefined, path = 'admin/takedown') {
  return callFunction<TakedownReply>(path, body, { token });
}

/** A Harness of the owner with these versions, each published unless it says otherwise. */
async function harnessWith(
  slug: string,
  versions: [string, ('unpublished' | 'published')?][],
): Promise<HarnessRow> {
  const harness = await insertHarness(owner, slug);
  for (const [version, status] of versions) {
    const row = await insertVersion(harness, version);
    if (status === 'unpublished') {
      await serviceRest('PATCH', `harness_versions?id=eq.${row.id}`, {
        status: 'unpublished',
        unpublished_at: new Date().toISOString(),
      });
    }
  }
  return harness;
}

/** A Report on the Harness (and version), stored directly, open unless `status` says otherwise. */
async function reportOn(
  harness: HarnessRow,
  fields: { version_id?: string; status?: 'open' | 'dismissed' } = {},
): Promise<string> {
  const [row] = await serviceRest<{ id: string }[]>('POST', 'reports', {
    harness_id: harness.id,
    reason: 'malware',
    ...fields,
  });
  if (row === undefined) throw new Error('No Report returned');
  return row.id;
}

async function versionsOf(harness: HarnessRow) {
  return serviceRest<
    { id: string; version: string; status: string; takedown_note: string | null }[]
  >(
    'GET',
    `harness_versions?harness_id=eq.${harness.id}&select=id,version,status,takedown_note&order=version`,
  );
}

async function reportsOf(harness: HarnessRow) {
  return serviceRest<
    { id: string; status: string; resolution_note: string | null; resolved_at: string | null }[]
  >('GET', `reports?harness_id=eq.${harness.id}&select=id,status,resolution_note,resolved_at`);
}

async function actionsOn(harness: HarnessRow) {
  return serviceRest<
    {
      admin_id: string;
      action: string;
      target_harness_id: string;
      target_version_id: string | null;
      note: string;
    }[]
  >(
    'GET',
    `admin_actions?target_harness_id=eq.${harness.id}&select=admin_id,action,target_harness_id,target_version_id,note&order=created_at`,
  );
}

async function harnessState(harness: HarnessRow) {
  const [row] = await serviceRest<{ status: string; latest_version: string | null }[]>(
    'GET',
    `harnesses?id=eq.${harness.id}&select=status,latest_version`,
  );
  return row;
}

describe('admin/takedown: who may call it', () => {
  it('refuses a signed-in User who is not an administrator (403), and changes nothing', async () => {
    const harness = await harnessWith('not-admin', [['1.0.0']]);
    await reportOn(harness);
    for (const caller of [other, owner]) {
      const reply = await takedown({ harness_id: harness.harness_id, note: 'No.' }, caller.token);
      expect(reply.status).toBe(403);
      expect(reply.body.error?.code).toBe('forbidden');
    }
    expect(await harnessState(harness)).toEqual({ status: 'active', latest_version: '1.0.0' });
    expect((await reportsOf(harness)).map((report) => report.status)).toEqual(['open']);
    expect(await actionsOn(harness)).toEqual([]);
  });

  it('refuses a caller with no session or a refused token (401)', async () => {
    const harness = await harnessWith('signed-out', [['1.0.0']]);
    for (const token of [undefined, 'not-a-jwt']) {
      const reply = await takedown({ harness_id: harness.harness_id, note: 'No.' }, token);
      expect(reply.status, String(token)).toBe(401);
      expect(reply.body.error?.code).toBe('unauthenticated');
    }
    expect((await harnessState(harness))?.status).toBe('active');
  });

  it('reads is_admin from the profile, never from a claim of the JWT', async () => {
    const harness = await harnessWith('claim', [['1.0.0']]);
    const claiming = mintJwt(other.id, 3600, {
      is_admin: true,
      app_metadata: { provider: 'github', is_admin: true },
      user_metadata: { is_admin: true },
    });
    const reply = await takedown({ harness_id: harness.harness_id, note: 'No.' }, claiming);
    expect(reply.status).toBe(403);
    expect((await harnessState(harness))?.status).toBe('active');
  });

  it('serves only admin/takedown, and only POST', async () => {
    const other = await takedown({}, admin.token, 'admin/feature');
    expect(other.status).toBe(404);
    expect(other.body.error?.code).toBe('not_found');
    expect((await call({ token: admin.token }, 'GET', 'functions/v1/admin/takedown')).status).toBe(
      405,
    );
  });
});

describe('admin/takedown by an administrator', () => {
  it('with a version: takes down only that version, resolves every open Report and logs one action', async () => {
    const harness = await harnessWith('one-version', [['1.0.0'], ['2.0.0']]);
    const [first, second] = await versionsOf(harness);
    const onVersion = await reportOn(harness, { version_id: second?.id });
    const onHarness = await reportOn(harness);
    const dismissed = await reportOn(harness, { status: 'dismissed' });

    const note = 'Version 2.0.0 sends files to an unknown server.';
    const reply = await takedown(
      { harness_id: harness.harness_id, version: '2.0.0', note },
      admin.token,
    );
    expect(reply).toEqual({
      status: 200,
      body: {
        harness_id: harness.harness_id,
        version: '2.0.0',
        status: 'taken_down',
        resolved_reports: 2,
      },
    });

    expect(await versionsOf(harness)).toEqual([
      { id: first?.id, version: '1.0.0', status: 'published', takedown_note: null },
      { id: second?.id, version: '2.0.0', status: 'taken_down', takedown_note: note },
    ]);
    expect(await harnessState(harness)).toEqual({ status: 'active', latest_version: '1.0.0' });

    const reports = new Map((await reportsOf(harness)).map((report) => [report.id, report]));
    for (const id of [onVersion, onHarness]) {
      expect(reports.get(id)).toMatchObject({ status: 'resolved', resolution_note: note });
      expect(reports.get(id)?.resolved_at).not.toBeNull();
    }
    expect(reports.get(dismissed)).toMatchObject({ status: 'dismissed', resolution_note: null });

    expect(await actionsOn(harness)).toEqual([
      {
        admin_id: admin.id,
        action: 'takedown_version',
        target_harness_id: harness.id,
        target_version_id: second?.id,
        note,
      },
    ]);
  });

  it('without a version: takes down the Harness and every one of its versions, which disappear from every public read', async () => {
    const harness = await harnessWith('whole', [['1.0.0'], ['1.1.0', 'unpublished'], ['2.0.0']]);
    await reportOn(harness);
    const note = 'Malware in every version.';

    const reply = await takedown({ harness_id: harness.harness_id, note }, admin.token);
    expect(reply).toEqual({
      status: 200,
      body: {
        harness_id: harness.harness_id,
        version: null,
        status: 'taken_down',
        resolved_reports: 1,
      },
    });

    expect(
      (await versionsOf(harness)).map(({ version, status, takedown_note }) => ({
        version,
        status,
        takedown_note,
      })),
    ).toEqual([
      { version: '1.0.0', status: 'taken_down', takedown_note: note },
      { version: '1.1.0', status: 'taken_down', takedown_note: note },
      { version: '2.0.0', status: 'taken_down', takedown_note: note },
    ]);
    expect(await harnessState(harness)).toEqual({ status: 'taken_down', latest_version: null });
    expect((await reportsOf(harness)).map((report) => report.status)).toEqual(['resolved']);
    expect(await actionsOn(harness)).toEqual([
      {
        admin_id: admin.id,
        action: 'takedown_harness',
        target_harness_id: harness.id,
        target_version_id: null,
        note,
      },
    ]);

    const detail = await rest('anon', 'GET', `harnesses?harness_id=eq.${harness.harness_id}`);
    expect(detail).toEqual({ status: 200, body: [] });
    const check = await rest('anon', 'POST', 'rpc/latest_versions', {
      harness_ids: [harness.harness_id],
    });
    expect(check.body).toEqual([
      {
        harness_id: harness.harness_id,
        store_status: 'taken_down',
        latest_version: null,
        manifest: null,
      },
    ]);
    const download = await callFunction('download', {
      harness_id: harness.harness_id,
      version: '1.0.0',
      platform: 'linux-x64',
      app_version: '0.1.0',
    });
    expect(download.status).toBe(404);
  });

  it('writes exactly one admin_actions row per call, also when it was already taken down', async () => {
    const harness = await harnessWith('twice', [['1.0.0']]);
    const first = await takedown({ harness_id: harness.harness_id, note: 'First.' }, admin.token);
    expect(first.status).toBe(200);
    await reportOn(harness);

    const again = await takedown({ harness_id: harness.harness_id, note: 'Again.' }, admin.token);
    expect(again.status).toBe(200);
    expect(again.body.resolved_reports).toBe(1);
    const byVersion = await takedown(
      { harness_id: harness.harness_id, version: '1.0.0', note: 'And the version.' },
      admin.token,
    );
    expect(byVersion.status).toBe(200);
    expect(byVersion.body.resolved_reports).toBe(0);

    expect((await actionsOn(harness)).map((action) => [action.action, action.note])).toEqual([
      ['takedown_harness', 'First.'],
      ['takedown_harness', 'Again.'],
      ['takedown_version', 'And the version.'],
    ]);
    // The note stays the one of the takedown that changed the version.
    expect((await versionsOf(harness))[0]?.takedown_note).toBe('First.');
  });

  it('answers 404 for an unknown Harness or version, and 400 without a note', async () => {
    const harness = await harnessWith('lookups', [['1.0.0']]);
    for (const body of [
      { harness_id: 'nobody/no-such-harness', note: 'x' },
      { harness_id: harness.harness_id, version: '9.9.9', note: 'x' },
    ]) {
      const reply = await takedown(body, admin.token);
      expect(reply.status, JSON.stringify(body)).toBe(404);
      expect(reply.body.error?.code).toBe('not_found');
    }
    for (const note of [undefined, '', '   ', 'n'.repeat(2001), 5, 'x\u0000y']) {
      const reply = await takedown({ harness_id: harness.harness_id, note }, admin.token);
      expect(reply.status, String(note).slice(0, 20)).toBe(400);
      expect(reply.body.error?.code).toBe('invalid_request');
    }
    expect(await actionsOn(harness)).toEqual([]);
    expect((await harnessState(harness))?.status).toBe('active');
  });
});

describe('a whole-Harness Takedown while a publish of that Harness is in flight', () => {
  it('also takes down the version the publish commits first', async () => {
    const harness = await harnessWith('takedown-race', [['1.0.0']]);
    const { manifest, platforms, permissions } = versionRow(harness, '2.0.0');
    const literal = (value: unknown) => `'${JSON.stringify(value)}'::jsonb`;

    // The first session publishes 2.0.0 and stays open until the Takedown, in a second session,
    // waits on a lock: a Takedown that read the versions before the publish committed would miss
    // 2.0.0 and leave it published under a taken-down Harness.
    const first = sql(`
      begin;
      select public.publish_version(
        '${owner.id}',
        ${literal({ ...manifest, platforms, permissions })},
        '# Readme',
        '${harness.harness_id}/2.0.0.zip',
        '${'0'.repeat(64)}',
        1,
        '{}',
        1
      );
      do $$ /* takedown-race-first */
      declare deadline timestamptz := clock_timestamp() + interval '10 seconds';
      begin
        while not exists (
          select 1 from pg_stat_activity
          where pid <> pg_backend_pid() and wait_event_type = 'Lock'
            and query like '%takedown-race-second%'
        ) loop
          if clock_timestamp() > deadline then
            raise exception 'the Takedown never waited on a lock';
          end if;
          perform pg_sleep(0.05);
          -- pg_stat_activity is otherwise read once per transaction.
          perform pg_stat_clear_snapshot();
        end loop;
      end $$;
      commit;
    `);
    // The Takedown starts only once the publish has inserted its version.
    for (let tries = 0; ; tries += 1) {
      const started = await sql(
        `select count(*) from pg_stat_activity
         where pid <> pg_backend_pid() and query like '%takedown-race-first%'`,
      );
      if (started === '1') break;
      if (tries > 200) throw new Error('the publish never started');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const note = 'Taken down during a publish.';
    await sql(
      `/* takedown-race-second */
       select public.take_down('${admin.id}', '${harness.harness_id}', null, '${note}');`,
    );
    await first;

    expect(await versionsOf(harness)).toEqual([
      expect.objectContaining({ version: '1.0.0', status: 'taken_down', takedown_note: note }),
      expect.objectContaining({ version: '2.0.0', status: 'taken_down', takedown_note: note }),
    ]);
    expect(await harnessState(harness)).toEqual({ status: 'taken_down', latest_version: null });
  });
});

describe('the takedown note and the Publisher-only read policy', () => {
  let harness: HarnessRow;
  const note = 'Taken down: the listing is misleading.';
  const notes = (caller: 'anon' | { token: string }) =>
    rest<{ version: string; status: string; takedown_note: string | null }[]>(
      caller,
      'GET',
      `harness_versions?harness_id=eq.${harness.id}&select=version,status,takedown_note&order=version`,
    );

  beforeAll(async () => {
    harness = await harnessWith('note', [['1.0.0'], ['1.1.0', 'unpublished'], ['2.0.0']]);
    const reply = await takedown(
      { harness_id: harness.harness_id, version: '2.0.0', note },
      admin.token,
    );
    expect(reply.status).toBe(200);
  });

  it('lets the owning Publisher read every one of their versions, with the takedown note', async () => {
    expect(await notes({ token: owner.token })).toEqual({
      status: 200,
      body: [
        { version: '1.0.0', status: 'published', takedown_note: null },
        { version: '1.1.0', status: 'unpublished', takedown_note: null },
        { version: '2.0.0', status: 'taken_down', takedown_note: note },
      ],
    });
  });

  it('shows another Publisher and anon the published version only, never the note', async () => {
    for (const caller of ['anon', { token: other.token }, { token: admin.token }] as const) {
      expect(await notes(caller)).toEqual({
        status: 200,
        body: [{ version: '1.0.0', status: 'published', takedown_note: null }],
      });
    }
  });

  it('also lets the owner read the versions of their whole-taken-down Harness, and nobody else', async () => {
    const whole = await harnessWith('note-whole', [['1.0.0']]);
    await takedown({ harness_id: whole.harness_id, note }, admin.token);
    const read = (caller: 'anon' | { token: string }) =>
      rest<unknown[]>(
        caller,
        'GET',
        `harness_versions?harness_id=eq.${whole.id}&select=version,takedown_note`,
      );
    expect((await read({ token: owner.token })).body).toEqual([
      { version: '1.0.0', takedown_note: note },
    ]);
    expect((await read({ token: other.token })).body).toEqual([]);
    expect((await read('anon')).body).toEqual([]);
  });

  it("answers api.md's own-versions read with the owner's versions only, in any status", async () => {
    const login = owner.userName.toLowerCase();
    const reply = await rest<{ harness_id: string; version: string; status: string }[]>(
      { token: owner.token },
      'GET',
      `harness_versions?select=harness_id:manifest->>id,name:manifest->>name,version,status,takedown_note,download_count,published_at,unpublished_at&manifest->>id=like.${login}/*&order=published_at.desc`,
    );
    expect(reply.status).toBe(200);
    expect(reply.body.length).toBeGreaterThan(0);
    for (const row of reply.body) expect(row.harness_id.startsWith(`${login}/`)).toBe(true);
    expect(
      reply.body
        .filter((row) => row.harness_id === harness.harness_id)
        .map((row) => `${row.version} ${row.status}`)
        .sort(),
    ).toEqual(['1.0.0 published', '1.1.0 unpublished', '2.0.0 taken_down']);
  });

  it('does not show the owner their hidden Harnesses in the public Harness reads', async () => {
    const whole = await harnessWith('owner-hidden', [['1.0.0']]);
    await takedown({ harness_id: whole.harness_id, note }, admin.token);
    const reply = await rest(
      { token: owner.token },
      'GET',
      `harnesses?harness_id=eq.${whole.harness_id}&select=harness_id`,
    );
    expect(reply).toEqual({ status: 200, body: [] });
  });

  it('keeps admin_actions out of reach of anon and every Publisher', async () => {
    for (const caller of ['anon', { token: owner.token }, { token: admin.token }] as const) {
      expect(isPermissionDenied(await rest(caller, 'GET', 'admin_actions'))).toBe(true);
    }
  });

  it('puts a takedown note only on a taken-down version', async () => {
    const [published] = await versionsOf(harness);
    const reply = await rest('service', 'PATCH', `harness_versions?id=eq.${published?.id ?? ''}`, {
      takedown_note: 'Not taken down.',
    });
    expect(reply.status).toBe(400);
    expect(JSON.stringify(reply.body)).toContain('harness_versions_takedown_note_only_taken_down');
  });
});
