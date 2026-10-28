/**
 * Seeds the local Store with Harnesses built from the P0-01 fixture packages (the reference
 * Harnesses of P0-06 do not exist yet at this point of the build order). Run by `pnpm db:reset`
 * after `supabase db reset`, or on its own with `pnpm seed`.
 *
 * Every Harness Package is zipped, checked with validatePackage exactly as the `publish` function
 * will check it, and stored at the paths `publish` uses; the rows are written with the service
 * role, as the Edge Functions write them. SQL cannot upload to Storage, which is why this is a
 * script and not supabase/seed.sql.
 *
 * Idempotent: it first deletes every catalogue row (Harnesses and, through them, versions,
 * Reports and download events) and every object in both buckets, and reuses the seed Publishers'
 * auth users when they exist. Running it twice gives the same catalogue.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ArchiveSource, validatePackage } from '@harness-store/manifest';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { zipSync } from 'fflate';
import { storedReadme } from '../supabase/functions/_shared/readme.ts';
import {
  ASSETS_BUCKET,
  assetUploads,
  PACKAGES_BUCKET,
  packagePath,
} from '../supabase/functions/_shared/storage-paths.ts';
import { localStack, storeRoot } from './local-stack.ts';
import type { LocalStack } from './local-stack.ts';

interface SeedPublisher {
  login: string;
  displayName: string;
}

interface SeedVersion {
  version: string;
  downloads: number;
  /** How long ago it was published; also keeps seed publishes out of the 24 h rate limit. */
  daysAgo: number;
  /** What happened to it after publishing. */
  status?: 'unpublished' | 'taken_down';
  /** Manifest fields of this version only. */
  manifest?: Record<string, unknown>;
}

interface SeedHarness {
  /** Harness ID, `publisher/slug`. */
  id: string;
  /** Folder in packages/manifest/fixtures the package is made from. */
  fixture: string;
  /** Manifest fields replaced in every version (besides `id` and `version`). */
  manifest?: Record<string, unknown>;
  /** README.md replacing the fixture's. */
  readme?: string;
  /** In ascending version order: each must be greater than the ones before. */
  versions: SeedVersion[];
  featuredRank?: number;
  takenDown?: boolean;
}

export const SEED_PUBLISHERS: readonly SeedPublisher[] = [
  { login: 'alice', displayName: 'Alice Example' },
  { login: 'bob', displayName: '鲍勃' },
  { login: 'carol', displayName: 'Carol Example' },
];

/**
 * Three visible Harnesses (one Featured, one in Chinese, one whose newest version is
 * Unpublished), one Harness whose only version is Unpublished and one taken down.
 */
export const SEED_HARNESSES: readonly SeedHarness[] = [
  {
    id: 'alice/code-reviewer',
    fixture: 'valid-binary-multi-platform',
    featuredRank: 1,
    versions: [
      {
        version: '2.0.0',
        downloads: 950,
        daysAgo: 30,
        manifest: { changelog: '## 2.0.0\n\n- First stable release.' },
      },
      { version: '2.1.0-beta.3', downloads: 310, daysAgo: 3 },
    ],
  },
  {
    id: 'alice/hello-web',
    fixture: 'valid-with-screenshots',
    versions: [
      { version: '0.1.0', downloads: 128, daysAgo: 20 },
      { version: '0.2.0', downloads: 4, daysAgo: 10, status: 'unpublished' },
    ],
  },
  {
    id: 'bob/xiezuo',
    fixture: 'valid-web-ui-options',
    manifest: { name: '写作助手', summary: '帮你润色中文文章。', tags: ['writing'] },
    readme: '# 写作助手\n\n润色、改写和总结中文文章。\n',
    versions: [{ version: '1.0.0', downloads: 42, daysAgo: 7 }],
  },
  {
    id: 'bob/retired-tool',
    fixture: 'valid-minimal-node',
    manifest: { name: 'Retired Tool', summary: 'A Harness whose only version was Unpublished.' },
    versions: [{ version: '1.0.0', downloads: 7, daysAgo: 40, status: 'unpublished' }],
  },
  {
    id: 'carol/bad-tool',
    fixture: 'valid-minimal-node',
    manifest: { name: 'Bad Tool', summary: 'A Harness taken down by a Store administrator.' },
    takenDown: true,
    versions: [{ version: '1.0.0', downloads: 3, daysAgo: 15, status: 'taken_down' }],
  },
];

/** Zip entry times are fixed so the same seed gives byte-identical packages. */
const ZIP_TIME = new Date('2026-01-01T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function seedEmail(login: string): string {
  return `${login}@seed.harness-store.invalid`;
}

/** Every file under `dir`, by `/`-separated relative path. */
export function readFolder(dir: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const visit = (prefix: string) => {
    for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.set(path, readFileSync(join(dir, path)));
    }
  };
  visit('');
  return files;
}

