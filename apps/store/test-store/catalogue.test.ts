/**
 * Ticket P0-07.1: what the schema's triggers guarantee whoever writes. The writes here use the
 * service role, which bypasses row-level security, so it is the trigger (not RLS) that refuses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createUser,
  deleteUser,
  insertHarness,
  insertVersion,
  isPermissionDenied,
  readHarness,
  rest,
  serviceRest,
  versionRow,
} from './support.ts';
import type { HarnessRow, TestUser, VersionRow } from './support.ts';

let publisher: TestUser;

beforeAll(async () => {
  publisher = await createUser();
});

afterAll(async () => {
  await deleteUser(publisher);
});

describe('semver_key', () => {
  it('orders 1.0.0 < 1.0.1 < 1.1.0-beta.1 < 1.1.0 < 2.0.0 (and 1.9.0 < 1.10.0)', async () => {
    const ordered = ['1.0.0', '1.0.1', '1.1.0-beta.1', '1.1.0', '1.9.0', '1.10.0', '2.0.0'];
    // One Harness per version, inserted in a shuffled order, so neither insertion order nor text
    // order (where "1.1.0" < "1.1.0-beta.1" and "1.10.0" < "1.9.0") can pass for semver order.
    const shuffled = ['1.10.0', '2.0.0', '1.1.0', '1.0.0', '1.1.0-beta.1', '1.9.0', '1.0.1'];
    const ids: string[] = [];
    for (const [index, version] of shuffled.entries()) {
      const harness = await insertHarness(publisher, `semver-${String(index)}`);
      await insertVersion(harness, version);
      ids.push(harness.id);
    }
    const rows = await serviceRest<VersionRow[]>(
      'GET',
      `harness_versions?harness_id=in.(${ids.join(',')})&select=version,semver_key&order=semver_key.asc`,
    );
    expect(rows.map((row) => row.version)).toEqual(ordered);
    expect(rows.find((row) => row.version === '1.1.0-beta.1')?.semver_key).toEqual([1, 1, 0, 0]);
    expect(rows.find((row) => row.version === '1.1.0')?.semver_key).toEqual([1, 1, 0, 1]);
  });

  it('refuses a version that is not strict semver', async () => {
    const harness = await insertHarness(publisher, 'semver-invalid');
    const reply = await rest('service', 'POST', 'harness_versions', versionRow(harness, '1.0'));
    expect(reply.status).toBe(400);
    expect(JSON.stringify(reply.body)).toContain('Not a strict semver version');
  });

  it('refuses a version that sorts below one already published (a backstop for publish)', async () => {
    const harness = await insertHarness(publisher, 'semver-backstop');
    await insertVersion(harness, '2.0.0');
    const reply = await rest('service', 'POST', 'harness_versions', versionRow(harness, '1.5.0'));
    expect(reply.status).toBe(400);
    expect(JSON.stringify(reply.body)).toContain('not greater than every earlier version');
  });
});

describe('Harness fields copied from the latest published version', () => {
  let harness: HarnessRow;

  beforeAll(async () => {
    harness = await insertHarness(publisher, 'latest');
    await insertVersion(harness, '1.0.0', { download_count: 5 });
    await insertVersion(harness, '1.1.0-beta.1', { download_count: 2 });
    await insertVersion(harness, '1.1.0-beta.2', {
      download_count: 1,
      readme: '# Tiles\n\nMahjong solitaire with your model as the opponent.',
      manifest: {
        name: 'Tiles',
        summary: 'Mahjong solitaire.',
        tags: ['fun', 'education'],
      },
    });
  });

  it('sets the Harness ID, the listing fields and the search vector from that version', async () => {
    const row = await readHarness(harness.id);
    expect(row).toMatchObject({
      harness_id: `${publisher.userName}/latest`,
      latest_version: '1.1.0-beta.2',
      name: 'Tiles',
      summary: 'Mahjong solitaire.',
      tags: ['fun', 'education'],
      icon_path: `${publisher.userName}/latest/1.1.0-beta.2/icon.png`,
      download_count: 8,
    });
    expect(row.latest_published_at).not.toBeNull();
    const matches = await serviceRest<unknown[]>(
      'GET',
      `harnesses?id=eq.${harness.id}&search=fts(simple).opponent`,
    );
    expect(matches).toHaveLength(1);
  });

  it('falls back to the previous published version after an Unpublish, then to none', async () => {
    await serviceRest(
      'PATCH',
      `harness_versions?harness_id=eq.${harness.id}&version=eq.1.1.0-beta.2`,
      { status: 'unpublished', unpublished_at: new Date().toISOString() },
    );
    expect((await readHarness(harness.id)).latest_version).toBe('1.1.0-beta.1');

    await serviceRest('PATCH', `harness_versions?harness_id=eq.${harness.id}&status=eq.published`, {
      status: 'unpublished',
    });
    const row = await readHarness(harness.id);
    // The last listing fields stay (those of 1.1.0-beta.1); only the latest version and its date go.
    expect(row).toMatchObject({
      latest_version: null,
      latest_published_at: null,
      name: 'latest 1.1.0-beta.1',
    });
    expect(row.status).toBe('active');
  });
});

describe('Harness Version immutability', () => {
  let harness: HarnessRow;
  let version: VersionRow;

  beforeAll(async () => {
    harness = await insertHarness(publisher, 'immutable');
    version = await insertVersion(harness, '1.0.0');
  });

  it.each([
    ['manifest', { manifest: { id: 'x/y' } }],
    ['version', { version: '9.9.9' }],
    ['readme', { readme: 'changed' }],
    ['package_sha256', { package_sha256: 'f'.repeat(64) }],
    ['published_at', { published_at: '2020-01-01T00:00:00Z' }],
  ])('the trigger refuses a change of %s, even for the service role', async (_column, change) => {
    const reply = await rest('service', 'PATCH', `harness_versions?id=eq.${version.id}`, change);
    expect(reply.status).toBe(400);
    expect(JSON.stringify(reply.body)).toContain('is immutable');
    const [row] = await serviceRest<VersionRow[]>('GET', `harness_versions?id=eq.${version.id}`);
    expect(row).toEqual(version);
  });

  it('RLS refuses the same change for an authenticated Publisher, even the owner', async () => {
    const reply = await rest(
      { token: publisher.token },
      'PATCH',
      `harness_versions?id=eq.${version.id}`,
      {
        manifest: { id: 'x/y' },
      },
    );
    expect(isPermissionDenied(reply)).toBe(true);
  });

  it('allows download_count, status and unpublished_at to change', async () => {
    await serviceRest('PATCH', `harness_versions?id=eq.${version.id}`, { download_count: 3 });
    await serviceRest('PATCH', `harness_versions?id=eq.${version.id}`, {
      status: 'unpublished',
      unpublished_at: new Date().toISOString(),
    });
    const [row] = await serviceRest<VersionRow[]>('GET', `harness_versions?id=eq.${version.id}`);
    expect(row).toMatchObject({ download_count: 3, status: 'unpublished' });
  });

  it('only moves status forward: never back to published, and nothing leaves taken_down', async () => {
    const back = await rest('service', 'PATCH', `harness_versions?id=eq.${version.id}`, {
      status: 'published',
    });
    expect(back.status).toBe(400);
    expect(JSON.stringify(back.body)).toContain('cannot go from unpublished to published');

    await serviceRest('PATCH', `harness_versions?id=eq.${version.id}`, { status: 'taken_down' });
    const out = await rest('service', 'PATCH', `harness_versions?id=eq.${version.id}`, {
      status: 'unpublished',
    });
    expect(out.status).toBe(400);
    expect(JSON.stringify(out.body)).toContain('cannot go from taken_down to unpublished');
  });
});

describe('DELETE', () => {
  it('is refused to anon and to an authenticated Publisher, and allowed to the service role', async () => {
    const harness = await insertHarness(publisher, 'deletable');
    const version = await insertVersion(harness, '1.0.0');

    for (const caller of ['anon', { token: publisher.token }] as const) {
      for (const path of [
        `harness_versions?id=eq.${version.id}`,
        `harnesses?id=eq.${harness.id}`,
      ]) {
        const reply = await rest(caller, 'DELETE', path);
        expect(isPermissionDenied(reply)).toBe(true);
      }
    }
    expect(
      await serviceRest<unknown[]>('GET', `harness_versions?id=eq.${version.id}`),
    ).toHaveLength(1);

    expect(
      await serviceRest<unknown[]>('DELETE', `harness_versions?id=eq.${version.id}`),
    ).toHaveLength(1);
    expect(await serviceRest<unknown[]>('DELETE', `harnesses?id=eq.${harness.id}`)).toHaveLength(1);
  });
});
