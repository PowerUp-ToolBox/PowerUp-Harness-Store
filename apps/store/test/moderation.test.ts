/**
 * Ticket P0-07.6, the request rules of the `unpublish`, `report` and `admin` Edge Functions that
 * need no stack: who the caller is, the request bodies, the per-IP Report counter, the
 * `admin/takedown` route and the mapping of the SQL functions' errors. The functions themselves
 * are tested over HTTP in test-store/unpublish.test.ts, report.test.ts and takedown.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { signedInUser } from '../supabase/functions/_shared/caller.ts';
import type { CallerLookups } from '../supabase/functions/_shared/caller.ts';
import { raisedError } from '../supabase/functions/_shared/http.ts';
import {
  clientIp,
  MAX_DETAILS_LENGTH,
  RATE_LIMITED,
  REPORT_ERRORS,
  REPORT_REASONS,
  ReportCounter,
  reportRequest,
} from '../supabase/functions/_shared/report.ts';
import {
  isTakedownRoute,
  MAX_NOTE_LENGTH,
  TAKEDOWN_ERRORS,
  takedownRequest,
} from '../supabase/functions/_shared/takedown.ts';
import {
  FORBIDDEN,
  NOT_FOUND,
  TAKEN_DOWN,
  UNPUBLISH_ERRORS,
  unpublishRequest,
} from '../supabase/functions/_shared/unpublish.ts';

const INVALID = { status: 400, code: 'invalid_request' };

/** Lookups answering as Auth and the database would for one user, counting the calls. */
function lookups(
  user: { id: string } | { error: { name: string; status?: number; code?: string } },
  profile: { github_login: string | null; is_admin: boolean } | null | Error = {
    github_login: 'alice',
    is_admin: false,
  },
): CallerLookups & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getUser: (token) => {
      calls.push(`getUser ${token}`);
      return Promise.resolve(
        'error' in user
          ? { data: { user: null }, error: user.error }
          : { data: { user }, error: null },
      );
    },
    profile: (id) => {
      calls.push(`profile ${id}`);
      return Promise.resolve(
        profile instanceof Error ? { data: null, error: profile } : { data: profile, error: null },
      );
    },
  };
}

describe('signedInUser', () => {
  it('is the Publisher behind a bearer token, with is_admin from their profile', async () => {
    const found = lookups({ id: 'u1' }, { github_login: 'alice', is_admin: true });
    expect(await signedInUser('Bearer t0k', found)).toEqual({
      id: 'u1',
      login: 'alice',
      isAdmin: true,
    });
    expect(found.calls).toEqual(['getUser t0k', 'profile u1']);
    expect(await signedInUser('Bearer t0k', lookups({ id: 'u1' }))).toMatchObject({
      isAdmin: false,
    });
  });

  it('is undefined without a token, without asking Auth', async () => {
    const none = lookups({ id: 'u1' });
    expect(await signedInUser(null, none)).toBeUndefined();
    expect(await signedInUser('Basic abc', none)).toBeUndefined();
    expect(none.calls).toEqual([]);
  });

  it('is undefined for a token Auth refuses, or a user with no GitHub profile', async () => {
    const refused = lookups({ error: { name: 'AuthApiError', status: 403, code: 'bad_jwt' } });
    expect(await signedInUser('Bearer x', refused)).toBeUndefined();
    expect(await signedInUser('Bearer x', lookups({ id: 'u1' }, null))).toBeUndefined();
    expect(
      await signedInUser('Bearer x', lookups({ id: 'u1' }, { github_login: null, is_admin: true })),
    ).toBeUndefined();
  });

  it('throws when Auth or the database cannot answer, so the call is a 500', async () => {
    const down = lookups({ error: { name: 'AuthRetryableFetchError', status: 503 } });
    await expect(signedInUser('Bearer x', down)).rejects.toMatchObject({ status: 503 });
    await expect(
      signedInUser('Bearer x', lookups({ id: 'u1' }, new Error('connection refused'))),
    ).rejects.toThrow('connection refused');
  });
});

