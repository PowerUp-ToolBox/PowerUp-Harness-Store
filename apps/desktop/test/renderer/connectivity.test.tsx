// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Locale } from '../../src/shared/i18n/locale.js';
import type { Connectivity, IpcResult } from '../../src/shared/ipc.js';
import { connectivityResult, installFakeApi, renderApp } from './render-app.js';

const BANNER = "You're offline. Library and Models still work.";

afterEach(() => {
  cleanup();
});

/** A fake Runtime whose last Store check found the Store unreachable. */
function installOfflineApi(osLocale: Locale = 'en') {
  const api = installFakeApi(osLocale);
  api.connectivity.get.mockResolvedValue(connectivityResult('offline'));
  api.connectivity.check.mockResolvedValue(connectivityResult('offline'));
  return api;
}

function offlinePanel() {
  return screen.getByRole('region', { name: "Can't reach the Store" });
}

describe('Store routes while the Store is unreachable', () => {
  it.each(['#/store', '#/store/h/acme/code-reviewer', '#/store/p/octocat'])(
    '%s shows the offline panel with Retry instead of the Store screen',
    async (hash) => {
      installOfflineApi();
      await renderApp(hash);
      const panel = offlinePanel();
      expect(
        within(panel).getByText('Check your internet connection, then try again.'),
      ).toBeDefined();
      expect(within(panel).getByRole('button', { name: 'Retry' })).toBeDefined();
      expect(screen.queryByText(/appear here/)).toBeNull();
      // Still inside the shell: the User can leave for another section.
      expect(screen.getByRole('heading', { level: 1, name: 'Store' })).toBeDefined();
      expect(screen.getByRole('navigation', { name: 'Main' })).toBeDefined();
    },
  );

  it('Retry re-checks, shows a spinner meanwhile, then the Store screen once the Store answers', async () => {
    const api = installOfflineApi();
    let answer: (result: IpcResult<Connectivity>) => void = () => undefined;
    api.connectivity.check.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await renderApp('#/store');

    const retry = within(offlinePanel()).getByRole('button', { name: 'Retry' });
    await act(async () => {
      fireEvent.click(retry);
      await Promise.resolve();
    });
    expect(api.connectivity.check).toHaveBeenCalledOnce();
    expect(retry.hasAttribute('disabled')).toBe(true);
    expect(retry.getAttribute('aria-busy')).toBe('true');
    expect(retry.querySelector('.spinner')).not.toBeNull();

    await act(async () => {
      answer(connectivityResult('online'));
      await Promise.resolve();
    });
    expect(screen.getByText('There are no Harnesses in the Store yet.')).toBeDefined();
    expect(screen.queryByRole('region', { name: "Can't reach the Store" })).toBeNull();
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it('keeps the panel, with Retry enabled again, while the Store still does not answer', async () => {
    const api = installOfflineApi();
    await renderApp('#/store');
    await act(async () => {
      fireEvent.click(within(offlinePanel()).getByRole('button', { name: 'Retry' }));
      await Promise.resolve();
    });
    expect(api.connectivity.check).toHaveBeenCalledOnce();
    const retry = within(offlinePanel()).getByRole('button', { name: 'Retry' });
    expect(retry.hasAttribute('disabled')).toBe(false);
    expect(retry.querySelector('.spinner')).toBeNull();
  });

  it('keeps the panel when the check itself fails over IPC', async () => {
    const api = installOfflineApi();
    api.connectivity.check.mockRejectedValue(new Error('IPC down'));
    await renderApp('#/store');
    await act(async () => {
      fireEvent.click(within(offlinePanel()).getByRole('button', { name: 'Retry' }));
      await Promise.resolve();
    });
    expect(
      within(offlinePanel()).getByRole('button', { name: 'Retry' }).hasAttribute('disabled'),
    ).toBe(false);
  });
});

describe('other routes while the Store is unreachable', () => {
  it.each([
    ['#/library', 'Library', 'Nothing installed yet'],
    ['#/models', 'Models', 'Connections'],
    ['#/usage', 'Usage', 'Tokens your Harnesses use appear here.'],
    ['#/publish', 'Publish', "Signing in needs the Store, and you're offline."],
  ])('%s renders its own content, never the offline panel', async (hash, title, content) => {
    installOfflineApi();
    await renderApp(hash);
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeDefined();
    expect(await screen.findByText(content)).toBeDefined();
    expect(screen.queryByRole('region', { name: "Can't reach the Store" })).toBeNull();
  });

  it('#/settings works: the language switches and the diagnostics load', async () => {
    const api = installOfflineApi();
    await renderApp('#/settings');
    expect(await screen.findByText('4.5.6')).toBeDefined();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'zh-CN' } });
      await Promise.resolve();
    });
    expect(api.settings.set).toHaveBeenCalledWith({ locale: 'zh-CN' });
    expect(screen.getByRole('heading', { level: 1, name: '设置' })).toBeDefined();
    expect(screen.queryByRole('region', { name: '无法连接商店' })).toBeNull();
  });

  it.each(['#/library', '#/models', '#/usage', '#/settings', '#/store'])(
    '%s shows the offline banner above the page',
    async (hash) => {
      installOfflineApi();
      await renderApp(hash);
      expect(screen.getByRole('status').textContent).toBe(BANNER);
    },
  );

  it('the first-run wizard shows no banner', async () => {
    installOfflineApi();
    await renderApp('#/onboarding');
    expect(screen.queryByText(BANNER)).toBeNull();
  });
});

describe('connectivity from the Runtime', () => {
  it('shows the Store screen and no banner while the first check has not ended', async () => {
    const api = installFakeApi();
    api.connectivity.get.mockResolvedValue(connectivityResult('unknown'));
    await renderApp('#/store');
    expect(screen.getByText('There are no Harnesses in the Store yet.')).toBeDefined();
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it('follows connectivity.changed: the banner and panel come and go without a reload', async () => {
    const api = installFakeApi();
    await renderApp('#/store');
    expect(screen.getByText('There are no Harnesses in the Store yet.')).toBeDefined();

    act(() => {
      api.emit('connectivity.changed', { state: 'offline' });
    });
    expect(offlinePanel()).toBeDefined();
    expect(screen.getByText(BANNER)).toBeDefined();

    // The Store screen mounts afresh and reads the Store home again.
    await act(async () => {
      api.emit('connectivity.changed', { state: 'online' });
      await Promise.resolve();
    });
    expect(screen.getByText('There are no Harnesses in the Store yet.')).toBeDefined();
    expect(api.store.home).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it('subscribes before asking for the current state, so no change is missed', async () => {
    const api = installFakeApi();
    await renderApp('#/library');
    expect(api.on).toHaveBeenCalledWith('connectivity.changed', expect.any(Function));
    const [subscribed] = api.on.mock.invocationCallOrder;
    const [asked] = api.connectivity.get.mock.invocationCallOrder;
    expect(subscribed).toBeLessThan(asked ?? 0);
  });
});

describe('offline copy in zh-CN', () => {
  it('shows the banner and panel in Chinese', async () => {
    installOfflineApi('zh-CN');
    await renderApp('#/store');
    expect(screen.getByRole('status').textContent).toBe('当前离线。资源库和模型页仍可使用。');
    const panel = screen.getByRole('region', { name: '无法连接商店' });
    expect(within(panel).getByText('请检查网络连接后重试。')).toBeDefined();
    expect(within(panel).getByRole('button', { name: '重试' })).toBeDefined();
  });
});
