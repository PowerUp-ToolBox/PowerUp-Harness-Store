/**
 * Ticket P0-12.1: `store.reportInfo` and `store.report` through the Runtime's IPC handlers, with
 * the settings in a real SQLite database, against a fake Store on a real HTTP port whose `report`
 * function answers what a test sets (201 by default). It checks the exact request (the anon key
 * alone, `client_info` built by main and nothing else), the install ID kept across restarts, the
 * client-side limit of 3 Reports per Harness in 24 hours (no request for a fourth), and how each
 * answer of the Store maps to an IPC result.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../../src/main/runtime/database.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import type { Services } from '../../src/main/runtime/services.js';
import { createSqliteSettingsStore } from '../../src/main/runtime/settings-store.js';
import { createSettingsService } from '../../src/main/runtime/settings.js';
import { createStoreReporter } from '../../src/main/runtime/store-report.js';
import type { IpcResult, ReportInfo, ReportRequest } from '../../src/shared/ipc.js';
import { REFUSED_PORT } from '../support/refused-port.js';

const ANON_KEY = 'fake-anon-key';
const MAIN_WINDOW = {};
const HOUR = 60 * 60 * 1000;

interface ReceivedRequest {
  method: string;
  path: string;
  apikey: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

let server: Server;
let baseUrl: string;
let requests: ReceivedRequest[];
/** The status the fake `report` function answers with. */
let status: number;
let dir: string;
let opened: DatabaseSync[];
let clock: number;
let ids: number;

