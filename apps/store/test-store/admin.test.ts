/**
 * Ticket P0-12.2: the admin CLI (scripts/admin.ts) against the local stack, given the stack's URL,
 * service-role key and JWT secret as an administrator would set them, and what a Takedown it makes
 * does to Store discovery. The administrator is a test Publisher with `profiles.is_admin` set, as
 * one is set by hand in the real Store; the open Reports are stored directly with the service
 * role. Everything belongs to test Publishers deleted afterwards (their Harnesses, versions,
 * Reports and `admin_actions` rows with them).
 *
 * Discovery is checked through the very reads P0-09 makes (api.md "Reads": the three home rows,
 * `search_harnesses` and the Publisher page), with the anon key: a taken-down Harness, or version,
 * is in none of them, with no mechanism of its own.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAdmin } from '../scripts/admin.ts';
import {
  createUser,
  deleteUser,
  insertHarness,
  insertVersion,
  makeAdmin,
  rest,
  serviceRest,
  stack,
} from './support.ts';
import type { HarnessRow, TestUser } from './support.ts';

let owner: TestUser;
let admin: TestUser;
let notAdmin: TestUser;

beforeAll(async () => {
  owner = await createUser();
  admin = await createUser();
  notAdmin = await createUser();
  await makeAdmin(admin);
});

afterAll(async () => {
  await deleteUser(owner);
  await deleteUser(admin);
  await deleteUser(notAdmin);
});

/** The environment an administrator sets: the stack's own values. */
function environment(login: string = admin.userName): NodeJS.ProcessEnv {
  return {
    STORE_URL: stack.apiUrl,
    STORE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
    STORE_JWT_SECRET: stack.jwtSecret,
    STORE_ADMIN_LOGIN: login,
  };
}

/** Runs the CLI; its exit code and what it printed. */
async function cli(argv: string[], env: NodeJS.ProcessEnv = environment()) {
  const log: string[] = [];
  const error: string[] = [];
  const code = await runAdmin(argv, env, {
    log: (line) => log.push(line),
    error: (line) => error.push(line),
  });
  return { code, log, error, printed: [...log, ...error].join('\n') };
}

/** A random word of lowercase letters: one search token no other Harness has. */
function word(): string {
  return Array.from(randomBytes(10), (byte) => String.fromCharCode(97 + (byte % 26))).join('');
}

/** A Harness of the owner with these versions, published now with many downloads. */
async function harnessWith(slug: string, versions: string[], name = slug): Promise<HarnessRow> {
  const harness = await insertHarness(owner, slug);
  for (const [index, version] of versions.entries()) {
    await insertVersion(harness, version, {
      manifest: { name, summary: `The ${slug} Harness.`, tags: ['coding'] },
      download_count: 1_000_000 + index,
      published_at: new Date(Date.now() + index * 1000).toISOString(),
    });
  }
  return harness;
}

async function versionIds(harness: HarnessRow): Promise<Map<string, string>> {
  const rows = await serviceRest<{ id: string; version: string }[]>(
    'GET',
    `harness_versions?harness_id=eq.${harness.id}&select=id,version`,
  );
  return new Map(rows.map((row) => [row.version, row.id]));
}

/** An open Report on the Harness (and version), stored directly; its ID. */
async function reportOn(
  harness: HarnessRow,
  fields: { version_id?: string; reason?: string; details?: string; status?: string } = {},
): Promise<string> {
  const [row] = await serviceRest<{ id: string }[]>('POST', 'reports', {
    harness_id: harness.id,
    reason: 'malware',
    ...fields,
  });
  if (row === undefined) throw new Error('No Report returned');
  return row.id;
}

async function reportsOf(harness: HarnessRow) {
  return serviceRest<
    { id: string; status: string; resolution_note: string | null; resolved_at: string | null }[]
  >('GET', `reports?harness_id=eq.${harness.id}&select=id,status,resolution_note,resolved_at`);
}

async function versionsOf(harness: HarnessRow) {
  return serviceRest<{ version: string; status: string; takedown_note: string | null }[]>(
    'GET',
    `harness_versions?harness_id=eq.${harness.id}&select=version,status,takedown_note&order=version`,
  );
}

async function harnessState(harness: HarnessRow) {
  const [row] = await serviceRest<{ status: string; latest_version: string | null }[]>(
    'GET',
    `harnesses?id=eq.${harness.id}&select=status,latest_version`,
  );
  return row;
}

