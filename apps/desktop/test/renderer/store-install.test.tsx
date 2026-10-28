// @vitest-environment jsdom
/**
 * Ticket P0-10.1: installing from a Store detail page (docs/ux/flows.md F2) over the fake
 * `window.api`, in en and zh-CN. Install downloads with progress on the button and Cancel; the
 * shared consent dialog opens once the package is verified, its Install enabled after one second
 * (fake timers); Install installs it, the button becomes Launch and a toast says so; Cancel in the
 * dialog, or during the download, discards it, also when the download was done as Cancel was
 * pressed; leaving the app's screens cancels the jobs; a checksum error shows under the button,
 * and Install retries. The dialog is the same component "Install this folder locally" uses.
 */
import type { Manifest } from '@harness-store/manifest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/renderer/src/i18n/I18nProvider.js';
import {
  CONSENT_READ_DELAY_MS,
  ConsentDialog,
} from '../../src/renderer/src/install/ConsentDialog.js';
import { TOAST_DURATION_MS } from '../../src/renderer/src/components/Toasts.js';
import type {
  InstalledHarness,
  InstalledVersion,
  IpcError,
  IpcResult,
  ManifestSummary,
  StoreDetail,
} from '../../src/shared/ipc.js';
import { installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const MANIFEST: Manifest = {
  manifestVersion: 1,
  id: 'alice/writer',
  version: '1.2.0',
  name: 'Writer',
  summary: 'Drafts and edits long texts.',
  license: 'MIT',
  platforms: ['darwin-arm64', 'linux-x64'],
  runtime: { kind: 'node', node: '22' },
  entry: 'dist/index.js',
  ui: { kind: 'web' },
  workspace: 'required',
  models: { slots: { default: {} } },
  permissions: {
    filesystem: { scope: 'home' },
    shell: true,
    network: { domains: ['api.example.com'] },
  },
};

const DETAIL: StoreDetail = {
  platform: 'darwin-arm64',
  storeStatus: 'available',
  harness: {
    harnessId: 'alice/writer',
    publisher: { login: 'alice', displayName: 'Alice', avatarUrl: null },
    iconUrl: null,
    downloadCount: 3,
    manifest: MANIFEST,
    readme: null,
    screenshotUrls: [],
    versions: [
      {
        version: '1.2.0',
        publishedAt: '2026-10-20T09:00:00.000Z',
        changelog: null,
        permissionsChanged: false,
      },
    ],
  },
};

const SUMMARY: ManifestSummary = {
  harnessId: 'alice/writer',
  version: '1.2.0',
  name: 'Writer',
  runtimeKind: 'node',
  uiKind: 'web',
  workspace: 'required',
  platforms: ['darwin-arm64', 'linux-x64'],
  entry: 'dist/index.js',
  permissions: MANIFEST.permissions,
  platformSupported: true,
};

const INSTALLED: InstalledHarness = {
  harnessId: 'alice/writer',
  version: '1.2.0',
  name: 'Writer',
  publisher: 'alice',
  source: 'store',
  manifest: MANIFEST,
  installPath: '/profile/harnesses/alice/writer/1.2.0',
  installedAt: '2026-10-28T09:00:00.000Z',
  lastLaunchedAt: null,
  iconDataUrl: null,
  platformSupported: true,
};

function error(code: IpcError['code'], message: string): IpcError {
  return { code, messageKey: `error.${code}`, message };
}

/** A promise the test settles. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

/**
 * The detail page of `alice/writer`, not installed, with `installs.install` and
 * `installs.confirm` waiting for the test.
 */
async function openDetail(locale: 'en' | 'zh-CN' = 'en') {
  const api = installFakeApi(locale);
  api.store.detail.mockResolvedValue({ ok: true, data: DETAIL });
  const install = deferred<IpcResult<ManifestSummary>>();
  const confirm = deferred<IpcResult<InstalledVersion>>();
  api.installs.install.mockReturnValue(install.promise);
  api.installs.confirm.mockReturnValue(confirm.promise);
  await renderApp('#/store/h/alice/writer');
  await settle();
  return { api, install, confirm };
}

function actions() {
  const container = document.querySelector('.listing-detail-actions');
  if (!(container instanceof HTMLElement)) throw new Error('No actions');
  return container;
}

function buttons() {
  return within(actions())
    .getAllByRole('button')
    .map((button) =>
      (button as HTMLButtonElement).disabled
        ? `${button.textContent} (disabled)`
        : button.textContent,
    );
}

/** The job ID the page chose for its `installs.install` call. */
function jobIdOf(api: ReturnType<typeof installFakeApi>): string {
  const request = api.installs.install.mock.calls[0]?.[0];
  if (request === undefined) throw new Error('installs.install was not called');
  return request.jobId;
}

/** The toast area, a polite live region. */
function toasts() {
  const area = document.querySelector('.toasts');
  if (!(area instanceof HTMLElement) || area.getAttribute('aria-live') !== 'polite') {
    throw new Error('No toast area');
  }
  return area;
}

describe('Install on a Store detail page', () => {
  it('downloads with progress, asks for consent, installs, then offers Launch with a toast', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { api, install, confirm } = await openDetail();
    expect(buttons()).toEqual(['Install']);

    fireEvent.click(within(actions()).getByRole('button', { name: 'Install' }));
    const jobId = jobIdOf(api);
    expect(api.installs.install).toHaveBeenCalledExactlyOnceWith({
      harnessId: 'alice/writer',
      jobId,
    });
    expect(buttons()).toEqual(['Downloading 0% (disabled)', 'Cancel']);
    act(() => {
      api.emit(`progress:${jobId}`, { received: 42, total: 100 });
    });
    expect(buttons()).toEqual(['Downloading 42% (disabled)', 'Cancel']);

    // Verified: the consent dialog opens, Install disabled for a second.
    await act(async () => {
      install.resolve({ ok: true, data: SUMMARY });
      await Promise.resolve();
    });
    const dialog = screen.getByRole('dialog', { name: 'Install Writer 1.2.0?' });
    expect(within(dialog).getByText('alice/writer · 1.2.0 · dist/index.js')).toBeDefined();
    expect(
      within(dialog).getByText(
        'Harness Store does not sandbox Harnesses. Installing means trusting this Publisher.',
      ),
    ).toBeDefined();
    const severities = within(within(dialog).getByRole('list', { name: 'Permissions' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent.split(' · ')[0]);
    expect(severities).toEqual(['High', 'High', 'Medium']);
    expect(
      within(within(dialog).getByRole('list', { name: 'About this Harness' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Runs on the bundled Node runtime',
      'Opens as a window',
      'Needs a folder to work in',
      'darwin-arm64',
      'linux-x64',
    ]);
    const installButton = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Install',
    });
    expect(installButton.disabled).toBe(true);
    // Behind the dialog the page offers to review it.
    expect(buttons()).toEqual(['Review and install']);
    act(() => {
      vi.advanceTimersByTime(CONSENT_READ_DELAY_MS);
    });
    expect(installButton.disabled).toBe(false);
    expect(api.installs.confirm).not.toHaveBeenCalled();

    fireEvent.click(installButton);
    expect(api.installs.confirm).toHaveBeenCalledExactlyOnceWith(jobId);
    api.installs.list.mockResolvedValue({ ok: true, data: [INSTALLED] });
    await act(async () => {
      confirm.resolve({ ok: true, data: { harnessId: 'alice/writer', version: '1.2.0' } });
      await Promise.resolve();
    });
    act(() => {
      api.emit('installs.changed', { harnessId: 'alice/writer' });
    });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(toasts()).getByText('Installed Writer')).toBeDefined();
    expect(buttons()).toEqual(['Launch', 'Uninstall (disabled)']);
    expect(api.installs.cancel).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS);
    });
    expect(within(toasts()).queryByText('Installed Writer')).toBeNull();
  });

  it('Cancel during the download stops it, with a toast, and offers Install again', async () => {
    const { api, install } = await openDetail();
    fireEvent.click(within(actions()).getByRole('button', { name: 'Install' }));
    const jobId = jobIdOf(api);
    fireEvent.click(within(actions()).getByRole('button', { name: 'Cancel' }));
    expect(api.installs.cancel).toHaveBeenCalledExactlyOnceWith(jobId);
    await act(async () => {
      install.resolve({
        ok: false,
        error: error('download_cancelled', 'The download was cancelled.'),
      });
      await Promise.resolve();
    });
    expect(within(toasts()).getByText('Download cancelled')).toBeDefined();
    expect(buttons()).toEqual(['Install']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Cancel as the download finishes discards it rather than asking for consent', async () => {
    const { api, install } = await openDetail();
    fireEvent.click(within(actions()).getByRole('button', { name: 'Install' }));
    const jobId = jobIdOf(api);
    fireEvent.click(within(actions()).getByRole('button', { name: 'Cancel' }));
    // Main had verified the package before the Cancel reached it, and answered.
    await act(async () => {
      install.resolve({ ok: true, data: SUMMARY });
      await Promise.resolve();
    });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(toasts()).getByText('Download cancelled')).toBeDefined();
    expect(buttons()).toEqual(['Install']);
    // Cancelled again, now that it waits for consent in main.
    expect(api.installs.cancel.mock.calls).toEqual([[jobId], [jobId]]);
    expect(api.installs.confirm).not.toHaveBeenCalled();
  });

  it('cancels its jobs when it goes away, and a download done after that', async () => {
    const { api, install } = await openDetail();
    fireEvent.click(within(actions()).getByRole('button', { name: 'Install' }));
    const jobId = jobIdOf(api);
    cleanup();
    expect(api.installs.cancel).toHaveBeenCalledExactlyOnceWith(jobId);
    await act(async () => {
      install.resolve({ ok: true, data: SUMMARY });
      await Promise.resolve();
    });
    await settle();
    expect(api.installs.cancel.mock.calls).toEqual([[jobId], [jobId]]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Cancel in the consent dialog discards the download', async () => {
    const { api, install } = await openDetail();
    fireEvent.click(within(actions()).getByRole('button', { name: 'Install' }));
    const jobId = jobIdOf(api);
    await act(async () => {
      install.resolve({ ok: true, data: SUMMARY });
      await Promise.resolve();
    });
    const dialog = screen.getByRole('dialog', { name: 'Install Writer 1.2.0?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.installs.cancel).toHaveBeenCalledExactlyOnceWith(jobId);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(buttons()).toEqual(['Install']);
    expect(api.installs.confirm).not.toHaveBeenCalled();
  });

  it('a checksum error shows under the button, and Install downloads again', async () => {
    const { api, install } = await openDetail();
    fireEvent.click(within(actions()).getByRole('button', { name: 'Install' }));
    await act(async () => {
      install.resolve({
        ok: false,
        error: error('checksum_mismatch', 'The downloaded package did not match.'),
      });
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(actions()).getByRole('alert').textContent).toBe(
      "The downloaded package did not match the Store's checksum. Nothing was installed. Try again.",
    );
    expect(buttons()).toEqual(['Install']);

    api.installs.install.mockReturnValue(new Promise(() => undefined));
    fireEvent.click(within(actions()).getByRole('button', { name: 'Install' }));
    expect(api.installs.install).toHaveBeenCalledTimes(2);
    expect(within(actions()).queryByRole('alert')).toBeNull();
  });

  it('keeps the download going while the User browses elsewhere', async () => {
    const { api } = await openDetail();
    fireEvent.click(within(actions()).getByRole('button', { name: 'Install' }));
    const jobId = jobIdOf(api);
    act(() => {
      api.emit(`progress:${jobId}`, { received: 30, total: 100 });
    });
    await act(async () => {
      window.location.hash = '#/library';
      await Promise.resolve();
    });
    await settle();
    act(() => {
      api.emit(`progress:${jobId}`, { received: 75, total: 100 });
    });
    await act(async () => {
      window.location.hash = '#/store/h/alice/writer';
      await Promise.resolve();
    });
    await settle();
    expect(buttons()).toEqual(['Downloading 75% (disabled)', 'Cancel']);
    expect(api.installs.install).toHaveBeenCalledOnce();
  });

  it('speaks zh-CN', async () => {
    const { api, install } = await openDetail('zh-CN');
    fireEvent.click(within(actions()).getByRole('button', { name: '安装' }));
    const jobId = jobIdOf(api);
    act(() => {
      api.emit(`progress:${jobId}`, { received: 1, total: 2 });
    });
    expect(buttons()).toEqual(['下载中 50% (disabled)', '取消']);
    await act(async () => {
      install.resolve({ ok: true, data: SUMMARY });
      await Promise.resolve();
    });
    const dialog = screen.getByRole('dialog', { name: '安装 Writer 1.2.0？' });
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDefined();
    expect(buttons()).toEqual(['查看权限并安装']);
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(buttons()).toEqual(['安装']);

    api.installs.install.mockResolvedValue({
      ok: false,
      error: error('checksum_mismatch', 'mismatch'),
    });
    await act(async () => {
      fireEvent.click(within(actions()).getByRole('button', { name: '安装' }));
      await Promise.resolve();
    });
    await settle();
    expect(within(actions()).getByRole('alert').textContent).toBe(
      '下载的 Harness 包与商店提供的校验值不一致，未安装任何内容。请重试。',
    );
  });
});

describe('ConsentDialog', () => {
  it('disables Install when it opens and enables it after one second', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    installFakeApi();
    const onInstall = vi.fn();
    await act(async () => {
      render(
        <I18nProvider>
          <ConsentDialog
            summary={SUMMARY}
            installing={false}
            error={null}
            onInstall={onInstall}
            onCancel={() => undefined}
          />
        </I18nProvider>,
      );
      await Promise.resolve();
    });
    const install = screen.getByRole<HTMLButtonElement>('button', { name: 'Install' });
    expect(install.disabled).toBe(true);
    fireEvent.click(install);
    act(() => {
      vi.advanceTimersByTime(CONSENT_READ_DELAY_MS - 1);
    });
    expect(install.disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(install.disabled).toBe(false);
    fireEvent.click(install);
    expect(onInstall).toHaveBeenCalledOnce();
  });
});
