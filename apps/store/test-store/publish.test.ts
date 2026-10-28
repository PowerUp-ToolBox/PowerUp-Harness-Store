/**
 * Ticket P0-07.3: the `publish` Edge Function, over HTTP against the local stack. Each package is
 * a P0-01 fixture folder zipped with the test Publisher's Harness ID; a rejected package must
 * give the documented status, code and validatePackage's own problems (compared with what
 * validatePackage reports locally for the same bytes and options), and leave no row and no
 * Storage object behind.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ArchiveSource,
  interpolate,
  MESSAGES_EN,
  PackageReadError,
  validatePackage,
} from '@harness-store/manifest';
import type { Manifest, Problem, ValidatePackageOptions } from '@harness-store/manifest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  corrupt,
  FIXTURES,
  fixturePackage,
  publish,
  storedEntry,
  symlinkEntry,
} from './packages.ts';
import type { PackageOptions } from './packages.ts';
import {
  call,
  createUser,
  deleteUser,
  edgeRuntimeUrl,
  insertHarness,
  insertVersion,
  listObjects,
  mintJwt,
  nodeOnStackNetwork,
  rest,
  serviceRest,
  sql,
  stack,
} from './support.ts';
import type { HarnessRow, TestUser } from './support.ts';

let publisher: TestUser;
let login: string;

beforeAll(async () => {
  publisher = await createUser();
  login = publisher.userName.toLowerCase();
});

afterAll(async () => {
  await deleteUser(publisher);
});

/** The fixture zipped as `<login>/<slug>@<version>`. */
function packageOf(
  slug: string,
  version: string,
  fixture = 'valid-minimal-node',
  options: PackageOptions = {},
): Uint8Array {
  return fixturePackage(fixture, {
    ...options,
    manifest: { id: `${login}/${slug}`, version, ...options.manifest },
  });
}

/** What validatePackage reports locally for the same zip and options. */
async function localProblems(zip: Uint8Array, options: ValidatePackageOptions) {
  const result = await validatePackage(await ArchiveSource.open(zip), options);
  if (result.ok) throw new Error('The package is valid locally');
  return result.problems;
}

/** Every object of `harnessId` in both buckets. */
async function objectsOf(harnessId: string): Promise<string[]> {
  return [
    ...(await listObjects('harness-packages', harnessId)),
    ...(await listObjects('harness-assets', harnessId)),
  ];
}

async function harnessRow(harnessId: string): Promise<HarnessRow | undefined> {
  const [row] = await serviceRest<HarnessRow[]>(
    'GET',
    `harnesses?harness_id=eq.${encodeURIComponent(harnessId)}`,
  );
  return row;
}

async function versionsOf(harnessId: string) {
  return serviceRest<
    {
      version: string;
      status: string;
      changelog: string | null;
      platforms: string[];
      permissions: unknown;
      manifest: Record<string, unknown>;
      readme: string;
      package_path: string;
      package_sha256: string;
      package_size: number;
      screenshot_paths: string[];
    }[]
  >(
    'GET',
    `harness_versions?select=*,harnesses!inner(harness_id)&harnesses.harness_id=eq.${encodeURIComponent(harnessId)}&order=published_at`,
  );
}

