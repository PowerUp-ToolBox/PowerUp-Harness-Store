// @vitest-environment jsdom
/**
 * Ticket P0-10.3: the Library's cards in each status with exactly their actions, its name filter,
 * views and sort (client-side: no call to main), the last launched date, and Uninstall from a
 * card's menu and from the detail page, over the fake `window.api`, in en and zh-CN.
 * test/install/uninstall.test.ts covers the same calls in main.
 */
import type { Manifest } from '@harness-store/manifest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  InstalledHarness,
  IpcResult,
  LaunchStatus,
  StoreDetail,
} from '../../src/shared/ipc.js';
import { installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
});

const MANIFEST: Manifest = {
  manifestVersion: 1,
  id: 'acme/installed',
  version: '1.0.0',
  name: 'Installed',
  summary: 'A test Harness.',
  license: 'MIT',
  platforms: ['darwin-arm64', 'linux-x64', 'win32-x64'],
  runtime: { kind: 'node', node: '22' },
  entry: 'index.mjs',
  ui: { kind: 'terminal' },
  models: { slots: { default: {} } },
  permissions: { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } },
};

function installed(
  slug: string,
  name: string,
  fields: Partial<InstalledHarness> = {},
): InstalledHarness {
  const harnessId = `acme/${slug}`;
  return {
    harnessId,
    version: '1.0.0',
    name,
    publisher: 'acme',
    source: 'store',
    manifest: { ...MANIFEST, id: harnessId, name },
    installPath: `/profile/harnesses/acme/${slug}/1.0.0`,
    installedAt: '2026-10-01T00:00:00.000Z',
    lastLaunchedAt: null,
    iconDataUrl: null,
    platformSupported: true,
    storeStatus: 'available',
    availableUpdate: null,
    ...fields,
  };
}

/** The six statuses of docs/ux/screens.md, one card each, never launched unless said. */
const INSTALLED = installed('installed', 'Installed');
const UPDATE = installed('update', 'Update Available', {
  availableUpdate: { version: '1.1.0', manifest: { ...MANIFEST, version: '1.1.0' } },
});
const RUNNING = installed('running', 'Running Now', {
  lastLaunchedAt: '2026-10-27T09:00:00.000Z',
});
const CRASHED = installed('crashed', 'Crashed', { lastLaunchedAt: '2026-10-26T09:00:00.000Z' });
const LOCAL = installed('local', 'Local Copy', { source: 'local', storeStatus: null });
const GONE = installed('gone', 'Gone From Store', { storeStatus: 'taken_down' });
const ALL = [INSTALLED, UPDATE, RUNNING, CRASHED, LOCAL, GONE];

function launchStatus(harnessId: string, fields: Partial<LaunchStatus>): LaunchStatus {
  return {
    harnessId,
    launchId: `launch-of-${harnessId}`,
    state: 'ready',
    startedAt: '2026-10-28T09:00:00.000Z',
    ...fields,
  };
}

function setup(locale: 'en' | 'zh-CN' = 'en', installs: readonly InstalledHarness[] = ALL) {
  const api = installFakeApi(locale);
  api.installs.list.mockResolvedValue({ ok: true, data: installs });
  api.launch.status.mockResolvedValue({
    ok: true,
    data: [
      launchStatus(RUNNING.harnessId, { state: 'ready' }),
      launchStatus(CRASHED.harnessId, { state: 'failed', reason: 'exit_nonzero', exitCode: 1 }),
    ],
  });
  api.bindings.resolveAll.mockResolvedValue({
    ok: true,
    data: [
      { slot: 'default', binding: { connectionId: 'ollama', model: 'qwen3', source: 'default' } },
    ],
  });
  return api;
}

const cardNames = () =>
  screen.getAllByRole('article').map((article) => article.getAttribute('aria-label'));

/** The buttons of a card outside its menu, as "label" or "label (disabled)". */
function actions(name: string): string[] {
  const card = screen.getByRole('article', { name });
  return within(card)
    .getAllByRole('button')
    .filter((button) => !button.classList.contains('card-menu-button'))
    .map((button) => {
      const label = button.textContent.trim();
      return (button as HTMLButtonElement).disabled ? `${label} (disabled)` : label;
    });
}

