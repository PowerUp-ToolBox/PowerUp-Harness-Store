// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Locale } from '../../src/shared/i18n/locale.js';
import type { StartupStatus } from '../../src/shared/ipc.js';
import { FAKE_DIAGNOSTICS, installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
});

/** A fake Runtime whose startup ended with `status`. */
function installStartedApi(status: StartupStatus, osLocale: Locale = 'en') {
  const api = installFakeApi(osLocale);
  api.app.status.mockResolvedValue({ ok: true, data: status });
  return api;
}

describe('startup error screen', () => {
  it('blocks the app when the Model Gateway could not bind its port', async () => {
    const api = installStartedApi({
      state: 'failed',
      stage: 'gateway',
      detail: 'listen EADDRINUSE: address already in use',
    });
    await renderApp('#/library');
    expect(screen.getByRole('heading', { level: 1, name: 'Harness Store could not start' }));
    expect(screen.getByRole('alert').textContent).toBe(
      'The Model Gateway could not start, so Harnesses would not reach any model.',
    );
    expect(screen.getByText('listen EADDRINUSE: address already in use')).toBeDefined();
    // No shell, no screen behind it.
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Library' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Quit' }));
    expect(api.app.quit).toHaveBeenCalledOnce();
  });

  it('names the database step in the OS language when SQLite could not open', async () => {
    installStartedApi(
      { state: 'failed', stage: 'database', detail: 'unable to open database file' },
      'zh-CN',
    );
    await renderApp('#/settings');
    expect(screen.getByRole('heading', { level: 1, name: 'Harness Store 无法启动' }));
    expect(screen.getByRole('alert').textContent).toBe('无法打开本地数据库。');
    expect(screen.getByRole('button', { name: '退出' })).toBeDefined();
  });

  it('renders the app when the Runtime started', async () => {
    installStartedApi({ state: 'ready' });
    await renderApp('#/library');
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeDefined();
    expect(screen.queryByText('Harness Store could not start')).toBeNull();
  });
});

describe('Settings diagnostics', () => {
  function diagnostics() {
    return within(screen.getByRole('region', { name: 'Diagnostics' }));
  }

  it('shows the live Model Gateway port, the database path and the version', async () => {
    installFakeApi();
    await renderApp('#/settings');
    await screen.findByRole('region', { name: 'Diagnostics' });
    expect(diagnostics().getByText('Running on port 51234')).toBeDefined();
    expect(diagnostics().getByText('/profile/harness-store.sqlite')).toBeDefined();
    expect(diagnostics().getByText('4.5.6')).toBeDefined();
  });

  it('says when the Model Gateway is not running', async () => {
    const api = installFakeApi('zh-CN');
    api.diagnostics.get.mockResolvedValue({
      ok: true,
      data: { ...FAKE_DIAGNOSTICS, gateway: { running: false } },
    });
    await renderApp('#/settings');
    expect(await screen.findByText('未运行')).toBeDefined();
    expect(screen.queryByText(/51234/)).toBeNull();
  });
});