async function actionsOn(harness: HarnessRow) {
  return serviceRest<
    { admin_id: string; action: string; target_version_id: string | null; note: string }[]
  >(
    'GET',
    `admin_actions?target_harness_id=eq.${harness.id}&select=admin_id,action,target_version_id,note`,
  );
}

/** The lines `reports list` printed for one Harness: its header up to the next blank line. */
function section(lines: string[], harnessId: string): string[] {
  const start = lines.findIndex((line) => line.startsWith(`${harnessId}: `));
  if (start === -1) return [];
  const end = lines.indexOf('', start);
  return lines.slice(start, end === -1 ? undefined : end);
}

describe('reports list', () => {
  let harness: HarnessRow;
  let onVersion: string;
  let onHarness: string;
  let dismissed: string;

  beforeAll(async () => {
    harness = await harnessWith('listed', ['1.0.0', '1.1.0']);
    const ids = await versionIds(harness);
    dismissed = await reportOn(harness, { reason: 'spam', status: 'dismissed' });
    onHarness = await reportOn(harness, { reason: 'broken', details: 'It never starts.' });
    onVersion = await reportOn(harness, {
      version_id: ids.get('1.1.0') ?? '',
      reason: 'malware',
      details: 'Uploads ~/.ssh to an unknown host.\nSeen in its logs.',
    });
  });

  it('--open shows the open Reports with their reason, the per-Harness counts and the latest details', async () => {
    const run = await cli(['reports', 'list', '--open']);
    expect(run.code).toBe(0);
    const lines = section(run.log, harness.harness_id);
    expect(lines.slice(0, 3)).toEqual([
      `${harness.harness_id}: 2 open Reports (broken 1, malware 1)`,
      '  Latest details: Uploads ~/.ssh to an unknown host.',
      '    Seen in its logs.',
    ]);
    // Newest first: the Report on 1.1.0, then the one on the whole Harness.
    expect(lines.slice(3)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^  ${onVersion}  \\S+  1\\.1\\.0  malware  open  Uploads ~/\\.ssh to an unknown host\\. Seen in its logs\\.$`,
        ),
      ),
      expect.stringMatching(
        new RegExp(`^  ${onHarness}  \\S+  all versions  broken  open  It never starts\\.$`),
      ),
    ]);
    expect(run.printed).not.toContain(dismissed);
  });

  it('without --open shows every Report, the dismissed one too', async () => {
    const run = await cli(['reports', 'list']);
    expect(run.code).toBe(0);
    const lines = section(run.log, harness.harness_id);
    expect(lines[0]).toBe(`${harness.harness_id}: 3 Reports (broken 1, malware 1, spam 1)`);
    expect(
      lines.some((line) => line.includes(`${dismissed}  `) && line.includes('dismissed')),
    ).toBe(true);
  });

  it('prints no key or secret, and needs only the URL and the service-role key', async () => {
    const run = await cli(['reports', 'list', '--open'], {
      STORE_URL: stack.apiUrl,
      STORE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
    });
    expect(run.code).toBe(0);
    for (const secret of [stack.serviceRoleKey, stack.jwtSecret, stack.anonKey]) {
      expect(run.printed).not.toContain(secret);
    }
  });

  it('exits 1 with the Store refusal when the key is not the service role', async () => {
    const run = await cli(['reports', 'list'], {
      STORE_URL: stack.apiUrl,
      STORE_SERVICE_ROLE_KEY: stack.anonKey,
    });
    expect(run.code).toBe(1);
    expect(run.error[0]).toMatch(/^The Store refused \(40[13]\): 42501: /);
    expect(run.printed).not.toContain(stack.anonKey);
  });
});

describe('reports dismiss', () => {
  it('marks the open Report dismissed with the note, and nothing else changes', async () => {
    const harness = await harnessWith('dismissed', ['1.0.0']);
    const report = await reportOn(harness, { reason: 'spam' });
    const other = await reportOn(harness, { reason: 'broken' });
    const note = 'Not spam: the listing is accurate.';

    const run = await cli(['reports', 'dismiss', report, '--note', note]);
    expect(run).toMatchObject({ code: 0, log: [`Dismissed Report ${report}.`], error: [] });

    const reports = new Map((await reportsOf(harness)).map((row) => [row.id, row]));
    expect(reports.get(report)).toMatchObject({ status: 'dismissed', resolution_note: note });
    expect(reports.get(report)?.resolved_at).not.toBeNull();
    expect(reports.get(other)).toMatchObject({ status: 'open', resolution_note: null });
    // The Harness is untouched, and a dismissal is not a Takedown: no admin_actions row.
    expect(await harnessState(harness)).toEqual({ status: 'active', latest_version: '1.0.0' });
    expect(await versionsOf(harness)).toEqual([
      { version: '1.0.0', status: 'published', takedown_note: null },
    ]);
    expect(await actionsOn(harness)).toEqual([]);

    // Only an open Report can be dismissed.
    const again = await cli(['reports', 'dismiss', report, '--note', 'Again.']);
    expect(again).toMatchObject({ code: 1, error: [`No open Report ${report}.`] });
    expect((await reportsOf(harness)).find((row) => row.id === report)?.resolution_note).toBe(note);
  });

  it('exits 1 for a Report that does not exist', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    expect(await cli(['reports', 'dismiss', id, '--note', 'x'])).toMatchObject({
      code: 1,
      error: [`No open Report ${id}.`],
    });
  });
});

describe('takedown', () => {
  it('--version takes down only that version, resolves every open Report and logs one action', async () => {
    const harness = await harnessWith('version-down', ['1.0.0', '2.0.0']);
    const ids = await versionIds(harness);
    const onVersion = await reportOn(harness, { version_id: ids.get('2.0.0') ?? '' });
    const onHarness = await reportOn(harness, { reason: 'other' });
    const note = 'Version 2.0.0 sends files to an unknown server. Appeals: appeals@example.com';

    const run = await cli(['takedown', harness.harness_id, '--version', '2.0.0', '--note', note]);
    expect(run).toMatchObject({
      code: 0,
      log: [`Took down version 2.0.0 of ${harness.harness_id}; resolved 2 open Reports.`],
      error: [],
    });
    expect(await versionsOf(harness)).toEqual([
      { version: '1.0.0', status: 'published', takedown_note: null },
      { version: '2.0.0', status: 'taken_down', takedown_note: note },
    ]);
    expect(await harnessState(harness)).toEqual({ status: 'active', latest_version: '1.0.0' });
    for (const report of await reportsOf(harness)) {
      expect([onVersion, onHarness]).toContain(report.id);
      expect(report).toMatchObject({ status: 'resolved', resolution_note: note });
      expect(report.resolved_at).not.toBeNull();
    }
    expect(await actionsOn(harness)).toEqual([
      {
        admin_id: admin.id,
        action: 'takedown_version',
        target_version_id: ids.get('2.0.0'),
        note,
      },
    ]);
  });

  it('without --version takes down the whole Harness and every version, with one action', async () => {
    const harness = await harnessWith('whole-down', ['1.0.0', '1.1.0']);
    await reportOn(harness);
    const note = 'Malware in every version.';

    const run = await cli(['takedown', harness.harness_id, '--note', note]);
    expect(run).toMatchObject({
      code: 0,
      log: [`Took down the whole Harness ${harness.harness_id}; resolved 1 open Report.`],
    });
    expect(await versionsOf(harness)).toEqual([
      { version: '1.0.0', status: 'taken_down', takedown_note: note },
      { version: '1.1.0', status: 'taken_down', takedown_note: note },
    ]);
    expect(await harnessState(harness)).toEqual({ status: 'taken_down', latest_version: null });
    expect((await reportsOf(harness)).map((report) => report.status)).toEqual(['resolved']);
    expect(await actionsOn(harness)).toEqual([
      { admin_id: admin.id, action: 'takedown_harness', target_version_id: null, note },
    ]);
  });

  it('refuses a login that is not an administrator, and an unknown one, changing nothing', async () => {
    const harness = await harnessWith('not-down', ['1.0.0']);
    await reportOn(harness);
    for (const [login, message] of [
      [notAdmin.userName, 'STORE_ADMIN_LOGIN is not a Store administrator'],
      ['nobody-at-all-here', 'STORE_ADMIN_LOGIN names no profile in this Store.'],
    ] as const) {
      const run = await cli(['takedown', harness.harness_id, '--note', 'No.'], environment(login));
      expect(run.code, login).toBe(1);
      expect(run.error[0]).toContain(message);
    }
    expect(await harnessState(harness)).toEqual({ status: 'active', latest_version: '1.0.0' });
    expect((await reportsOf(harness)).map((report) => report.status)).toEqual(['open']);
    expect(await actionsOn(harness)).toEqual([]);
  });

  it("exits 1 with the function's code and message for an unknown Harness or version", async () => {
    const harness = await harnessWith('unknown-version', ['1.0.0']);
    for (const argv of [
      ['takedown', `${owner.userName.toLowerCase()}/no-such-harness`, '--note', 'x'],
      ['takedown', harness.harness_id, '--version', '9.9.9', '--note', 'x'],
    ]) {
      const run = await cli(argv);
      expect(run.code).toBe(1);
      expect(run.error[0]).toMatch(/^The Store refused \(404\): not_found: /);
      for (const secret of [stack.serviceRoleKey, stack.jwtSecret]) {
        expect(run.printed).not.toContain(secret);
      }
    }
    expect(await actionsOn(harness)).toEqual([]);
  });
});

describe('Store discovery after a Takedown (the P0-09 reads)', () => {
  const LIST_COLUMNS =
    'harness_id,name,summary,icon_path,tags,download_count,latest_version,latest_published_at,harness_versions(version,platforms)';
  const FEATURED = `harnesses?featured_rank=not.is.null&order=featured_rank&limit=12&select=${LIST_COLUMNS}`;
  const MOST_DOWNLOADED = `harnesses?order=download_count.desc,harness_id&limit=12&select=${LIST_COLUMNS}`;
  const NEW = `harnesses?order=latest_published_at.desc,harness_id&limit=12&select=${LIST_COLUMNS}`;
  const publisherPage = (login: string) =>
    `profiles?github_login=eq.${login}&select=github_login,display_name,avatar_url,bio,created_at,harnesses(${LIST_COLUMNS})&harnesses.order=download_count.desc,harness_id`;

  interface Card {
    harness_id: string;
    latest_version: string | null;
    harness_versions: { version: string }[];
  }

  /** Every place discovery shows `harness`: its card in each read, by read. */
  async function discovery(harness: HarnessRow, query: string) {
    const card = async (path: string) => {
      const reply = await rest<Card[]>('anon', 'GET', path);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      return reply.body.find((row) => row.harness_id === harness.harness_id) ?? null;
    };
    const search = await rest<{ harness_id: string; latest_version: string }[]>(
      'anon',
      'POST',
      'rpc/search_harnesses',
      { q: query },
    );
    expect(search.status).toBe(200);
    const page = await rest<{ harnesses: Card[] }[]>(
      'anon',
      'GET',
      publisherPage(owner.userName.toLowerCase()),
    );
    expect(page.status).toBe(200);
    return {
      featured: await card(FEATURED),
      mostDownloaded: await card(MOST_DOWNLOADED),
      new: await card(NEW),
      search: search.body.find((row) => row.harness_id === harness.harness_id) ?? null,
      publisherPage:
        page.body[0]?.harnesses.find((row) => row.harness_id === harness.harness_id) ?? null,
    };
  }

  it('a whole-Harness Takedown removes it from the home rows, search and the Publisher page', async () => {
    const query = word();
    const harness = await harnessWith('gone-whole', ['1.0.0'], `Gone ${query}`);
    await serviceRest('PATCH', `harnesses?id=eq.${harness.id}`, { featured_rank: 77 });

    const before = await discovery(harness, query);
    for (const [read, card] of Object.entries(before)) {
      expect(card, read).toMatchObject({ harness_id: harness.harness_id, latest_version: '1.0.0' });
    }

    expect((await cli(['takedown', harness.harness_id, '--note', 'Malware.'])).code).toBe(0);
    expect(await discovery(harness, query)).toEqual({
      featured: null,
      mostDownloaded: null,
      new: null,
      search: null,
      publisherPage: null,
    });
  });

  it('a version Takedown removes that version: the latest is the one before, and it is embedded nowhere', async () => {
    const query = word();
    const harness = await harnessWith('gone-version', ['1.0.0', '2.0.0'], `Gone ${query}`);
    await serviceRest('PATCH', `harnesses?id=eq.${harness.id}`, { featured_rank: 78 });
    const before = await discovery(harness, query);
    expect(before.new?.latest_version).toBe('2.0.0');
    expect(before.search?.latest_version).toBe('2.0.0');

    const run = await cli([
      'takedown',
      harness.harness_id,
      '--version',
      '2.0.0',
      '--note',
      'Bad release.',
    ]);
    expect(run.code).toBe(0);

    const after = await discovery(harness, query);
    expect(after.search).toMatchObject({ latest_version: '1.0.0' });
    for (const read of ['featured', 'mostDownloaded', 'new', 'publisherPage'] as const) {
      expect(after[read], read).toMatchObject({
        latest_version: '1.0.0',
        harness_versions: [{ version: '1.0.0' }],
      });
    }
    // Nor can the detail page read it.
    const detail = await rest(
      'anon',
      'GET',
      `harness_versions?harness_id=eq.${harness.id}&version=eq.2.0.0`,
    );
    expect(detail).toEqual({ status: 200, body: [] });
  });
});
