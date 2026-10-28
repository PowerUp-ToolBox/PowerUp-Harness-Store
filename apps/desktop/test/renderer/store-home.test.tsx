// @vitest-environment jsdom
/**
 * Ticket P0-09.1: the Store home with a mocked `store.home`: skeletons while the first call is in
 * flight, then Featured, New and Most downloaded as labelled rows of the shared Store card; empty
 * rows hidden; an inline error with Retry; and the offline panel when the Store is unreachable,
 * with the rest of the app still usable. In en and zh-CN.
 */
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { IpcError, IpcResult, StoreHome, StoreListing } from '../../src/shared/ipc.js';
import { connectivityResult, installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
});

function listing(harnessId: string, fields: Partial<StoreListing> = {}): StoreListing {
  return {
    harnessId,
    publisher: harnessId.split('/')[0] ?? '',
    name: harnessId.split('/')[1] ?? harnessId,
    summary: `What ${harnessId} does.`,
    iconUrl: `store-asset://harness-assets/${harnessId}/1.0.0/icon.png`,
    tags: ['coding'],
    downloadCount: 10,
    latestVersion: '1.0.0',
    latestPublishedAt: '2026-10-20T09:00:00.000000+00:00',
    platforms: ['darwin-arm64', 'linux-x64'],
    ...fields,
  };
}

const WRITER = listing('alice/writer', {
  name: 'Writer',
  summary: 'Drafts and edits long texts.',
  tags: ['writing', 'research'],
  downloadCount: 1260,
});
const LINUX_ONLY = listing('bob/linux-tool', {
  name: 'Linux Tool',
  iconUrl: null,
  platforms: ['linux-x64'],
});
const FRESH = listing('carol/fresh', { name: 'Fresh', downloadCount: 1 });

const HOME: StoreHome = {
  platform: 'darwin-arm64',
  featured: [LINUX_ONLY, WRITER],
  mostDownloaded: [WRITER, LINUX_ONLY],
  newest: [FRESH, WRITER],
};

function storeError(code: 'store_error' | 'store_unreachable'): IpcResult<StoreHome> {
  const error: IpcError = {
    code,
    messageKey: `error.${code}`,
    message: code === 'store_error' ? 'Unexpected answer.' : 'The Store did not answer.',
  };
  return { ok: false, error };
}

/** A fake Runtime whose `store.home` answers only when the test says so. */
function installPendingHome(locale: 'en' | 'zh-CN' = 'en') {
  const api = installFakeApi(locale);
  let answer: (result: IpcResult<StoreHome>) => void = () => undefined;
  api.store.home.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  return {
    api,
    answer: async (result: IpcResult<StoreHome>) => {
      await act(async () => {
        answer(result);
        await Promise.resolve();
      });
    },
  };
}

function section(name: string) {
  return screen.getByRole('region', { name });
}

function cardNames(name: string) {
  return within(section(name))
    .getAllByRole('article')
    .map((card) => card.getAttribute('aria-label'));
}