/** What `store.detail` answers for `install`, whose latest version the Store offers is `manifest`. */
function detailOf(
  install: InstalledHarness,
  manifest: Manifest = install.manifest,
): IpcResult<StoreDetail> {
  return {
    ok: true,
    data: {
      platform: 'darwin-arm64',
      storeStatus: 'available',
      harness: {
        harnessId: install.harnessId,
        publisher: { login: 'acme', displayName: 'Acme', avatarUrl: null },
        iconUrl: null,
        downloadCount: 3,
        manifest,
        readme: null,
        screenshotUrls: [],
        versions: [
          {
            version: manifest.version,
            publishedAt: '2026-10-01T09:00:00.000000+00:00',
            changelog: null,
            permissionsChanged: false,
          },
        ],
      },
    },
  };
}

async function openMenu(name: string) {
  const card = within(await screen.findByRole('article', { name }));
  fireEvent.click(card.getByRole('button', { name: `More actions for ${name}` }));
  return card.getByRole('menu');
}

/** How many calls the renderer has made to main so far, over every method of `window.api`. */
function callsToMain(api: ReturnType<typeof installFakeApi>): number {
  let total = 0;
  for (const [domain, methods] of Object.entries(api)) {
    if (domain === 'on' || domain === 'emit' || typeof methods !== 'object') continue;
    for (const method of Object.values(methods as Record<string, unknown>)) {
      if (vi.isMockFunction(method)) total += (method as Mock).mock.calls.length;
    }
  }
  return total;
}

describe('the Library cards', () => {
  it('shows each status with exactly its actions', async () => {
    setup();
    await renderApp('#/library');
    await screen.findByRole('article', { name: 'Installed' });
    await screen.findByRole('button', { name: 'Running…' });

    expect(actions('Installed')).toEqual(['Launch']);
    expect(actions('Update Available')).toEqual(['Update', 'Launch']);
    expect(actions('Running Now')).toEqual(['Running…', 'Show window']);
    // Exited with error: why, with Show logs and Dismiss; Launch retries.
    const crashed = screen.getByRole('article', { name: 'Crashed' });
    expect(within(crashed).getByRole('alert').textContent).toContain('Exited with an error');
    expect(actions('Crashed')).toEqual(['Show logs', 'Dismiss', 'Launch']);
    // Local: the badge, and never Update.
    const local = screen.getByRole('article', { name: 'Local Copy' });
    expect(within(local).getByText('Local')).toBeDefined();
    expect(actions('Local Copy')).toEqual(['Launch']);
    // No longer in the Store: the note, and no Update.
    const gone = screen.getByRole('article', { name: 'Gone From Store' });
    expect(within(gone).getByText('No longer available in the Store')).toBeDefined();
    expect(actions('Gone From Store')).toEqual(['Launch']);

    // Every card's menu has the same five items, Uninstall last.
    for (const name of ['Installed', 'Local Copy', 'Running Now']) {
      const menu = await openMenu(name);
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((item) => item.textContent),
      ).toEqual(['View in Store', 'Model Overrides', 'Show logs', 'Open data folder', 'Uninstall']);
      fireEvent.keyDown(menu, { key: 'Escape' });
    }
  });

  it('a local install never offers Update, even with a version in the row', async () => {
    setup('en', [
      installed('local', 'Local Copy', {
        source: 'local',
        storeStatus: null,
        // A local install is never checked; a stray value must not make an Update button.
        availableUpdate: { version: '1.1.0', manifest: { ...MANIFEST, version: '1.1.0' } },
      }),
    ]);
    await renderApp('#/library');
    await screen.findByRole('article', { name: 'Local Copy' });
    expect(actions('Local Copy')).toEqual(['Launch']);
    // Nor does it count as an update: no nav badge, and the view of updates has nothing.
    expect(screen.queryByRole('img', { name: /update/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Updates available' }));
    expect(screen.getByText('No Harnesses in this view')).toBeDefined();
  });

  it('shows when each Harness was last launched, nothing for one never launched', async () => {
    setup();
    await renderApp('#/library');
    const running = await screen.findByRole('article', { name: 'Running Now' });
    // The date is local time: 09:00 UTC is the day before west of UTC-9.
    expect(within(running).getByText(/^Last launched Oct 2[67], 2026$/)).toBeDefined();
    const never = screen.getByRole('article', { name: 'Installed' });
    expect(within(never).queryByText(/Last launched/)).toBeNull();
  });
});

describe('loading', () => {
  it('shows skeleton cards until the list answers', async () => {
    const api = setup();
    // The nav badge reads the list too: every call waits for the one answer.
    const waiting: ((result: IpcResult<readonly InstalledHarness[]>) => void)[] = [];
    api.installs.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          waiting.push(resolve);
        }),
    );
    await renderApp('#/library');
    const loading = await screen.findByRole('status', { name: 'Loading your Library' });
    expect(loading.querySelectorAll('.skeleton-card').length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('article')).toEqual([]);
    await act(async () => {
      for (const answer of waiting) answer({ ok: true, data: ALL });
      await Promise.resolve();
    });
    expect(await screen.findByRole('article', { name: 'Installed' })).toBeDefined();
    expect(screen.queryByRole('status', { name: 'Loading your Library' })).toBeNull();
  });

  it('reads in zh-CN', async () => {
    const api = setup('zh-CN');
    api.installs.list.mockImplementation(() => new Promise(() => undefined));
    await renderApp('#/library');
    expect(await screen.findByRole('status', { name: '正在加载资源库' })).toBeDefined();
  });
});