describe('a valid Harness Package', () => {
  it('creates the Harness and its Harness Version, and stores the package and its assets', async () => {
    const harnessId = `${login}/hello-web`;
    const zip = packageOf('hello-web', '0.1.0', 'valid-with-screenshots', {
      manifest: { changelog: '## 0.1.0\n\n- First release.' },
    });
    const reply = await publish(publisher.token, zip);
    expect(reply).toEqual({
      status: 201,
      body: { harness_id: harnessId, version: '0.1.0', url: `/store/h/${harnessId}` },
    });

    const harness = await harnessRow(harnessId);
    expect(harness).toMatchObject({
      harness_id: harnessId,
      name: 'Hello Web',
      summary: 'A minimal web-UI harness that says hello with your model.',
      tags: ['fun'],
      icon_path: `${harnessId}/0.1.0/icon.png`,
      latest_version: '0.1.0',
      status: 'active',
      download_count: 0,
    });
    const [version, ...others] = await versionsOf(harnessId);
    expect(others).toEqual([]);
    expect(version).toMatchObject({
      version: '0.1.0',
      status: 'published',
      changelog: '## 0.1.0\n\n- First release.',
      platforms: ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'],
      permissions: { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } },
      package_path: `${harnessId}/0.1.0.zip`,
      package_sha256: createHash('sha256').update(zip).digest('hex'),
      package_size: zip.length,
      screenshot_paths: [
        `${harnessId}/0.1.0/screenshots/0.png`,
        `${harnessId}/0.1.0/screenshots/1.jpg`,
      ],
    });
    expect(version?.manifest).toMatchObject({ id: harnessId, version: '0.1.0' });
    expect(version?.readme).toContain('# Fixture: valid-with-screenshots');

    // The package, byte for byte, from the private bucket (the service role, as `download` will).
    const stored = await fetch(
      `${stack.apiUrl}/storage/v1/object/harness-packages/${harnessId}/0.1.0.zip`,
      { headers: { authorization: `Bearer ${stack.serviceRoleKey}` } },
    );
    expect(stored.status).toBe(200);
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(zip);
    expect(await objectsOf(harnessId)).toEqual([
      `${harnessId}/0.1.0.zip`,
      `${harnessId}/0.1.0/icon.png`,
      `${harnessId}/0.1.0/screenshots/0.png`,
      `${harnessId}/0.1.0/screenshots/1.jpg`,
    ]);

    // Visible to anyone at once.
    const read = await rest<{ latest_version: string }[]>(
      'anon',
      'GET',
      `harnesses?harness_id=eq.${encodeURIComponent(harnessId)}&select=latest_version`,
    );
    expect(read.body).toEqual([{ latest_version: '0.1.0' }]);
  });

  it('keeps at most five screenshots of at most 2 MB, the first in package path order', async () => {
    const harnessId = `${login}/many-screenshots`;
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const screenshot = (index: number, size = 16) => {
      const bytes = new Uint8Array(size);
      bytes.set(signature);
      bytes[size - 1] = index;
      return bytes;
    };
    // Seven screenshots (validatePackage only warns), one of them over 2 MB.
    const extra: Record<string, Uint8Array> = {};
    for (let index = 0; index < 7; index++)
      extra[`assets/s${String(index)}.png`] = screenshot(index);
    extra['assets/s2.png'] = screenshot(2, 2 * 1024 * 1024 + 1);
    const zip = packageOf('many-screenshots', '1.0.0', 'valid-minimal-node', { extra });
    const result = await validatePackage(await ArchiveSource.open(zip), { publisher: login });
    expect(result.ok).toBe(true);
    expect(result.warnings.map((warning) => warning.code).sort()).toEqual([
      'file_too_large',
      'screenshots_too_many',
    ]);

    expect((await publish(publisher.token, zip)).status).toBe(201);
    const kept = ['s0', 's1', 's3', 's4', 's5'];
    const paths = kept.map((_, index) => `${harnessId}/1.0.0/screenshots/${String(index)}.png`);
    const [version] = await versionsOf(harnessId);
    expect(version?.screenshot_paths).toEqual(paths);
    expect(await objectsOf(harnessId)).toEqual([
      `${harnessId}/1.0.0.zip`,
      `${harnessId}/1.0.0/icon.png`,
      ...paths,
    ]);
    for (const [index, name] of kept.entries()) {
      const stored = await fetch(
        `${stack.apiUrl}/storage/v1/object/public/harness-assets/${paths[index] ?? ''}`,
      );
      expect(new Uint8Array(await stored.arrayBuffer()), name).toEqual(extra[`assets/${name}.png`]);
    }
  });

  it('updates the listing fields of the Harness from a newer version immediately', async () => {
    const harnessId = `${login}/listing`;
    expect((await publish(publisher.token, packageOf('listing', '1.0.0'))).status).toBe(201);
    const reply = await publish(
      publisher.token,
      packageOf('listing', '1.1.0', 'valid-minimal-node', {
        manifest: { name: 'Listing Two', summary: 'The second version.', tags: ['coding'] },
      }),
    );
    expect(reply.status).toBe(201);
    expect(await harnessRow(harnessId)).toMatchObject({
      name: 'Listing Two',
      summary: 'The second version.',
      tags: ['coding'],
      icon_path: `${harnessId}/1.1.0/icon.png`,
      latest_version: '1.1.0',
    });
  });
});

