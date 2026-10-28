/**
 * Ticket P0-07.6: the `report` Edge Function, over HTTP against the local stack, with the anon key
 * as the desktop app sends it. Every Report goes to a Harness of the test Publisher, so deleting
 * the Publisher afterwards deletes the Reports too.
 *
 * The rate limit is tested through the per-install check (`client_info.install_id` against the
 * stored Reports), which is exact. The per-IP counter lives in each function worker's memory, so
 * whether a request meets the same counter is up to the edge runtime: its rules are unit tests
 * (test/moderation.test.ts), and each request here sends an IP address of its own unless the test is
 * about one IP, so that no counter of an earlier request gets in the way.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPORT_REASONS } from '../supabase/functions/_shared/report.ts';
import {
  callFunction,
  createUser,
  deleteUser,
  insertHarness,
  insertVersion,
  isPermissionDenied,
  rest,
  serviceRest,
  stack,
} from './support.ts';
import type { HarnessRow, TestUser, VersionRow } from './support.ts';

let publisher: TestUser;
let harness: HarnessRow;
let version: VersionRow;

beforeAll(async () => {
  publisher = await createUser();
  harness = await insertHarness(publisher, 'reported');
  version = await insertVersion(harness, '1.0.0');
});

afterAll(async () => {
  await deleteUser(publisher);
});

/**
 * An X-Forwarded-For header whose first address (the client's) is a random one of the IPv6
 * documentation prefix (RFC 3849), so no two calls, nor two runs, share a per-IP counter.
 */
function ip(): string {
  const hex = randomBytes(8).toString('hex').match(/.{4}/g) ?? [];
  return `2001:db8::${hex.join(':')}, 10.0.0.1`;
}

interface StoredReport {
  id: string;
  harness_id: string;
  version_id: string | null;
  reporter_id: string | null;
  reason: string;
  details: string;
  client_info: Record<string, unknown>;
  status: string;
}

/** POST /functions/v1/report from `forwardedFor`, with the anon key as bearer unless `token`. */
function report(body: Record<string, unknown>, forwardedFor = ip(), token = stack.anonKey) {
  return callFunction<{ id: string }>('report', body, {
    token,
    headers: { 'x-forwarded-for': forwardedFor },
  });
}

/** A valid body for the test Harness, from an install of its own. */
function valid(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    harness_id: harness.harness_id,
    reason: 'broken',
    details: 'It crashes on start.',
    client_info: { install_id: randomUUID(), app_version: '0.1.0', platform: 'linux-x64' },
    ...fields,
  };
}

async function storedReport(id: string): Promise<StoredReport | undefined> {
  const [row] = await serviceRest<StoredReport[]>('GET', `reports?id=eq.${id}`);
  return row;
}