beforeEach(async () => {
  requests = [];
  status = 201;
  clock = Date.parse('2026-10-28T09:00:00.000Z');
  ids = 0;
  dir = mkdtempSync(join(tmpdir(), 'harness-store-report-'));
  opened = [];
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        apikey: request.headers.apikey as string | undefined,
        authorization: request.headers.authorization,
        body: JSON.parse(body) as unknown,
      });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify(status === 201 ? { id: 'r-1' } : { code: 'x', message: 'Refused.' }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  for (const db of opened) db.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * One app run on the same userData: its own reporter (nothing kept in memory between runs) and
 * dispatcher, against `storeBaseUrl`.
 */
function launch(storeBaseUrl: () => string = () => baseUrl) {
  const db = openDatabase(join(dir, 'harness-store.sqlite'));
  opened.push(db);
  const settingsStore = createSqliteSettingsStore(db);
  const unreachable = vi.fn<() => void>();
  const reports = createStoreReporter({
    fetch: (url, init) => globalThis.fetch(url, init),
    storeBaseUrl,
    anonKey: ANON_KEY,
    settings: settingsStore,
    platform: 'darwin-arm64',
    appVersion: '0.4.2',
    onStoreUnreachable: unreachable,
    now: () => new Date(clock),
    newInstallId: () => `7f1c2a9e-0b4d-4c55-8a3e-2d6f9b1e4c7${String(ids++)}`,
    timeoutMs: 1000,
  });
  const dispatch = createDispatcher({
    handlers: createHandlers({
      reports,
      settings: createSettingsService(settingsStore, () => 'en'),
    } as unknown as Services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
    onHandlerError: (method, error) => {
      throw new Error(`${method} threw`, { cause: error });
    },
  });
  return {
    settingsStore,
    unreachable,
    info: (input: unknown) =>
      dispatch(MAIN_WINDOW, { method: 'store.reportInfo', input }) as Promise<
        IpcResult<ReportInfo>
      >,
    report: (input: unknown) =>
      dispatch(MAIN_WINDOW, { method: 'store.report', input }) as Promise<IpcResult<null>>,
    settings: () => dispatch(MAIN_WINDOW, { method: 'settings.get' }),
  };
}

const REPORT: ReportRequest = {
  harnessId: 'alice/writer',
  version: '1.2.0',
  reason: 'malware',
  details: 'It deletes files outside its Workspace.',
  contactEmail: '',
};

const INSTALL_ID = '7f1c2a9e-0b4d-4c55-8a3e-2d6f9b1e4c70';

describe('store.reportInfo', () => {
  it('makes one random install ID, keeps it across restarts, and never shows it in settings.get', async () => {
    const run = launch();
    await expect(run.info('alice/writer')).resolves.toEqual({
      ok: true,
      data: {
        installId: INSTALL_ID,
        platform: 'darwin-arm64',
        appVersion: '0.4.2',
        rateLimited: false,
      },
    });
    await expect(run.info('bob/other')).resolves.toMatchObject({
      data: { installId: INSTALL_ID },
    });
    // The next run reads the same one; no second ID is made.
    await expect(launch().info('alice/writer')).resolves.toMatchObject({
      data: { installId: INSTALL_ID },
    });
    expect(ids).toBe(1);
    const settings = await run.settings();
    expect(JSON.stringify(settings)).not.toContain(INSTALL_ID);
    expect(Object.keys((settings as IpcResult<object> & { ok: true }).data)).not.toContain(
      'installId',
    );
    // Nothing went to the Store.
    expect(requests).toEqual([]);
  });

  it('refuses an input that is not a Harness ID', async () => {
    const run = launch();
    for (const input of [undefined, '', 'no-slash', 42, 'x/'.padEnd(300, 'y')]) {
      await expect(run.info(input)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
    }
  });
});

describe('store.report', () => {
  it('sends the reason, version, details and client_info only, with the anon key', async () => {
    const run = launch();
    await expect(run.report({ ...REPORT, contactEmail: '  me@example.com ' })).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/functions/v1/report',
        apikey: ANON_KEY,
        authorization: `Bearer ${ANON_KEY}`,
        body: {
          harness_id: 'alice/writer',
          version: '1.2.0',
          reason: 'malware',
          details: 'Contact: me@example.com\n\nIt deletes files outside its Workspace.',
          client_info: { install_id: INSTALL_ID, app_version: '0.4.2', platform: 'darwin-arm64' },
        },
      },
    ]);
  });

  it('leaves out a version it does not know and details nobody typed', async () => {
    const run = launch();
    await run.report({ ...REPORT, version: null, details: '   ', reason: 'other' });
    await run.report({ ...REPORT, version: null, details: '', contactEmail: 'me@example.com' });
    expect(requests.map((request) => request.body)).toEqual([
      {
        harness_id: 'alice/writer',
        reason: 'other',
        client_info: { install_id: INSTALL_ID, app_version: '0.4.2', platform: 'darwin-arm64' },
      },
      {
        harness_id: 'alice/writer',
        reason: 'malware',
        details: 'Contact: me@example.com',
        client_info: { install_id: INSTALL_ID, app_version: '0.4.2', platform: 'darwin-arm64' },
      },
    ]);
  });

  it('blocks a 4th Report of one Harness within 24 hours without a request, across restarts', async () => {
    const run = launch();
    for (let sent = 0; sent < 3; sent++) {
      await expect(run.report(REPORT)).resolves.toEqual({ ok: true, data: null });
      clock += HOUR;
    }
    expect(requests).toHaveLength(3);
    await expect(run.info('alice/writer')).resolves.toMatchObject({
      data: { rateLimited: true },
    });
    await expect(run.report(REPORT)).resolves.toMatchObject({
      ok: false,
      error: { code: 'rate_limited' },
    });
    // After a restart too: the history is in the database.
    const next = launch();
    await expect(next.report(REPORT)).resolves.toMatchObject({
      error: { code: 'rate_limited' },
    });
    expect(requests).toHaveLength(3);
    // Another Harness is not limited.
    await expect(next.info('bob/other')).resolves.toMatchObject({ data: { rateLimited: false } });
    await expect(next.report({ ...REPORT, harnessId: 'bob/other' })).resolves.toMatchObject({
      ok: true,
    });

    // 24 hours after the first one, one more may go; the entry that aged out is dropped.
    clock = Date.parse('2026-10-29T09:00:00.000Z');
    await expect(next.info('alice/writer')).resolves.toMatchObject({
      data: { rateLimited: false },
    });
    await expect(next.report(REPORT)).resolves.toMatchObject({ ok: true });
    expect(next.settingsStore.read('report_history')).toEqual({
      'alice/writer': [
        '2026-10-28T10:00:00.000Z',
        '2026-10-28T11:00:00.000Z',
        '2026-10-29T09:00:00.000Z',
      ],
      'bob/other': ['2026-10-28T12:00:00.000Z'],
    });
    expect(requests).toHaveLength(5);
  });

  it('counts Reports still being sent, so a double click cannot send a 4th', async () => {
    const run = launch();
    const answers = await Promise.all([1, 2, 3, 4, 5].map(() => run.report(REPORT)));
    expect(answers.filter((answer) => answer.ok)).toHaveLength(3);
    expect(
      answers.filter((answer) => !answer.ok && answer.error.code === 'rate_limited'),
    ).toHaveLength(2);
    expect(requests).toHaveLength(3);
  });

  it('maps the Store’s refusals, none of which counts toward the limit', async () => {
    const run = launch();
    const expected: [number, string][] = [
      [429, 'rate_limited'],
      [400, 'invalid_input'],
      [404, 'not_found'],
      [500, 'store_error'],
      [503, 'store_error'],
      [200, 'store_error'],
    ];
    for (const [answer, code] of expected) {
      status = answer;
      await expect(run.report(REPORT)).resolves.toMatchObject({ ok: false, error: { code } });
    }
    expect(run.unreachable).not.toHaveBeenCalled();
    expect(requests).toHaveLength(expected.length);
    await expect(run.info('alice/writer')).resolves.toMatchObject({
      data: { rateLimited: false },
    });
    expect(run.settingsStore.read('report_history')).toBeUndefined();
  });

  it('answers store_unreachable when the Store does not answer, then sends the same Report on Retry', async () => {
    let target = `http://127.0.0.1:${String(REFUSED_PORT)}`;
    const run = launch(() => target);
    await expect(run.report(REPORT)).resolves.toMatchObject({
      ok: false,
      error: { code: 'store_unreachable' },
    });
    expect(run.unreachable).toHaveBeenCalledTimes(1);
    expect(run.settingsStore.read('report_history')).toBeUndefined();

    target = baseUrl;
    await expect(run.report(REPORT)).resolves.toEqual({ ok: true, data: null });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({ details: REPORT.details });
  });

  it('refuses an input it cannot send, without a request', async () => {
    const run = launch();
    const refused: unknown[] = [
      undefined,
      { ...REPORT, reason: 'misleading' },
      { ...REPORT, harnessId: 'no-slash' },
      { ...REPORT, version: '' },
      { ...REPORT, version: undefined },
      { ...REPORT, details: 42 },
      { ...REPORT, contactEmail: 'not an email' },
      { ...REPORT, contactEmail: `${'a'.repeat(250)}@b.cd` },
      { ...REPORT, clientInfo: { machineId: 'x' } },
      // 2001 characters with the contact line.
      { ...REPORT, contactEmail: 'me@example.com', details: 'x'.repeat(2001 - 25) },
      { ...REPORT, details: 'x'.repeat(2001) },
    ];
    for (const input of refused) {
      await expect(run.report(input)).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
    }
    expect(requests).toEqual([]);

    // Exactly 2000 characters, the contact line included, goes.
    await expect(
      run.report({ ...REPORT, contactEmail: 'me@example.com', details: 'x'.repeat(2000 - 25) }),
    ).resolves.toEqual({ ok: true, data: null });
    expect((requests[0]?.body as { details: string }).details).toHaveLength(2000);
  });
});
