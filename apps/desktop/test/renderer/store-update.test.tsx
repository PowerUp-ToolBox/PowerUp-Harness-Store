// @vitest-environment jsdom
/**
 * Ticket P0-10.2: updates in the renderer (docs/ux/flows.md F4) over the fake `window.api`, in en
 * and zh-CN. The Library nav item counts the installs with an update; a card offers Update, or
 * "Review update" when the update needs the User's consent again, with Launch as the secondary
 * link. A simple update runs in one click with its progress and Cancel on the button and a toast
 * once done; one that needs consent again opens the update prompt first, whose "New:" lines are
 * exactly what `diffForReconsent` adds (How to verify, step 3), with the changelog, and whose
 * Update is enabled after one second. A Harness the Store no longer offers has a note and no
 * Update; an update refused because the Harness runs says "Close the Harness to update".
 */
import { diffForReconsent, type Manifest } from '@harness-store/manifest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_READ_DELAY_MS } from '../../src/renderer/src/install/ConsentDialog.js';
import { translatorFor } from '../../src/shared/i18n/translate.js';
import type {
  InstalledHarness,
  InstalledVersion,
  IpcError,
  IpcResult,
  LaunchStatus,
  StoreDetail,
} from '../../src/shared/ipc.js';
import { reconsentChanges } from '../../src/shared/permissions.js';
import { installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const V1: Manifest = {
  manifestVersion: 1,
  id: 'alice/writer',
  version: '1.0.0',
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
    filesystem: { scope: 'workspace' },
    shell: false,
    network: { domains: ['api.example.com', 'cdn.example.com'] },
  },
};

/** Narrows a permission: no re-consent. */
const V2_NARROWED: Manifest = {
  ...V1,
  version: '1.1.0',
  changelog: 'Fewer network calls.',
  permissions: { ...V1.permissions, network: { domains: ['api.example.com'] } },
};

/** Widens the permissions (shell on, a new domain, the home folder) and changes the Entry. */
const V2_WIDENED: Manifest = {
  ...V1,
  version: '1.1.0',
  entry: 'dist/main.js',
  changelog: 'Adds a **terminal** for builds.',
  permissions: {
    filesystem: { scope: 'home' },
    shell: true,
    network: { domains: ['api.example.com', 'cdn.example.com', 'builds.example.com'] },
  },
};

function installed(fields: Partial<InstalledHarness> = {}): InstalledHarness {
  return {
    harnessId: 'alice/writer',
    version: '1.0.0',
    name: 'Writer',
    publisher: 'alice',
    source: 'store',
    manifest: V1,
    installPath: '/profile/harnesses/alice/writer/1.0.0',
    installedAt: '2026-10-28T09:00:00.000Z',
    lastLaunchedAt: null,
    iconDataUrl: null,
    platformSupported: true,
    storeStatus: 'available',
    availableUpdate: null,
    ...fields,
  };
}

const withUpdate = (target: Manifest, fields: Partial<InstalledHarness> = {}) =>
  installed({ availableUpdate: { version: target.version, manifest: target }, ...fields });

function error(code: IpcError['code'], message: string): IpcError {
  return { code, messageKey: `error.${code}`, message };
}

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

/** The Library with `installs`, `installs.update` waiting for the test. */
async function openLibrary(
  installs: readonly InstalledHarness[],
  locale: 'en' | 'zh-CN' = 'en',
  launches: readonly LaunchStatus[] = [],
) {
  const api = installFakeApi(locale);
  api.installs.list.mockResolvedValue({ ok: true, data: installs });
  api.launch.status.mockResolvedValue({ ok: true, data: launches });
  const update = deferred<IpcResult<InstalledVersion>>();
  api.installs.update.mockReturnValue(update.promise);
  await renderApp('#/library');
  await settle();
  return { api, update };
}

function card(name: string) {
  return screen.getByRole('article', { name });
}

function cardButtons(name: string) {
  return within(card(name))
    .getAllByRole('button')
    .filter((button) => !button.classList.contains('card-menu-button'))
    .map((button) =>
      (button as HTMLButtonElement).disabled
        ? `${button.textContent} (disabled)`
        : button.textContent,
    );
}

/** The job ID of the first `installs.update` call. */
function updateRequest(api: ReturnType<typeof installFakeApi>) {
  const request = api.installs.update.mock.calls[0]?.[0];
  if (request === undefined) throw new Error('installs.update was not called');
  return request;
}