describe('Store home', () => {
  it('shows skeletons while store.home is in flight, then Featured, New and Most downloaded', async () => {
    const { api, answer } = installPendingHome();
    await renderApp('#/store');

    const loading = screen.getByRole('status', { name: 'Loading the Store' });
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(within(loading).getByRole('heading', { name: 'Featured' })).toBeDefined();
    expect(within(loading).getByRole('heading', { name: 'New' })).toBeDefined();
    expect(within(loading).getByRole('heading', { name: 'Most downloaded' })).toBeDefined();
    expect(loading.querySelectorAll('.skeleton-card').length).toBeGreaterThan(0);
    expect(api.store.home).toHaveBeenCalledWith({});

    await answer({ ok: true, data: HOME });
    expect(screen.queryByRole('status', { name: 'Loading the Store' })).toBeNull();
    // Each row in the Store's order.
    expect(cardNames('Featured')).toEqual(['Linux Tool', 'Writer']);
    expect(cardNames('New')).toEqual(['Fresh', 'Writer']);
    expect(cardNames('Most downloaded')).toEqual(['Writer', 'Linux Tool']);
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['Featured', 'New', 'Most downloaded']);
  });

  it('shows on each card its icon, name, Publisher, summary, tags, downloads and platform badges', async () => {
    const { answer } = installPendingHome();
    await renderApp('#/store');
    await answer({ ok: true, data: HOME });

    const [linuxOnly, writer] = within(section('Featured')).getAllByRole('article');
    if (writer === undefined || linuxOnly === undefined) throw new Error('Missing cards');
    const card = within(writer);
    expect(writer.querySelector('img.harness-icon')?.getAttribute('src')).toBe(
      'store-asset://harness-assets/alice/writer/1.0.0/icon.png',
    );
    expect(card.getByRole('link', { name: 'Writer' }).getAttribute('href')).toBe(
      '#/store/h/alice/writer',
    );
    expect(card.getByRole('link', { name: 'alice' }).getAttribute('href')).toBe('#/store/p/alice');
    expect(card.getByText('Drafts and edits long texts.')).toBeDefined();
    expect(writer.querySelector('.listing-card-meta')?.textContent).toBe('alice · 1,260 downloads');
    const tags = card.getByRole('list', { name: 'Tags' });
    expect(
      within(tags)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Writing', 'Research']);
    // This machine (darwin-arm64) is highlighted among the declared platforms.
    const badges = within(card.getByRole('list', { name: 'Platforms' })).getAllByRole('listitem');
    expect(badges.map((badge) => [badge.textContent, badge.className])).toEqual([
      ['darwin-arm64 (this computer)', 'current'],
      ['linux-x64', ''],
    ]);

    // No icon: the monogram. Not declared for this machine: a greyed badge says so.
    expect(linuxOnly.querySelector('.harness-icon.monogram')?.textContent).toBe('L');
    const linuxBadges = within(
      within(linuxOnly).getByRole('list', { name: 'Platforms' }),
    ).getAllByRole('listitem');
    expect(linuxBadges.map((badge) => [badge.textContent, badge.className])).toEqual([
      ['linux-x64', ''],
      ['darwin-arm64 (not supported)', 'unsupported'],
    ]);
  });

  it('opens the detail page from a card’s name', async () => {
    const { api, answer } = installPendingHome();
    await renderApp('#/store');
    await answer({ ok: true, data: HOME });

    const writer = within(section('Featured')).getAllByRole('article')[1];
    if (writer === undefined) throw new Error('Missing card');
    await act(async () => {
      fireEvent.click(within(writer).getByRole('link', { name: 'Writer' }));
      await Promise.resolve();
    });
    expect(window.location.hash).toBe('#/store/h/alice/writer');
    expect(api.store.detail).toHaveBeenCalledWith('alice/writer');
  });

  it('opens the Publisher page from a card’s login', async () => {
    const { answer } = installPendingHome();
    await renderApp('#/store');
    await answer({ ok: true, data: HOME });

    const writer = within(section('Featured')).getAllByRole('article')[1];
    if (writer === undefined) throw new Error('Missing card');
    await act(async () => {
      fireEvent.click(within(writer).getByRole('link', { name: 'alice' }));
      await Promise.resolve();
    });
    expect(window.location.hash).toBe('#/store/p/alice');
    expect(screen.getByText('Harnesses by the Publisher alice appear here.')).toBeDefined();
  });

  it('hides an empty row', async () => {
    const { answer } = installPendingHome();
    await renderApp('#/store');
    await answer({ ok: true, data: { ...HOME, featured: [] } });
    expect(screen.queryByRole('region', { name: 'Featured' })).toBeNull();
    expect(cardNames('New')).toEqual(['Fresh', 'Writer']);
  });

  it('says so when the Store has no Harness at all', async () => {
    installFakeApi();
    await renderApp('#/store');
    expect(screen.getByText('There are no Harnesses in the Store yet.')).toBeDefined();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('reads store.home again when the User comes back to the Store tab', async () => {
    const api = installFakeApi();
    await renderApp('#/store');
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: 'Library' }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: 'Store' }));
      await Promise.resolve();
    });
    // The Runtime answers from its 5-minute cache; the renderer only asks.
    expect(api.store.home.mock.calls).toEqual([[{}], [{}]]);
  });

  it('shows a server error inline with Retry, which reads the Store again', async () => {
    const { api, answer } = installPendingHome();
    await renderApp('#/store');
    await answer(storeError('store_error'));

    const error = screen.getByRole('region', { name: "Couldn't load the Store" });
    expect(within(error).getByRole('alert').textContent).toBe(
      'The Store answered with something unexpected. Try again in a moment.',
    );
    await act(async () => {
      fireEvent.click(within(error).getByRole('button', { name: 'Retry' }));
      await Promise.resolve();
    });
    expect(api.store.home).toHaveBeenLastCalledWith({ refresh: true });
    expect(screen.getByRole('status', { name: 'Loading the Store' })).toBeDefined();
    await answer({ ok: true, data: HOME });
    expect(cardNames('Featured')).toEqual(['Linux Tool', 'Writer']);
  });

  it('gives way to the offline panel with Retry when the Store is unreachable; the rest of the app works', async () => {
    const { api, answer } = installPendingHome();
    await renderApp('#/store');
    // The Runtime answers store_unreachable and its connectivity check finds the Store offline.
    await answer(storeError('store_unreachable'));
    act(() => {
      api.emit('connectivity.changed', { state: 'offline' });
    });

    const panel = screen.getByRole('region', { name: "Can't reach the Store" });
    expect(within(panel).getByRole('button', { name: 'Retry' })).toBeDefined();
    expect(screen.getByText("You're offline. Library and Models still work.")).toBeDefined();
    expect(screen.queryByRole('region', { name: "Couldn't load the Store" })).toBeNull();

    // Retry: the Store answers again, and the Store home loads afresh.
    api.connectivity.check.mockResolvedValue(connectivityResult('online'));
    api.store.home.mockResolvedValue({ ok: true, data: HOME });
    await act(async () => {
      fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
      await Promise.resolve();
    });
    expect(cardNames('Featured')).toEqual(['Linux Tool', 'Writer']);

    // The Library never waits for the Store.
    act(() => {
      api.emit('connectivity.changed', { state: 'offline' });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('link', { name: 'Library' }));
      await Promise.resolve();
    });
    expect(screen.getByText('Nothing installed yet')).toBeDefined();
  });
});

describe('Store home in zh-CN', () => {
  it('labels the rows, tags, badges and errors in Chinese', async () => {
    const { answer } = installPendingHome('zh-CN');
    await renderApp('#/store');
    expect(screen.getByRole('status', { name: '正在加载商店' })).toBeDefined();
    await answer({ ok: true, data: HOME });

    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['精选', '最新', '下载最多']);
    const writer = within(section('精选')).getAllByRole('article')[1];
    if (writer === undefined) throw new Error('Missing card');
    const tags = within(writer).getByRole('list', { name: '标签' });
    expect(
      within(tags)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['写作', '研究']);
    expect(writer.querySelector('.platform-badges .current')?.textContent).toBe(
      'darwin-arm64（当前平台）',
    );
  });

  it('shows the inline error in Chinese', async () => {
    const { answer } = installPendingHome('zh-CN');
    await renderApp('#/store');
    await answer(storeError('store_error'));
    const error = screen.getByRole('region', { name: '无法加载商店' });
    expect(within(error).getByRole('button', { name: '重试' })).toBeDefined();
  });
});
