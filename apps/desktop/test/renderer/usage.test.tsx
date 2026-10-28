// @vitest-environment jsdom
/**
 * Ticket P0-11.1: the Usage page over the fake `window.api`, in en and zh-CN: the period selector
 * (7 days by default, from a local midnight), the totals, the table by Harness then model, the
 * daily breakdown, the dash for a Provider that did not report usage, the filters, the live
 * refresh on `usage.recorded` (throttled to once every 2 seconds, only while the window is
 * visible), Export CSV and Clear usage data. Every number comes from `usage.query` as main summed
 * it; test/usage/usage-seam.test.ts covers the sums.
 */
import type { Manifest } from '@harness-store/manifest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledHarness, UsageQuery, UsageRow } from '../../src/shared/ipc.js';
import { periodStart } from '../../src/renderer/src/usage/period.js';
import { connectionSummary, installFakeApi, NO_USAGE, renderApp } from './render-app.js';

afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible');
  cleanup();
});

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

async function settle() {
  await act(async () => {
    for (let step = 0; step < 8; step += 1) await Promise.resolve();
  });
}

function row(fields: Partial<UsageRow>): UsageRow {
  return { ...NO_USAGE, lastUsedAt: '2026-10-28T13:42:00.000Z', ...fields };
}

/** What `usage.query` answers for each grouping. */
interface Answers {
  readonly total: UsageRow;
  readonly harness: readonly UsageRow[];
  /** The all-time, unfiltered `['harness']` query's (the Harness filter's options); default `harness`. */
  readonly harnessOptions?: readonly UsageRow[];
  readonly model: readonly UsageRow[];
  readonly day: readonly UsageRow[];
  readonly provider: readonly UsageRow[];
}

/**
 * Two Harnesses: Code Reviewer (installed), with three requests on a local model of which one did
 * not report usage and one failed request on Anthropic; and `gone/old` (uninstalled), whose three
 * requests went to a custom endpoint that never reports usage.
 */
const ANSWERS: Answers = {
  total: row({ requests: 7, errors: 1, promptTokens: 40, completionTokens: 60, unknownCount: 4 }),
  harness: [
    row({
      harnessId: 'acme/reviewer',
      requests: 4,
      errors: 1,
      promptTokens: 40,
      completionTokens: 60,
      unknownCount: 1,
    }),
    row({
      harnessId: 'gone/old',
      requests: 3,
      unknownCount: 3,
      lastUsedAt: '2026-10-20T08:00:00.000Z',
    }),
  ],
  model: [
    row({
      harnessId: 'acme/reviewer',
      provider: 'ollama',
      model: 'qwen3:8b',
      requests: 3,
      promptTokens: 40,
      completionTokens: 60,
      unknownCount: 1,
    }),
    row({
      harnessId: 'acme/reviewer',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      requests: 1,
      errors: 1,
    }),
    row({
      harnessId: 'gone/old',
      provider: 'openai-compatible:vllm',
      model: 'llama-70b',
      requests: 3,
      unknownCount: 3,
      lastUsedAt: '2026-10-20T08:00:00.000Z',
    }),
  ],
  day: [
    row({ day: '2026-10-28', requests: 4, errors: 1, promptTokens: 40, completionTokens: 60 }),
    row({ day: '2026-10-20', requests: 3, unknownCount: 3 }),
  ],
  provider: [
    row({ provider: 'ollama' }),
    row({ provider: 'anthropic' }),
    row({ provider: 'openai-compatible:vllm' }),
  ],
};

const MANIFEST: Manifest = {
  manifestVersion: 1,
  id: 'acme/reviewer',
  version: '1.0.0',
  name: 'Code Reviewer',
  summary: 'Reviews code.',
  license: 'MIT',
  platforms: ['darwin-arm64'],
  runtime: { kind: 'node', node: '22' },
  entry: 'index.mjs',
  ui: { kind: 'terminal' },
  models: { slots: { default: {} } },
  permissions: { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } },
};

