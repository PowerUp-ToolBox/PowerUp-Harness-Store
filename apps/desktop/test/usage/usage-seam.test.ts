/**
 * Ticket P0-11.1: the Usage page's calls in main, through the IPC handlers of the real Runtime
 * (SQLite, the Model Gateway on a loopback port, the fake Provider standing in for a vendor). The
 * Gateway writes Usage Records from scripted fake-Provider answers; `usage.query` then sums them
 * in SQL by period, Harness, Provider and model, and local day; `usage.export` writes them as CSV;
 * `usage.clear` deletes them. test/renderer/usage.test.tsx covers the page.
 *
 * Periods and days are the User's local time: this file runs in a timezone with daylight saving
 * time (America/New_York, whose clocks went back on 2026-11-01), set before anything reads the
 * clock and restored afterwards, so it passes the same in CI's UTC.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGateway, type Gateway, type UsageRecord } from '@harness-store/gateway';
import { startFakeProvider, type FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startRuntime,
  type Runtime,
  type RuntimeOptions,
} from '../../src/main/runtime/bootstrap.js';
import { createDispatcher } from '../../src/main/runtime/dispatcher.js';
import { createHandlers } from '../../src/main/runtime/handlers.js';
import { createUsageRecordStore } from '../../src/main/runtime/usage-records.js';
import type { IpcEventName, UsageRow } from '../../src/shared/ipc.js';
import { createFakeCipher } from '../support/fake-cipher.js';

const savedTimeZone = process.env.TZ;
process.env.TZ = 'America/New_York';
afterAll(() => {
  if (savedTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = savedTimeZone;
});

const MAIN_WINDOW = {};

let dataDir: string;
let runtime: Runtime;
let gateway: Gateway;
let events: { event: IpcEventName; payload: unknown }[];
let pickSaveFile: ReturnType<typeof vi.fn<(defaultName: string) => Promise<string | null>>>;

beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), 'harness-store-usage-')), 'userData');
  events = [];
  pickSaveFile = vi.fn<(defaultName: string) => Promise<string | null>>(() =>
    Promise.resolve(null),
  );
});
afterEach(async () => {
  await runtime.shutdown();
  rmSync(join(dataDir, '..'), { recursive: true, force: true });
});

/** Starts the Runtime against `dataDir`, without Electron and without a Store. */
async function launch(options: Partial<RuntimeOptions> = {}): Promise<void> {
  let created: Gateway | undefined;
  runtime = await startRuntime({
    dataDir,
    version: '1.0.0',
    osLocale: () => 'en-US',
    quit: () => undefined,
    logError: () => undefined,
    fetch: () => Promise.reject(new TypeError('fetch failed')),
    providerFetch: globalThis.fetch,
    secretCipher: createFakeCipher(),
    emit: (event, payload) => {
      events.push({ event, payload });
    },
    pickSaveFile,
    createGateway: (gatewayOptions) => {
      created = createGateway({
        ...gatewayOptions,
        logger: { debug: () => undefined, error: () => undefined },
      });
      return created;
    },
    ...options,
  });
  if (created === undefined) throw new Error('The Runtime did not create a Gateway');
  gateway = created;
}

function call(method: string, input?: unknown) {
  const dispatch = createDispatcher({
    handlers: createHandlers(runtime.services),
    isTrustedSender: (sender) => sender === MAIN_WINDOW,
  });
  return dispatch(MAIN_WINDOW, { method, input });
}

/** `usage.query`'s rows; fails the test when it answers an error. */
async function query(input: Record<string, unknown>): Promise<UsageRow[]> {
  const result = await call('usage.query', { from: null, to: null, ...input });
  if (!result.ok) throw new Error(`usage.query failed: ${result.error.code}`);
  return result.data as UsageRow[];
}

/** Writes Usage Records into the Runtime's database, as the Gateway's onUsage does. */
function insert(records: readonly Partial<UsageRecord>[]): void {
  const { databasePath } = runtime.services.diagnostics.get();
  const db = new DatabaseSync(databasePath);
  try {
    const store = createUsageRecordStore(db);
    for (const record of records) store.insert({ ...BASE, ...record });
  } finally {
    db.close();
  }
}

