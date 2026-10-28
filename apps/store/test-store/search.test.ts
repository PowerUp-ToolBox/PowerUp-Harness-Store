/**
 * Ticket P0-07.5: the `search_harnesses` RPC, over HTTP with the anon key as the desktop app calls
 * it, against the seed catalogue (scripts/seed.ts) plus Harnesses each test inserts with the
 * service role. Those carry random words of their own, in English and in Chinese, so that a query
 * finds only what the test put there; each group of tests deletes its Publisher afterwards.
 */
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  createUser,
  deleteUser,
  insertHarness,
  insertVersion,
  rest,
  serviceRest,
} from './support.ts';
import type { Caller, HarnessRow, Reply, TestUser } from './support.ts';

interface SearchResult {
  harness_id: string;
  publisher_login: string;
  name: string;
  summary: string;
  icon_path: string | null;
  tags: string[];
  platforms: string[];
  download_count: number;
  latest_version: string;
  latest_published_at: string;
}

interface SearchArgs {
  q?: string | null;
  tags?: string[] | null;
  platform?: string | null;
  limit?: number | null;
  offset?: number | null;
}

/** `POST rest/v1/rpc/search_harnesses`, as anon unless `caller` says otherwise. */
function search(args: SearchArgs, caller: Caller = 'anon'): Promise<Reply<SearchResult[]>> {
  return rest<SearchResult[]>(caller, 'POST', 'rpc/search_harnesses', args);
}

/** The Harness IDs of a search that must succeed. */
async function ids(args: SearchArgs, caller: Caller = 'anon'): Promise<string[]> {
  const reply = await search(args, caller);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body.map((row) => row.harness_id);
}

/** A random word of lowercase letters: one token that no other Harness contains. */
function englishWord(): string {
  return Array.from({ length: 12 }, () => String.fromCharCode(97 + randomInt(26))).join('');
}