const REVIEWER: InstalledHarness = {
  harnessId: 'acme/reviewer',
  version: '1.0.0',
  name: 'Code Reviewer',
  publisher: 'acme',
  source: 'store',
  manifest: MANIFEST,
  installPath: '/profile/harnesses/acme/reviewer/1.0.0',
  installedAt: '2026-10-01T00:00:00.000Z',
  lastLaunchedAt: null,
  iconDataUrl: null,
  platformSupported: true,
  storeStatus: 'available',
  availableUpdate: null,
};

function answer(answers: Answers) {
  return (query: UsageQuery) => {
    const allTime =
      query.from === null &&
      query.to === null &&
      query.harnessId === undefined &&
      query.providerId === undefined;
    const rows: Record<string, readonly UsageRow[]> = {
      '': [answers.total],
      harness: allTime ? (answers.harnessOptions ?? answers.harness) : answers.harness,
      'harness,model': answers.model,
      day: answers.day,
      provider: answers.provider,
    };
    return Promise.resolve({ ok: true as const, data: rows[query.groupBy.join()] ?? [] });
  };
}

async function openUsage(locale: 'en' | 'zh-CN' = 'en', answers: Answers = ANSWERS) {
  const api = installFakeApi(locale);
  api.usage.query.mockImplementation(answer(answers));
  api.installs.list.mockResolvedValue({ ok: true, data: [REVIEWER] });
  api.connections.list.mockResolvedValue({
    ok: true,
    data: [
      connectionSummary({ id: 'ollama' }),
      connectionSummary({ id: 'openai-compatible:vllm', displayName: 'My vLLM' }),
    ],
  });
  await renderApp('#/usage');
  await settle();
  return api;
}

/** The totals, as "label value" pairs. */
function totals(): string[] {
  const list = document.querySelector('dl.usage-totals');
  if (list === null) throw new Error('No totals');
  return [...list.querySelectorAll('div')].map((tile) => {
    const label = tile.querySelector('dt')?.textContent ?? '';
    const value = tile.querySelector('dd');
    const unknown = value?.querySelector('[role="img"]') === null ? '' : ' [unknown]';
    return `${label} ${(value?.textContent ?? '').replace('—', '').trim()}${unknown}`.trim();
  });
}

/** A table's body rows, as their cells' text, a "did not report" mark shown as `[unknown]`. */
function tableRows(name: string): string[][] {
  const table = screen.getByRole('table', { name });
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((tr) =>
      [...tr.querySelectorAll('th, td')].map((cell) => {
        const mark = cell.querySelector('[role="img"]');
        const text = cell.textContent.replace('—', '').trim();
        if (mark === null) return text;
        return text === '' ? '[unknown]' : `${text} [unknown]`;
      }),
    );
}

/** The queries of the last load, one per grouping, by grouping. */
function lastLoad(api: ReturnType<typeof installFakeApi>): Record<string, UsageQuery[]> {
  const calls = api.usage.query.mock.calls.slice(-6).map(([query]) => query);
  const byGroup: Record<string, UsageQuery[]> = {};
  for (const query of calls) (byGroup[query.groupBy.join()] ??= []).push(query);
  return byGroup;
}

