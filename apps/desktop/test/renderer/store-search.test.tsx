// @vitest-environment jsdom
/**
 * Ticket P0-09.2: the Store's filter row and search results with a mocked `store.search` that
 * answers like the Store over a small catalogue: text in the name, every tag, this machine's
 * platform (darwin-arm64) unless every platform is asked for, most downloaded first, 24 a page.
 * Typed text is searched once, 300 ms after the last keystroke; Enter, a tag and the toggle at
 * once. A change of the Store URL in Settings drops the old Store's results. In en and zh-CN.
 */
import type { Tag } from '@harness-store/manifest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  IpcResult,
  StoreHome,
  StoreListing,
  StoreSearchPage,
  StoreSearchRequest,
} from '../../src/shared/ipc.js';
import { installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function listing(harnessId: string, fields: Partial<StoreListing> = {}): StoreListing {
  return {
    harnessId,
    publisher: harnessId.split('/')[0] ?? '',
    name: harnessId.split('/')[1] ?? harnessId,
    summary: `What ${harnessId} does.`,
    iconUrl: null,
    tags: ['coding'],
    downloadCount: 10,
    latestVersion: '1.0.0',
    latestPublishedAt: '2026-10-20T09:00:00.000000+00:00',
    platforms: ['darwin-arm64', 'linux-x64'],
    ...fields,
  };
}

const WRITER = listing('alice/writer', {
  name: 'Note Writer',
  tags: ['writing', 'research'],
  downloadCount: 1260,
});
const NOTES = listing('bob/notes', { name: 'Notes', tags: ['writing'], downloadCount: 300 });
/** Not built for this machine (darwin-arm64), and the most downloaded of the notes. */
const LINUX_NOTES = listing('carol/linux-notes', {
  name: 'Linux Notes',
  tags: ['writing'],
  platforms: ['linux-x64'],
  downloadCount: 5000,
});
const XIEZUO = listing('dave/xiezuo', { name: '写作助手', tags: ['writing'], downloadCount: 42 });

const CATALOGUE = [WRITER, NOTES, LINUX_NOTES, XIEZUO];

const HOME: StoreHome = {
  platform: 'darwin-arm64',
  featured: [WRITER],
  mostDownloaded: [WRITER, NOTES],
  newest: [XIEZUO],
};

/** `store.search` as the Store answers it over `catalogue`. */
function storeSearch(catalogue: readonly StoreListing[]) {
  return (request: StoreSearchRequest): Promise<IpcResult<StoreSearchPage>> => {
    const q = request.q.trim().toLowerCase();
    const found = catalogue
      .filter((item) => q === '' || item.name.toLowerCase().includes(q))
      .filter((item) => request.tags.every((tag) => item.tags.includes(tag)))
      .filter((item) => request.allPlatforms || item.platforms.includes('darwin-arm64'))
      .sort((a, b) => b.downloadCount - a.downloadCount);
    const page = found.slice(request.offset, request.offset + 24);
    return Promise.resolve({
      ok: true,
      data: { platform: 'darwin-arm64', listings: page, hasMore: page.length === 24 },
    });
  };
}

async function renderStore(locale: 'en' | 'zh-CN' = 'en', catalogue = CATALOGUE) {
  const api = installFakeApi(locale);
  api.store.home.mockResolvedValue({ ok: true, data: HOME });
  api.store.search.mockImplementation(storeSearch(catalogue));
  await renderApp('#/store');
  return api;
}

/** Lets the answers already given reach the screen. */
async function settle() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

function searchBox(name = 'Search Harnesses'): HTMLInputElement {
  return screen.getByRole('searchbox', { name });
}

function typeText(text: string, name?: string) {
  act(() => {
    fireEvent.change(searchBox(name), { target: { value: text } });
  });
}

/** Types `text` and presses Enter. */
async function searchFor(text: string, name?: string) {
  typeText(text, name);
  await act(async () => {
    fireEvent.submit(screen.getByRole('search'));
    await Promise.resolve();
  });
  await settle();
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
  await settle();
}

function resultNames(name = 'Search results') {
  return within(screen.getByRole('list', { name }))
    .getAllByRole('article')
    .map((card) => card.getAttribute('aria-label'));
}

function homeShown() {
  return screen.queryByRole('region', { name: 'Featured' }) !== null;
}

const request = (fields: Partial<StoreSearchRequest>): StoreSearchRequest => ({
  q: '',
  tags: [],
  allPlatforms: false,
  offset: 0,
  ...fields,
});

describe('Store search', () => {
  it('searches typed text once, 300 ms after the last keystroke, replacing the home sections', async () => {
    const api = await renderStore();
    expect(homeShown()).toBe(true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    for (const text of ['n', 'no', 'not', 'note']) {
      typeText(text);
      act(() => {
        vi.advanceTimersByTime(200);
      });
    }
    expect(api.store.search).not.toHaveBeenCalled();
    expect(homeShown()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(99);
    });
    expect(api.store.search).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(api.store.search.mock.calls).toEqual([[request({ q: 'note' })]]);
    await settle();

    expect(homeShown()).toBe(false);
    expect(resultNames()).toEqual(['Note Writer', 'Notes']);
  });

  // Chromium sends the committed text's change before compositionend, WebKit after it.
  it.each(['before', 'after'] as const)(
    'searches text an input method composes only once it is committed (last change %s compositionend)',
    async (order) => {
      const api = await renderStore('zh-CN');
      const box = searchBox('搜索 Harness');
      expect(box.maxLength).toBe(200);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      act(() => {
        fireEvent.compositionStart(box);
      });
      for (const text of ['x', 'xie', 'xie z', 'xie zuo']) {
        typeText(text, '搜索 Harness');
        act(() => {
          vi.advanceTimersByTime(1000);
        });
      }
      // The pinyin is never searched, and the home sections stay.
      expect(api.store.search).not.toHaveBeenCalled();
      expect(box.value).toBe('xie zuo');
      expect(screen.queryByRole('region', { name: '精选' })).not.toBeNull();

      act(() => {
        if (order === 'before') fireEvent.change(box, { target: { value: '写作' } });
        fireEvent.compositionEnd(box);
        if (order === 'after') fireEvent.change(box, { target: { value: '写作' } });
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(api.store.search.mock.calls).toEqual([[request({ q: '写作' })]]);
      await settle();
      expect(resultNames('搜索结果')).toEqual(['写作助手']);
    },
  );

  it('drops a search still waiting for the pause once an input method starts composing', async () => {
    const api = await renderStore();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeText('notes');
    act(() => {
      fireEvent.compositionStart(searchBox());
    });
    typeText('notes x');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(api.store.search).not.toHaveBeenCalled();
  });

  it('searches at once on Enter, without waiting for the pause', async () => {
    const api = await renderStore();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typeText('notes');
    act(() => {
      fireEvent.submit(screen.getByRole('search'));
    });
    expect(api.store.search.mock.calls).toEqual([[request({ q: 'notes' })]]);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // The pending search was the same one: it is not made again.
    expect(api.store.search).toHaveBeenCalledOnce();
    await settle();
    expect(resultNames()).toEqual(['Notes']);
  });

  it('narrows to Harnesses that have every selected tag, together with the text', async () => {
    const api = await renderStore();
    const tags = screen.getByRole('list', { name: 'Filter by tag' });
    // The ten curated tags, in the Manifest schema's order.
    expect(
      within(tags)
        .getAllByRole('button')
        .map((chip) => chip.textContent),
    ).toEqual([
      'Coding',
      'Writing',
      'Research',
      'Data',
      'Productivity',
      'DevOps',
      'Design',
      'Education',
      'Fun',
      'Other',
    ]);

    const writing = within(tags).getByRole('button', { name: 'Writing' });
    await click(writing);
    expect(writing.getAttribute('aria-pressed')).toBe('true');
    expect(api.store.search).toHaveBeenLastCalledWith(request({ tags: ['writing'] }));
    expect(resultNames()).toEqual(['Note Writer', 'Notes', '写作助手']);

    await click(within(tags).getByRole('button', { name: 'Research' }));
    expect(api.store.search).toHaveBeenLastCalledWith(
      request({ tags: ['writing', 'research'] satisfies Tag[] }),
    );
    expect(resultNames()).toEqual(['Note Writer']);

    await searchFor('zzz');
    expect(api.store.search).toHaveBeenLastCalledWith(
      request({ q: 'zzz', tags: ['writing', 'research'] }),
    );
  });

  it('shows only this machine’s Harnesses by default, and every platform’s with the toggle, the unsupported badge greyed', async () => {
    const api = await renderStore();
    const toggle = screen.getByRole('checkbox', { name: 'My platform only' });
    expect((toggle as HTMLInputElement).checked).toBe(true);

    await searchFor('notes');
    expect(resultNames()).toEqual(['Notes']);

    await click(toggle);
    expect(api.store.search).toHaveBeenLastCalledWith(request({ q: 'notes', allPlatforms: true }));
    expect(resultNames()).toEqual(['Linux Notes', 'Notes']);
    const linux = within(screen.getByRole('list', { name: 'Search results' })).getByRole(
      'article',
      { name: 'Linux Notes' },
    );
    const badges = within(within(linux).getByRole('list', { name: 'Platforms' })).getAllByRole(
      'listitem',
    );
    expect(badges.map((badge) => [badge.textContent, badge.className])).toEqual([
      ['linux-x64', ''],
      ['darwin-arm64 (not supported)', 'unsupported'],
    ]);
  });

  it('keeps the home sections when only the platform toggle changes', async () => {
    const api = await renderStore();
    await click(screen.getByRole('checkbox', { name: 'My platform only' }));
    expect(api.store.search).not.toHaveBeenCalled();
    expect(homeShown()).toBe(true);
  });

  it('returns to the home sections once the box is empty and no tag is selected', async () => {
    const api = await renderStore();
    await searchFor('notes');
    await click(screen.getByRole('button', { name: 'Writing' }));
    expect(homeShown()).toBe(false);

    await searchFor('');
    // A tag is still selected: its results.
    expect(api.store.search).toHaveBeenLastCalledWith(request({ tags: ['writing'] }));
    expect(homeShown()).toBe(false);

    const calls = api.store.search.mock.calls.length;
    await click(screen.getByRole('button', { name: 'Writing' }));
    expect(homeShown()).toBe(true);
    expect(screen.queryByRole('list', { name: 'Search results' })).toBeNull();
    expect(api.store.search).toHaveBeenCalledTimes(calls);

    // Blank text is no search either.
    await searchFor('   ');
    expect(homeShown()).toBe(true);
    expect(api.store.search).toHaveBeenCalledTimes(calls);

    // Emptying the box with no tag goes home at once, without waiting for the pause.
    await searchFor('notes');
    typeText('');
    await settle();
    expect(homeShown()).toBe(true);
    expect(api.store.search).toHaveBeenCalledTimes(calls + 1);
  });

  it('says when nothing matches, and Clear filters goes back to the home sections', async () => {
    await renderStore();
    await click(screen.getByRole('button', { name: 'Research' }));
    await searchFor('nothing like it');

    expect(screen.getByText('No Harnesses match')).toBeDefined();
    expect(screen.getByText('Try another word or clear the filters.')).toBeDefined();
    await click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(homeShown()).toBe(true);
    expect(searchBox().value).toBe('');
    expect(screen.getByRole('button', { name: 'Research' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  it('appends the next page on Load more, keeping the first page as it was', async () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      listing(`erin/tool-${String(index).padStart(2, '0')}`, {
        name: `Tool ${String(index).padStart(2, '0')}`,
        downloadCount: 1000 - index,
      }),
    );
    const api = await renderStore('en', many);
    await searchFor('tool');
    expect(resultNames()).toHaveLength(24);
    const list = screen.getByRole('list', { name: 'Search results' });
    const firstCard = within(list).getAllByRole('article')[0];

    await click(screen.getByRole('button', { name: 'Load more' }));
    expect(api.store.search).toHaveBeenLastCalledWith(request({ q: 'tool', offset: 24 }));
    expect(resultNames()).toEqual(many.map((item) => item.name));
    // The same list and cards, extended: nothing re-rendered from scratch, so nothing scrolls.
    expect(screen.getByRole('list', { name: 'Search results' })).toBe(list);
    expect(within(list).getAllByRole('article')[0]).toBe(firstCard);
    // A short page was the last one.
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('starts over once the Store URL changes: the old Store’s results are gone', async () => {
    const api = await renderStore();
    await searchFor('note');
    expect(resultNames()).toEqual(['Note Writer', 'Notes']);

    await click(screen.getByRole('link', { name: 'Settings' }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Store URL'), {
        target: { value: 'https://staging.store.test' },
      });
      await Promise.resolve();
    });
    await click(screen.getByRole('button', { name: 'Apply' }));
    expect(api.settings.set).toHaveBeenCalledWith({ storeBaseUrl: 'https://staging.store.test' });

    await click(screen.getByRole('link', { name: 'Store' }));
    expect(screen.queryByRole('list', { name: 'Search results' })).toBeNull();
    expect(homeShown()).toBe(true);
    expect(searchBox().value).toBe('');
    expect(api.store.search).toHaveBeenCalledTimes(1);
  });

  it('shows a Harness once when a later page repeats it', async () => {
    const api = await renderStore();
    const first = Array.from({ length: 24 }, (_, index) => listing(`erin/tool-${String(index)}`));
    api.store.search
      .mockResolvedValueOnce({
        ok: true,
        data: { platform: 'darwin-arm64', listings: first, hasMore: true },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          platform: 'darwin-arm64',
          listings: [first[23] ?? WRITER, WRITER],
          hasMore: false,
        },
      });
    await searchFor('tool');
    await click(screen.getByRole('button', { name: 'Load more' }));
    expect(resultNames()).toEqual([...first.map((item) => item.name), 'Note Writer']);
  });

  it('shows only the newest search’s answer', async () => {
    const api = await renderStore();
    const answers: ((result: IpcResult<StoreSearchPage>) => void)[] = [];
    api.store.search.mockImplementation(
      () =>
        new Promise((resolve) => {
          answers.push(resolve);
        }),
    );
    await searchFor('old');
    await searchFor('new');
    const page = (listings: StoreListing[]): IpcResult<StoreSearchPage> => ({
      ok: true,
      data: { platform: 'darwin-arm64', listings, hasMore: false },
    });
    await act(async () => {
      answers[1]?.(page([NOTES]));
      await Promise.resolve();
    });
    await act(async () => {
      answers[0]?.(page([WRITER]));
      await Promise.resolve();
    });
    await settle();
    expect(resultNames()).toEqual(['Notes']);
  });

  it('drops a Load more answer once the filters changed', async () => {
    const api = await renderStore();
    const first = Array.from({ length: 24 }, (_, index) => listing(`erin/tool-${String(index)}`));
    let answerMore: (result: IpcResult<StoreSearchPage>) => void = () => undefined;
    api.store.search
      .mockResolvedValueOnce({
        ok: true,
        data: { platform: 'darwin-arm64', listings: first, hasMore: true },
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerMore = resolve;
          }),
      );
    await searchFor('tool');
    await click(screen.getByRole('button', { name: 'Load more' }));
    expect(api.store.search).toHaveBeenLastCalledWith(request({ q: 'tool', offset: 24 }));

    // A tag changes the search while the next page of the old one is on its way.
    await click(screen.getByRole('button', { name: 'Writing' }));
    expect(api.store.search).toHaveBeenLastCalledWith(request({ q: 'tool', tags: ['writing'] }));
    expect(screen.getByText('No Harnesses match')).toBeDefined();
    await act(async () => {
      answerMore({
        ok: true,
        data: { platform: 'darwin-arm64', listings: [LINUX_NOTES], hasMore: false },
      });
      await Promise.resolve();
    });
    await settle();
    // The old search's page is not added to the new search's (empty) results.
    expect(screen.getByText('No Harnesses match')).toBeDefined();
    expect(screen.queryByRole('list', { name: 'Search results' })).toBeNull();
  });

  it('keeps the first page and Load more when the next page fails, and shows why', async () => {
    const api = await renderStore();
    const first = Array.from({ length: 24 }, (_, index) => listing(`erin/tool-${String(index)}`));
    api.store.search
      .mockResolvedValueOnce({
        ok: true,
        data: { platform: 'darwin-arm64', listings: first, hasMore: true },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'store_error', messageKey: 'error.store_error', message: 'Unexpected.' },
      });
    await searchFor('tool');
    const list = screen.getByRole('list', { name: 'Search results' });
    await click(screen.getByRole('button', { name: 'Load more' }));

    expect(screen.getByRole('list', { name: 'Search results' })).toBe(list);
    expect(resultNames()).toEqual(first.map((item) => item.name));
    expect(screen.getByRole('alert').textContent).toBe(
      'The Store answered with something unexpected. Try again in a moment.',
    );
    const loadMore = screen.getByRole('button', { name: 'Load more' });
    expect(loadMore.hasAttribute('disabled')).toBe(false);

    // Asking again loads the page.
    await click(loadMore);
    expect(api.store.search).toHaveBeenLastCalledWith(request({ q: 'tool', offset: 24 }));
  });

  it('shows a failed search inline with Retry', async () => {
    const api = await renderStore();
    api.store.search.mockResolvedValueOnce({
      ok: false,
      error: { code: 'store_error', messageKey: 'error.store_error', message: 'Unexpected.' },
    });
    await searchFor('notes');
    const error = screen.getByRole('region', { name: "Couldn't load the Store" });
    expect(within(error).getByRole('alert').textContent).toBe(
      'The Store answered with something unexpected. Try again in a moment.',
    );
    await click(within(error).getByRole('button', { name: 'Retry' }));
    expect(api.store.search).toHaveBeenCalledTimes(2);
    expect(resultNames()).toEqual(['Notes']);
  });

  it.each([
    ['the sidebar’s Store', 'sidebar'],
    ['Back', 'history'],
  ] as const)(
    'restores the text, tags, toggle and results after a detail page, through %s',
    async (_, how) => {
      const api = await renderStore();
      await click(screen.getByRole('button', { name: 'Writing' }));
      await click(screen.getByRole('checkbox', { name: 'My platform only' }));
      await searchFor('notes');
      expect(resultNames()).toEqual(['Linux Notes', 'Notes']);
      const calls = api.store.search.mock.calls.length;

      await click(screen.getByRole('link', { name: 'Notes' }));
      expect(window.location.hash).toBe('#/store/h/bob/notes');
      expect(screen.queryByRole('searchbox')).toBeNull();

      if (how === 'sidebar') {
        await click(screen.getByRole('link', { name: 'Store' }));
      } else {
        await act(async () => {
          window.history.back();
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      }
      expect(window.location.hash).toBe('#/store');
      expect(searchBox().value).toBe('notes');
      expect(screen.getByRole('button', { name: 'Writing' }).getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(
        screen.getByRole<HTMLInputElement>('checkbox', { name: 'My platform only' }).checked,
      ).toBe(false);
      expect(resultNames()).toEqual(['Linux Notes', 'Notes']);
      // Restored from memory, not searched again.
      expect(api.store.search).toHaveBeenCalledTimes(calls);
    },
  );
});

describe('Store search in zh-CN', () => {
  it('labels the filter row and results in Chinese, and searches Chinese text and tags', async () => {
    const api = await renderStore('zh-CN');
    expect(searchBox('搜索 Harness').placeholder).toBe('搜索 Harness');
    expect(screen.getByRole('checkbox', { name: '仅显示支持当前平台' })).toBeDefined();
    const tags = screen.getByRole('list', { name: '按标签筛选' });

    await click(within(tags).getByRole('button', { name: '写作' }));
    expect(api.store.search).toHaveBeenLastCalledWith(request({ tags: ['writing'] }));
    expect(resultNames('搜索结果')).toEqual(['Note Writer', 'Notes', '写作助手']);

    await searchFor('写作', '搜索 Harness');
    expect(api.store.search).toHaveBeenLastCalledWith(request({ q: '写作', tags: ['writing'] }));
    expect(resultNames('搜索结果')).toEqual(['写作助手']);

    await searchFor('没有', '搜索 Harness');
    expect(screen.getByText('没有匹配的 Harness')).toBeDefined();
    expect(screen.getByText('换个关键词，或清除筛选。')).toBeDefined();
    await click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByRole('region', { name: '精选' })).toBeDefined();
  });

  it('labels Load more in Chinese', async () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      listing(`erin/tool-${String(index)}`, { name: `Tool ${String(index)}` }),
    );
    await renderStore('zh-CN', many);
    await searchFor('tool', '搜索 Harness');
    expect(screen.getByRole('button', { name: '加载更多' })).toBeDefined();
  });
});