describe('report', () => {
  it('accepts each of the six reasons from anyone, storing one Report per call', async () => {
    expect(REPORT_REASONS).toHaveLength(6);
    for (const reason of REPORT_REASONS) {
      const reply = await report(valid({ reason }));
      expect(reply.status, reason).toBe(201);
      expect(reply.body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await storedReport(reply.body.id)).toMatchObject({
        harness_id: harness.id,
        version_id: null,
        reporter_id: null,
        reason,
        details: 'It crashes on start.',
        status: 'open',
      });
    }
  });

  it('rejects a reason that is not one of the six (400) and stores nothing', async () => {
    const before = await serviceRest<unknown[]>('GET', `reports?harness_id=eq.${harness.id}`);
    for (const reason of ['malicious', 'MALWARE', '', null, 1]) {
      const reply = await report(valid({ reason }));
      expect(reply.status, String(reason)).toBe(400);
      expect(reply.body.error?.code).toBe('invalid_request');
    }
    const body = valid();
    delete body.reason;
    expect((await report(body)).status).toBe(400);
    expect(await serviceRest<unknown[]>('GET', `reports?harness_id=eq.${harness.id}`)).toEqual(
      before,
    );
  });

  it('rate-limits the 6th Report within an hour from one IP address and install; the first 5 succeed', async () => {
    const from = ip();
    const install = randomUUID();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const reply = await report(
        valid({ client_info: { install_id: install, platform: 'darwin-arm64' } }),
        from,
      );
      statuses.push(reply.status);
      if (reply.status === 429) expect(reply.body.error?.code).toBe('rate_limited');
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    const stored = await serviceRest<unknown[]>(
      'GET',
      `reports?client_info->>install_id=eq.${install}`,
    );
    expect(stored).toHaveLength(5);

    // Another install from another address is not affected.
    expect((await report(valid())).status).toBe(201);
  });

  it('keeps only install_id, app_version and platform of client_info, and never an IP address', async () => {
    const install = randomUUID();
    // The forwarded address is a fresh one (see the header); the one the client names is fixed.
    const forwardedFor = ip();
    const reply = await report(
      valid({
        client_info: {
          install_id: install,
          app_version: '0.2.0',
          platform: 'win32-x64',
          hostname: 'my-laptop',
          ip: '198.51.100.7',
        },
      }),
      forwardedFor,
    );
    expect(reply.status).toBe(201);
    const row = await storedReport(reply.body.id);
    expect(row?.client_info).toEqual({
      install_id: install,
      app_version: '0.2.0',
      platform: 'win32-x64',
    });
    expect(JSON.stringify(row)).not.toContain('198.51.100.7');
    expect(JSON.stringify(row)).not.toContain('2001:db8:');
  });

  it('records the version when one is named, and refuses an unknown Harness or version (404)', async () => {
    const reply = await report(valid({ version: '1.0.0' }));
    expect(reply.status).toBe(201);
    expect((await storedReport(reply.body.id))?.version_id).toBe(version.id);

    for (const fields of [{ version: '9.9.9' }, { harness_id: 'nobody/no-such-harness' }]) {
      const refused = await report(valid(fields));
      expect(refused.status, JSON.stringify(fields)).toBe(404);
      expect(refused.body.error?.code).toBe('not_found');
    }
  });

  it('accepts a Report on a Harness in any status (here taken down)', async () => {
    const takenDown = await insertHarness(publisher, 'reported-taken-down');
    await insertVersion(takenDown, '1.0.0');
    await serviceRest('PATCH', `harnesses?id=eq.${takenDown.id}`, { status: 'taken_down' });
    const reply = await report(valid({ harness_id: takenDown.harness_id }));
    expect(reply.status).toBe(201);
  });

  it('refuses details over 2000 characters, client_info fields that are not short strings, or a NUL anywhere (400)', async () => {
    expect((await report(valid({ details: 'x'.repeat(2000) }))).status).toBe(201);
    expect((await report(valid({ details: undefined }))).status).toBe(201);
    for (const fields of [
      { details: 'x'.repeat(2001) },
      { details: 3 },
      { client_info: 'linux' },
      { client_info: { install_id: 7 } },
      { client_info: { app_version: 'v'.repeat(65) } },
      { version: '' },
      // Postgres cannot store a NUL character: refused before the database is asked.
      { details: 'x\u0000y' },
      { harness_id: `${harness.harness_id}\u0000` },
      { version: '1.0.0\u0000' },
      { client_info: { install_id: 'i\u0000' } },
    ]) {
      const reply = await report(valid(fields));
      expect(reply.status, JSON.stringify(fields).slice(0, 80)).toBe(400);
      expect(reply.body.error?.code).toBe('invalid_request');
    }
  });

  it('records the reporter when a signed-in Publisher sends it, and nobody for the anon key', async () => {
    const reporter = await createUser();
    try {
      const signedIn = await report(valid(), ip(), reporter.token);
      expect(signedIn.status).toBe(201);
      expect((await storedReport(signedIn.body.id))?.reporter_id).toBe(reporter.id);

      const anonymous = await report(valid());
      expect((await storedReport(anonymous.body.id))?.reporter_id).toBeNull();
      // A token Auth refuses does not fail a Report: it is anonymous.
      const refused = await report(valid(), ip(), 'not-a-jwt');
      expect(refused.status).toBe(201);
      expect((await storedReport(refused.body.id))?.reporter_id).toBeNull();
    } finally {
      await deleteUser(reporter);
    }
  });

  it('is the only way in: anon and Publishers cannot insert a Report through PostgREST', async () => {
    for (const caller of ['anon', { token: publisher.token }] as const) {
      const reply = await rest(caller, 'POST', 'reports', {
        harness_id: harness.id,
        reason: 'spam',
      });
      expect(isPermissionDenied(reply)).toBe(true);
    }
  });
});