describe('Usage page', () => {
  it('shows 7 days by default: totals, the table by Harness then model, the daily breakdown', async () => {
    const before = new Date();
    const api = await openUsage();

    expect(screen.getByRole('heading', { level: 1, name: 'Usage' })).not.toBeNull();
    expect(
      screen.getByText(
        'Counted by the Model Gateway on this machine. Usage Records never leave it.',
      ),
    ).not.toBeNull();
    const period = screen.getByRole('group', { name: 'Period' });
    expect(
      within(period)
        .getAllByRole('button')
        .map((button) => `${button.textContent} ${String(button.getAttribute('aria-pressed'))}`),
    ).toEqual(['Today false', '7 days true', '30 days false', 'All false']);

    // Six queries, all summed in main: the period's from today's local midnight, 6 days back.
    const load = lastLoad(api);
    expect(Object.keys(load).sort()).toEqual(['', 'day', 'harness', 'harness,model', 'provider']);
    expect([periodStart('7d', before), periodStart('7d', new Date())]).toContain(
      load['']?.[0]?.from,
    );
    expect(load['']?.[0]).toMatchObject({ to: null, groupBy: [] });
    expect(load['']?.[0]).not.toHaveProperty('harnessId');
    // The filter options are of all time, unfiltered.
    expect(load.provider).toEqual([{ from: null, to: null, groupBy: ['provider'] }]);
    expect(load.harness).toContainEqual({ from: null, to: null, groupBy: ['harness'] });

    expect(totals()).toEqual([
      'Requests 7',
      'Errors 1',
      'Prompt tokens 40 [unknown]',
      'Completion tokens 60 [unknown]',
    ]);
    expect(tableRows('Usage by Harness and model')).toEqual([
      ['Code Reviewer', '4', '1', '40 [unknown]', '60 [unknown]', expect.any(String)],
      ['qwen3:8b via Ollama', '3', '0', '40 [unknown]', '60 [unknown]', expect.any(String)],
      ['claude-sonnet-4-5 via Anthropic', '1', '1', '0', '0', expect.any(String)],
      ['gone/old', '3', '0', '[unknown]', '[unknown]', expect.any(String)],
      ['llama-70b via My vLLM', '3', '0', '[unknown]', '[unknown]', expect.any(String)],
    ]);
    const lastUsed = tableRows('Usage by Harness and model')[0]?.[5];
    expect(lastUsed).toMatch(/2026/);
    expect(tableRows('Daily breakdown')).toEqual([
      ['Oct 28, 2026', '4', '1', '40', '60'],
      ['Oct 20, 2026', '3', '0', '[unknown]', '[unknown]'],
    ]);
    // The mark says why, as a tooltip and to a screen reader.
    const marks = screen.getAllByRole('img', { name: 'This Provider did not report usage' });
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0]?.getAttribute('title')).toBe('This Provider did not report usage');
    expect(screen.getByRole('button', { name: 'Export CSV' })).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Clear usage data' })).not.toBeNull();
  });

  it('a Harness and a Provider filter narrow every query but the filter options', async () => {
    const api = await openUsage();
    const harnesses = screen.getByRole('combobox', { name: 'Harness' });
    expect(
      within(harnesses)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All Harnesses', 'Code Reviewer', 'gone/old']);
    const providers = screen.getByRole('combobox', { name: 'Provider' });
    expect(
      within(providers)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All Providers', 'Ollama', 'Anthropic', 'My vLLM']);

    act(() => {
      fireEvent.change(harnesses, { target: { value: 'gone/old' } });
    });
    await settle();
    act(() => {
      fireEvent.change(providers, { target: { value: 'openai-compatible:vllm' } });
    });
    await settle();

    const load = lastLoad(api);
    for (const groupBy of ['', 'harness,model', 'day']) {
      expect(load[groupBy]?.[0]).toMatchObject({
        harnessId: 'gone/old',
        providerId: 'openai-compatible:vllm',
      });
    }
    expect(load.harness?.filter((query) => query.harnessId === 'gone/old')).toHaveLength(1);
    expect(
      load.harness?.filter((query) => query.from === null && !('harnessId' in query)),
    ).toHaveLength(1);
    expect(load.provider).toEqual([{ from: null, to: null, groupBy: ['provider'] }]);
  });

  it('Today and All change the period start; a period without records shows zeros', async () => {
    const api = await openUsage();
    api.usage.query.mockImplementation(
      answer({
        total: NO_USAGE,
        harness: [],
        harnessOptions: ANSWERS.harness,
        model: [],
        day: [],
        provider: ANSWERS.provider,
      }),
    );
    const before = new Date();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    });
    await settle();
    expect([periodStart('today', before), periodStart('today', new Date())]).toContain(
      lastLoad(api)['']?.[0]?.from,
    );
    expect(screen.getByRole('button', { name: 'Today' }).getAttribute('aria-pressed')).toBe('true');
    expect(totals()).toEqual(['Requests 0', 'Errors 0', 'Prompt tokens 0', 'Completion tokens 0']);
    expect(tableRows('Usage by Harness and model')).toEqual([]);
    expect(tableRows('Daily breakdown')).toEqual([]);
    // The filters still offer every Harness and Provider that has records.
    expect(
      within(screen.getByRole('combobox', { name: 'Harness' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All Harnesses', 'Code Reviewer', 'gone/old']);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'All' }));
    });
    await settle();
    expect(lastLoad(api)['']?.[0]).toEqual({ from: null, to: null, groupBy: [] });
  });

  it('queries again at once on usage.recorded, then at most once every 2 seconds', async () => {
    const api = await openUsage();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const loads = () => api.usage.query.mock.calls.length / 6;
    const start = loads();
    api.usage.query.mockImplementation(
      answer({ ...ANSWERS, total: { ...ANSWERS.total, requests: 8 } }),
    );

    act(() => {
      api.emit('usage.recorded', { harnessId: 'acme/reviewer' });
    });
    await settle();
    expect(loads()).toBe(start + 1);
    expect(totals()[0]).toBe('Requests 8');

    // More records during the wait: one more query at its end, not one each.
    act(() => {
      api.emit('usage.recorded', { harnessId: 'acme/reviewer' });
      api.emit('usage.recorded', { harnessId: 'acme/reviewer' });
    });
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(loads()).toBe(start + 1);
    api.usage.query.mockImplementation(
      answer({ ...ANSWERS, total: { ...ANSWERS.total, requests: 10 } }),
    );
    act(() => {
      vi.advanceTimersByTime(1);
    });
    await settle();
    expect(loads()).toBe(start + 2);
    expect(totals()[0]).toBe('Requests 10');

    // Nothing more came: no query.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(loads()).toBe(start + 2);
  });

  it('while the window is hidden it does not query; it queries once when it shows again', async () => {
    const api = await openUsage();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const loads = () => api.usage.query.mock.calls.length / 6;
    const start = loads();

    setVisibility('hidden');
    act(() => {
      api.emit('usage.recorded', { harnessId: 'acme/reviewer' });
      api.emit('usage.recorded', { harnessId: 'acme/reviewer' });
      vi.advanceTimersByTime(5000);
    });
    expect(loads()).toBe(start);

    setVisibility('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    expect(loads()).toBe(start + 1);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(5000);
    });
    expect(loads()).toBe(start + 1);
  });

  it('stops listening once the page closes', async () => {
    const api = await openUsage();
    await act(async () => {
      window.location.hash = '#/settings';
      await Promise.resolve();
    });
    await settle();
    const calls = api.usage.query.mock.calls.length;
    act(() => {
      api.emit('usage.recorded', { harnessId: 'acme/reviewer' });
    });
    await settle();
    expect(api.usage.query.mock.calls.length).toBe(calls);
  });

  it('Export CSV exports the period and filters on view, and names the file saved', async () => {
    const api = await openUsage();
    api.usage.export.mockResolvedValue({ ok: true, data: { path: '/Users/me/usage.csv' } });
    act(() => {
      fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), {
        target: { value: 'ollama' },
      });
    });
    await settle();
    const viewed = lastLoad(api)['']?.[0];

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
      await Promise.resolve();
    });
    await settle();
    expect(api.usage.export).toHaveBeenCalledOnce();
    const [filter] = api.usage.export.mock.calls[0] ?? [];
    expect(filter).toEqual({ from: viewed?.from, to: null, providerId: 'ollama' });
    expect(screen.getByText('Saved usage.csv')).not.toBeNull();
  });

  it('an export that fails stays shown through live refreshes until the next export', async () => {
    const api = await openUsage();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    api.usage.export.mockResolvedValue({
      ok: false,
      error: {
        code: 'internal_error',
        messageKey: 'error.internal_error',
        message: 'Internal error.',
      },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
      await Promise.resolve();
    });
    await settle();
    const failure =
      'Something went wrong inside Harness Store. Try again, and restart the app if it keeps happening.';
    expect(screen.getByRole('alert').textContent).toBe(failure);

    // A Harness keeps writing records: the page loads again, successfully, and the failure stays.
    const calls = api.usage.query.mock.calls.length;
    act(() => {
      api.emit('usage.recorded', { harnessId: 'acme/reviewer' });
    });
    await settle();
    act(() => {
      api.emit('usage.recorded', { harnessId: 'acme/reviewer' });
      vi.advanceTimersByTime(2000);
    });
    await settle();
    expect(api.usage.query.mock.calls.length).toBe(calls + 12);
    expect(screen.getByRole('alert').textContent).toBe(failure);

    // The next export that succeeds clears it.
    api.usage.export.mockResolvedValue({ ok: true, data: { path: '/Users/me/usage.csv' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
      await Promise.resolve();
    });
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Saved usage.csv')).not.toBeNull();
  });

  it('Clear usage data asks first; once confirmed the page shows its empty state', async () => {
    const api = await openUsage();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear usage data' }));
    });
    const dialog = screen.getByRole('dialog', { name: 'Clear usage data?' });
    expect(
      within(dialog).getByText('This deletes every Usage Record on this machine.'),
    ).not.toBeNull();
    act(() => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.usage.clear).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear usage data' }));
    });
    api.usage.query.mockImplementation(
      answer({ total: NO_USAGE, harness: [], model: [], day: [], provider: [] }),
    );
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear usage data' }),
      );
      await Promise.resolve();
    });
    await settle();
    expect(api.usage.clear).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Usage data cleared')).not.toBeNull();
    expect(screen.getByText('Launch a Harness to see usage here')).not.toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('with no Usage Record at all it says to launch a Harness', async () => {
    const api = installFakeApi('en');
    await renderApp('#/usage');
    await settle();
    expect(api.usage.query).toHaveBeenCalled();
    expect(screen.getByText('Launch a Harness to see usage here')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
  });

  it('shows no cost anywhere', async () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      await openUsage(locale);
      expect(document.body.textContent).not.toMatch(/[$¥€£]|USD|cost|price|费用|成本|价格|美元/i);
      cleanup();
    }
  });
});

