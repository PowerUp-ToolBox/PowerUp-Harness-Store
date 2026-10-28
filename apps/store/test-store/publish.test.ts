/**
 * Ticket P0-07.3: the `publish` Edge Function, over HTTP against the local stack. Each package is
 * a P0-01 fixture folder zipped with the test Publisher's Harness ID; a rejected package must
 * give the documented status, code and validatePackage's own problems (compared with what
 * validatePackage reports locally for the same bytes and options), and leave no row and no
 * Storage object behind.
 */
import { createHash } from 'node:crypto';
import { ArchiveSource, validatePackage } from '@harness-store/manifest';
import type { ValidatePackageOptions } from '@harness-store/manifest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixturePackage, publish, symlinkEntry } from './packages.ts';
import type { PackageOptions } from './packages.ts';
import {
  call,
  createUser,
  deleteUser,
  edgeRuntimeUrl,
  listObjects,
  nodeOnStackNetwork,
  rest,
  serviceRest,
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

describe('two publishes of the same version at once', () => {
  it('give one Harness Version: one succeeds, the other is refused, and the package stays', async () => {
    const harnessId = `${login}/race`;
    const zip = packageOf('race', '1.0.0');
    const replies = await Promise.all([
      publish(publisher.token, zip),
      publish(publisher.token, zip),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
    expect((await versionsOf(harnessId)).map((row) => row.version)).toEqual(['1.0.0']);
    expect(await objectsOf(harnessId)).toEqual([
      `${harnessId}/1.0.0.zip`,
      `${harnessId}/1.0.0/icon.png`,
    ]);
  });
});

describe('authentication', () => {
  it('refuses a call without a Publisher session with 401 unauthenticated', async () => {
    const notGithub = await createUser(undefined, 'email');
    try {
      const zip = packageOf('unauthenticated', '1.0.0');
      for (const token of [undefined, stack.anonKey, 'not-a-jwt', notGithub.token]) {
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
    const reply = await publish(busy.token, zipOf(20));
    expect(reply.status).toBe(429);
    expect(reply.body.error.code).toBe('rate_limited');

    const rows = await serviceRest<unknown[]>(
      'GET',
      `harness_versions?select=id,harnesses!inner(publisher_id)&harnesses.publisher_id=eq.${busy.id}`,
    );
    expect(rows).toHaveLength(20);
    expect(await listObjects('harness-packages', `${busyLogin}/burst-2`)).not.toContain(
      `${busyLogin}/burst-2/1.0.20.zip`,
    );
  });
});
