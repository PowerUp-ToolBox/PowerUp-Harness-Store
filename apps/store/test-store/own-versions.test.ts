/**
 * Ticket P0-08.3: api.md's "Own versions" read, as the desktop app's My Harnesses makes it, over
 * PostgREST against the local stack. With their session, a Publisher reads every version of
 * their Harnesses in any status, with the takedown note; another Publisher reading with the same
 * filter, or anon, sees only the published ones and never a note. The versions are written with
 * the service role, in the statuses an Unpublish and a Takedown leave them in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createUser,
  deleteUser,
  insertHarness,
  insertVersion,
  rest,
  serviceRest,
} from './support.ts';
import type { HarnessRow, TestUser } from './support.ts';

/** api.md's columns for the "Own versions" read. */
const SELECT =
  'harness_id:manifest->>id,name:manifest->>name,version,status,takedown_note,download_count,published_at,unpublished_at';
const NOTE = 'Taken down: it sends files to an unlisted domain.';

interface OwnVersionRow {
  harness_id: string;
  name: string;
  version: string;
  status: string;
  takedown_note: string | null;
  download_count: number;
  published_at: string;
  unpublished_at: string | null;
}

let publisher: TestUser;
let other: TestUser;
let web: HarnessRow;
let term: HarnessRow;
let others: HarnessRow;

beforeAll(async () => {
  publisher = await createUser();
  other = await createUser();
  web = await insertHarness(publisher, 'own-web');
  term = await insertHarness(publisher, 'own-term');
  others = await insertHarness(other, 'own-other');
  // Inserted one after the other, so published_at follows this order.
  await withVersion(web, '1.0.0', { download_count: 120 });
  await withVersion(term, '0.1.0', { download_count: 40 });
  await withVersion(web, '1.1.0', {
    download_count: 7,
    status: 'unpublished',
    unpublished_at: new Date().toISOString(),
  });
  await withVersion(web, '2.0.0', { download_count: 3, status: 'taken_down', takedown_note: NOTE });
  await withVersion(term, '0.2.0', { download_count: 2 });
  await withVersion(others, '1.0.0', { download_count: 9 });
});

afterAll(async () => {
  await deleteUser(publisher);
  await deleteUser(other);
});

/** A version, published, then changed with the service role as the test says. */
async function withVersion(harness: HarnessRow, version: string, change: Record<string, unknown>) {
  const row = await insertVersion(harness, version);
  await serviceRest('PATCH', `harness_versions?id=eq.${row.id}`, change);
}

/** The "Own versions" read of `login`'s Harnesses, made with `caller`'s credentials. */
async function ownVersions(caller: 'anon' | TestUser, login: string) {
  const query = new URLSearchParams({
    select: SELECT,
    'manifest->>id': `like.${login.toLowerCase()}/*`,
    order: 'published_at.desc',
  });
  const reply = await rest<OwnVersionRow[]>(
    caller === 'anon' ? 'anon' : { token: caller.token },
    'GET',
    `harness_versions?${query.toString()}`,
  );
  expect(reply.status).toBe(200);
  return reply.body;
}

/** The rows as `<id> <version> <status> <downloads> <note>`, in the order read. */
function summary(rows: OwnVersionRow[]): string[] {
  return rows.map(
    (row) =>
      `${row.harness_id} ${row.version} ${row.status} ${String(row.download_count)} ${row.takedown_note ?? '-'}`,
  );
}

describe('the "Own versions" read', () => {
  it('answers the Publisher every version of their Harnesses, newest first, in any status, with the note', async () => {
    const rows = await ownVersions(publisher, publisher.userName);
    expect(summary(rows)).toEqual([
      `${term.harness_id} 0.2.0 published 2 -`,
      `${web.harness_id} 2.0.0 taken_down 3 ${NOTE}`,
      `${web.harness_id} 1.1.0 unpublished 7 -`,
      `${term.harness_id} 0.1.0 published 40 -`,
      `${web.harness_id} 1.0.0 published 120 -`,
    ]);
    // The Manifest's name, and when the Unpublished one was withdrawn.
    expect(rows[0]?.name).toBe('own-term 0.2.0');
    expect(rows.find((row) => row.version === '1.1.0')?.unpublished_at).toEqual(expect.any(String));
    expect(
      rows.filter((row) => row.status !== 'unpublished').map((row) => row.unpublished_at),
    ).toEqual([null, null, null, null]);
  });

  it('answers another Publisher their own Harnesses only', async () => {
    expect(summary(await ownVersions(other, other.userName))).toEqual([
      `${others.harness_id} 1.0.0 published 9 -`,
    ]);
  });

  it("never shows another Publisher, or anon, this Publisher's Unpublished or taken-down versions, or the note", async () => {
    for (const caller of [other, 'anon'] as const) {
      expect(summary(await ownVersions(caller, publisher.userName))).toEqual([
        `${term.harness_id} 0.2.0 published 2 -`,
        `${term.harness_id} 0.1.0 published 40 -`,
        `${web.harness_id} 1.0.0 published 120 -`,
      ]);
    }
  });
});
