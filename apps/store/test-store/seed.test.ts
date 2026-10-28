/**
 * Ticket P0-07.1, "How to verify" step 3: the seed is reproducible. It first wipes the catalogue
 * and both buckets, so running it again gives a catalogue identical to a fresh one.
 */
import { describe, expect, it } from 'vitest';
import { seed } from '../scripts/seed.ts';
import { call, serviceRest } from './support.ts';

interface Snapshot {
  counts: Record<string, number>;
  harnesses: unknown[];
  versions: unknown[];
  objects: Record<string, string[]>;
}

/** Every object path under `prefix` in `bucket`, listed folder by folder. */
async function listObjects(bucket: string, prefix = ''): Promise<string[]> {
  const reply = await call<{ name: string; id: string | null }[]>(
    'service',
    'POST',
    `storage/v1/object/list/${bucket}`,
    {
      prefix,
      limit: 1000,
    },
  );
  const paths: string[] = [];
  for (const item of reply.body) {
    const path = prefix === '' ? item.name : `${prefix}/${item.name}`;
    // Folders have no id.
    if (item.id === null) paths.push(...(await listObjects(bucket, path)));
    else paths.push(path);
  }
  return paths.sort();
}

async function snapshot(): Promise<Snapshot> {
  const counts: Record<string, number> = {};
  for (const table of ['profiles', 'harnesses', 'harness_versions', 'reports', 'download_events']) {
    counts[table] = (await serviceRest<unknown[]>('GET', `${table}?select=id`)).length;
  }
  return {
    counts,
    harnesses: await serviceRest(
      'GET',
      'harnesses?select=harness_id,name,summary,tags,icon_path,latest_version,status,featured_rank,download_count,search&order=harness_id',
    ),
    versions: await serviceRest(
      'GET',
      'harness_versions?select=version,status,semver_key,platforms,package_path,package_sha256,package_size,screenshot_paths,download_count,harnesses(harness_id)&order=package_path',
    ),
    objects: {
      'harness-packages': await listObjects('harness-packages'),
      'harness-assets': await listObjects('harness-assets'),
    },
  };
}

describe('seed', () => {
  it('gives the same catalogue every time it runs', async () => {
    await seed();
    const first = await snapshot();
    await seed();
    const second = await snapshot();
    expect(second).toEqual(first);

    // Three visible Harnesses, one Unpublished-only, one taken down.
    expect(first.counts).toMatchObject({
      harnesses: 5,
      harness_versions: 7,
      reports: 0,
      download_events: 0,
    });
    expect(first.objects['harness-packages']).toHaveLength(7);
    // An icon per version, plus two screenshots for each alice/hello-web version.
    expect(first.objects['harness-assets']).toHaveLength(11);
    expect(first.objects['harness-assets']).toContain('alice/hello-web/0.1.0/screenshots/1.jpg');
  });

  it('has a Featured Harness, an Unpublished-only one and a taken-down one', async () => {
    const rows = await serviceRest<
      {
        harness_id: string;
        featured_rank: number | null;
        latest_version: string | null;
        status: string;
      }[]
    >('GET', 'harnesses?select=harness_id,featured_rank,latest_version,status&order=harness_id');
    expect(rows).toEqual([
      {
        harness_id: 'alice/code-reviewer',
        featured_rank: 1,
        latest_version: '2.1.0-beta.3',
        status: 'active',
      },
      {
        harness_id: 'alice/hello-web',
        featured_rank: null,
        latest_version: '0.1.0',
        status: 'active',
      },
      {
        harness_id: 'bob/retired-tool',
        featured_rank: null,
        latest_version: null,
        status: 'active',
      },
      { harness_id: 'bob/xiezuo', featured_rank: null, latest_version: '1.0.0', status: 'active' },
      {
        harness_id: 'carol/bad-tool',
        featured_rank: null,
        latest_version: null,
        status: 'taken_down',
      },
    ]);
  });
});
