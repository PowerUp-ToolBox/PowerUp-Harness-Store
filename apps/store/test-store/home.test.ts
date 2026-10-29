/**
 * Ticket P0-07.5: the Store home rows (Featured, Most downloaded, New) and the Publisher page,
 * which are plain PostgREST reads with the anon key, called exactly as docs/tech/api.md writes
 * them, against the seed catalogue (scripts/seed.ts) plus the Harnesses of one test Publisher:
 * two visible, one Unpublished-only and one taken down, the hidden two Featured with the lowest
 * ranks so that only row-level security can keep them out.
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
import type { Caller, HarnessRow, TestUser } from './support.ts';

const LIST_COLUMNS =
  'harness_id,name,summary,icon_path,tags,download_count,latest_version,latest_published_at';

/** The reads of api.md "Reads", word for word. */
const FEATURED = `harnesses?featured_rank=not.is.null&order=featured_rank&limit=12&select=${LIST_COLUMNS}`;
const MOST_DOWNLOADED = `harnesses?order=download_count.desc,harness_id&limit=12&select=${LIST_COLUMNS}`;
const NEW = `harnesses?order=latest_published_at.desc,harness_id&limit=12&select=${LIST_COLUMNS}`;
const publisherPage = (login: string) =>
  `profiles?github_login=eq.${login}&select=github_login,display_name,avatar_url,bio,created_at,harnesses(${LIST_COLUMNS})&harnesses.order=download_count.desc,harness_id`;

const DAY_MS = 24 * 60 * 60 * 1000;

let publisher: TestUser;
let login: string;
let popularOld: HarnessRow;
let quietNew: HarnessRow;
let unpublished: HarnessRow;
let takenDown: HarnessRow;

/** A Harness of the test Publisher with one published version 1.0.0. */
async function listed(slug: string, downloads: number, daysAgo: number): Promise<HarnessRow> {
  const harness = await insertHarness(publisher, slug);
  await insertVersion(harness, '1.0.0', {
    manifest: { name: `Home ${slug}`, summary: `The ${slug} Harness.`, tags: ['coding'] },
    download_count: downloads,
    published_at: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
  });
  return harness;
}

async function feature(harness: HarnessRow, rank: number): Promise<void> {
  await serviceRest('PATCH', `harnesses?id=eq.${harness.id}`, { featured_rank: rank });
}

beforeAll(async () => {
  publisher = await createUser();
  login = publisher.userName.toLowerCase();
  // Inserted and ranked out of order, so neither can pass for featured_rank order.
  popularOld = await listed('popular-old', 2000, 15);
  quietNew = await listed('quiet-new', 100, 1);
  unpublished = await listed('unpublished', 5000, 0.5);
  takenDown = await listed('taken-down', 6000, 0.5);
  await feature(popularOld, 30);
  await feature(quietNew, 20);
  await feature(unpublished, 10);
  await feature(takenDown, 5);
  await serviceRest('PATCH', `harness_versions?harness_id=eq.${unpublished.id}`, {
    status: 'unpublished',
    unpublished_at: new Date().toISOString(),
  });
  await serviceRest('PATCH', `harnesses?id=eq.${takenDown.id}`, { status: 'taken_down' });
});

afterAll(async () => {
  await deleteUser(publisher);
});

async function harnessIds(caller: Caller, path: string): Promise<string[]> {
  const reply = await rest<{ harness_id: string }[]>(caller, 'GET', path);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body.map((row) => row.harness_id);
}

describe('Store home', () => {
  for (const [who, as] of [
    ['anon', (): Caller => 'anon'],
    ['a signed-in Publisher', (): Caller => ({ token: publisher.token })],
  ] as const) {
    it(`Featured is the visible Featured Harnesses in ascending featured_rank (${who})`, async () => {
      expect(await harnessIds(as(), FEATURED)).toEqual([
        'alice/code-reviewer',
        quietNew.harness_id,
        popularOld.harness_id,
      ]);
      const ranks = await rest<{ featured_rank: number }[]>(
        as(),
        'GET',
        'harnesses?featured_rank=not.is.null&order=featured_rank&select=featured_rank',
      );
      expect(ranks.body.map((row) => row.featured_rank)).toEqual([1, 20, 30]);
    });

    it(`Most downloaded is the visible Harnesses by download count (${who})`, async () => {
      expect(await harnessIds(as(), MOST_DOWNLOADED)).toEqual([
        popularOld.harness_id, // 2000
        'alice/code-reviewer', // 1260
        'alice/hello-web', // 132
        quietNew.harness_id, // 100
        'bob/xiezuo', // 42
      ]);
    });

    it(`New is the visible Harnesses by their latest version's publish date (${who})`, async () => {
      expect(await harnessIds(as(), NEW)).toEqual([
        quietNew.harness_id, // 1 day ago
        'alice/code-reviewer', // 3 days ago (2.1.0-beta.3)
        'bob/xiezuo', // 7 days ago
        popularOld.harness_id, // 15 days ago
        'alice/hello-web', // 20 days ago (0.1.0; 0.2.0 is Unpublished)
      ]);
    });
  }

  it('a list row has the columns a card needs and no search vector', async () => {
    const reply = await rest<Record<string, unknown>[]>('anon', 'GET', FEATURED);
    expect(reply.body[1]).toEqual({
      harness_id: quietNew.harness_id,
      name: 'Home quiet-new',
      summary: 'The quiet-new Harness.',
      icon_path: `${quietNew.harness_id}/1.0.0/icon.png`,
      tags: ['coding'],
      download_count: 100,
      latest_version: '1.0.0',
      latest_published_at: expect.any(String) as string,
    });
  });
});

describe('Publisher page', () => {
  interface Page {
    github_login: string;
    display_name: string | null;
    harnesses: { harness_id: string }[];
  }

  async function page(of: string): Promise<Page[]> {
    const reply = await rest<Page[]>('anon', 'GET', publisherPage(of));
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return reply.body;
  }

  it("lists only the Publisher's active Harnesses with a published version, most downloaded first", async () => {
    const [own] = await page(login);
    expect(own).toMatchObject({ github_login: login, display_name: `Test ${publisher.userName}` });
    expect(own?.harnesses.map((row) => row.harness_id)).toEqual([
      popularOld.harness_id,
      quietNew.harness_id,
    ]);
  });

  it('lists the seed Publishers without their hidden Harnesses', async () => {
    expect((await page('alice'))[0]?.harnesses.map((row) => row.harness_id)).toEqual([
      'alice/code-reviewer',
      'alice/hello-web',
    ]);
    // bob/retired-tool is Unpublished-only, carol/bad-tool taken down.
    expect((await page('bob'))[0]?.harnesses.map((row) => row.harness_id)).toEqual(['bob/xiezuo']);
    expect(await page('carol')).toMatchObject([{ github_login: 'carol', harnesses: [] }]);
  });

  it('is empty for a login that is no Publisher', async () => {
    expect(await page('no-such-publisher')).toEqual([]);
  });
});
