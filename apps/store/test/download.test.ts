/**
 * Ticket P0-07.4, the request rules of the `download` Edge Function that need no stack: the
 * request body, which version is downloaded, the signed URL's lifetime and its public origin. The
 * function itself is tested over HTTP in test-store/download.test.ts.
 */
import { manifestSchema } from '@harness-store/manifest';
import { describe, expect, it } from 'vitest';
import {
  downloadRequest,
  MAX_APP_VERSION_LENGTH,
  publicSignedUrl,
  resolveVersion,
  SIGNED_URL_TTL_SECONDS,
  signedUrlTtl,
} from '../supabase/functions/_shared/download.ts';

const PLATFORMS = (manifestSchema.$defs as { platform: { enum: readonly string[] } }).platform.enum;

const VALID = { harness_id: 'alice/hello-web', platform: 'linux-x64', app_version: '0.1.0' };

describe('downloadRequest', () => {
  it('accepts a request with or without a version, and drops other fields', () => {
    expect(downloadRequest(VALID, PLATFORMS)).toEqual(VALID);
    expect(downloadRequest({ ...VALID, version: null }, PLATFORMS)).toEqual(VALID);
    expect(downloadRequest({ ...VALID, version: '1.2.0-beta.1', extra: 1 }, PLATFORMS)).toEqual({
      ...VALID,
      version: '1.2.0-beta.1',
    });
  });

  it('accepts every platform of the Manifest schema, and nothing else', () => {
    expect(PLATFORMS.length).toBeGreaterThan(0);
    for (const platform of PLATFORMS) {
      expect(downloadRequest({ ...VALID, platform }, PLATFORMS)).toMatchObject({ platform });
    }
    for (const platform of ['linux', 'Linux-x64', '', undefined, 1]) {
      expect(downloadRequest({ ...VALID, platform }, PLATFORMS)).toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
    }
  });

  it(`requires an app_version of 1 to ${String(MAX_APP_VERSION_LENGTH)} characters`, () => {
    const appVersion = 'x'.repeat(MAX_APP_VERSION_LENGTH);
    expect(downloadRequest({ ...VALID, app_version: appVersion }, PLATFORMS)).toMatchObject({
      app_version: appVersion,
    });
    for (const app_version of [undefined, '', 1, `${appVersion}x`, '0.1.0\u0000']) {
      expect(downloadRequest({ ...VALID, app_version }, PLATFORMS)).toMatchObject({ status: 400 });
    }
  });

  it('refuses a body that is not an object, and a missing or malformed Harness ID or version', () => {
    for (const body of [undefined, null, 'text', [], 3]) {
      expect(downloadRequest(body, PLATFORMS)).toMatchObject({ status: 400 });
    }
    for (const harness_id of [undefined, '', 3, 'x'.repeat(257), 'alice/a\u0000']) {
      expect(downloadRequest({ ...VALID, harness_id }, PLATFORMS)).toMatchObject({ status: 400 });
    }
    for (const version of ['', 1, ['1.0.0'], '1.0.0\u0000']) {
      expect(downloadRequest({ ...VALID, version }, PLATFORMS)).toMatchObject({ status: 400 });
    }
  });
});

describe('resolveVersion', () => {
  it('is the version asked for, or else the latest published one, of a visible Harness', () => {
    const harness = { status: 'active', latest_version: '1.1.0' };
    expect(resolveVersion(harness, undefined)).toBe('1.1.0');
    expect(resolveVersion(harness, '1.0.0')).toBe('1.0.0');
  });

  it('is undefined for an unknown, taken-down or Unpublished-only Harness', () => {
    expect(resolveVersion(null, undefined)).toBeUndefined();
    expect(
      resolveVersion({ status: 'taken_down', latest_version: '1.0.0' }, '1.0.0'),
    ).toBeUndefined();
    expect(resolveVersion({ status: 'active', latest_version: null }, undefined)).toBeUndefined();
    expect(resolveVersion({ status: 'active', latest_version: null }, '1.0.0')).toBeUndefined();
  });
});

describe('signedUrlTtl', () => {
  it('is 60 seconds unless set to a whole number of seconds from 1 to 60', () => {
    expect(SIGNED_URL_TTL_SECONDS).toBe(60);
    expect(signedUrlTtl(undefined)).toBe(60);
    expect(signedUrlTtl('5')).toBe(5);
    expect(signedUrlTtl(' 1 ')).toBe(1);
    expect(signedUrlTtl('60')).toBe(60);
    for (const raw of ['', '0', '61', '3600', '-5', '2.5', 'ten']) {
      expect(signedUrlTtl(raw), raw).toBe(60);
    }
  });
});

describe('publicSignedUrl', () => {
  it("puts the Store's public origin in place of the gateway's internal one, keeping path and token", () => {
    const signed =
      'http://kong:8000/storage/v1/object/sign/harness-packages/alice/hello-web/0.1.0.zip?token=a.b.c';
    expect(publicSignedUrl(signed, 'http://127.0.0.1:54321')).toBe(
      'http://127.0.0.1:54321/storage/v1/object/sign/harness-packages/alice/hello-web/0.1.0.zip?token=a.b.c',
    );
    expect(publicSignedUrl(signed, 'https://store.example.com/')).toBe(
      'https://store.example.com/storage/v1/object/sign/harness-packages/alice/hello-web/0.1.0.zip?token=a.b.c',
    );
  });
});