/** The fixture folder as a Harness Package for `version`, zipped. */
function buildPackage(harness: SeedHarness, version: SeedVersion) {
  const fixtures = join(storeRoot(), '..', '..', 'packages', 'manifest', 'fixtures');
  const files = readFolder(join(fixtures, harness.fixture));
  const fixtureManifest = JSON.parse(
    new TextDecoder().decode(files.get('manifest.json')),
  ) as Record<string, unknown>;
  const manifest = {
    ...fixtureManifest,
    ...harness.manifest,
    ...version.manifest,
    id: harness.id,
    version: version.version,
  };
  files.set('manifest.json', new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
  if (harness.readme !== undefined)
    files.set('README.md', new TextEncoder().encode(harness.readme));
  const zip = zipSync(Object.fromEntries(files), { mtime: ZIP_TIME });
  return { files, zip };
}

async function ensurePublishers(client: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await client.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  for (const publisher of SEED_PUBLISHERS) {
    if (data.users.some((user) => user.email === seedEmail(publisher.login))) continue;
    // What GitHub sign-in gives Auth; the profile trigger turns it into a profiles row.
    const created = await client.auth.admin.createUser({
      email: seedEmail(publisher.login),
      email_confirm: true,
      app_metadata: { provider: 'github' },
      user_metadata: { user_name: publisher.login, full_name: publisher.displayName },
    });
    if (created.error) throw created.error;
  }
  const profiles = await client
    .from('profiles')
    .select('id, github_login')
    .in(
      'github_login',
      SEED_PUBLISHERS.map((publisher) => publisher.login),
    );
  if (profiles.error) throw profiles.error;
  return new Map(
    profiles.data.map((row: { id: string; github_login: string }) => [row.github_login, row.id]),
  );
}

async function wipe(client: SupabaseClient): Promise<void> {
  // Versions, Reports and download events go with their Harness (on delete cascade).
  const deleted = await client.from('harnesses').delete().not('id', 'is', null);
  if (deleted.error) throw deleted.error;
  for (const bucket of [PACKAGES_BUCKET, ASSETS_BUCKET]) {
    const emptied = await client.storage.emptyBucket(bucket);
    if (emptied.error) throw emptied.error;
  }
}

async function upload(
  client: SupabaseClient,
  bucket: string,
  path: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  const { error } = await client.storage.from(bucket).upload(path, body, { contentType });
  if (error) throw new Error(`Uploading ${bucket}/${path} failed: ${error.message}`);
}

async function seedHarness(
  client: SupabaseClient,
  harness: SeedHarness,
  publisherIds: Map<string, string>,
  now: number,
): Promise<void> {
  const [login = '', slug = ''] = harness.id.split('/');
  const publisherId = publisherIds.get(login);
  if (publisherId === undefined) throw new Error(`No seed Publisher "${login}"`);
  let harnessRowId: string | undefined;
  const published: string[] = [];

  for (const version of harness.versions) {
    const { files, zip } = buildPackage(harness, version);
    const result = await validatePackage(await ArchiveSource.open(zip), {
      publisher: login,
      publishedVersions: published,
    });
    if (!result.ok) {
      throw new Error(
        `Seed package ${harness.id}@${version.version} is invalid: ${JSON.stringify(result.problems)}`,
      );
    }
    const { manifest } = result;

    const zipPath = packagePath(harness.id, version.version);
    await upload(client, PACKAGES_BUCKET, zipPath, zip, 'application/zip');
    const assets = assetUploads(harness.id, version.version, files.keys());
    for (const asset of assets) {
      const bytes = files.get(asset.file);
      if (bytes === undefined) throw new Error(`${asset.file} is missing`);
      await upload(client, ASSETS_BUCKET, asset.path, bytes, asset.contentType);
    }

    if (harnessRowId === undefined) {
      const inserted = await client
        .from('harnesses')
        .insert({
          publisher_id: publisherId,
          slug,
          name: manifest.name,
          summary: manifest.summary,
          tags: manifest.tags ?? [],
        })
        .select('id')
        .single<{ id: string }>();
      if (inserted.error) throw inserted.error;
      harnessRowId = inserted.data.id;
    }

    const readme = files.get('README.md') ?? new Uint8Array();
    const row = await client.from('harness_versions').insert({
      harness_id: harnessRowId,
      version: version.version,
      manifest,
      readme: storedReadme(readme),
      changelog: manifest.changelog ?? null,
      platforms: manifest.platforms,
      permissions: manifest.permissions,
      package_path: zipPath,
      package_sha256: createHash('sha256').update(zip).digest('hex'),
      package_size: zip.length,
      screenshot_paths: assets.slice(1).map((asset) => asset.path),
      download_count: version.downloads,
      published_at: new Date(now - version.daysAgo * DAY_MS).toISOString(),
    });
    if (row.error) throw row.error;
    published.push(version.version);
  }

  for (const version of harness.versions) {
    if (version.status === undefined) continue;
    const changed = await client
      .from('harness_versions')
      .update({
        status: version.status,
        ...(version.status === 'unpublished'
          ? { unpublished_at: new Date(now).toISOString() }
          : {}),
      })
      .eq('harness_id', harnessRowId)
      .eq('version', version.version);
    if (changed.error) throw changed.error;
  }

  if (harness.takenDown === true || harness.featuredRank !== undefined) {
    const changed = await client
      .from('harnesses')
      .update({
        ...(harness.takenDown === true ? { status: 'taken_down' } : {}),
        ...(harness.featuredRank !== undefined ? { featured_rank: harness.featuredRank } : {}),
      })
      .eq('id', harnessRowId);
    if (changed.error) throw changed.error;
  }
}

/** Replaces the local Store's catalogue with the seed catalogue. */
export async function seed(stack: LocalStack = localStack()): Promise<void> {
  const client = createClient(stack.apiUrl, stack.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const publisherIds = await ensurePublishers(client);
  await wipe(client);
  const now = Date.now();
  for (const harness of SEED_HARNESSES) await seedHarness(client, harness, publisherIds, now);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await seed();
  console.log(
    `Seeded ${String(SEED_HARNESSES.length)} Harnesses from ${String(SEED_PUBLISHERS.length)} Publishers.`,
  );
}
