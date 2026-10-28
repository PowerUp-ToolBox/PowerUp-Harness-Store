// @vitest-environment jsdom
/**
 * Ticket P0-11.2 in the renderer: the Settings page against a fake `window.api`, in en and zh-CN.
 * Switching the language changes text elsewhere in the app in place, without re-mounting it (How
 * to verify, step 3); the update interval and Check now; Data location's two folders; the Store
 * URL under Advanced, applied with Apply, refused inline, and the custom Store banner it brings
 * on every main screen; Re-run setup touching no Connection; Clear usage data through the shared
 * confirmation; and the diagnostics, read again on Copy, showing a Model Gateway that does not
 * answer as not reachable.
 */
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Diagnostics, InstalledHarness, IpcError } from '../../src/shared/ipc.js';
import {
  connectivityResult,
  FAKE_DEFAULT_STORE_URL,
  FAKE_DIAGNOSTICS,
  installFakeApi,
  renderApp,
} from './render-app.js';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

const STAGING = 'https://staging.store.test';

function error(code: IpcError['code'], message: string, params?: IpcError['params']): IpcError {
  return {
    code,
    messageKey: `error.${code}`,
    message,
    ...(params === undefined ? {} : { params }),
  };
}

/** An installed Store Harness, with an update when `update` is given. */
function installed(harnessId: string, update?: string): InstalledHarness {
  // Only `availableUpdate` matters to Check now's count.
  const manifest = { id: harnessId, version: '1.0.0' } as InstalledHarness['manifest'];
  return {
    harnessId,
    version: '1.0.0',
    name: harnessId,
    publisher: harnessId.split('/')[0] ?? harnessId,
    source: 'store',
    manifest,
    installPath: `/profile/harnesses/${harnessId}/1.0.0`,
    installedAt: '2026-10-28T09:00:00.000Z',
    lastLaunchedAt: null,
    iconDataUrl: null,
    platformSupported: true,
    storeStatus: 'available',
    availableUpdate:
      update === undefined ? null : { version: update, manifest: { ...manifest, version: update } },
  };
}

/** The nearest ancestor of `element` matching `selector`; throws when there is none. */
function enclosing(element: Element, selector: string): HTMLElement {
  const found = element.closest<HTMLElement>(selector);
  if (found === null) throw new Error(`No ${selector} around the element`);
  return found;
}