describe('version ordering', () => {
  const slug = 'ordering';
  const harnessId = () => `${login}/${slug}`;

  beforeAll(async () => {
    expect((await publish(publisher.token, packageOf(slug, '1.0.0'))).status).toBe(201);
  });

  it.each(['1.0.0', '0.9.0', '1.0.0-rc.1'])(
    'refuses %s after 1.0.0 with 409 version_not_greater and the validator problems',
    async (version) => {
      const before = await objectsOf(harnessId());
      const zip = packageOf(slug, version);
      const reply = await publish(publisher.token, zip);
      expect(reply.status).toBe(409);
      expect(reply.body.error).toEqual({
        code: 'version_not_greater',
        message: expect.any(String) as string,
        problems: await localProblems(zip, { publisher: login, publishedVersions: ['1.0.0'] }),
      });
      expect((await versionsOf(harnessId())).map((row) => row.version)).toEqual(['1.0.0']);
      expect(await objectsOf(harnessId())).toEqual(before);
    },
  );

  it('still refuses a version number that was Unpublished', async () => {
    expect((await publish(publisher.token, packageOf(slug, '1.1.0'))).status).toBe(201);
    // P0-07.6 (unpublish) does not exist yet: set the status as it will.
    await serviceRest(
      'PATCH',
      `harness_versions?package_path=eq.${encodeURIComponent(`${harnessId()}/1.1.0.zip`)}`,
      { status: 'unpublished', unpublished_at: new Date().toISOString() },
    );
    expect((await harnessRow(harnessId()))?.latest_version).toBe('1.0.0');

    for (const version of ['1.1.0', '1.0.5']) {
      const zip = packageOf(slug, version);
      const reply = await publish(publisher.token, zip);
      expect(reply.status, version).toBe(409);
      expect(reply.body.error.problems).toEqual(
        await localProblems(zip, { publisher: login, publishedVersions: ['1.0.0', '1.1.0'] }),
      );
    }
    expect((await publish(publisher.token, packageOf(slug, '1.2.0'))).status).toBe(201);
    expect((await harnessRow(harnessId()))?.latest_version).toBe('1.2.0');
  });
});

