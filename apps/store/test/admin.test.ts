/**
 * Ticket P0-12.2: the admin CLI's parts that need no Store (scripts/admin.ts): its command line,
 * the environment it needs (named when missing, never printed), how `reports list` lays out the
 * Reports, the administrator JWT `takedown` mints, the exit codes of a usage error, and how
 * `reports list` pages past PostgREST's `max_rows` (against a fake PostgREST). The CLI against a
 * running Store is test-store/admin.test.ts.
 */
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_JWT_LIFETIME_SECONDS,
  formatReports,
  mintAdminJwt,
  parseCommand,
  printable,
  readEnv,
  REPORTS_PAGE_SIZE,
  runAdmin,
  UsageError,
  USAGE,
} from '../scripts/admin.ts';
import type { ReportRow } from '../scripts/admin.ts';

const REPORT_ID = '3f2b6c1e-8d4a-4b7f-9c2e-1a5d7e9f0b3c';

/** U+202E RIGHT-TO-LEFT OVERRIDE, which makes a terminal show text reversed. */
const RLO = String.fromCodePoint(0x202e);

describe('parseCommand', () => {
  it.each<[string[], unknown]>([
    [['reports', 'list'], { kind: 'reports-list', open: false }],
    [['reports', 'list', '--open'], { kind: 'reports-list', open: true }],
    [
      ['reports', 'dismiss', REPORT_ID.toUpperCase(), '--note', 'Not malware.'],
      { kind: 'reports-dismiss', id: REPORT_ID, note: 'Not malware.' },
    ],
    [
      ['takedown', 'carol/bad-tool', '--note', 'Steals keys.'],
      { kind: 'takedown', harnessId: 'carol/bad-tool', version: null, note: 'Steals keys.' },
    ],
    [
      ['takedown', 'carol/bad-tool', '--version', '1.2.0', '--note=Steals keys.'],
      { kind: 'takedown', harnessId: 'carol/bad-tool', version: '1.2.0', note: 'Steals keys.' },
    ],
    [['--help'], { kind: 'help' }],
    [['reports', 'list', '-h'], { kind: 'help' }],
  ])('understands %j', (argv, command) => {
    expect(parseCommand(argv)).toEqual(command);
  });

  it.each<[string, string[]]>([
    ['no command', []],
    ['an unknown command', ['delete', 'carol/bad-tool']],
    ['an unknown reports action', ['reports', 'resolve']],
    ['an unknown option', ['reports', 'list', '--all']],
    ['an option of another command', ['reports', 'list', '--note', 'x']],
    ['--open on dismiss', ['reports', 'dismiss', REPORT_ID, '--note', 'x', '--open']],
    ['--version on dismiss', ['reports', 'dismiss', REPORT_ID, '--note', 'x', '--version', '1']],
    ['an extra argument', ['reports', 'list', 'now']],
    ['a Report ID that is not a UUID', ['reports', 'dismiss', '42', '--note', 'x']],
    ['two Report IDs', ['reports', 'dismiss', REPORT_ID, REPORT_ID, '--note', 'x']],
    ['dismiss without a note', ['reports', 'dismiss', REPORT_ID]],
    ['a blank note', ['reports', 'dismiss', REPORT_ID, '--note', '   ']],
    ['a note over 2000 characters', ['takedown', 'carol/bad-tool', '--note', 'n'.repeat(2001)]],
    ['a note with NUL', ['takedown', 'carol/bad-tool', '--note', 'a\u0000b']],
    ['takedown without a note', ['takedown', 'carol/bad-tool']],
    ['takedown without a Harness', ['takedown', '--note', 'x']],
    ['a Harness ID without a slug', ['takedown', 'carol', '--note', 'x']],
    ['a Harness ID of three segments', ['takedown', 'carol/bad/tool', '--note', 'x']],
    ['an empty version', ['takedown', 'carol/bad-tool', '--version', ' ', '--note', 'x']],
    ['--version without a value', ['takedown', 'carol/bad-tool', '--note', 'x', '--version']],
  ])('refuses %s', (_, argv) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
  });

  it('takes a note of exactly 2000 characters', () => {
    const note = 'n'.repeat(2000);
    expect(parseCommand(['takedown', 'carol/bad-tool', '--note', note])).toMatchObject({ note });
  });
});

