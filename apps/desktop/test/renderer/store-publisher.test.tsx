// @vitest-environment jsdom
/**
 * Ticket P0-09.4: the Publisher page with a mocked `store.publisher`, in en and zh-CN: the
 * Publisher's avatar, name, GitHub link, join date, bio and total downloads over their Harnesses
 * as the Store's own cards; the empty state of a Publisher with nothing visible; a login with no
 * Publisher; an inline error with Retry; and the journey from a search result's Publisher to their
 * page, on to a card's detail page and back, as well as from the detail page's header.
 */
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  StoreDetail,
  StoreHome,
  StoreListing,
  StorePublisherPage,
  StorePublisherProfile,
} from '../../src/shared/ipc.js';
import { installFakeApi, renderApp } from './render-app.js';

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
    tags: ['writing'],
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
const LINUX_ONLY = listing('alice/linux-tool', {
  name: 'Linux Tool',
  iconUrl: null,
  downloadCount: 7,
  platforms: ['linux-x64'],
});

const ALICE: StorePublisherProfile = {
  login: 'alice',
  displayName: 'Alice Liddell',
  avatarUrl: 'https://avatars.githubusercontent.com/u/1',
  bio: 'Writes tools for writers.',
  joinedAt: '2026-03-14T09:00:00.000000+00:00',
  harnesses: [WRITER, LINUX_ONLY],
};

const page = (publisher: StorePublisherProfile | null): StorePublisherPage => ({
  platform: 'darwin-arm64',
  publisher,
});

async function settle() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

async function openPublisher(
  publisher: StorePublisherProfile | null = ALICE,
  locale: 'en' | 'zh-CN' = 'en',
) {
  const api = installFakeApi(locale);
  api.store.publisher.mockResolvedValue({ ok: true, data: page(publisher) });
  await renderApp(`#/store/p/${publisher?.login ?? 'nobody'}`);
  await settle();
  return api;
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
  await settle();
}

function publisherHeader() {
  const header = document.querySelector('.publisher-header');
  if (!(header instanceof HTMLElement)) throw new Error('No Publisher header');
  return header;
}

function cardNames() {
  return within(screen.getByRole('list', { name: /Harnesses by|发布的 Harness/ }))
    .getAllByRole('article')
    .map((card) => card.getAttribute('aria-label'));
}

describe('Publisher page', () => {
  it('shows the avatar, name, GitHub link, join date, bio and total downloads, then the cards', async () => {
    const api = await openPublisher();
    expect(api.store.publisher).toHaveBeenCalledWith('alice');
    const header = publisherHeader();
    expect(
      within(header).getByRole('heading', { level: 2, name: 'Harnesses by Alice Liddell' }),
    ).toBeDefined();
    expect(header.querySelector('img.avatar')?.getAttribute('src')).toBe(
      'https://avatars.githubusercontent.com/u/1',
    );
    const github = within(header).getByRole('link', { name: '@alice' });
    expect(github.getAttribute('href')).toBe('https://github.com/alice');
    expect(github.getAttribute('target')).toBe('_blank');
    expect(within(header).getByText('Joined March 2026')).toBeDefined();
    expect(within(header).getByText('Writes tools for writers.')).toBeDefined();
    expect(within(header).getByText('Total downloads: 1,267')).toBeDefined();
    // In the Store's order (most downloaded first), each opening its detail page.
    expect(cardNames()).toEqual(['Writer', 'Linux Tool']);
    const writer = screen.getByRole('article', { name: 'Writer' });
    expect(within(writer).getByRole('link', { name: 'Writer' }).getAttribute('href')).toBe(
      '#/store/h/alice/writer',
    );
    expect(within(writer).getByRole('link', { name: 'alice' }).getAttribute('href')).toBe(
      '#/store/p/alice',
    );
    // This machine's platform is greyed on a card that does not declare it, as on Store home.
    const badges = within(
      within(screen.getByRole('article', { name: 'Linux Tool' })).getByRole('list', {
        name: 'Platforms',
      }),
    ).getAllByRole('listitem');
    expect(badges.map((badge) => badge.className)).toEqual(['', 'unsupported']);
  });

  it('shows the login and a monogram for a Publisher without a display name or avatar', async () => {
    await openPublisher({ ...ALICE, displayName: null, avatarUrl: null, bio: null });
    const header = publisherHeader();
    expect(within(header).getByRole('heading', { name: 'Harnesses by alice' })).toBeDefined();
    expect(header.querySelector('img')).toBeNull();
    expect(header.querySelector('.monogram')?.textContent).toBe('A');
  });

  it('shows "No published Harnesses" for a Publisher with none visible, not a blank grid', async () => {
    await openPublisher({ ...ALICE, harnesses: [] });
    expect(screen.getByText('No published Harnesses')).toBeDefined();
    expect(screen.getByText('Total downloads: 0')).toBeDefined();
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Harnesses by Alice Liddell' })).toBeNull();
  });

  it('says there is no such Publisher for a login without a profile', async () => {
    await openPublisher(null);
    expect(screen.getByRole('heading', { name: 'No such Publisher' })).toBeDefined();
    expect(
      screen.getByText('No Publisher in the Store has the GitHub login nobody.'),
    ).toBeDefined();
  });

  it('labels the page in Chinese', async () => {
    await openPublisher({ ...ALICE, harnesses: [WRITER] }, 'zh-CN');
    const header = publisherHeader();
    expect(
      within(header).getByRole('heading', { name: 'Alice Liddell 发布的 Harness' }),
    ).toBeDefined();
    expect(within(header).getByText('2026年3月加入')).toBeDefined();
    expect(within(header).getByText('总下载量：1,260')).toBeDefined();
    expect(screen.getByRole('button', { name: '返回' })).toBeDefined();
    cleanup();

    await openPublisher({ ...ALICE, harnesses: [] }, 'zh-CN');
    expect(screen.getByText('没有已发布的 Harness')).toBeDefined();
    cleanup();

    await openPublisher(null, 'zh-CN');
    expect(screen.getByRole('heading', { name: '没有这个发布者' })).toBeDefined();
  });

  it('shows skeletons while loading, a failed read inline, and Retry reads again', async () => {
    const api = installFakeApi();
    let fail: () => void = () => undefined;
    api.store.publisher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          fail = () => {
            resolve({
              ok: false,
              error: {
                code: 'store_error',
                messageKey: 'error.store_error',
                message: 'Unexpected.',
              },
            });
          };
        }),
    );
    api.store.publisher.mockResolvedValue({ ok: true, data: page(ALICE) });
    await renderApp('#/store/p/alice');
    const loading = screen.getByRole('status', { name: 'Loading the Publisher' });
    expect(loading.querySelectorAll('.skeleton-card').length).toBeGreaterThan(0);
    await act(async () => {
      fail();
      await Promise.resolve();
    });
    await settle();
    const failed = screen.getByRole('region', { name: "Couldn't load the Store" });
    await click(within(failed).getByRole('button', { name: 'Retry' }));
    expect(api.store.publisher).toHaveBeenCalledTimes(2);
    expect(cardNames()).toEqual(['Writer', 'Linux Tool']);
  });

  it('shows the exact card of Store home', async () => {
    const api = await openPublisher({ ...ALICE, harnesses: [WRITER] });
    const onPublisherPage = screen.getByRole('article', { name: 'Writer' }).outerHTML;
    cleanup();

    const home: StoreHome = {
      platform: 'darwin-arm64',
      featured: [WRITER],
      mostDownloaded: [],
      newest: [],
    };
    api.store.home.mockResolvedValue({ ok: true, data: home });
    await renderApp('#/store');
    await settle();
    expect(screen.getByRole('article', { name: 'Writer' }).outerHTML).toBe(onPublisherPage);
  });
});

