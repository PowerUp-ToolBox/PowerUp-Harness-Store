/**
 * Ticket P0-07.3, the request rules of the `publish` Edge Function that need no stack: the
 * Content-Length check, which Harness's versions are looked up, the status for validatePackage's
 * problems, publish_version's errors and the HTTP helpers. The function itself is tested over
 * HTTP in test-store/publish.test.ts.
 */
import { PACKAGE_LIMITS } from '@harness-store/manifest';
import type { Problem } from '@harness-store/manifest';
import { describe, expect, it } from 'vitest';
import { bearerToken, errorResponse } from '../supabase/functions/_shared/http.ts';
import {
  contentLengthError,
  MAX_PACKAGE_BYTES,
  MULTIPART_ALLOWANCE,
  ownHarnessId,
  publishVersionError,
  rejection,
  storeRoute,
} from '../supabase/functions/_shared/publish.ts';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function problem(code: string, path = '$'): Problem {
  return { path, code, message: code, messageKey: code };
}

describe('contentLengthError', () => {
  it('needs a Content-Length: 411 length_required', () => {
    expect(contentLengthError(null)).toMatchObject({ status: 411, code: 'length_required' });
  });

  it('refuses one that is not a number: 400 invalid_request', () => {
    expect(contentLengthError('12a')).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(contentLengthError('-1')).toMatchObject({ status: 400, code: 'invalid_request' });
  });

  it('allows up to 500 MB plus the multipart framing, and refuses more: 413 package_too_large', () => {
    expect(MAX_PACKAGE_BYTES).toBe(PACKAGE_LIMITS.maxArchiveBytes);
    expect(contentLengthError('0')).toBeUndefined();
    expect(contentLengthError(String(MAX_PACKAGE_BYTES + MULTIPART_ALLOWANCE))).toBeUndefined();
    expect(contentLengthError(String(MAX_PACKAGE_BYTES + MULTIPART_ALLOWANCE + 1))).toMatchObject({
      status: 413,
      code: 'package_too_large',
    });
  });
});

describe('ownHarnessId', () => {
  it("is the manifest's Harness ID when its publisher segment is the caller's login", () => {
    expect(ownHarnessId(encode({ id: 'alice/hello-web' }), 'alice')).toBe('alice/hello-web');
  });

  it("is undefined for another Publisher's ID, so their versions are never looked up", () => {
    expect(ownHarnessId(encode({ id: 'bob/hello-web' }), 'alice')).toBeUndefined();
    expect(ownHarnessId(encode({ id: 'alicex/hello-web' }), 'alice')).toBeUndefined();
  });

  it('is undefined without a usable ID', () => {
    expect(ownHarnessId(undefined, 'alice')).toBeUndefined();
    expect(ownHarnessId(new TextEncoder().encode('{not json'), 'alice')).toBeUndefined();
    expect(ownHarnessId(encode(null), 'alice')).toBeUndefined();
    expect(ownHarnessId(encode({ id: 7 }), 'alice')).toBeUndefined();
    expect(ownHarnessId(encode({ id: 'alice' }), 'alice')).toBeUndefined();
    expect(ownHarnessId(encode({ id: 'alice/' }), 'alice')).toBeUndefined();
    expect(ownHarnessId(encode({ id: 'alice/a/b' }), 'alice')).toBeUndefined();
  });
});

describe('rejection', () => {
  it('is 413 package_too_large for a package too large or with too many files, whatever else', () => {
    for (const code of ['archive_too_large', 'archive_too_many_files']) {
      expect(
        rejection([
          problem('schema_required', 'license'),
          problem(code),
          problem('publisher_mismatch', 'id'),
        ]),
      ).toMatchObject({ status: 413, code: 'package_too_large' });
    }
  });

  it('is 422 invalid_manifest for any other problem, archive safety included', () => {
    for (const code of [
      'schema_required',
      'archive_symlink',
      'archive_path_traversal',
      'archive_invalid',
    ]) {
      expect(
        rejection([
          problem('version_not_greater', 'version'),
          problem(code),
          problem('publisher_mismatch', 'id'),
        ]),
      ).toMatchObject({ status: 422, code: 'invalid_manifest' });
    }
  });

  it('is 403 publisher_mismatch before 409 version_not_greater', () => {
    expect(
      rejection([problem('version_not_greater', 'version'), problem('publisher_mismatch', 'id')]),
    ).toMatchObject({ status: 403, code: 'publisher_mismatch' });
    expect(rejection([problem('version_not_greater', 'version')])).toMatchObject({
      status: 409,
      code: 'version_not_greater',
    });
  });
});

describe('publishVersionError', () => {
  it("maps publish_version's own errors and a duplicate version", () => {
    expect(publishVersionError('PT429', 'rate_limited')).toMatchObject({
      status: 429,
      code: 'rate_limited',
    });
    expect(publishVersionError('PT409', 'harness_taken_down')).toMatchObject({
      status: 409,
      code: 'harness_taken_down',
    });
    expect(publishVersionError('PT409', 'version_not_greater')).toMatchObject({ status: 409 });
    expect(publishVersionError('PT403', 'publisher_mismatch')).toMatchObject({ status: 403 });
    expect(publishVersionError('23505', 'duplicate key value')).toMatchObject({
      status: 409,
      code: 'version_not_greater',
    });
  });

  it('leaves anything else to a server error', () => {
    expect(publishVersionError('PT409', 'rate_limited')).toBeUndefined();
    expect(publishVersionError('23514', 'check_violation')).toBeUndefined();
    expect(publishVersionError('', 'TypeError: fetch failed')).toBeUndefined();
  });
});

describe('HTTP helpers', () => {
  it('read a bearer token', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('bearer  abc ')).toBe('abc');
    expect(bearerToken(null)).toBeUndefined();
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken('Bearer')).toBeUndefined();
  });

  it('write errors as { error: { code, message, ...details } }', async () => {
    const response = errorResponse(422, 'invalid_manifest', 'Bad.', { problems: [] });
    expect(response.status).toBe(422);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      error: { code: 'invalid_manifest', message: 'Bad.', problems: [] },
    });
  });

  it('give the Store tab route of a Harness', () => {
    expect(storeRoute('alice/hello-web')).toBe('/store/h/alice/hello-web');
  });
});