describe('readEnv', () => {
  const list = parseCommand(['reports', 'list']);
  const takedown = parseCommand(['takedown', 'carol/bad-tool', '--note', 'x']);
  const base = { STORE_URL: 'https://store.example.com/', STORE_SERVICE_ROLE_KEY: 'service-key' };

  it('reads the Store URL (without a trailing slash) and the service-role key', () => {
    expect(readEnv(list, base)).toEqual({
      storeUrl: 'https://store.example.com',
      serviceRoleKey: 'service-key',
    });
  });

  it('also reads the JWT secret and the administrator login (lower-cased) for takedown', () => {
    expect(
      readEnv(takedown, { ...base, STORE_JWT_SECRET: 'jwt-secret', STORE_ADMIN_LOGIN: 'Carol' }),
    ).toEqual({
      storeUrl: 'https://store.example.com',
      serviceRoleKey: 'service-key',
      jwtSecret: 'jwt-secret',
      adminLogin: 'carol',
    });
  });

  it('names every missing variable, and no value', () => {
    expect(() => readEnv(list, {})).toThrow('Set STORE_URL, STORE_SERVICE_ROLE_KEY.');
    expect(() => readEnv(takedown, { ...base, STORE_JWT_SECRET: ' ' })).toThrow(
      'Set STORE_JWT_SECRET, STORE_ADMIN_LOGIN.',
    );
  });

  it('refuses a Store URL that is not an http or https URL', () => {
    for (const url of ['store.example.com', 'ftp://store.example.com']) {
      expect(() => readEnv(list, { ...base, STORE_URL: url })).toThrow(UsageError);
    }
  });
});

describe('formatReports', () => {
  const report = (fields: Partial<ReportRow>): ReportRow => ({
    id: REPORT_ID,
    created_at: '2026-10-28T09:00:00+00:00',
    reason: 'malware',
    status: 'open',
    details: '',
    harnesses: { harness_id: 'carol/bad-tool' },
    harness_versions: null,
    ...fields,
  });

  it('groups by Harness with the counts per reason, the latest details and a line per Report', () => {
    const rows = [
      report({
        id: 'id-3',
        created_at: '2026-10-28T12:00:00+00:00',
        details: 'Uploads my files.\nTo an unknown host.',
        harness_versions: { version: '1.2.0' },
      }),
      report({
        id: 'id-2',
        created_at: '2026-10-28T11:00:00+00:00',
        reason: 'spam',
        harnesses: { harness_id: 'dave/other' },
      }),
      report({ id: 'id-1', created_at: '2026-10-28T10:00:00+00:00', details: 'x'.repeat(130) }),
    ];
    expect(formatReports(rows, true)).toEqual([
      'carol/bad-tool: 2 open Reports (malware 2)',
      '  Latest details: Uploads my files.',
      '    To an unknown host.',
      '  id-3  2026-10-28T12:00:00+00:00  1.2.0  malware  open  Uploads my files. To an unknown host.',
      `  id-1  2026-10-28T10:00:00+00:00  all versions  malware  open  ${'x'.repeat(120)}…`,
      '',
      'dave/other: 1 open Report (spam 1)',
      '  Latest details: (none)',
      '  id-2  2026-10-28T11:00:00+00:00  all versions  spam  open',
    ]);
  });

  it('orders the reasons by count, and says when there is no Report', () => {
    const rows = [
      report({ reason: 'spam' }),
      report({ reason: 'broken' }),
      report({ reason: 'broken', status: 'dismissed' }),
    ];
    expect(formatReports(rows, false)[0]).toBe('carol/bad-tool: 3 Reports (broken 2, spam 1)');
    expect(formatReports([], true)).toEqual(['No open Reports.']);
    expect(formatReports([], false)).toEqual(['No Reports.']);
  });

  it('never passes a terminal control sequence or a bidi override through from the details', () => {
    const lines = formatReports(
      [report({ details: `Hi \u001b[2J${RLO}hidden\u0007\r\nnext` })],
      true,
    ).join('\n');
    const unsafe = Array.from(lines).filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return (code < 0x20 && char !== '\n') || (code >= 0x7f && code <= 0x9f) || char === RLO;
    });
    expect(unsafe).toEqual([]);
    expect(lines).toContain('Hi \\u{1b}[2J\\u{202e}hidden\\u{7}');
  });
});

describe('printable', () => {
  it('keeps text, and line breaks only when asked', () => {
    expect(printable('写作助手 ok')).toBe('写作助手 ok');
    expect(printable('a\nb\tc')).toBe('a b c');
    expect(printable('a\nb\tc', true)).toBe('a\nb\tc');
    expect(printable(`a\u0000b${String.fromCodePoint(0x2066)}c`)).toBe('a\\u{0}b\\u{2066}c');
  });
});

describe('mintAdminJwt', () => {
  it('signs a 5-minute HS256 session JWT for the profile, with nothing that claims admin', () => {
    const now = Date.parse('2026-10-28T09:00:00.000Z');
    const token = mintAdminJwt('6d3b0c1e-0000-4000-8000-000000000001', 'jwt-secret', now);
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString())).toEqual({
      sub: '6d3b0c1e-0000-4000-8000-000000000001',
      role: 'authenticated',
      aud: 'authenticated',
      iat: now / 1000,
      exp: now / 1000 + ADMIN_JWT_LIFETIME_SECONDS,
    });
    expect(ADMIN_JWT_LIFETIME_SECONDS).toBe(300);
    expect(signature).toBe(
      createHmac('sha256', 'jwt-secret')
        .update(`${header ?? ''}.${payload ?? ''}`)
        .digest('base64url'),
    );
  });
});