describe('a rejected Harness Package', () => {
  it("is refused with 403 publisher_mismatch for another Publisher's Harness ID", async () => {
    const other = `someone-else-${login}`;
    const zip = fixturePackage('publisher_mismatch', {
      manifest: { id: `${other}/hello-web` },
    });
    const reply = await publish(publisher.token, zip);
    expect(reply.status).toBe(403);
    expect(reply.body.error).toEqual({
      code: 'publisher_mismatch',
      message: expect.any(String) as string,
      problems: await localProblems(zip, { publisher: login, publishedVersions: [] }),
    });
    expect(reply.body.error.problems).toMatchObject([{ code: 'publisher_mismatch', path: 'id' }]);
    expect(await harnessRow(`${other}/hello-web`)).toBeUndefined();
    expect(await objectsOf(other)).toEqual([]);
  });

  it.each(['schema_required', 'multiple-problems', 'icon_dimensions', 'entry-file-missing-node'])(
    'is refused with 422 invalid_manifest and the problems validatePackage reports locally (%s)',
    async (fixture) => {
      const slug = `bad-${fixture.replaceAll('_', '-')}`;
      const zip = packageOf(slug, '1.0.0', fixture);
      const reply = await publish(publisher.token, zip);
      expect(reply.status).toBe(422);
      expect(reply.body.error).toEqual({
        code: 'invalid_manifest',
        message: expect.any(String) as string,
        problems: await localProblems(zip, { publisher: login, publishedVersions: [] }),
      });
      expect(await harnessRow(`${login}/${slug}`)).toBeUndefined();
      expect(await objectsOf(`${login}/${slug}`)).toEqual([]);
    },
  );

  it('is refused with 422 invalid_manifest for text the Store cannot keep, leaving no object', async () => {
    // JSON text may encode U+0000 and a lone surrogate, but jsonb refuses the one and a lone
    // surrogate has no UTF-8 form: validatePackage reports both, here as on the desktop.
    const cases: [string, Record<string, unknown>, string][] = [
      ['nul-name', { name: 'Hello\u0000Web' }, 'name'],
      ['surrogate-changelog', { changelog: 'x\ud800y' }, 'changelog'],
    ];
    for (const [slug, manifest, path] of cases) {
      const zip = packageOf(slug, '1.0.0', 'valid-minimal-node', { manifest });
      const reply = await publish(publisher.token, zip);
      expect(reply.status, slug).toBe(422);
      expect(reply.body.error, slug).toEqual({
        code: 'invalid_manifest',
        message: expect.any(String) as string,
        problems: await localProblems(zip, { publisher: login, publishedVersions: [] }),
      });
      expect(reply.body.error.problems, slug).toMatchObject([
        { path, code: 'schema_pattern', messageKey: 'schema_pattern.unstorable_character' },
      ]);
      expect(await harnessRow(`${login}/${slug}`), slug).toBeUndefined();
      expect(await objectsOf(`${login}/${slug}`), slug).toEqual([]);
    }
  });

  it('is refused with 422 for a zip-slip entry or a symbolic link, leaving no object', async () => {
    const cases: [string, PackageOptions['extra'], string][] = [
      [
        'zip-slip',
        {
          '../escape.txt': new TextEncoder().encode('outside'),
          'dist/../../escape.txt': new TextEncoder().encode('outside'),
          '/tmp/absolute.txt': new TextEncoder().encode('anywhere'),
        },
        'archive_path_traversal',
      ],
      ['symlink', { 'dist/config.json': symlinkEntry('/etc/passwd') }, 'archive_symlink'],
    ];
    for (const [slug, extra, code] of cases) {
      const zip = packageOf(slug, '1.0.0', 'valid-minimal-node', { extra });
      const reply = await publish(publisher.token, zip);
      expect(reply.status, slug).toBe(422);
      expect(reply.body.error.code, slug).toBe('invalid_manifest');
      expect(reply.body.error.problems, slug).toEqual(
        await localProblems(zip, { publisher: login, publishedVersions: [] }),
      );
      expect(reply.body.error.problems?.length, slug).toBeGreaterThan(0);
      for (const problem of reply.body.error.problems ?? []) {
        expect(problem, slug).toMatchObject({ code });
      }
      expect(await harnessRow(`${login}/${slug}`), slug).toBeUndefined();
      expect(await objectsOf(`${login}/${slug}`), slug).toEqual([]);
    }
  });

  it('is refused with 413 package_too_large for more than 20 000 files', async () => {
    const filler: Record<string, Uint8Array> = {};
    for (let index = 0; index < 20_000; index++)
      filler[`filler/${String(index)}`] = new Uint8Array();
    const zip = packageOf('too-many', '1.0.0', 'valid-minimal-node', { extra: filler });
    const reply = await publish(publisher.token, zip);
    expect(reply.status).toBe(413);
    expect(reply.body.error).toEqual({
      code: 'package_too_large',
      message: expect.any(String) as string,
      problems: await localProblems(zip, { publisher: login, publishedVersions: [] }),
    });
    expect(reply.body.error.problems).toMatchObject([{ code: 'archive_too_many_files' }]);
    expect(await objectsOf(`${login}/too-many`)).toEqual([]);
  });

  it('is refused with 413 package_too_large for an icon over 5 MB, before any upload', async () => {
    const icon = readFileSync(join(FIXTURES, 'valid-minimal-node', 'assets', 'icon.png'));
    const padded = new Uint8Array(5 * 1024 * 1024 + 1);
    padded.set(icon);
    const zip = packageOf('huge-icon', '1.0.0', 'valid-minimal-node', {
      extra: { 'assets/icon.png': padded },
    });
    expect((await validatePackage(await ArchiveSource.open(zip), { publisher: login })).ok).toBe(
      true,
    );
    const reply = await publish(publisher.token, zip);
    expect(reply.status).toBe(413);
    expect(reply.body.error).toEqual({
      code: 'package_too_large',
      message: expect.stringContaining('icon') as string,
    });
    expect(await harnessRow(`${login}/huge-icon`)).toBeUndefined();
    expect(await objectsOf(`${login}/huge-icon`)).toEqual([]);
  });

  it('is refused with 422 invalid_manifest for a corrupt icon or README that validatePackage does not read in full', async () => {
    // Stored uncompressed, then one byte flipped past what validatePackage reads (the icon's
    // first 33 bytes; nothing of README.md): only a full read finds the CRC-32 mismatch.
    const icon = readFileSync(join(FIXTURES, 'valid-minimal-node', 'assets', 'icon.png'));
    const readme = new TextEncoder().encode('# Corrupt\n\nCORRUPT-THIS-README-LINE\n');
    let zip = packageOf('corrupt', '1.0.0', 'valid-minimal-node', {
      extra: { 'assets/icon.png': storedEntry(icon), 'README.md': storedEntry(readme) },
    });
    zip = corrupt(zip, icon.subarray(80, 100));
    zip = corrupt(zip, new TextEncoder().encode('CORRUPT-THIS-README-LINE'));
    const source = await ArchiveSource.open(zip);
    expect((await validatePackage(source, { publisher: login })).ok).toBe(true);

    // The problem validatePackage reports for an entry it cannot read.
    const unreadable = async (path: string): Promise<Problem> => {
      const error = await source.readFile(path).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(PackageReadError);
      const params = { detail: (error as PackageReadError).message };
      return {
        path,
        code: 'archive_invalid',
        message: interpolate(MESSAGES_EN['archive_invalid.entry'], params),
        messageKey: 'archive_invalid.entry',
        params,
      };
    };
    const reply = await publish(publisher.token, zip);
    expect(reply.status).toBe(422);
    expect(reply.body.error).toEqual({
      code: 'invalid_manifest',
      message: expect.any(String) as string,
      problems: [await unreadable('assets/icon.png'), await unreadable('README.md')],
    });
    expect(await harnessRow(`${login}/corrupt`)).toBeUndefined();
    expect(await objectsOf(`${login}/corrupt`)).toEqual([]);
  });

  it('is refused with 411 length_required without a Content-Length', async () => {
    // A chunked body, straight to the Edge Functions: the gateway (Kong) buffers a body and
    // passes it on with a Content-Length. (A Content-Length over 500 MB is refused before the
    // body is read, but neither the gateway nor the local edge runtime passes the answer on
    // before the whole body arrived, so that rule is covered by test/publish.test.ts only.)
    const script = `
      import { request } from 'node:http';
      const outgoing = request(process.env.URL, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + process.env.TOKEN,
          'content-type': 'multipart/form-data; boundary=x',
        },
      }, (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => {
          console.log(JSON.stringify({ status: response.statusCode, body: JSON.parse(body) }));
        });
      });
      outgoing.on('error', (error) => { console.error(error); process.exit(1); });
      outgoing.write('--x\\r\\n');
      outgoing.end('--x--\\r\\n');
    `;
    const output = await nodeOnStackNetwork(script, {
      URL: `${edgeRuntimeUrl()}/publish`,
      TOKEN: publisher.token,
    });
    expect(JSON.parse(output)).toEqual({
      status: 411,
      body: { error: { code: 'length_required', message: expect.any(String) as string } },
    });
  });

  it('is refused with 400 invalid_request without a "package" part', async () => {
    const reply = await publish(publisher.token, undefined);
    expect(reply.status).toBe(400);
    expect(reply.body.error.code).toBe('invalid_request');
  });

  it('is refused with 409 harness_taken_down for a taken-down Harness', async () => {
    const harnessId = `${login}/taken`;
    expect((await publish(publisher.token, packageOf('taken', '1.0.0'))).status).toBe(201);
    await serviceRest('PATCH', `harnesses?harness_id=eq.${encodeURIComponent(harnessId)}`, {
      status: 'taken_down',
    });
    const before = await objectsOf(harnessId);
    const reply = await publish(publisher.token, packageOf('taken', '2.0.0'));
    expect(reply.status).toBe(409);
    expect(reply.body.error.code).toBe('harness_taken_down');
    expect((await versionsOf(harnessId)).map((row) => row.version)).toEqual(['1.0.0']);
    expect(await objectsOf(harnessId)).toEqual(before);
  });
});