describe('raisedError', () => {
  it('maps a PT<status> SQLSTATE with the API code as message to that error', () => {
    expect(raisedError('PT404', 'not_found', UNPUBLISH_ERRORS)).toBe(NOT_FOUND);
    expect(raisedError('PT403', 'forbidden', UNPUBLISH_ERRORS)).toBe(FORBIDDEN);
    expect(raisedError('PT409', 'harness_taken_down', UNPUBLISH_ERRORS)).toBe(TAKEN_DOWN);
    expect(raisedError('PT429', 'rate_limited', REPORT_ERRORS)).toBe(RATE_LIMITED);
    expect(raisedError('PT403', 'forbidden', TAKEDOWN_ERRORS)).toMatchObject({ status: 403 });
  });

  it('is undefined for anything else, which is a server error', () => {
    expect(raisedError('PT404', 'forbidden', UNPUBLISH_ERRORS)).toBeUndefined();
    expect(raisedError('PT429', 'rate_limited', UNPUBLISH_ERRORS)).toBeUndefined();
    expect(raisedError('23505', 'not_found', UNPUBLISH_ERRORS)).toBeUndefined();
    expect(raisedError(undefined, undefined, UNPUBLISH_ERRORS)).toBeUndefined();
  });
});

describe('unpublishRequest', () => {
  it('needs a Harness ID and a version, and drops other fields', () => {
    expect(unpublishRequest({ harness_id: 'alice/a', version: '1.0.0', x: 1 })).toEqual({
      harness_id: 'alice/a',
      version: '1.0.0',
    });
    for (const body of [
      undefined,
      null,
      [],
      'alice/a',
      { harness_id: 'alice/a' },
      { harness_id: 'alice/a', version: '' },
      { harness_id: 'alice/a', version: 1 },
      { version: '1.0.0' },
      { harness_id: 'a'.repeat(257), version: '1.0.0' },
      // Postgres text cannot hold a NUL: a 400, not a failed database call.
      { harness_id: 'alice/a\u0000', version: '1.0.0' },
      { harness_id: 'alice/a', version: '1.0.0\u0000' },
    ]) {
      expect(unpublishRequest(body), JSON.stringify(body)).toMatchObject(INVALID);
    }
  });
});

describe('reportRequest', () => {
  const VALID = { harness_id: 'alice/a', reason: 'spam' };

  it('accepts each of the six reasons of data-model.md, and nothing else', () => {
    expect(REPORT_REASONS).toEqual([
      'malware',
      'bypasses_gateway',
      'broken',
      'inappropriate',
      'spam',
      'other',
    ]);
    for (const reason of REPORT_REASONS) {
      expect(reportRequest({ ...VALID, reason })).toMatchObject({ reason });
    }
    for (const reason of ['Spam', 'misleading', '', null, undefined, 3]) {
      expect(reportRequest({ ...VALID, reason }), String(reason)).toMatchObject(INVALID);
    }
  });

  it('fills in what may be left out: no version, empty details and client info', () => {
    expect(reportRequest(VALID)).toEqual({ ...VALID, details: '', client_info: {} });
    expect(reportRequest({ ...VALID, version: null, details: null, client_info: null })).toEqual({
      ...VALID,
      details: '',
      client_info: {},
    });
    expect(reportRequest({ ...VALID, version: '1.0.0' })).toMatchObject({ version: '1.0.0' });
  });

  it('keeps install_id, app_version and platform of client_info, and drops the rest', () => {
    expect(
      reportRequest({
        ...VALID,
        client_info: {
          install_id: 'i',
          app_version: '0.1.0',
          platform: 'linux-x64',
          ip: '1.2.3.4',
        },
      }),
    ).toMatchObject({
      client_info: { install_id: 'i', app_version: '0.1.0', platform: 'linux-x64' },
    });
  });

  it('refuses long details, a bad version and client_info fields that are not short strings', () => {
    expect(reportRequest({ ...VALID, details: 'x'.repeat(MAX_DETAILS_LENGTH) })).toMatchObject({
      details: 'x'.repeat(MAX_DETAILS_LENGTH),
    });
    for (const fields of [
      { details: 'x'.repeat(MAX_DETAILS_LENGTH + 1) },
      { details: {} },
      { version: '' },
      { version: 1 },
      { harness_id: '' },
      { client_info: [] },
      { client_info: 'x' },
      { client_info: { install_id: '' } },
      { client_info: { platform: 1 } },
      { client_info: { app_version: 'v'.repeat(65) } },
      // Postgres text and jsonb cannot hold a NUL: a 400, not a failed database call.
      { harness_id: 'alice/a\u0000' },
      { version: '1.0.0\u0000' },
      { details: 'x\u0000y' },
      { client_info: { install_id: 'i\u0000' } },
      { client_info: { platform: '\u0000' } },
    ]) {
      expect(reportRequest({ ...VALID, ...fields }), JSON.stringify(fields)).toMatchObject(INVALID);
    }
    expect(reportRequest([])).toMatchObject(INVALID);
  });
});

