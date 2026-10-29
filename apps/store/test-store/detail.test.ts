/**
 * Ticket P0-09.3: the reads behind the desktop app's Harness detail page, called exactly as
 * docs/tech/api.md writes them, with the anon key: the Harness detail read (its columns named, so
 * no `search` vector, and its published versions newest first with their changelogs and Declared
 * Permissions), then the "Version manifest" read of the latest version, and the list read's
 * embedded platforms for a Harness with several published versions. The test Publisher's Harness
 * has three published versions and a newer Unpublished one.
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

const LIST_COLUMNS =
  'harness_id,name,summary,icon_path,tags,download_count,latest_version,latest_published_at,harness_versions(version,platforms)';

/** api.md's Harness detail read, word for word. */
const detailRead = (harnessId: string) =>
  `harnesses?harness_id=eq.${encodeURIComponent(harnessId)}` +
  '&select=id,harness_id,name,summary,icon_path,tags,download_count,latest_version,latest_published_at,status,' +
  'profiles(github_login,display_name,avatar_url),' +
  'harness_versions(version,changelog,published_at,platforms,status,download_count,permissions)' +
  '&harness_versions.order=published_at.desc';

/** api.md's Version manifest read, as the detail page makes it. */
const versionRead = (uuid: string, version: string) =>
  `harness_versions?harness_id=eq.${uuid}&version=eq.${version}&select=manifest,readme,screenshot_paths`;

const DAY_MS = 24 * 60 * 60 * 1000;
const NONE = { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } };
const SHELL = { filesystem: { scope: 'workspace' }, shell: true, network: { domains: [] } };

let publisher: TestUser;
let harness: HarnessRow;

beforeAll(async () => {
  publisher = await createUser();
  harness = await insertHarness(publisher, 'three-versions');
  const versions = [
    ['1.0.0', 30, NONE, ['linux-x64']],
    ['1.1.0', 20, SHELL, ['linux-x64', 'darwin-arm64']],
    ['1.2.0', 10, SHELL, ['darwin-arm64']],
    ['1.3.0', 5, NONE, ['win32-x64']],
  ] as const;
  for (const [version, daysAgo, permissions, platforms] of versions) {
    await insertVersion(harness, version, {
      manifest: {
        id: harness.harness_id,
        version,
        name: 'Three Versions',
        summary: 'Has a history.',
        changelog: `Notes ${version}`,
      },
      changelog: `Notes ${version}`,
      permissions,
      platforms,
      readme: `# Three Versions ${version}`,
      screenshot_paths: [`${harness.harness_id}/${version}/screenshots/1.png`],
      published_at: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    });
  }
  await serviceRest('PATCH', `harness_versions?harness_id=eq.${harness.id}&version=eq.1.3.0`, {
    status: 'unpublished',
    unpublished_at: new Date().toISOString(),
  });
});

afterAll(async () => {
  await deleteUser(publisher);
});

interface DetailRow {
  id: string;
  harness_id: string;
  latest_version: string;
  status: string;
  profiles: { github_login: string; display_name: string | null; avatar_url: string | null };
  harness_versions: {
    version: string;
    changelog: string | null;
    status: string;
    permissions: unknown;
    platforms: string[];
  }[];
}

describe('Harness detail read', () => {
  it('lists the published versions only, newest first, each with its changelog and permissions', async () => {
    const reply = await rest<DetailRow[]>('anon', 'GET', detailRead(harness.harness_id));
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const [row] = reply.body;
    expect(row).toMatchObject({
      id: harness.id,
      harness_id: harness.harness_id,
      latest_version: '1.2.0',
      status: 'active',
      profiles: { github_login: publisher.userName.toLowerCase() },
    });
    expect(
      row?.harness_versions.map(({ version, changelog, status, permissions }) => ({
        version,
        changelog,
        status,
        permissions,
      })),
    ).toEqual([
      { version: '1.2.0', changelog: 'Notes 1.2.0', status: 'published', permissions: SHELL },
      { version: '1.1.0', changelog: 'Notes 1.1.0', status: 'published', permissions: SHELL },
      { version: '1.0.0', changelog: 'Notes 1.0.0', status: 'published', permissions: NONE },
    ]);
    // Its columns are named: no search vector.
    expect(row).not.toHaveProperty('search');
  });

  it("then reads the latest version's Manifest, README and screenshots", async () => {
    const reply = await rest<Record<string, unknown>[]>(
      'anon',
      'GET',
      versionRead(harness.id, '1.2.0'),
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toEqual([
      {
        manifest: expect.objectContaining({ id: harness.harness_id, version: '1.2.0' }) as unknown,
        readme: '# Three Versions 1.2.0',
        screenshot_paths: [`${harness.harness_id}/1.2.0/screenshots/1.png`],
      },
    ]);
    // An Unpublished version is not readable at all.
    const hidden = await rest('anon', 'GET', versionRead(harness.id, '1.3.0'));
    expect(hidden).toEqual({ status: 200, body: [] });
  });

  it("embeds every published version's platforms in the list read, the latest one's among them", async () => {
    const reply = await rest<
      {
        harnesses: {
          latest_version: string;
          harness_versions: { version: string; platforms: string[] }[];
        }[];
      }[]
    >(
      'anon',
      'GET',
      `profiles?github_login=eq.${publisher.userName.toLowerCase()}&select=github_login,display_name,avatar_url,bio,created_at,harnesses(${LIST_COLUMNS})&harnesses.order=download_count.desc,harness_id`,
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const [listed] = reply.body[0]?.harnesses ?? [];
    expect(listed?.latest_version).toBe('1.2.0');
    expect(
      [...(listed?.harness_versions ?? [])].sort((a, b) => (a.version < b.version ? -1 : 1)),
    ).toEqual([
      { version: '1.0.0', platforms: ['linux-x64'] },
      { version: '1.1.0', platforms: ['linux-x64', 'darwin-arm64'] },
      { version: '1.2.0', platforms: ['darwin-arm64'] },
    ]);
  });
});