const BASE: UsageRecord = {
  timestamp: '2026-10-30T14:00:00.000Z',
  harnessId: 'acme/reviewer',
  harnessVersion: '1.0.0',
  slot: 'default',
  provider: 'ollama',
  model: 'qwen3:8b',
  promptTokens: 10,
  completionTokens: 20,
  durationMs: 50,
  status: 'ok',
};

/** Local midnight `daysAgo` days before `now`'s day, as the Usage page computes a period start. */
function localMidnight(now: Date, daysAgo: number): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).toISOString();
}

const ZERO = { requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, unknownCount: 0 };

describe('Usage Records from the Model Gateway', () => {
  let fake: FakeProvider;
  beforeEach(async () => {
    fake = await startFakeProvider();
  });
  afterEach(async () => {
    await fake.close();
  });

  /** One chat completion through the Gateway, read to its end, as a Harness sends it. */
  async function complete(token: string, model: string, stream = false) {
    const { gateway: status } = runtime.services.diagnostics.get();
    if (!status.running) throw new Error('The Model Gateway is not running');
    const response = await fetch(`http://127.0.0.1:${String(status.port)}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'hello there' }] }),
    });
    const text = await response.text();
    return { status: response.status, text };
  }

  /** The rows of usage_records, oldest first, once there are `count` of them. */
  async function storedRecords(count: number): Promise<Record<string, unknown>[]> {
    const { databasePath } = runtime.services.diagnostics.get();
    let rows: Record<string, unknown>[] = [];
    await vi.waitFor(() => {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        rows = db
          .prepare(
            'SELECT harness_id, provider, model, prompt_tokens, completion_tokens, status FROM usage_records ORDER BY id',
          )
          .all();
      } finally {
        db.close();
      }
      expect(rows).toHaveLength(count);
    });
    return rows;
  }

  it('two answers with usage, one without and one that fails after its first byte: the 7-day total sums the two, with one unknown and one error', async () => {
    await launch();
    await expect(
      call('connections.add', { providerId: 'ollama', baseUrl: fake.url }),
    ).resolves.toMatchObject({ ok: true });
    const token = gateway.issueToken({
      harnessId: 'acme/hello',
      harnessVersion: '1.0.0',
      launchId: 'launch-1',
      locale: 'en',
    });

    const first = await complete(token, 'ollama/fake/echo');
    const second = await complete(token, 'ollama/fake/echo');
    expect([first.status, second.status]).toEqual([200, 200]);
    expect((await complete(token, 'ollama/fake/stream-no-usage')).status).toBe(200);
    const failed = await complete(token, 'ollama/fake/stream-error', true);
    expect(failed.status).toBe(200);
    expect(failed.text).toContain('provider_error');

    const usageOf = (text: string) =>
      (JSON.parse(text) as { usage: { prompt_tokens: number; completion_tokens: number } }).usage;
    const [a, b] = [usageOf(first.text), usageOf(second.text)];
    const records = await storedRecords(4);
    expect(records).toEqual([
      {
        harness_id: 'acme/hello',
        provider: 'ollama',
        model: 'fake/echo',
        prompt_tokens: a.prompt_tokens,
        completion_tokens: a.completion_tokens,
        status: 'ok',
      },
      {
        harness_id: 'acme/hello',
        provider: 'ollama',
        model: 'fake/echo',
        prompt_tokens: b.prompt_tokens,
        completion_tokens: b.completion_tokens,
        status: 'ok',
      },
      {
        harness_id: 'acme/hello',
        provider: 'ollama',
        model: 'fake/stream-no-usage',
        prompt_tokens: null,
        completion_tokens: null,
        status: 'ok',
      },
      {
        harness_id: 'acme/hello',
        provider: 'ollama',
        model: 'fake/stream-error',
        prompt_tokens: null,
        completion_tokens: null,
        status: 'provider_error',
      },
    ]);
    // Every write is announced to the main window, for the Usage page's live refresh.
    expect(events.filter(({ event }) => event === 'usage.recorded')).toEqual(
      Array.from({ length: 4 }, () => ({
        event: 'usage.recorded',
        payload: { harnessId: 'acme/hello' },
      })),
    );

    const sevenDays = { from: localMidnight(new Date(), 6), to: null };
    const [total] = await query({ ...sevenDays, groupBy: [] });
    expect(total).toMatchObject({
      requests: 4,
      errors: 1,
      promptTokens: a.prompt_tokens + b.prompt_tokens,
      completionTokens: a.completion_tokens + b.completion_tokens,
      unknownCount: 1,
    });
    expect(a.prompt_tokens + b.prompt_tokens).toBeGreaterThan(0);
    const byModel = await query({ ...sevenDays, groupBy: ['harness', 'model'] });
    expect(byModel.map((row) => [row.model, row.requests, row.errors, row.unknownCount])).toEqual(
      expect.arrayContaining([
        ['fake/echo', 2, 0, 0],
        ['fake/stream-no-usage', 1, 0, 1],
        ['fake/stream-error', 1, 1, 0],
      ]),
    );
    const errored = byModel.find((row) => row.model === 'fake/stream-error');
    expect(errored).toMatchObject({ promptTokens: 0, completionTokens: 0 });
  });
});

describe('usage.query', () => {
  it('sums a group with an unknown record and an error: the known ones only, one unknown, one error', async () => {
    await launch();
    insert([
      { promptTokens: 10, completionTokens: 20 },
      { promptTokens: 30, completionTokens: 40, timestamp: '2026-10-30T15:00:00.000Z' },
      { promptTokens: null, completionTokens: null },
      // Half a count is no count: it is unknown and neither half is summed.
      { promptTokens: 7, completionTokens: null },
      // A failed request is never summed, whatever it carries.
      { status: 'provider_error', promptTokens: 1000, completionTokens: 1000 },
      { status: 'timeout', promptTokens: null, completionTokens: null },
      { status: 'aborted', promptTokens: null, completionTokens: null },
    ]);
    await expect(query({ groupBy: ['harness', 'model'] })).resolves.toEqual([
      {
        harnessId: 'acme/reviewer',
        provider: 'ollama',
        model: 'qwen3:8b',
        requests: 7,
        errors: 3,
        promptTokens: 40,
        completionTokens: 60,
        unknownCount: 2,
        lastUsedAt: '2026-10-30T15:00:00.000Z',
      },
    ]);
  });

  it('answers one total row of zeros over no records, and nothing for a grouping', async () => {
    await launch();
    await expect(query({ groupBy: [] })).resolves.toEqual([{ ...ZERO, lastUsedAt: null }]);
    await expect(query({ groupBy: ['harness'] })).resolves.toEqual([]);
  });

  it('buckets days and periods in local time, across the end of daylight saving time', async () => {
    await launch();
    insert([
      // 23:30 EDT on Oct 31: Nov 1 in UTC.
      { timestamp: '2026-11-01T03:30:00.000Z', promptTokens: 1 },
      // 00:30 EDT on Nov 1.
      { timestamp: '2026-11-01T04:30:00.000Z', promptTokens: 2 },
      // 23:30 EST on Nov 1, after the clocks went back: Nov 2 in UTC.
      { timestamp: '2026-11-02T04:30:00.000Z', promptTokens: 3 },
      // 00:30 EST on Nov 2.
      { timestamp: '2026-11-02T05:30:00.000Z', promptTokens: 4 },
    ]);
    const days = await query({ groupBy: ['day'] });
    expect(days.map((row) => [row.day, row.requests, row.promptTokens])).toEqual([
      ['2026-11-02', 1, 4],
      ['2026-11-01', 2, 5],
      ['2026-10-31', 1, 1],
    ]);

    // Nov 1 is 25 hours long here; its local midnights bound exactly its two records.
    const from = new Date(2026, 10, 1).toISOString();
    const to = new Date(2026, 10, 2).toISOString();
    expect([from, to]).toEqual(['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z']);
    const [day] = await query({ from, to, groupBy: [] });
    expect(day).toMatchObject({ requests: 2, promptTokens: 5 });

    // "7 days" on Nov 2 at noon: from local midnight on Oct 27, today included.
    const now = new Date(2026, 10, 2, 12);
    expect(localMidnight(now, 6)).toBe('2026-10-27T04:00:00.000Z');
    const [week] = await query({ from: localMidnight(now, 6), to: null, groupBy: [] });
    expect(week).toMatchObject({ requests: 4, promptTokens: 10 });
    // "Today": from its local midnight.
    const [today] = await query({ from: localMidnight(now, 0), to: null, groupBy: [] });
    expect(today).toMatchObject({ requests: 1, promptTokens: 4 });
  });

  it('filters by Harness and Provider narrow every grouping alike, and the days sum to the period', async () => {
    await launch();
    insert([
      { harnessId: 'acme/reviewer', provider: 'ollama', model: 'qwen3:8b' },
      {
        harnessId: 'acme/reviewer',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        timestamp: '2026-10-29T14:00:00.000Z',
        promptTokens: 100,
        completionTokens: 200,
      },
      {
        harnessId: 'acme/writer',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        timestamp: '2026-10-28T14:00:00.000Z',
        promptTokens: 1000,
        completionTokens: 2000,
      },
      {
        harnessId: 'acme/writer',
        provider: 'ollama',
        model: 'qwen3:8b',
        timestamp: '2026-10-27T14:00:00.000Z',
        status: 'timeout',
        promptTokens: null,
        completionTokens: null,
      },
      // Before the period.
      { harnessId: 'acme/writer', timestamp: '2026-10-20T14:00:00.000Z', promptTokens: 9 },
    ]);
    const period = { from: '2026-10-27T04:00:00.000Z', to: '2026-11-03T05:00:00.000Z' };
    const totals = (rows: readonly UsageRow[]) =>
      rows.reduce(
        (sum, row) => ({
          requests: sum.requests + row.requests,
          errors: sum.errors + row.errors,
          promptTokens: sum.promptTokens + row.promptTokens,
          completionTokens: sum.completionTokens + row.completionTokens,
          unknownCount: sum.unknownCount + row.unknownCount,
        }),
        ZERO,
      );
    const unfiltered = (await query({ ...period, groupBy: [] }))[0];
    expect(unfiltered).toMatchObject({ requests: 4, errors: 1, promptTokens: 1110 });

    for (const filter of [
      {},
      { harnessId: 'acme/writer' },
      { providerId: 'anthropic' },
      { harnessId: 'acme/reviewer', providerId: 'ollama' },
    ]) {
      const [total] = await query({ ...period, ...filter, groupBy: [] });
      for (const groupBy of [['harness'], ['harness', 'model'], ['provider'], ['day']]) {
        const rows = await query({ ...period, ...filter, groupBy });
        expect(totals(rows), `${JSON.stringify(filter)} by ${groupBy.join()}`).toEqual(
          totals(total === undefined ? [] : [total]),
        );
        if (filter.harnessId !== undefined) {
          expect(
            rows.every((row) => row.harnessId === undefined || row.harnessId === filter.harnessId),
          ).toBe(true);
        }
        if (filter.providerId !== undefined) {
          expect(
            rows.every((row) => row.provider === undefined || row.provider === filter.providerId),
          ).toBe(true);
        }
      }
    }
    await expect(query({ ...period, harnessId: 'acme/writer', groupBy: [] })).resolves.toEqual([
      {
        requests: 2,
        errors: 1,
        promptTokens: 1000,
        completionTokens: 2000,
        unknownCount: 0,
        lastUsedAt: '2026-10-28T14:00:00.000Z',
      },
    ]);
    await expect(
      query({ ...period, harnessId: 'acme/reviewer', providerId: 'ollama', groupBy: ['model'] }),
    ).resolves.toEqual([
      {
        provider: 'ollama',
        model: 'qwen3:8b',
        requests: 1,
        errors: 0,
        promptTokens: 10,
        completionTokens: 20,
        unknownCount: 0,
        lastUsedAt: '2026-10-30T14:00:00.000Z',
      },
    ]);
  });

  it('lists the most recently used group first', async () => {
    await launch();
    insert([
      { harnessId: 'acme/old', timestamp: '2026-10-01T10:00:00.000Z' },
      { harnessId: 'acme/new', timestamp: '2026-10-02T10:00:00.000Z' },
      { harnessId: 'acme/new', model: 'other', timestamp: '2026-10-03T10:00:00.000Z' },
      { harnessId: 'acme/old', model: 'other', timestamp: '2026-09-01T10:00:00.000Z' },
    ]);
    const byHarness = await query({ groupBy: ['harness'] });
    expect(byHarness.map((row) => [row.harnessId, row.lastUsedAt])).toEqual([
      ['acme/new', '2026-10-03T10:00:00.000Z'],
      ['acme/old', '2026-10-01T10:00:00.000Z'],
    ]);
    const byModel = await query({ groupBy: ['harness', 'model'] });
    expect(byModel.map((row) => `${String(row.harnessId)} ${String(row.model)}`)).toEqual([
      'acme/new other',
      'acme/new qwen3:8b',
      'acme/old qwen3:8b',
      'acme/old other',
    ]);
  });
});

describe('usage.export', () => {
  it('writes the grouped rows of the period and filters as CSV to the file the User picked', async () => {
    const path = join(dataDir, '..', 'usage.csv');
    pickSaveFile.mockResolvedValue(path);
    await launch({ now: () => new Date(2026, 10, 2, 0, 30) });
    insert([
      { timestamp: '2026-11-02T05:30:00.000Z' },
      { timestamp: '2026-11-02T04:30:00.000Z', promptTokens: null, completionTokens: null },
      { timestamp: '2026-11-01T04:30:00.000Z', status: 'provider_error', promptTokens: null },
      { provider: 'openai-compatible:vllm', model: '=HYPERLINK("http://x")' },
      { model: 'say "hi", then go' },
      { model: '-2+3' },
      { harnessId: 'acme/writer', timestamp: '2026-11-02T05:30:00.000Z' },
      // Before the period.
      { timestamp: '2026-10-01T10:00:00.000Z' },
    ]);
    const filter = {
      from: '2026-10-27T04:00:00.000Z',
      to: null,
      harnessId: 'acme/reviewer',
    };

    await expect(call('usage.export', filter)).resolves.toEqual({ ok: true, data: { path } });
    expect(pickSaveFile).toHaveBeenCalledWith('harness-store-usage-2026-11-02.csv');
    const csv = readFileSync(path, 'utf8');
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(csv.split('\r\n')).toEqual([
      'harness_id,provider,model,day,requests,errors,prompt_tokens,completion_tokens,unknown_usage_count,last_used_at',
      "acme/reviewer,ollama,'-2+3,2026-10-30,1,0,10,20,0,2026-10-30T14:00:00.000Z",
      'acme/reviewer,ollama,qwen3:8b,2026-11-01,2,1,0,0,1,2026-11-02T04:30:00.000Z',
      'acme/reviewer,ollama,qwen3:8b,2026-11-02,1,0,10,20,0,2026-11-02T05:30:00.000Z',
      'acme/reviewer,ollama,"say ""hi"", then go",2026-10-30,1,0,10,20,0,2026-10-30T14:00:00.000Z',
      `acme/reviewer,openai-compatible:vllm,"'=HYPERLINK(""http://x"")",2026-10-30,1,0,10,20,0,2026-10-30T14:00:00.000Z`,
      '',
    ]);

    // The rows are those usage.query answers for the same period, filters and grouping.
    const rows = await query({ ...filter, groupBy: ['harness', 'model', 'day'] });
    expect(rows).toHaveLength(csv.split('\r\n').length - 2);
  });

  it('writes nothing when the User cancels the save dialog', async () => {
    await launch();
    insert([{}]);
    await expect(call('usage.export', { from: null, to: null })).resolves.toEqual({
      ok: true,
      data: null,
    });
    expect(pickSaveFile).toHaveBeenCalledOnce();
  });

  it('answers internal_error when the file cannot be written', async () => {
    pickSaveFile.mockResolvedValue(join(dataDir, 'no-such-folder', 'usage.csv'));
    await launch();
    await expect(call('usage.export', { from: null, to: null })).resolves.toMatchObject({
      ok: false,
      error: { code: 'internal_error' },
    });
  });
});

describe('usage.clear', () => {
  it('deletes every Usage Record: every total is zero and no group is left', async () => {
    await launch();
    insert([{}, { harnessId: 'acme/writer', status: 'timeout' }]);
    await expect(call('usage.clear')).resolves.toEqual({ ok: true, data: null });
    await expect(query({ groupBy: [] })).resolves.toEqual([{ ...ZERO, lastUsedAt: null }]);
    await expect(query({ groupBy: ['harness'] })).resolves.toEqual([]);
  });
});