/** A random word of four CJK characters, which the `simple` parser keeps as one token. */
function chineseWord(): string {
  return Array.from({ length: 4 }, () => String.fromCodePoint(0x4e00 + randomInt(0x5000))).join('');
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface Listing {
  name: string;
  summary?: string;
  tags?: string[];
  platforms?: string[];
  readme?: string;
  downloads?: number;
  daysAgo?: number;
}

let slugs = 0;

/** A Harness of `user` with one published version 1.0.0 that has the given listing. */
async function listed(user: TestUser, listing: Listing): Promise<HarnessRow> {
  slugs += 1;
  const harness = await insertHarness(user, `search-${String(slugs)}`);
  await insertVersion(harness, '1.0.0', {
    manifest: {
      id: harness.harness_id,
      version: '1.0.0',
      name: listing.name,
      summary: listing.summary ?? 'A test Harness.',
      tags: listing.tags ?? ['coding'],
    },
    readme: listing.readme ?? '',
    platforms: listing.platforms ?? ['linux-x64'],
    download_count: listing.downloads ?? 0,
    published_at: new Date(Date.now() - (listing.daysAgo ?? 1) * DAY_MS).toISOString(),
  });
  return harness;
}

describe('text search', () => {
  let publisher: TestUser;
  const english = englishWord();
  const chinese = chineseWord();
  const found: Record<string, HarnessRow> = {};

  beforeAll(async () => {
    publisher = await createUser();
    // Where the word is decides the order (name A, summary C, README D), not the downloads.
    found.englishInReadme = await listed(publisher, {
      name: 'Readme hit',
      readme: `# Notes\n\nMentions ${english} once.`,
      downloads: 1000,
    });
    found.englishInName = await listed(publisher, { name: `${english} helper`, downloads: 1 });
    found.englishInSummary = await listed(publisher, {
      name: 'Summary hit',
      summary: `Does ${english} things.`,
      downloads: 50,
    });
    found.chineseInReadme = await listed(publisher, {
      name: '说明文件',
      readme: `# 说明\n\n${chinese} 出现在这里。`,
      downloads: 1000,
    });
    found.chineseInName = await listed(publisher, { name: chinese, downloads: 1 });
  });

  afterAll(async () => {
    await deleteUser(publisher);
  });

  it('finds the seeded Chinese Harness by its whole Chinese name, alone and with filters', async () => {
    expect(await ids({ q: '写作助手' })).toEqual(['bob/xiezuo']);
    expect(await ids({ q: '写作助手', tags: ['writing'], platform: 'linux-x64' })).toEqual([
      'bob/xiezuo',
    ]);
    // A word of its summary and of its README count too.
    expect(await ids({ q: '帮你润色中文文章' })).toEqual(['bob/xiezuo']);
    expect(await ids({ q: '润色' })).toEqual(['bob/xiezuo']);
  });

  it('does not match part of a Chinese word (the `simple` parser does not segment Chinese, P0)', async () => {
    expect(await ids({ q: '写作' })).toEqual([]);
  });

  it('finds the seeded English Harness by its name, whatever the case', async () => {
    expect((await ids({ q: 'code REVIEWER' }))[0]).toBe('alice/code-reviewer');
  });

  it('ranks a match in the name above the summary above the README, before downloads', async () => {
    expect(await ids({ q: english })).toEqual([
      found.englishInName?.harness_id,
      found.englishInSummary?.harness_id,
      found.englishInReadme?.harness_id,
    ]);
    expect(await ids({ q: chinese })).toEqual([
      found.chineseInName?.harness_id,
      found.chineseInReadme?.harness_id,
    ]);
  });

  it('takes websearch syntax: a quoted phrase, or, and a minus that excludes', async () => {
    expect(await ids({ q: `"${english} helper"` })).toEqual([found.englishInName?.harness_id]);
    expect(await ids({ q: `${english} or ${chinese}` })).toHaveLength(5);
    // ts_rank does not order a query with an exclusion meaningfully: only the set counts.
    expect((await ids({ q: `${english} -helper` })).sort()).toEqual(
      [found.englishInSummary?.harness_id, found.englishInReadme?.harness_id].sort(),
    );
  });

  it('answers each result with what a list card needs', async () => {
    const reply = await search({ q: chinese });
    const harnessId = found.chineseInName?.harness_id ?? '';
    expect(reply.body[0]).toEqual({
      harness_id: harnessId,
      publisher_login: publisher.userName.toLowerCase(),
      name: chinese,
      summary: 'A test Harness.',
      icon_path: `${harnessId}/1.0.0/icon.png`,
      tags: ['coding'],
      platforms: ['linux-x64'],
      download_count: 1,
      latest_version: '1.0.0',
      latest_published_at: expect.any(String) as string,
    });
  });
});

describe('order without a text query, and ties', () => {
  let publisher: TestUser;
  const word = englishWord();
  const rows: Record<string, HarnessRow> = {};

  beforeAll(async () => {
    publisher = await createUser();
    // The same text everywhere, so ts_rank ties and the downloads, then the date, decide.
    const same = { name: `${word} twin`, summary: 'Twin.' };
    rows.fewOld = await listed(publisher, { ...same, downloads: 5, daysAgo: 9 });
    rows.many = await listed(publisher, { ...same, downloads: 500, daysAgo: 9 });
    rows.fewNew = await listed(publisher, { ...same, downloads: 5, daysAgo: 2 });
  });

  afterAll(async () => {
    await deleteUser(publisher);
  });

  it('breaks equal ranks by downloads, then by the newest latest version', async () => {
    expect(await ids({ q: word })).toEqual([
      rows.many?.harness_id,
      rows.fewNew?.harness_id,
      rows.fewOld?.harness_id,
    ]);
  });

  it('orders an empty query (null, empty, blank, or without any word) by downloads', async () => {
    // Every visible Harness, in the order the RPC must give them.
    const visible = await serviceRest<
      { harness_id: string; download_count: number; latest_published_at: string }[]
    >(
      'GET',
      'harnesses?status=eq.active&latest_version=not.is.null&select=harness_id,download_count,latest_published_at',
    );
    const expected = visible
      .sort(
        (a, b) =>
          b.download_count - a.download_count ||
          Date.parse(b.latest_published_at) - Date.parse(a.latest_published_at) ||
          (a.harness_id < b.harness_id ? -1 : 1),
      )
      .map((row) => row.harness_id);
    expect(expected.length).toBeLessThanOrEqual(24);

    for (const q of [undefined, null, '', '   ', '!!! ...']) {
      const got = await ids(q === undefined ? {} : { q });
      expect(got, String(q)).toEqual(expected);
    }
    // The seed's own order: 1260, 132 and 42 downloads.
    const seeded = expected.filter((id) =>
      ['alice/code-reviewer', 'alice/hello-web', 'bob/xiezuo'].includes(id),
    );
    expect(seeded).toEqual(['alice/code-reviewer', 'alice/hello-web', 'bob/xiezuo']);
    const reply = await search({});
    const counts = reply.body.map((row) => row.download_count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});

describe('tag and platform filters', () => {
  let publisher: TestUser;
  const word = englishWord();
  const rows: Record<string, HarnessRow> = {};

  beforeAll(async () => {
    publisher = await createUser();
    rows.all = await listed(publisher, {
      name: `${word} all`,
      tags: ['coding', 'writing', 'devops'],
      platforms: ['darwin-arm64', 'linux-x64'],
      downloads: 40,
    });
    rows.wrongTags = await listed(publisher, {
      name: `${word} tags`,
      tags: ['coding'],
      platforms: ['linux-x64'],
      downloads: 30,
    });
    rows.wrongPlatform = await listed(publisher, {
      name: `${word} platform`,
      tags: ['coding', 'writing'],
      platforms: ['win32-x64'],
      downloads: 20,
    });
    rows.wrongText = await listed(publisher, {
      name: 'Unrelated',
      tags: ['coding', 'writing'],
      platforms: ['linux-x64'],
      downloads: 10,
    });
    // Platforms come from the latest version only: 1.0.0 is Windows-only, 2.0.0 Linux-only.
    rows.moved = await listed(publisher, {
      name: `${word} moved`,
      tags: ['coding', 'writing'],
      platforms: ['win32-x64'],
      downloads: 1,
    });
    await insertVersion(rows.moved, '2.0.0', {
      manifest: { name: `${word} moved`, summary: 'Moved.', tags: ['coding', 'writing'] },
      platforms: ['linux-x64'],
    });
  });

  afterAll(async () => {
    await deleteUser(publisher);
  });

  it('returns only the Harnesses that match the text, all the tags and the platform at once', async () => {
    expect(await ids({ q: word, tags: ['writing', 'coding'], platform: 'linux-x64' })).toEqual([
      rows.all?.harness_id,
      rows.moved?.harness_id,
    ]);
  });

  it('applies each filter on its own', async () => {
    expect(await ids({ q: word })).toEqual([
      rows.all?.harness_id,
      rows.wrongTags?.harness_id,
      rows.wrongPlatform?.harness_id,
      rows.moved?.harness_id,
    ]);
    expect(await ids({ q: word, tags: ['coding', 'writing'] })).toEqual([
      rows.all?.harness_id,
      rows.wrongPlatform?.harness_id,
      rows.moved?.harness_id,
    ]);
    expect(await ids({ q: word, platform: 'linux-x64' })).toEqual([
      rows.all?.harness_id,
      rows.wrongTags?.harness_id,
      rows.moved?.harness_id,
    ]);
    expect(await ids({ q: word, platform: 'win32-x64' })).toEqual([rows.wrongPlatform?.harness_id]);
    const tagged = await ids({ tags: ['devops', 'writing'], platform: 'darwin-arm64' });
    expect(tagged).toContain(rows.all?.harness_id);
    expect(tagged).not.toContain(rows.wrongTags?.harness_id);
  });

  it('treats a null or empty tag list as no filter, and an unknown platform as matching nothing', async () => {
    const unfiltered = await ids({ q: word });
    expect(await ids({ q: word, tags: [] })).toEqual(unfiltered);
    expect(await ids({ q: word, tags: null, platform: null })).toEqual(unfiltered);
    expect(await ids({ q: word, platform: 'beos-x86' })).toEqual([]);
    expect(await ids({ q: word, tags: ['no-such-tag'] })).toEqual([]);
  });
});

describe('Harnesses that are not visible', () => {
  let publisher: TestUser;
  let other: TestUser;
  const word = englishWord();

  beforeAll(async () => {
    publisher = await createUser();
    other = await createUser();
    // Each of these once had a published version with the word in its name.
    const unpublished = await listed(publisher, { name: `${word} unpublished`, downloads: 9 });
    await serviceRest('PATCH', `harness_versions?harness_id=eq.${unpublished.id}`, {
      status: 'unpublished',
      unpublished_at: new Date().toISOString(),
    });
    const versionTakenDown = await listed(publisher, { name: `${word} version`, downloads: 9 });
    await serviceRest('PATCH', `harness_versions?harness_id=eq.${versionTakenDown.id}`, {
      status: 'taken_down',
    });
    const harnessTakenDown = await listed(publisher, { name: `${word} harness`, downloads: 9 });
    await serviceRest('PATCH', `harnesses?id=eq.${harnessTakenDown.id}`, {
      status: 'taken_down',
    });
  });

  afterAll(async () => {
    await deleteUser(publisher);
    await deleteUser(other);
  });

  it('never appear, whatever the query, for anon, another Publisher or their own Publisher', async () => {
    const hidden = ['bob/retired-tool', 'carol/bad-tool'];
    const queries: SearchArgs[] = [
      {},
      { q: 'Retired Tool' },
      { q: '"Bad Tool"' },
      { q: 'retired or bad or tool' },
      { q: 'A Harness taken down by a Store administrator.' },
      { q: 'Retired Tool', tags: ['coding'], platform: 'linux-x64' },
      { q: word },
      { q: `${word} unpublished` },
      { q: `${word} harness`, limit: 60 },
      { limit: 60 },
      { limit: 60, offset: 3 },
    ];
    // The owner matters most: an owner read policy must not leak their own rows into search.
    for (const caller of ['anon', { token: other.token }, { token: publisher.token }] as const) {
      for (const args of queries) {
        const got = await ids(args, caller);
        for (const id of hidden) expect(got, JSON.stringify(args)).not.toContain(id);
        expect(
          got.filter((id) => id.startsWith(`${publisher.userName.toLowerCase()}/`)),
          JSON.stringify(args),
        ).toEqual([]);
      }
    }
    // The rows exist; only row-level security keeps them out.
    const all = await serviceRest<unknown[]>('GET', `harnesses?publisher_id=eq.${publisher.id}`);
    expect(all).toHaveLength(3);
  });
});

describe('limit and offset', () => {
  let publisher: TestUser;
  const word = englishWord();
  const MAX = 60;
  const COUNT = MAX + 5;
  let expected: string[] = [];

  beforeAll(async () => {
    publisher = await createUser();
    // More Harnesses with the word than one page may hold, inserted in two requests.
    const login = publisher.userName.toLowerCase();
    const harnesses = await serviceRest<HarnessRow[]>(
      'POST',
      'harnesses',
      Array.from({ length: COUNT }, (_, index) => ({
        publisher_id: publisher.id,
        slug: `page-${String(index)}`,
        name: `${word} ${String(index)}`,
        summary: 'Paged.',
      })),
    );
    await serviceRest(
      'POST',
      'harness_versions',
      harnesses.map((harness, index) => ({
        harness_id: harness.id,
        version: '1.0.0',
        manifest: { name: `${word} ${String(index)}`, summary: 'Paged.', tags: ['coding'] },
        platforms: ['linux-x64'],
        permissions: {},
        package_path: `${harness.harness_id}/1.0.0.zip`,
        package_sha256: '0'.repeat(64),
        package_size: 1,
        // Distinct counts give one exact order: page-0 has the most.
        download_count: COUNT - index,
      })),
    );
    expected = Array.from({ length: COUNT }, (_, index) => `${login}/page-${String(index)}`);
  });

  afterAll(async () => {
    await deleteUser(publisher);
  });

  it('gives 24 results by default', async () => {
    expect(await ids({ q: word })).toEqual(expected.slice(0, 24));
    expect(await ids({ q: word, limit: null, offset: null })).toEqual(expected.slice(0, 24));
  });

  it('clamps a limit above 60 to 60, and one below 1 to 1, instead of refusing it', async () => {
    expect(await ids({ q: word, limit: 1000 })).toEqual(expected.slice(0, MAX));
    expect(await ids({ q: word, limit: 2147483647 })).toEqual(expected.slice(0, MAX));
    expect(await ids({ q: word, limit: 0 })).toEqual(expected.slice(0, 1));
    expect(await ids({ q: word, limit: -5 })).toEqual(expected.slice(0, 1));
  });

  it('clamps a negative offset to 0 and pages without overlap', async () => {
    expect(await ids({ q: word, limit: 10, offset: -10 })).toEqual(expected.slice(0, 10));
    expect(await ids({ q: word, limit: MAX, offset: MAX })).toEqual(expected.slice(MAX));
    expect(await ids({ q: word, offset: 2147483647 })).toEqual([]);
  });

  it('caps the whole catalogue at 60 too, with no text query', async () => {
    expect(await ids({ limit: 1000 })).toHaveLength(MAX);
  });

  it('refuses arguments of the wrong type (PostgREST), not values out of range', async () => {
    const reply = await call('anon', 'POST', 'rest/v1/rpc/search_harnesses', { limit: 'many' });
    expect(reply.status).toBe(400);
  });
});