describe('objects already in Storage', () => {
  async function putObject(bucket: string, path: string, type: string, bytes: Uint8Array) {
    const reply = await fetch(`${stack.apiUrl}/storage/v1/object/${bucket}/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${stack.serviceRoleKey}`, 'content-type': type },
      body: bytes,
    });
    expect(reply.status).toBe(200);
  }

  it('make the publish fail with 409 and are never deleted by it', async () => {
    // A package left at this version's path (a crash, or another publish winning a race).
    const harnessId = `${login}/leftover-package`;
    await putObject(
      'harness-packages',
      `${harnessId}/1.0.0.zip`,
      'application/zip',
      new Uint8Array([1]),
    );
    const reply = await publish(publisher.token, packageOf('leftover-package', '1.0.0'));
    expect(reply.status).toBe(409);
    expect(reply.body.error.code).toBe('version_not_greater');
    expect(await objectsOf(harnessId)).toEqual([`${harnessId}/1.0.0.zip`]);
    expect(await harnessRow(harnessId)).toBeUndefined();
  });

  it('delete what the failed publish uploaded before it failed, and only that', async () => {
    // The icon is already there, so the package uploads and the icon does not.
    const harnessId = `${login}/leftover-icon`;
    const icon = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await putObject('harness-assets', `${harnessId}/1.0.0/icon.png`, 'image/png', icon);
    const reply = await publish(publisher.token, packageOf('leftover-icon', '1.0.0'));
    expect(reply.status).toBe(409);
    expect(await objectsOf(harnessId)).toEqual([`${harnessId}/1.0.0/icon.png`]);
    expect(await harnessRow(harnessId)).toBeUndefined();
  });
});

