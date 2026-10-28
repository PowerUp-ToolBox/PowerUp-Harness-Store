/**
 * Ticket P0-07.1: the two Storage buckets. harness-packages is private (no public URL, no read,
 * list or write for anon or a Publisher); harness-assets is readable by URL but not listable or
 * writable. Objects come from the seed (scripts/seed.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createUser, deleteUser, stack } from './support.ts';
import type { Caller, TestUser } from './support.ts';

const PACKAGE = 'alice/hello-web/0.1.0.zip';
const ICON = 'alice/hello-web/0.1.0/icon.png';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

let publisher: TestUser;

beforeAll(async () => {
  publisher = await createUser();
});

afterAll(async () => {
  await deleteUser(publisher);
});

const callers = (): [string, Caller][] => [
  ['anon', 'anon'],
  ['a Publisher', { token: publisher.token }],
];

describe('harness-assets (public read)', () => {
  it('serves an icon by its public URL without any key', async () => {
    const response = await fetch(`${stack.apiUrl}/storage/v1/object/public/harness-assets/${ICON}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await response.arrayBuffer()).subarray(0, 4)]).toEqual(PNG_SIGNATURE);
  });

  it('cannot be listed or written by anon or a Publisher', async () => {
    for (const [who, caller] of callers()) {
      const list = await call<unknown[]>(caller, 'POST', 'storage/v1/object/list/harness-assets', {
        prefix: 'alice/hello-web/0.1.0',
      });
      expect(list, who).toEqual({ status: 200, body: [] });

      const upload = await call(
        caller,
        'POST',
        `storage/v1/object/harness-assets/${publisher.userName}/x/1.0.0/icon.png`,
        undefined,
        {
          'content-type': 'image/png',
        },
      );
      expect(upload.status, who).toBeGreaterThanOrEqual(400);

      const remove = await call<unknown[]>(caller, 'DELETE', 'storage/v1/object/harness-assets', {
        prefixes: [ICON],
      });
      expect(remove.body, who).toEqual([]);
    }
    const still = await fetch(`${stack.apiUrl}/storage/v1/object/public/harness-assets/${ICON}`);
    expect(still.status).toBe(200);
  });
});

describe('harness-packages (private)', () => {
  it('has no public URL', async () => {
    const response = await fetch(
      `${stack.apiUrl}/storage/v1/object/public/harness-packages/${PACKAGE}`,
    );
    expect(response.status).toBe(400);
  });

  it('cannot be read, listed, signed or written by anon or a Publisher', async () => {
    for (const [who, caller] of callers()) {
      const read = await call(caller, 'GET', `storage/v1/object/harness-packages/${PACKAGE}`);
      expect(read.status, who).toBe(400);

      const list = await call(caller, 'POST', 'storage/v1/object/list/harness-packages', {
        prefix: 'alice',
      });
      expect(list, who).toEqual({ status: 200, body: [] });

      const sign = await call(
        caller,
        'POST',
        `storage/v1/object/sign/harness-packages/${PACKAGE}`,
        {
          expiresIn: 60,
        },
      );
      expect(sign.status, who).toBe(400);

      const upload = await call(
        caller,
        'POST',
        `storage/v1/object/harness-packages/${publisher.userName}/x/1.0.0.zip`,
        undefined,
        {
          'content-type': 'application/zip',
        },
      );
      expect(upload.status, who).toBeGreaterThanOrEqual(400);
    }
  });

  it('is readable by the service role (the download function signs URLs with it)', async () => {
    const read = await fetch(`${stack.apiUrl}/storage/v1/object/harness-packages/${PACKAGE}`, {
      headers: { apikey: stack.serviceRoleKey, authorization: `Bearer ${stack.serviceRoleKey}` },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get('content-type')).toBe('application/zip');
  });
});

describe('bucket settings', () => {
  it('limits harness-packages to zip files of at most 500 MiB and harness-assets to PNG and JPEG of at most 5 MiB', async () => {
    const buckets = await call<
      {
        id: string;
        public: boolean;
        file_size_limit: number | null;
        allowed_mime_types: string[];
      }[]
    >('service', 'GET', 'storage/v1/bucket');
    const byId = Object.fromEntries(buckets.body.map((bucket) => [bucket.id, bucket]));
    expect(byId['harness-packages']).toMatchObject({
      public: false,
      file_size_limit: 500 * 1024 * 1024,
      allowed_mime_types: ['application/zip'],
    });
    expect(byId['harness-assets']).toMatchObject({
      public: true,
      file_size_limit: 5 * 1024 * 1024,
      allowed_mime_types: ['image/png', 'image/jpeg'],
    });
  });
});