describe('clientIp', () => {
  it('is the first X-Forwarded-For address', () => {
    expect(clientIp('203.0.113.7, 172.18.0.1')).toBe('203.0.113.7');
    expect(clientIp(' 2001:db8::1 ')).toBe('2001:db8::1');
  });

  it('is undefined without one', () => {
    expect(clientIp(null)).toBeUndefined();
    expect(clientIp('')).toBeUndefined();
    expect(clientIp(' , 10.0.0.1')).toBeUndefined();
  });
});

describe('ReportCounter', () => {
  const HOUR = 60 * 60 * 1000;

  it('allows 5 Reports per key per hour, and the next once the first is an hour old', () => {
    const counter = new ReportCounter();
    for (let minute = 0; minute < 5; minute += 1) {
      expect(counter.allows('a', minute * 60_000)).toBe(true);
      counter.record('a', minute * 60_000);
    }
    expect(counter.allows('a', 10 * 60_000)).toBe(false);
    expect(counter.allows('b', 10 * 60_000)).toBe(true);
    expect(counter.allows('a', HOUR - 1)).toBe(false);
    expect(counter.allows('a', HOUR + 1)).toBe(true);
  });

  it('forgets the oldest key past its size limit', () => {
    const counter = new ReportCounter(1, HOUR, 2);
    counter.record('a', 0);
    counter.record('b', 0);
    counter.record('c', 0);
    expect(counter.allows('a', 1)).toBe(true);
    expect(counter.allows('b', 1)).toBe(false);
    expect(counter.allows('c', 1)).toBe(false);
  });
});

describe('admin/takedown', () => {
  it('is the only route of the admin function', () => {
    for (const path of ['/admin/takedown', '/admin/takedown/', '/functions/v1/admin/takedown']) {
      expect(isTakedownRoute(path), path).toBe(true);
    }
    for (const path of [
      '/admin',
      '/admin/',
      '/admin/feature',
      '/admin/takedown/x',
      '/xadmin/takedown',
    ]) {
      expect(isTakedownRoute(path), path).toBe(false);
    }
  });

  it('needs a Harness ID and a note of 1 to 2000 characters; the version is optional', () => {
    expect(takedownRequest({ harness_id: 'alice/a', note: 'Malware.' })).toEqual({
      harness_id: 'alice/a',
      note: 'Malware.',
    });
    expect(takedownRequest({ harness_id: 'alice/a', version: '1.0.0', note: 'n' })).toEqual({
      harness_id: 'alice/a',
      version: '1.0.0',
      note: 'n',
    });
    expect(
      takedownRequest({ harness_id: 'alice/a', version: null, note: 'n'.repeat(MAX_NOTE_LENGTH) }),
    ).toMatchObject({ note: 'n'.repeat(MAX_NOTE_LENGTH) });
    for (const body of [
      null,
      { harness_id: 'alice/a' },
      { harness_id: 'alice/a', note: '' },
      { harness_id: 'alice/a', note: ' \n ' },
      { harness_id: 'alice/a', note: 'n'.repeat(MAX_NOTE_LENGTH + 1) },
      { harness_id: 'alice/a', version: '', note: 'n' },
      { note: 'n' },
      { harness_id: 'alice/a\u0000', note: 'n' },
      { harness_id: 'alice/a', version: '1.0.0\u0000', note: 'n' },
      { harness_id: 'alice/a', note: 'Malware.\u0000' },
    ]) {
      expect(takedownRequest(body), JSON.stringify(body).slice(0, 60)).toMatchObject(INVALID);
    }
  });
});