describe('getting there and back', () => {
  /** `alice/writer`'s detail page, as `store.detail` answers it. */
  const DETAIL: StoreDetail = {
    platform: 'darwin-arm64',
    storeStatus: 'available',
    harness: {
      harnessId: 'alice/writer',
      publisher: {
        login: 'alice',
        displayName: 'Alice Liddell',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1',
      },
      iconUrl: null,
      downloadCount: 1260,
      manifest: {
        manifestVersion: 1,
        id: 'alice/writer',
        version: '1.0.0',
        name: 'Writer',
        summary: 'Drafts and edits long texts.',
        license: 'MIT',
        platforms: ['darwin-arm64'],
        runtime: { kind: 'node' },
        entry: 'dist/index.js',
        ui: { kind: 'web' },
        workspace: 'none',
        models: { slots: { default: {} } },
        permissions: { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } },
      },
      readme: null,
      screenshotUrls: [],
      versions: [],
    },
  };

  it('goes from a search result’s Publisher to their page, on to a card’s detail page, and back', async () => {
    const api = installFakeApi();
    api.store.search.mockResolvedValue({
      ok: true,
      data: { platform: 'darwin-arm64', listings: [WRITER], hasMore: false },
    });
    api.store.publisher.mockResolvedValue({ ok: true, data: page(ALICE) });
    api.store.detail.mockResolvedValue({ ok: true, data: DETAIL });
    await renderApp('#/store');
    await settle();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Harnesses' }), {
      target: { value: 'writer' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByRole('search'));
      await Promise.resolve();
    });
    await settle();

    const result = within(screen.getByRole('list', { name: 'Search results' })).getByRole(
      'article',
      { name: 'Writer' },
    );
    await click(within(result).getByRole('link', { name: 'alice' }));
    expect(window.location.hash).toBe('#/store/p/alice');
    expect(api.store.publisher).toHaveBeenCalledWith('alice');

    await click(
      within(screen.getByRole('article', { name: 'Linux Tool' })).getByRole('link', {
        name: 'Linux Tool',
      }),
    );
    expect(window.location.hash).toBe('#/store/h/alice/linux-tool');
    expect(api.store.detail).toHaveBeenLastCalledWith('alice/linux-tool');

    await click(screen.getByRole('button', { name: 'Back' }));
    expect(window.location.hash).toBe('#/store/p/alice');
    await click(screen.getByRole('button', { name: 'Back' }));
    expect(window.location.hash).toBe('#/store');
    // The search is as it was left.
    expect(
      screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search Harnesses' }).value,
    ).toBe('writer');
    expect(screen.getByRole('list', { name: 'Search results' })).toBeDefined();
  });

  it('goes from the detail page’s Publisher, avatar and name as one link, to their page', async () => {
    const api = installFakeApi();
    api.store.detail.mockResolvedValue({ ok: true, data: DETAIL });
    api.store.publisher.mockResolvedValue({ ok: true, data: page(ALICE) });
    await renderApp('#/store/h/alice/writer');
    await settle();
    const link = within(screen.getByRole('article', { name: 'Writer' })).getByRole('link', {
      name: 'by Alice Liddell',
    });
    expect(link.querySelector('img.avatar')).not.toBeNull();
    await click(link);
    expect(window.location.hash).toBe('#/store/p/alice');
    expect(screen.getByRole('heading', { name: 'Harnesses by Alice Liddell' })).toBeDefined();
  });

  it('goes back to the Store home from a page opened directly', async () => {
    window.location.hash = '#/settings';
    await openPublisher();
    await click(screen.getByRole('button', { name: 'Back' }));
    expect(window.location.hash).toBe('#/store');
  });
});