describe('two publishes at once', () => {
  it('of the same version give one Harness Version: one succeeds, the other is refused, and the package stays', async () => {
    const harnessId = `${login}/race`;
    const zip = packageOf('race', '1.0.0');
    const replies = await Promise.all([
      publish(publisher.token, zip),
      publish(publisher.token, zip),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
    expect(replies.find((reply) => reply.status === 409)?.body.error.code).toBe(
      'version_not_greater',
    );
    expect((await versionsOf(harnessId)).map((row) => row.version)).toEqual(['1.0.0']);
    expect(await objectsOf(harnessId)).toEqual([
      `${harnessId}/1.0.0.zip`,
      `${harnessId}/1.0.0/icon.png`,
    ]);
  });

  it('of two versions of a new Harness, both validated against no version, record only the first to commit', async () => {
    // A session holds publish_version's lock until both publishes wait for it, so both have
    // validated against no earlier version and uploaded their objects; the second to get the lock
    // then finds one version where it expected none.
    const key = `hashtextextended('publish:${publisher.id}', 0)`;
    const holder = sql(`
      select pg_advisory_lock(${key});
      do $$
      begin
        for attempt in 1..300 loop
          exit when (select count(*) from pg_locks where locktype = 'advisory' and not granted) >= 2;
          perform pg_sleep(0.1);
        end loop;
        if (select count(*) from pg_locks where locktype = 'advisory' and not granted) < 2 then
          raise exception 'The two publishes never waited for the lock';
        end if;
      end $$;
      select pg_advisory_unlock(${key});
    `);
    const held = `select count(*) from pg_locks where locktype = 'advisory' and granted;`;
    for (let attempt = 0; (await sql(held)) === '0'; attempt++) {
      if (attempt === 100) throw new Error('The lock was never taken');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const harnessId = `${login}/race-versions`;
    const replies = await Promise.all(
      ['1.0.0', '1.0.1'].map((version) =>
        publish(publisher.token, packageOf('race-versions', version)),
      ),
    );
    expect(await holder).toBe('t');
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
    const loser = replies.find((reply) => reply.status === 409);
    expect(loser?.body.error).toEqual({
      code: 'version_not_greater',
      message: expect.any(String) as string,
    });

    // Only the winner's objects stay: the loser's, uploaded before publish_version refused it,
    // are deleted.
    const winner = replies.find((reply) => reply.status === 201)?.body.version ?? '';
    expect((await versionsOf(harnessId)).map((row) => row.version)).toEqual([winner]);
    expect(await objectsOf(harnessId)).toEqual([
      `${harnessId}/${winner}.zip`,
      `${harnessId}/${winner}/icon.png`,
    ]);
  });
});

describe('publish_version (called directly with the service role)', () => {
  /** A validated Manifest of `<user's login>/<slug>@<version>`. */
  async function manifestOf(user: TestUser, slug: string, version: string): Promise<Manifest> {
    const zip = fixturePackage('valid-minimal-node', {
      manifest: { id: `${user.userName.toLowerCase()}/${slug}`, version },
    });
    const result = await validatePackage(await ArchiveSource.open(zip));
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.manifest;
  }

  async function publishVersion(user: TestUser, manifest: Manifest, knownVersions: number) {
    return rest<{ code?: string; message?: string } | null>(
      'service',
      'POST',
      'rpc/publish_version',
      {
        publisher: user.id,
        manifest,
        readme: '# Readme',
        package_path: `${manifest.id}/${manifest.version}.zip`,
        package_sha256: '0'.repeat(64),
        package_size: 1,
        screenshot_paths: [],
        known_versions: knownVersions,
      },
    );
  }

  it('refuses version_not_greater (PT409) when the number of versions changed since validation', async () => {
    const harnessId = `${login}/stale`;
    expect((await publish(publisher.token, packageOf('stale', '1.0.0'))).status).toBe(201);
    const next = await manifestOf(publisher, 'stale', '2.0.0');
    for (const known of [0, 2]) {
      const reply = await publishVersion(publisher, next, known);
      expect(reply.status, String(known)).toBe(409);
      expect(reply.body, String(known)).toMatchObject({
        code: 'PT409',
        message: 'version_not_greater',
      });
    }
    expect((await versionsOf(harnessId)).map((row) => row.version)).toEqual(['1.0.0']);

    // With the right count, the same call records the version.
    expect((await publishVersion(publisher, next, 1)).status).toBeLessThan(300);
    expect((await versionsOf(harnessId)).map((row) => row.version)).toEqual(['1.0.0', '2.0.0']);
  });

  it('refuses version_not_greater (PT409) for a new Harness when versions were expected', async () => {
    const reply = await publishVersion(publisher, await manifestOf(publisher, 'gone', '1.0.0'), 1);
    expect(reply.status).toBe(409);
    expect(reply.body).toMatchObject({ code: 'PT409', message: 'version_not_greater' });
    expect(await harnessRow(`${login}/gone`)).toBeUndefined();
  });

  it('re-counts the rate limit under the lock: rate_limited (PT429) after 20 versions in 24 hours', async () => {
    const busy = await createUser();
    try {
      const harness = await insertHarness(busy, 'busy');
      for (let index = 0; index < 20; index++) await insertVersion(harness, `1.0.${String(index)}`);
      const manifest = await manifestOf(busy, 'other', '1.0.0');
      const reply = await publishVersion(busy, manifest, 0);
      expect(reply.status).toBe(429);
      expect(reply.body).toMatchObject({ code: 'PT429', message: 'rate_limited' });
      expect(await harnessRow(manifest.id)).toBeUndefined();
    } finally {
      await deleteUser(busy);
    }
  });
});

describe('authentication', () => {
  it('refuses a call without a Publisher session with 401 unauthenticated', async () => {
    const notGithub = await createUser(undefined, 'email');
    try {
      const zip = packageOf('unauthenticated', '1.0.0');
      // A well-signed session JWT of a user that does not exist (deleted, say) included.
      const noUser = mintJwt(randomUUID());
      for (const token of [undefined, stack.anonKey, 'not-a-jwt', notGithub.token, noUser]) {
        const reply = await publish(token, zip);
        expect(reply.status, String(token)).toBe(401);
        expect(reply.body.error.code, String(token)).toBe('unauthenticated');
      }
      expect(await objectsOf(`${login}/unauthenticated`)).toEqual([]);
    } finally {
      await deleteUser(notGithub);
    }
  });

  it('refuses a GET with 405', async () => {
    const reply = await call({ token: publisher.token }, 'GET', 'functions/v1/publish');
    expect(reply.status).toBe(405);
  });
});

describe('rate limit', () => {
  let busy: TestUser | undefined;

  afterAll(async () => {
    await deleteUser(busy);
  });

  it('accepts 20 publishes in 24 hours and refuses the 21st with 429 rate_limited', async () => {
    busy = await createUser();
    const busyLogin = busy.userName.toLowerCase();
    const zipOf = (index: number) =>
      fixturePackage('valid-minimal-node', {
        manifest: {
          id: `${busyLogin}/burst-${String(index % 3)}`,
          version: `1.0.${String(index)}`,
        },
      });
    for (let index = 0; index < 20; index++) {
      const reply = await publish(busy.token, zipOf(index));
      expect(reply.status, `publish ${String(index + 1)}`).toBe(201);
    }
    const before = await objectsOf(busyLogin);
    expect(before).toHaveLength(40); // A package and an icon per version.
    const reply = await publish(busy.token, zipOf(20));
    expect(reply.status).toBe(429);
    expect(reply.body.error.code).toBe('rate_limited');

    const rows = await serviceRest<unknown[]>(
      'GET',
      `harness_versions?select=id,harnesses!inner(publisher_id)&harnesses.publisher_id=eq.${busy.id}`,
    );
    expect(rows).toHaveLength(20);
    // Neither the 21st package nor its icon was left in either bucket.
    expect(await objectsOf(busyLogin)).toEqual(before);
  });
});