/** Each "What changed" line of the update prompt. */
function changeLines(dialog: HTMLElement, title: string) {
  const section = within(dialog).getByRole('region', { name: title });
  return within(section)
    .getAllByRole('listitem')
    .map((item) => item.textContent);
}

describe('the Library nav badge (acceptance: an update shows in the nav)', () => {
  it('counts the installs with an update, and follows installs.changed', async () => {
    const { api } = await openLibrary([
      withUpdate(V2_NARROWED),
      installed({ harnessId: 'alice/other', name: 'Other' }),
    ]);
    const library = screen.getByRole('link', { name: /^Library/ });
    expect(within(library).getByRole('img', { name: '1 update available' }).textContent).toBe('1');

    api.installs.list.mockResolvedValue({ ok: true, data: [installed()] });
    act(() => {
      api.emit('installs.changed', { harnessId: 'alice/writer' });
    });
    await settle();
    expect(within(library).queryByRole('img')).toBeNull();
  });

  it('says it in zh-CN', async () => {
    await openLibrary([withUpdate(V2_NARROWED)], 'zh-CN');
    const library = screen.getByRole('link', { name: /^资源库/ });
    expect(within(library).getByRole('img', { name: '1 个可用更新' })).toBeDefined();
  });
});

describe('a Library card with an update', () => {
  it('offers Update with Launch as the secondary action; a local install never does', async () => {
    await openLibrary([
      withUpdate(V2_NARROWED),
      installed({
        harnessId: 'alice/local',
        name: 'Local one',
        source: 'local',
        storeStatus: null,
      }),
    ]);
    expect(cardButtons('Writer')).toEqual(['Update', 'Launch']);
    expect(cardButtons('Local one')).toEqual(['Launch']);
  });

  it('a simple update runs in one click, with progress and Cancel, then a toast', async () => {
    const { api, update } = await openLibrary([withUpdate(V2_NARROWED)]);
    fireEvent.click(within(card('Writer')).getByRole('button', { name: 'Update' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const request = updateRequest(api);
    expect(request).toEqual({
      harnessId: 'alice/writer',
      version: '1.1.0',
      jobId: request.jobId,
      reconsented: false,
    });
    expect(cardButtons('Writer')).toEqual(['Downloading 0% (disabled)', 'Cancel']);
    act(() => {
      api.emit(`progress:${request.jobId}`, { received: 30, total: 100 });
    });
    expect(cardButtons('Writer')).toEqual(['Downloading 30% (disabled)', 'Cancel']);

    api.installs.list.mockResolvedValue({
      ok: true,
      data: [installed({ version: '1.1.0', manifest: V2_NARROWED })],
    });
    await act(async () => {
      update.resolve({ ok: true, data: { harnessId: 'alice/writer', version: '1.1.0' } });
      await Promise.resolve();
    });
    act(() => {
      api.emit('installs.changed', { harnessId: 'alice/writer' });
    });
    await settle();
    expect(
      screen.getByText('Updated Writer to 1.1.0. See the changelog in Version history.'),
    ).toBeDefined();
    expect(cardButtons('Writer')).toEqual(['Launch']);
  });

  it('Cancel during the download stops it, with a toast', async () => {
    const { api, update } = await openLibrary([withUpdate(V2_NARROWED)]);
    fireEvent.click(within(card('Writer')).getByRole('button', { name: 'Update' }));
    const { jobId } = updateRequest(api);
    fireEvent.click(within(card('Writer')).getByRole('button', { name: 'Cancel' }));
    expect(api.installs.cancel).toHaveBeenCalledExactlyOnceWith(jobId);
    await act(async () => {
      update.resolve({ ok: false, error: error('download_cancelled', 'Cancelled.') });
      await Promise.resolve();
    });
    await settle();
    expect(screen.getByText('Download cancelled')).toBeDefined();
    expect(cardButtons('Writer')).toEqual(['Update', 'Launch']);
  });

  it('a corrupted download shows its error under the button, and Update retries', async () => {
    const { api, update } = await openLibrary([withUpdate(V2_NARROWED)]);
    fireEvent.click(within(card('Writer')).getByRole('button', { name: 'Update' }));
    await act(async () => {
      update.resolve({ ok: false, error: error('checksum_mismatch', 'Checksum.') });
      await Promise.resolve();
    });
    await settle();
    expect(within(card('Writer')).getByRole('alert').textContent).toBe(
      "The downloaded package did not match the Store's checksum. Nothing was installed. Try again.",
    );
    expect(cardButtons('Writer')).toEqual(['Update', 'Launch']);
    api.installs.update.mockResolvedValue({
      ok: true,
      data: { harnessId: 'alice/writer', version: '1.1.0' },
    });
    fireEvent.click(within(card('Writer')).getByRole('button', { name: 'Update' }));
    expect(api.installs.update).toHaveBeenCalledTimes(2);
  });

  it('an update refused because the Harness runs says to close it (How to verify, step 4)', async () => {
    const { api, update } = await openLibrary([withUpdate(V2_NARROWED)]);
    fireEvent.click(within(card('Writer')).getByRole('button', { name: 'Update' }));
    await act(async () => {
      update.resolve({ ok: false, error: error('harness_running', 'Running.') });
      await Promise.resolve();
    });
    await settle();
    expect(within(card('Writer')).getByRole('alert').textContent).toBe(
      'Close the Harness to update',
    );
    expect(api.installs.update).toHaveBeenCalledTimes(1);
  });

  it('while the Harness runs, the button is Running… and the card says to close it', async () => {
    await openLibrary([withUpdate(V2_NARROWED)], 'en', [
      {
        harnessId: 'alice/writer',
        launchId: 'launch-1',
        state: 'ready',
        startedAt: '2026-10-28T09:00:00.000Z',
      },
    ]);
    expect(cardButtons('Writer')).toEqual(['Running…', 'Show window']);
    expect(within(card('Writer')).getByText('Close the Harness to update')).toBeDefined();
  });

  it.each(['unpublished', 'taken_down'] as const)(
    'a Harness %s in the Store has the note and no Update',
    async (storeStatus) => {
      await openLibrary([installed({ storeStatus })]);
      expect(cardButtons('Writer')).toEqual(['Launch']);
      expect(within(card('Writer')).getByText('No longer available in the Store')).toBeDefined();
    },
  );
});

describe('the update prompt (How to verify, step 3)', () => {
  it('a widened update shows "Review update" and the prompt, whose New: lines are the diff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { api } = await openLibrary([withUpdate(V2_WIDENED)]);
    expect(cardButtons('Writer')).toEqual(['Review update', 'Launch']);

    fireEvent.click(within(card('Writer')).getByRole('button', { name: 'Review update' }));
    // Nothing is downloaded before the User consents.
    expect(api.installs.update).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Update available: 1.1.0' });
    expect(within(dialog).getByText('Writer 1.0.0 → 1.1.0')).toBeDefined();

    // Exactly the diff function's `added`, one "New:" line each, and no "Removed:" line.
    const { added } = diffForReconsent(V1, V2_WIDENED);
    const { t } = translatorFor('en');
    const lines = changeLines(dialog, 'What changed');
    expect(lines).toEqual(
      reconsentChanges(added).map((change) => {
        const text = t(change.messageKey, change.params);
        return `New: ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
      }),
    );
    expect(lines).toEqual([
      'New: accesses your home folder',
      'New: runs shell commands',
      'New: connects to: builds.example.com',
      'New: starts from dist/main.js',
    ]);
    expect(within(dialog).queryByText(/^Removed:/)).toBeNull();

    // The changelog, and the trust block of the new version with the no-sandbox sentence.
    const changelog = within(dialog).getByRole('region', { name: 'Changelog' });
    expect(changelog.textContent).toContain('Adds a terminal for builds.');
    expect(
      within(dialog).getByText(
        'Harness Store does not sandbox Harnesses. Installing means trusting this Publisher.',
      ),
    ).toBeDefined();

    const updateButton = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Update' });
    expect(updateButton.disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(CONSENT_READ_DELAY_MS);
    });
    expect(updateButton.disabled).toBe(false);
    fireEvent.click(updateButton);
    expect(screen.queryByRole('dialog')).toBeNull();
    const request = updateRequest(api);
    expect(request).toEqual({
      harnessId: 'alice/writer',
      version: '1.1.0',
      jobId: request.jobId,
      reconsented: true,
    });
    expect(cardButtons('Writer')).toEqual(['Downloading 0% (disabled)', 'Cancel']);
  });

  it('Not now closes it and downloads nothing', async () => {
    const { api } = await openLibrary([withUpdate(V2_WIDENED)]);
    fireEvent.click(within(card('Writer')).getByRole('button', { name: 'Review update' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.installs.update).not.toHaveBeenCalled();
    expect(cardButtons('Writer')).toEqual(['Review update', 'Launch']);
  });

  it('says that there is no changelog when the version has none', async () => {
    const withoutChangelog: Manifest = { ...V2_WIDENED };
    delete withoutChangelog.changelog;
    await openLibrary([withUpdate(withoutChangelog)]);
    fireEvent.click(within(card('Writer')).getByRole('button', { name: 'Review update' }));
    const changelog = within(screen.getByRole('dialog')).getByRole('region', {
      name: 'Changelog',
    });
    expect(changelog.textContent).toContain('The Publisher wrote no changelog for this version.');
  });

  it('in zh-CN', async () => {
    await openLibrary([withUpdate(V2_WIDENED)], 'zh-CN');
    expect(cardButtons('Writer')).toEqual(['查看更新', '启动']);
    fireEvent.click(within(card('Writer')).getByRole('button', { name: '查看更新' }));
    const dialog = screen.getByRole('dialog', { name: '有可用更新：1.1.0' });
    expect(changeLines(dialog, '权限变化')).toEqual([
      '新增：访问你的用户主目录',
      '新增：会执行命令行命令',
      '新增：访问以下网站：builds.example.com',
      '新增：从 dist/main.js 启动',
    ]);
    expect(within(dialog).getByRole('region', { name: '更新日志' })).toBeDefined();
    expect(within(dialog).getByRole('button', { name: '暂不' })).toBeDefined();
    expect(within(dialog).getByRole('button', { name: '更新' })).toBeDefined();
  });
});

describe('Update on a Store detail page', () => {
  const detail = (latest: Manifest): StoreDetail => ({
    platform: 'darwin-arm64',
    storeStatus: 'available',
    harness: {
      harnessId: 'alice/writer',
      publisher: { login: 'alice', displayName: 'Alice', avatarUrl: null },
      iconUrl: null,
      downloadCount: 3,
      manifest: latest,
      readme: null,
      screenshotUrls: [],
      versions: [
        {
          version: latest.version,
          publishedAt: '2026-10-28T09:00:00.000Z',
          changelog: latest.changelog ?? null,
          permissionsChanged: false,
        },
      ],
    },
  });

  async function openDetail(latest: Manifest) {
    const api = installFakeApi();
    api.store.detail.mockResolvedValue({ ok: true, data: detail(latest) });
    // The update check has not run: the page goes by the Store's latest version.
    api.installs.list.mockResolvedValue({ ok: true, data: [installed()] });
    await renderApp('#/store/h/alice/writer');
    await settle();
    const actions = document.querySelector('.listing-detail-actions');
    if (!(actions instanceof HTMLElement)) throw new Error('No actions');
    return { api, actions };
  }

  it('updates to the version the page shows, in one click when nothing widened', async () => {
    const { api, actions } = await openDetail(V2_NARROWED);
    fireEvent.click(within(actions).getByRole('button', { name: 'Update' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(updateRequest(api)).toMatchObject({ version: '1.1.0', reconsented: false });
  });

  it('"Review update" opens the update prompt first', async () => {
    const { api, actions } = await openDetail(V2_WIDENED);
    expect(
      within(actions)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Review update', 'Launch']);
    fireEvent.click(within(actions).getByRole('button', { name: 'Review update' }));
    expect(screen.getByRole('dialog', { name: 'Update available: 1.1.0' })).toBeDefined();
    expect(api.installs.update).not.toHaveBeenCalled();
  });

  it('an update refused because the Harness runs says "Close the Harness to update"', async () => {
    const { api, actions } = await openDetail(V2_NARROWED);
    api.installs.update.mockResolvedValue({
      ok: false,
      error: error('harness_running', 'Running.'),
    });
    fireEvent.click(within(actions).getByRole('button', { name: 'Update' }));
    await settle();
    expect(within(actions).getByRole('alert').textContent).toBe('Close the Harness to update');
  });
});