describe('runAdmin without a Store', () => {
  function capture() {
    const lines = { log: [] as string[], error: [] as string[] };
    return {
      lines,
      out: {
        log: (line: string) => lines.log.push(line),
        error: (line: string) => lines.error.push(line),
      },
    };
  }

  it('prints the usage for --help and exits 0', async () => {
    const { lines, out } = capture();
    await expect(runAdmin(['--help'], {}, out)).resolves.toBe(0);
    expect(lines.log).toEqual([USAGE]);
  });

  it('exits 2 on a usage error or a missing variable, printing no value', async () => {
    const { lines, out } = capture();
    await expect(runAdmin(['takedown', 'carol/bad-tool'], {}, out)).resolves.toBe(2);
    expect(lines.error[0]).toBe('--note "<why>" is required.');

    const env = {
      STORE_URL: 'https://store.example.com',
      STORE_SERVICE_ROLE_KEY: 'very-secret-service-key',
    };
    const second = capture();
    await expect(
      runAdmin(['takedown', 'carol/bad-tool', '--note', 'x'], env, second.out),
    ).resolves.toBe(2);
    expect(second.lines.error[0]).toBe('Set STORE_JWT_SECRET, STORE_ADMIN_LOGIN.');
    expect(JSON.stringify(second.lines)).not.toContain('very-secret-service-key');
  });

  it('exits 1 when the Store does not answer, naming no key', async () => {
    const { lines, out } = capture();
    const env = { STORE_URL: 'http://127.0.0.1:9', STORE_SERVICE_ROLE_KEY: 'very-secret' };
    await expect(runAdmin(['reports', 'list'], env, out)).resolves.toBe(1);
    expect(lines.error).toEqual(['The Store at http://127.0.0.1:9 did not answer.']);
    expect(lines.log).toEqual([]);
  });
});

/**
 * A fake PostgREST `reports` read: the rows newest first (created_at, then id, descending), the
 * keyset `or` filter `reports list` sends, `limit`, and at most `maxRows` rows an answer, as
 * PostgREST's `max_rows` cuts one short without saying so. Its URL and the requests it served.
 */
async function fakeReports(rows: readonly ReportRow[], maxRows: number) {
  const requests: URL[] = [];
  const sorted = [...rows].sort(
    (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
  );
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://store');
    requests.push(url);
    const after =
      /^\(created_at\.lt\."([^"]+)",and\(created_at\.eq\."[^"]+",id\.lt\.([^)]+)\)\)$/.exec(
        url.searchParams.get('or') ?? '',
      );
    const [, createdAt = '', id = ''] = after ?? [];
    const page = sorted
      .filter(
        (row) =>
          after === null ||
          row.created_at < createdAt ||
          (row.created_at === createdAt && row.id < id),
      )
      .slice(0, Math.min(Number(url.searchParams.get('limit') ?? Infinity), maxRows));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(page));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('reports list past max_rows', () => {
  /** 2,500 Reports on two Harnesses, many filed in one instant (one transaction's `now()`). */
  const rows: ReportRow[] = Array.from({ length: 2500 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    created_at: `2026-10-28T${String(10 + Math.floor(index / 400)).padStart(2, '0')}:00:00+00:00`,
    reason: index % 5 === 0 ? 'spam' : 'malware',
    status: 'open',
    details: '',
    // The oldest 300 are on a Harness of their own: the first 1000 rows hold none of them.
    harnesses: { harness_id: index < 300 ? 'dave/older' : 'carol/bad-tool' },
    harness_versions: null,
  }));

  it.each([REPORTS_PAGE_SIZE, 400])(
    'counts every Report when the Store answers at most %i rows a request',
    async (maxRows) => {
      const store = await fakeReports(rows, maxRows);
      try {
        const log: string[] = [];
        const code = await runAdmin(
          ['reports', 'list', '--open'],
          { STORE_URL: store.url, STORE_SERVICE_ROLE_KEY: 'service-key' },
          { log: (line) => log.push(line), error: () => undefined },
        );
        expect(code).toBe(0);
        expect(log.filter((line) => /^\S+: /.test(line))).toEqual([
          'carol/bad-tool: 2200 open Reports (malware 1760, spam 440)',
          'dave/older: 300 open Reports (malware 240, spam 60)',
        ]);
        // Each Report once: no page repeats a row of the one before.
        const ids = log.flatMap((line) => /^ {2}(\S{36}) {2}/.exec(line)?.[1] ?? []);
        expect(ids).toHaveLength(2500);
        expect(new Set(ids).size).toBe(2500);
        // Pages until an empty one, each asking for a page of REPORTS_PAGE_SIZE.
        expect(store.requests).toHaveLength(Math.ceil(2500 / maxRows) + 1);
        for (const request of store.requests) {
          expect(request.searchParams.get('limit')).toBe(String(REPORTS_PAGE_SIZE));
          expect(request.searchParams.get('status')).toBe('eq.open');
          expect(request.searchParams.get('order')).toBe('created_at.desc,id.desc');
        }
      } finally {
        await store.close();
      }
    },
  );
});