describe('Usage page in zh-CN', () => {
  it('shows its copy in Simplified Chinese', async () => {
    await openUsage('zh-CN');
    expect(screen.getByRole('heading', { level: 1, name: '用量' })).not.toBeNull();
    expect(screen.getByText('由本机的 Model Gateway 统计，用量记录不会离开本机。')).not.toBeNull();
    expect(
      within(screen.getByRole('group', { name: '时间范围' }))
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['今天', '7 天', '30 天', '全部']);
    expect(totals()).toEqual([
      '请求数 7',
      '失败 1',
      '输入 token 40 [unknown]',
      '输出 token 60 [unknown]',
    ]);
    const table = screen.getByRole('table', { name: '按 Harness 和模型统计的用量' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Harness / 模型', '请求数', '失败', '输入 token', '输出 token', '最近使用']);
    expect(tableRows('按 Harness 和模型统计的用量')[1]?.[0]).toBe('qwen3:8b 通过 Ollama');
    expect(
      screen.getAllByRole('img', { name: '该 Provider 未返回用量信息' }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: '每日明细' })).not.toBeNull();
    expect(
      within(screen.getByRole('combobox', { name: 'Harness' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['全部 Harness', 'Code Reviewer', 'gone/old']);
    expect(screen.getByRole('button', { name: '导出 CSV' })).not.toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '清除用量数据' }));
    });
    const dialog = screen.getByRole('dialog', { name: '清除用量数据？' });
    expect(within(dialog).getByText('这会删除本机上的所有用量记录。')).not.toBeNull();
    expect(within(dialog).getByRole('button', { name: '取消' })).not.toBeNull();
  });

  it('says to launch a Harness when there is no usage', async () => {
    installFakeApi('zh-CN');
    await renderApp('#/usage');
    await settle();
    expect(screen.getByText('启动一个 Harness 后，这里会显示用量')).not.toBeNull();
  });
});