describe('sorting and filtering', () => {
  it('sorts by last launched, then by name, and by name when asked', async () => {
    setup();
    await renderApp('#/library');
    await screen.findByRole('article', { name: 'Installed' });
    expect(cardNames()).toEqual([
      'Running Now',
      'Crashed',
      'Gone From Store',
      'Installed',
      'Local Copy',
      'Update Available',
    ]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort' }), {
      target: { value: 'name' },
    });
    expect(cardNames()).toEqual([
      'Crashed',
      'Gone From Store',
      'Installed',
      'Local Copy',
      'Running Now',
      'Update Available',
    ]);
  });

  it('narrows the cards as the User types a name, without calling main', async () => {
    const api = setup();
    await renderApp('#/library');
    await screen.findByRole('button', { name: 'Running…' });
    const before = callsToMain(api);

    const filter = screen.getByRole('searchbox', { name: 'Filter by name' });
    fireEvent.change(filter, { target: { value: 'r' } });
    expect(cardNames()).toEqual(['Running Now', 'Crashed', 'Gone From Store']);
    fireEvent.change(filter, { target: { value: 'RUN' } });
    expect(cardNames()).toEqual(['Running Now']);
    fireEvent.change(filter, { target: { value: 'local c' } });
    expect(cardNames()).toEqual(['Local Copy']);
    expect(callsToMain(api)).toBe(before);
  });

  it('shows the views Updates available, Running and Local installs', async () => {
    const api = setup();
    await renderApp('#/library');
    await screen.findByRole('button', { name: 'Running…' });
    const before = callsToMain(api);
    const views = within(screen.getByRole('list', { name: 'Show' }));
    expect(views.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(views.getByRole('button', { name: 'Updates available' }));
    expect(cardNames()).toEqual(['Update Available']);
    fireEvent.click(views.getByRole('button', { name: 'Running' }));
    expect(cardNames()).toEqual(['Running Now']);
    fireEvent.click(views.getByRole('button', { name: 'Local installs' }));
    expect(cardNames()).toEqual(['Local Copy']);
    fireEvent.click(views.getByRole('button', { name: 'All' }));
    expect(cardNames()).toHaveLength(6);
    expect(callsToMain(api)).toBe(before);
  });

  it('says a view has no Harnesses, and Clear filters shows them all again', async () => {
    setup();
    await renderApp('#/library');
    await screen.findByRole('article', { name: 'Installed' });
    fireEvent.click(screen.getByRole('button', { name: 'Local installs' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter by name' }), {
      target: { value: 'nothing like it' },
    });
    expect(screen.queryAllByRole('article')).toEqual([]);
    expect(screen.getByText('No Harnesses in this view')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(cardNames()).toHaveLength(6);
    expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Filter by name' }).value).toBe(
      '',
    );
  });

  it('reads in zh-CN', async () => {
    setup('zh-CN');
    await renderApp('#/library');
    await screen.findByRole('article', { name: 'Installed' });
    expect(screen.getByRole('searchbox', { name: '按名称筛选' })).toBeDefined();
    const views = within(screen.getByRole('list', { name: '显示' }));
    expect(views.getAllByRole('button').map((button) => button.textContent)).toEqual([
      '全部',
      '有可用更新',
      '运行中',
      '本地安装',
    ]);
    const sort = screen.getByRole('combobox', { name: '排序' });
    expect(
      within(sort)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['最近使用', '名称']);
    fireEvent.click(views.getByRole('button', { name: '本地安装' }));
    fireEvent.change(screen.getByRole('searchbox', { name: '按名称筛选' }), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText('此视图中没有 Harness')).toBeDefined();
    expect(screen.getByRole('button', { name: '清除筛选' })).toBeDefined();
    const running = screen.queryByRole('article', { name: 'Running Now' });
    expect(running).toBeNull();
  });
});

describe('Uninstall', () => {
  it('confirms with the name and the Data Directory size, uninstalls, and the card goes', async () => {
    const api = setup();
    api.installs.dataSize.mockResolvedValue({ ok: true, data: 1_500_000 });
    api.installs.uninstall.mockImplementation((harnessId: string) => {
      api.installs.list.mockResolvedValue({
        ok: true,
        data: ALL.filter((each) => each.harnessId !== harnessId),
      });
      api.emit('installs.changed', { harnessId });
      return Promise.resolve({ ok: true, data: null } as IpcResult<null>);
    });
    await renderApp('#/library');
    await screen.findByRole('article', { name: 'Installed' });
    // The size is read only when the dialog opens, never for every card.
    expect(api.installs.dataSize).not.toHaveBeenCalled();

    const menu = within(await openMenu('Installed'));
    fireEvent.click(menu.getByRole('menuitem', { name: 'Uninstall' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Uninstall Installed?' }));
    expect(
      await dialog.findByText(
        'This deletes its data directory (1.5 MB). Files in your own folders are not touched.',
      ),
    ).toBeDefined();
    expect(api.installs.dataSize).toHaveBeenCalledTimes(1);
    expect(api.installs.dataSize).toHaveBeenCalledWith('acme/installed');

    fireEvent.click(dialog.getByRole('button', { name: 'Uninstall' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(api.installs.uninstall).toHaveBeenCalledWith('acme/installed');
    expect(screen.getByText('Uninstalled Installed')).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByRole('article', { name: 'Installed' })).toBeNull();
    });
  });

  it('Cancel closes the dialog and uninstalls nothing', async () => {
    const api = setup();
    api.installs.dataSize.mockResolvedValue({ ok: true, data: 0 });
    await renderApp('#/library');
    await screen.findByRole('article', { name: 'Installed' });
    fireEvent.click(
      within(await openMenu('Installed')).getByRole('menuitem', { name: 'Uninstall' }),
    );
    const dialog = within(await screen.findByRole('dialog'));
    await dialog.findByText(/\(0 byte/);
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.installs.uninstall).not.toHaveBeenCalled();
  });

  it('says "Close the Harness first", with only Close, while it runs, deleting nothing', async () => {
    const api = setup();
    await renderApp('#/library');
    await screen.findByRole('button', { name: 'Running…' });
    fireEvent.click(
      within(await openMenu('Running Now')).getByRole('menuitem', { name: 'Uninstall' }),
    );
    const dialog = within(await screen.findByRole('dialog', { name: 'Uninstall Running Now?' }));
    expect(dialog.getByText('Close the Harness first')).toBeDefined();
    expect(dialog.getAllByRole('button').map((button) => button.textContent)).toEqual(['Close']);
    expect(api.installs.dataSize).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.installs.uninstall).not.toHaveBeenCalled();
  });

  it('turns to "Close the Harness first" when main refuses because it started meanwhile', async () => {
    const api = setup();
    api.installs.dataSize.mockResolvedValue({ ok: true, data: 2048 });
    api.installs.uninstall.mockResolvedValue({
      ok: false,
      error: {
        code: 'harness_running',
        messageKey: 'error.harness_running',
        message: 'This Harness is running.',
      },
    });
    await renderApp('#/library');
    await screen.findByRole('article', { name: 'Installed' });
    fireEvent.click(
      within(await openMenu('Installed')).getByRole('menuitem', { name: 'Uninstall' }),
    );
    const dialog = within(await screen.findByRole('dialog'));
    await dialog.findByText(/2\.0 kB|2 kB/);
    fireEvent.click(dialog.getByRole('button', { name: 'Uninstall' }));
    expect(await dialog.findByText('Close the Harness first')).toBeDefined();
    expect(screen.getByRole('article', { name: 'Installed' })).toBeDefined();
  });

  it('shows any other refusal in the dialog, which stays open', async () => {
    const api = setup();
    api.installs.dataSize.mockResolvedValue({ ok: true, data: 10 });
    api.installs.uninstall.mockResolvedValue({
      ok: false,
      error: {
        code: 'harness_installing',
        messageKey: 'error.harness_installing',
        message: 'This Harness is being installed.',
      },
    });
    await renderApp('#/library');
    await screen.findByRole('article', { name: 'Installed' });
    fireEvent.click(
      within(await openMenu('Installed')).getByRole('menuitem', { name: 'Uninstall' }),
    );
    const dialog = within(await screen.findByRole('dialog'));
    await dialog.findByText(/10 byte/);
    fireEvent.click(dialog.getByRole('button', { name: 'Uninstall' }));
    expect(
      await dialog.findByText(
        'This Harness is being installed. Try again once the install has finished.',
      ),
    ).toBeDefined();
  });

  it('reads in zh-CN', async () => {
    const api = setup('zh-CN');
    api.installs.dataSize.mockResolvedValue({ ok: true, data: 1_500_000 });
    api.installs.uninstall.mockResolvedValue({ ok: true, data: null });
    await renderApp('#/library');
    await screen.findByRole('article', { name: 'Installed' });
    const card = within(screen.getByRole('article', { name: 'Installed' }));
    fireEvent.click(card.getByRole('button', { name: 'Installed 的更多操作' }));
    fireEvent.click(card.getByRole('menuitem', { name: '卸载' }));
    const dialog = within(await screen.findByRole('dialog', { name: '卸载 Installed？' }));
    expect(
      await dialog.findByText('这会删除它的数据目录（1.5 MB）。你自己目录中的文件不受影响。'),
    ).toBeDefined();
    expect(dialog.getByRole('button', { name: '取消' })).toBeDefined();
    fireEvent.click(dialog.getByRole('button', { name: '卸载' }));
    expect(await screen.findByText('已卸载 Installed')).toBeDefined();
  });

  it('reads "Close the Harness first" in zh-CN', async () => {
    setup('zh-CN');
    await renderApp('#/library');
    await screen.findByRole('button', { name: '运行中…' });
    const card = within(screen.getByRole('article', { name: 'Running Now' }));
    fireEvent.click(card.getByRole('button', { name: 'Running Now 的更多操作' }));
    fireEvent.click(card.getByRole('menuitem', { name: '卸载' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('请先关闭该 Harness')).toBeDefined();
    expect(dialog.getByRole('button', { name: '关闭' })).toBeDefined();
  });

  it('is on the detail page beside Launch, and the page offers Install once it is done', async () => {
    const api = setup('en', [INSTALLED]);
    api.store.detail.mockResolvedValue(detailOf(INSTALLED));
    api.installs.dataSize.mockResolvedValue({ ok: true, data: 1_500_000 });
    api.installs.uninstall.mockImplementation((harnessId: string) => {
      api.installs.list.mockResolvedValue({ ok: true, data: [] });
      api.emit('installs.changed', { harnessId });
      return Promise.resolve({ ok: true, data: null } as IpcResult<null>);
    });
    await renderApp('#/store/h/acme/installed');
    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Uninstall Installed?' }));
    await dialog.findByText(/\(1\.5 MB\)/);
    fireEvent.click(dialog.getByRole('button', { name: 'Uninstall' }));
    expect(await screen.findByRole('button', { name: 'Install' })).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Uninstalled Installed')).toBeDefined();
    expect(api.installs.uninstall).toHaveBeenCalledWith('acme/installed');
  });

  it('on the detail page, gives way to Running… while the Harness runs, as Launch does', async () => {
    const api = setup('en', [INSTALLED]);
    api.launch.status.mockResolvedValue({ ok: true, data: [] });
    await renderApp('#/store/h/acme/installed');
    expect(await screen.findByRole('button', { name: 'Uninstall' })).toBeDefined();
    act(() => {
      api.emit('launch.state', launchStatus(INSTALLED.harnessId, { state: 'ready' }));
    });
    expect(await screen.findByRole('button', { name: 'Running…' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Uninstall' })).toBeNull();
  });

  it('is on the detail page beside "Set up a model first" too', async () => {
    const api = setup('en', [INSTALLED]);
    api.launch.status.mockResolvedValue({ ok: true, data: [] });
    api.bindings.resolveAll.mockResolvedValue({
      ok: true,
      data: [{ slot: 'default', binding: null }],
    });
    api.store.detail.mockResolvedValue(detailOf(INSTALLED));
    api.installs.dataSize.mockResolvedValue({ ok: true, data: 0 });
    await renderApp('#/store/h/acme/installed');
    expect(await screen.findByRole('button', { name: 'Set up a model first' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }));
    expect(await screen.findByRole('dialog', { name: 'Uninstall Installed?' })).toBeDefined();
  });

  it('is on the detail page beside "Not available for your platform" too', async () => {
    const elsewhere = installed('installed', 'Installed', { platformSupported: false });
    const api = setup('en', [elsewhere]);
    api.launch.status.mockResolvedValue({ ok: true, data: [] });
    api.store.detail.mockResolvedValue(detailOf(elsewhere));
    await renderApp('#/store/h/acme/installed');
    const unsupported = await screen.findByRole('button', {
      name: 'Not available for your platform',
    });
    expect((unsupported as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeDefined();
  });

  it('stays open when the Running view hides its card, as the Harness it asked to close stops', async () => {
    const api = setup();
    api.installs.dataSize.mockResolvedValue({ ok: true, data: 1_500_000 });
    await renderApp('#/library');
    await screen.findByRole('button', { name: 'Running…' });
    fireEvent.click(screen.getByRole('button', { name: 'Running' }));
    fireEvent.click(
      within(await openMenu('Running Now')).getByRole('menuitem', { name: 'Uninstall' }),
    );
    expect(await screen.findByText('Close the Harness first')).toBeDefined();

    act(() => {
      api.emit('launch.state', launchStatus(RUNNING.harnessId, { state: 'stopped', exitCode: 0 }));
    });
    // The card left the view; the dialog did not, and now asks to confirm.
    expect(screen.queryAllByRole('article')).toEqual([]);
    const dialog = await screen.findByRole('dialog', { name: 'Uninstall Running Now?' });
    expect(dialog.closest('[hidden]')).toBeNull();
    expect(await within(dialog).findByText(/\(1\.5 MB\)/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();

    // Showing the card again does not bring the dialog back.
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByRole('article', { name: 'Running Now' })).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.installs.uninstall).not.toHaveBeenCalled();
  });

  it('drops a failed update, so the detail page then offers Install with no stale error', async () => {
    const api = setup('en', [UPDATE]);
    api.launch.status.mockResolvedValue({ ok: true, data: [] });
    api.installs.update.mockResolvedValue({
      ok: false,
      error: {
        code: 'harness_running',
        messageKey: 'error.harness_running',
        message: 'This Harness is running.',
      },
    });
    api.installs.dataSize.mockResolvedValue({ ok: true, data: 0 });
    api.installs.uninstall.mockImplementation((harnessId: string) => {
      api.installs.list.mockResolvedValue({ ok: true, data: [] });
      api.emit('installs.changed', { harnessId });
      return Promise.resolve({ ok: true, data: null } as IpcResult<null>);
    });
    api.store.detail.mockResolvedValue(detailOf(UPDATE, UPDATE.availableUpdate?.manifest));
    await renderApp('#/library');
    const card = within(await screen.findByRole('article', { name: 'Update Available' }));
    fireEvent.click(card.getByRole('button', { name: 'Update' }));
    expect(await card.findByText('Close the Harness to update')).toBeDefined();

    fireEvent.click(
      within(await openMenu('Update Available')).getByRole('menuitem', { name: 'Uninstall' }),
    );
    const dialog = within(await screen.findByRole('dialog'));
    await dialog.findByText(/\(0 byte/);
    fireEvent.click(dialog.getByRole('button', { name: 'Uninstall' }));
    await screen.findByText('Nothing installed yet');

    act(() => {
      window.location.hash = '#/store/h/acme/update';
    });
    expect(await screen.findByRole('button', { name: 'Install' })).toBeDefined();
    expect(screen.queryByText('Close the Harness to update')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
