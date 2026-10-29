/**
 * Ticket P0-07.6, the request rules of the `unpublish`, `report` and `admin` Edge Functions that
 * need no stack: who the caller is, the request bodies, the per-IP Report counter, the
 * `admin/takedown` route and the mapping of the SQL functions' errors. The functions themselves
 * are tested over HTTP in test-store/unpublish.test.ts, report.test.ts and takedown.test.ts.
 */
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { callerLookups, signedInUser } from '../supabase/functions/_shared/caller.ts';
import type { CallerLookups } from '../supabase/functions/_shared/caller.ts';
import { isStorable, isText, raisedError } from '../supabase/functions/_shared/http.ts';
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

describe('callerLookups', () => {
  /**
   * A real supabase-js client (the version the functions import) whose requests go to `answer`,
   * which also proves the client fits the structural CallerClient type.
   */
  function client(answer: (url: URL, headers: Headers) => unknown) {
    const requests: string[] = [];
    const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
      const body = answer(url, new Headers(init?.headers));
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const supabase = createClient('http://store.test', 'service-role-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch },
    });
    return { lookups: callerLookups(supabase), requests };
  }

  it("ask Auth for the token's user and read github_login and is_admin of their profile", async () => {
    const { lookups, requests } = client((url, headers) => {
      if (url.pathname !== '/auth/v1/user') return [{ github_login: 'alice', is_admin: true }];
      expect(headers.get('authorization')).toBe('Bearer t0k');
      return { id: 'u1', aud: 'authenticated' };
    });
    expect(await signedInUser('Bearer t0k', lookups)).toEqual({
      id: 'u1',
      login: 'alice',
      isAdmin: true,
    });
    expect(requests).toEqual([
      'GET /auth/v1/user',
      'GET /rest/v1/profiles?select=github_login%2Cis_admin&id=eq.u1',
    ]);
  });

  it('give no Publisher for a user with no profile row', async () => {
    const { lookups } = client((url) => (url.pathname === '/auth/v1/user' ? { id: 'u2' } : []));
    expect(await signedInUser('Bearer t0k', lookups)).toBeUndefined();
  });
});

describe('isStorable and isText', () => {
  it('accept any string Postgres can store, surrogate pairs included', () => {
    for (const text of ['', 'alice/a', '插件 1.0', 'emoji \ud83d\ude00 pair', '\ufffd']) {
      expect(isStorable(text), JSON.stringify(text)).toBe(true);
    }
    expect(isText('\ud83d\ude00', 2)).toBe(true);
  });

  it('refuse a NUL character, a lone surrogate, and anything not a string', () => {
    for (const value of [
      'a\u0000b',
      '\ud800',
      'x\ud800y',
      'x\udc00',
      '\udc00\ud800',
      'pair cut \ud83d',
      undefined,
      null,
      1,
      ['a'],
    ]) {
      expect(isStorable(value), JSON.stringify(value)).toBe(false);
      expect(isText(value, 100), JSON.stringify(value)).toBe(false);
    }
  });

  it('isText also refuses the empty string and one over its length', () => {
    expect(isText('', 5)).toBe(false);
    expect(isText('abcdef', 5)).toBe(false);
    expect(isText('abcde', 5)).toBe(true);
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
      // Nor a lone UTF-16 surrogate, which has no UTF-8 form.
      { harness_id: 'alice/a\ud800', version: '1.0.0' },
      { harness_id: 'alice/a', version: '1.0.0\udc00' },
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
      // Nor a lone UTF-16 surrogate, which has no UTF-8 form.
      { harness_id: 'alice/a\ud800' },
      { version: '1.0.0\udfff' },
      { details: 'x\ud800y' },
      { details: 'x\udc00' },
      { client_info: { install_id: 'i\udbff' } },
      { client_info: { app_version: '\udc00\ud800' } },
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
      { harness_id: 'alice/a\ud800', note: 'n' },
      { harness_id: 'alice/a', version: '1.0.0\udc00', note: 'n' },
      { harness_id: 'alice/a', note: 'Malware.\ud800' },
    ]) {
      expect(takedownRequest(body), JSON.stringify(body).slice(0, 60)).toMatchObject(INVALID);
    }
  });
});