/** Lets the pending IPC answers settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function change(element: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.change(element, { target: { value } });
    await Promise.resolve();
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

describe('language (How to verify, step 3)', () => {
  it('changes a nav label in place: the same element, no reload of the app', async () => {
    const api = installFakeApi('en');
    await renderApp('#/settings');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const library = within(nav).getByRole('link', { name: 'Library' });

    await change(screen.getByLabelText('Language'), 'zh-CN');

    expect(api.settings.set).toHaveBeenCalledWith({ locale: 'zh-CN' });
    expect(library.isConnected).toBe(true);
    expect(library.textContent).toBe('资源库');
    // The page itself stayed: the diagnostics were read once, when it opened.
    expect(api.diagnostics.get).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('检查 Harness 更新').isConnected).toBe(true);
  });
});

describe('the page in each language', () => {
  it('lays out every section in en', async () => {
    installFakeApi('en');
    await renderApp('#/settings');
    await screen.findByText('Running on port 51234');
    for (const name of ['Data location', 'First-run setup', 'Usage data', 'Diagnostics']) {
      expect(screen.getByRole('heading', { name })).toBeDefined();
    }
    expect(screen.getByLabelText('Language')).toBeDefined();
    expect(screen.getByLabelText('Check for Harness updates')).toBeDefined();
    expect(screen.getByText('Advanced')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Copy diagnostics' })).toBeDefined();
  });

  it('lays out every section in zh-CN', async () => {
    installFakeApi('zh-CN');
    await renderApp('#/settings');
    await screen.findByText('运行中，端口 51234');
    for (const name of ['数据位置', '首次设置', '用量数据', '诊断信息']) {
      expect(screen.getByRole('heading', { name })).toBeDefined();
    }
    expect(screen.getByText('高级')).toBeDefined();
    expect(screen.getByRole('button', { name: '立即检查' })).toBeDefined();
    expect(screen.getByRole('button', { name: '打开日志文件夹' })).toBeDefined();
    expect(screen.getByRole('button', { name: '复制诊断信息' })).toBeDefined();
    const interval = screen.getByLabelText<HTMLSelectElement>('检查 Harness 更新');
    expect([...interval.options].map((option) => option.text)).toEqual([
      '每小时',
      '每 6 小时',
      '每 24 小时',
      '从不',
    ]);
  });
});

describe('Check for Harness updates', () => {
  it('lists 1 hour, 6 hours (chosen), 24 hours and Never, and applies a choice at once', async () => {
    const api = installFakeApi('en');
    await renderApp('#/settings');
    const select = screen.getByLabelText<HTMLSelectElement>('Check for Harness updates');
    expect(select.value).toBe('6h');
    expect([...select.options].map((option) => option.text)).toEqual([
      'Every hour',
      'Every 6 hours',
      'Every 24 hours',
      'Never',
    ]);
    await change(select, 'never');
    expect(api.settings.set).toHaveBeenCalledWith({ updateCheckInterval: 'never' });
    expect(select.value).toBe('never');
  });

  it('Check now checks and says how many updates there are', async () => {
    const api = installFakeApi('en');
    api.installs.list.mockResolvedValue({
      ok: true,
      data: [installed('acme/one', '2.0.0'), installed('acme/two', '1.1.0'), installed('acme/x')],
    });
    await renderApp('#/settings');
    await click(screen.getByRole('button', { name: 'Check now' }));
    await settle();
    expect(api.installs.checkUpdates).toHaveBeenCalledOnce();
    expect(await screen.findByText('Checked the Store. 2 updates available.')).toBeDefined();
  });

  it('says so when there is no update, in zh-CN', async () => {
    installFakeApi('zh-CN');
    await renderApp('#/settings');
    await click(screen.getByRole('button', { name: '立即检查' }));
    expect(await screen.findByText('已检查商店，没有可用更新。')).toBeDefined();
  });

  it('is off while offline, and shows store_unreachable when the Store did not answer', async () => {
    const api = installFakeApi('en');
    api.connectivity.get.mockResolvedValue(connectivityResult('offline'));
    await renderApp('#/settings');
    await settle();
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Check now' });
    expect(button.disabled).toBe(true);

    api.installs.checkUpdates.mockResolvedValue({
      ok: false,
      error: error('store_unreachable', 'The Store did not answer.'),
    });
    await act(async () => {
      api.emit('connectivity.changed', { state: 'online' });
      await Promise.resolve();
    });
    expect(button.disabled).toBe(false);
    await click(button);
    await settle();
    expect(screen.getByRole('alert').textContent).toBe(
      'The Store did not answer. Check your connection and try again.',
    );
  });
});

describe('Data location (acceptance: each opens the correct folder)', () => {
  it('shows the data root and opens it and the logs folder', async () => {
    const api = installFakeApi('en');
    await renderApp('#/settings');
    const section = enclosing(
      await screen.findByRole('heading', { name: 'Data location' }),
      'section',
    );
    expect(await within(section).findByText('/profile')).toBeDefined();

    await click(within(section).getByRole('button', { name: 'Open folder' }));
    await click(within(section).getByRole('button', { name: 'Open logs folder' }));
    expect(api.app.openFolder.mock.calls).toEqual([['dataRoot'], ['logs']]);
  });

  it('shows open_failed with the path', async () => {
    const api = installFakeApi('en');
    api.app.openFolder.mockResolvedValue({
      ok: false,
      error: error('open_failed', 'Could not open.', { path: '/profile/logs' }),
    });
    await renderApp('#/settings');
    await click(screen.getByRole('button', { name: 'Open logs folder' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('"/profile/logs"');
  });
});

describe('Store URL (acceptance: a persistent banner while it is not the default)', () => {
  function storeUrlField() {
    return screen.getByLabelText<HTMLInputElement>('Store URL');
  }

  it('sits collapsed under Advanced, showing the default Store', async () => {
    installFakeApi('en');
    await renderApp('#/settings');
    const details = enclosing(screen.getByText('Advanced'), 'details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(storeUrlField().value).toBe(FAKE_DEFAULT_STORE_URL);
    expect(screen.getByText(`Default: ${FAKE_DEFAULT_STORE_URL}`, { exact: false })).toBeDefined();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' }).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Use default' })).toBeNull();
    expect(screen.queryByText(/custom Store/)).toBeNull();
  });

  it('applies with Apply only, then shows the banner on every main screen until Use default', async () => {
    const api = installFakeApi('en');
    await renderApp('#/settings');
    await change(storeUrlField(), `  ${STAGING}/ `);
    expect(api.settings.set).not.toHaveBeenCalled();

    await click(screen.getByRole('button', { name: 'Apply' }));
    await settle();
    expect(api.settings.set).toHaveBeenCalledWith({ storeBaseUrl: `${STAGING}/` });
    expect(storeUrlField().value).toBe(STAGING);
    expect(screen.getByText('Store URL changed')).toBeDefined();
    const banner = screen.getByText(`You're using a custom Store: ${STAGING}`);
    expect(banner).toBeDefined();
    // It cannot be dismissed: no button in it, only the link to Settings.
    const bannerBox = enclosing(banner, '.custom-store-banner');
    expect(within(bannerBox).queryByRole('button')).toBeNull();
    expect(
      within(bannerBox).getByRole('link', { name: 'Change in Settings' }).getAttribute('href'),
    ).toBe('#/settings');

    for (const label of ['Library', 'Store', 'Models', 'Usage']) {
      await click(screen.getByRole('link', { name: label }));
      expect(screen.getByText(`You're using a custom Store: ${STAGING}`)).toBeDefined();
    }

    await click(screen.getByRole('link', { name: 'Settings' }));
    await click(screen.getByRole('button', { name: 'Use default' }));
    await settle();
    expect(api.settings.set).toHaveBeenLastCalledWith({ storeBaseUrl: null });
    expect(screen.queryByText(/custom Store/)).toBeNull();
    expect(storeUrlField().value).toBe(FAKE_DEFAULT_STORE_URL);
  });

  it('a stored custom URL shows the banner from the start, in zh-CN too, but not on the wizard', async () => {
    const api = installFakeApi('zh-CN');
    api.settings.get.mockResolvedValue({
      ok: true,
      data: {
        resolvedLocale: 'zh-CN',
        onboardingDone: true,
        updateCheckInterval: '6h',
        storeBaseUrl: STAGING,
        defaultStoreBaseUrl: FAKE_DEFAULT_STORE_URL,
      },
    });
    await renderApp('#/library');
    expect(screen.getByText(`正在使用自定义商店：${STAGING}`)).toBeDefined();
    expect(screen.getByRole('link', { name: '在设置中更改' })).toBeDefined();
    cleanup();
    await renderApp('#/onboarding');
    expect(screen.queryByText(/自定义商店/)).toBeNull();
  });

  it('explains a URL main refuses beside the field, and keeps the default Store', async () => {
    const api = installFakeApi('en');
    api.settings.set.mockResolvedValue({
      ok: false,
      error: error('invalid_input', 'Invalid request.', { method: 'settings.set' }),
    });
    await renderApp('#/settings');
    await change(storeUrlField(), 'ftp://store.test');
    await click(screen.getByRole('button', { name: 'Apply' }));
    await settle();
    expect(screen.getByRole('alert').textContent).toBe(
      'Enter an http:// or https:// address without a user name, password, query or fragment.',
    );
    expect(storeUrlField().getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText(/custom Store/)).toBeNull();

    // Typing again clears it.
    await change(storeUrlField(), 'https://store.test');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Re-run setup (acceptance: no Connection is removed or reset)', () => {
  it('opens the wizard at Welcome and writes nothing', async () => {
    const api = installFakeApi('en');
    await renderApp('#/settings');
    await click(screen.getByRole('button', { name: 'Re-run setup' }));
    expect(window.location.hash).toBe('#/onboarding');
    expect(api.settings.set).not.toHaveBeenCalled();
    expect(api.connections.remove).not.toHaveBeenCalled();
    expect(api.connections.update).not.toHaveBeenCalled();
    expect(api.bindings.setGlobal).not.toHaveBeenCalled();
  });
});

describe('Clear usage data', () => {
  it('asks first, then clears every Usage Record', async () => {
    const api = installFakeApi('en');
    await renderApp('#/settings');
    await click(screen.getByRole('button', { name: 'Clear usage data' }));
    const dialog = screen.getByRole('dialog', { name: 'Clear usage data?' });
    expect(
      within(dialog).getByText('This deletes every Usage Record on this machine.'),
    ).toBeDefined();
    expect(api.usage.clear).not.toHaveBeenCalled();

    await click(within(dialog).getByRole('button', { name: 'Clear usage data' }));
    await settle();
    expect(api.usage.clear).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Usage data cleared')).toBeDefined();
  });
});

describe('diagnostics (How to verify, step 4)', () => {
  const unreachable: Diagnostics = {
    ...FAKE_DIAGNOSTICS,
    gateway: { running: true, port: 51234, reachable: false },
  };

  it('shows every field, and a Gateway that does not answer as not reachable', async () => {
    const api = installFakeApi('en');
    api.diagnostics.get.mockResolvedValue({ ok: true, data: unreachable });
    await renderApp('#/settings');
    const section = enclosing(
      await screen.findByRole('heading', { name: 'Diagnostics' }),
      'section',
    );
    expect(within(section).getByText('Not reachable on port 51234')).toBeDefined();
    expect(within(section).queryByText('Running on port 51234')).toBeNull();
    expect(within(section).getByText('24.1.0')).toBeDefined();
    expect(within(section).getByText('/profile')).toBeDefined();
    expect(within(section).getByText('/profile/harness-store.sqlite')).toBeDefined();
    expect(within(section).getByText('4.5.6')).toBeDefined();
  });

  it('Copy has main copy them, then reads them again: the status shown is the live one', async () => {
    const api = installFakeApi('en');
    await renderApp('#/settings');
    expect(await screen.findByText('Running on port 51234')).toBeDefined();

    api.diagnostics.get.mockResolvedValue({ ok: true, data: unreachable });
    await click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    await settle();
    expect(api.diagnostics.copy).toHaveBeenCalledOnce();
    expect(api.diagnostics.copy).toHaveBeenCalledWith();
    expect(screen.getByText('Diagnostics copied')).toBeDefined();
    expect(api.diagnostics.get).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Not reachable on port 51234')).toBeDefined();
  });

  it('shows not running in zh-CN', async () => {
    const api = installFakeApi('zh-CN');
    api.diagnostics.get.mockResolvedValue({
      ok: true,
      data: { ...FAKE_DIAGNOSTICS, gateway: { running: false } },
    });
    await renderApp('#/settings');
    expect(await screen.findByText('未运行')).toBeDefined();
    expect(screen.getByText('数据根目录')).toBeDefined();
  });

  it('shows not reachable in zh-CN', async () => {
    const api = installFakeApi('zh-CN');
    api.diagnostics.get.mockResolvedValue({ ok: true, data: unreachable });
    await renderApp('#/settings');
    expect(await screen.findByText('无法访问，端口 51234')).toBeDefined();
  });
});
