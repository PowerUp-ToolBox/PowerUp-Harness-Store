// @vitest-environment jsdom
/**
 * Ticket P0-08.3: the Publish screen's "My Harnesses" tab, over the fake `window.api`. It lists
 * every Harness and Harness Version `publish.myHarnesses` answers, with each version's status (the
 * date of an Unpublish, the administrator's note on a Takedown) and downloads. Unpublish opens a
 * confirmation that names the version and says existing installs keep working; confirming calls
 * `publish.unpublish` once and reads the list again, which shows the new status and the Harness's
 * new current version. Offline, Unpublish is off.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translatorFor } from '../../src/shared/i18n/translate.js';
import type {
  IpcError,
  IpcResult,
  OwnHarness,
  OwnVersion,
  UnpublishedVersion,
} from '../../src/shared/ipc.js';
import { connectivityResult, FAKE_PUBLISHER, installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
});

function version(number: string, fields: Partial<OwnVersion> = {}): OwnVersion {
  return {
    version: number,
    status: 'published',
    publishedAt: '2026-10-01T09:00:00.000000+00:00',
    unpublishedAt: null,
    takedownNote: null,
    downloadCount: 0,
    ...fields,
  };
}

const NOTE = 'Taken down: it sends files to an unlisted domain.';

const HELLO_WEB: OwnHarness = {
  harnessId: 'octo-cat/hello-web',
  name: 'Hello Web',
  storeStatus: 'available',
  latestVersion: '1.2.0',
  downloadCount: 1_340,
  versions: [
    version('2.0.0', { status: 'taken_down', takedownNote: NOTE, downloadCount: 3 }),
    version('1.2.0', { downloadCount: 1_200 }),
    version('1.1.0', {
      status: 'unpublished',
      unpublishedAt: '2026-10-06T10:00:00.000000+00:00',
      downloadCount: 17,
    }),
    version('1.0.0', { downloadCount: 120 }),
  ],
};

const HELLO_TERM: OwnHarness = {
  harnessId: 'octo-cat/hello-term',
  name: 'Hello Term',
  storeStatus: 'taken_down',
  latestVersion: null,
  downloadCount: 40,
  versions: [version('0.1.0', { status: 'taken_down', takedownNote: NOTE, downloadCount: 40 })],
};

function failure(code: IpcError['code']) {
  const messageKey = `error.${code}` as const;
  return {
    ok: false as const,
    error: { code, messageKey, message: translatorFor('en').t(messageKey) },
  };
}

function signedIn(harnesses: readonly OwnHarness[] = [HELLO_WEB, HELLO_TERM]) {
  const api = installFakeApi('en');
  api.auth.whoami.mockResolvedValue({ ok: true, data: FAKE_PUBLISHER });
  api.publish.myHarnesses.mockResolvedValue({ ok: true, data: harnesses });
  return api;
}

/** Opens Publish on the "My Harnesses" tab, once the list is shown. */
async function openMine() {
  await renderApp('#/publish');
  fireEvent.click(await screen.findByRole('tab', { name: 'My Harnesses' }));
  await screen.findByRole('heading', { name: 'Hello Web' });
}

/** The table rows of a Harness's versions, by version. */
function rowOf(harness: string, number: string): HTMLElement {
  const table = screen.getByRole('table', { name: `Versions of ${harness}` });
  const row = within(table)
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByText(number) !== null);
  if (row === undefined) throw new Error(`No row for ${harness} ${number}`);
  return row;
}

describe('My Harnesses', () => {
  it('lists every Harness and version with its status, its downloads and the takedown note', async () => {
    signedIn();
    await openMine();
    expect(screen.getByRole('tab', { name: 'My Harnesses' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByText('octo-cat/hello-web')).toBeDefined();
    expect(screen.getByText('1,340 downloads')).toBeDefined();
    expect(screen.getByText('Current version in the Store: 1.2.0')).toBeDefined();

    expect(within(rowOf('Hello Web', '1.2.0')).getByText('Published')).toBeDefined();
    expect(within(rowOf('Hello Web', '1.2.0')).getByText('1,200')).toBeDefined();
    const unpublished = rowOf('Hello Web', '1.1.0');
    expect(within(unpublished).getByText('Unpublished')).toBeDefined();
    expect(within(unpublished).getByText('Unpublished on Oct 6, 2026')).toBeDefined();
    const takenDown = rowOf('Hello Web', '2.0.0');
    expect(within(takenDown).getByText('Taken down')).toBeDefined();
    expect(within(takenDown).getByText(`Administrator's note: ${NOTE}`)).toBeDefined();

    // Unpublish only on the published versions of a Harness that is not taken down.
    expect(within(rowOf('Hello Web', '1.2.0')).queryByRole('button')).not.toBeNull();
    expect(within(rowOf('Hello Web', '1.0.0')).queryByRole('button')).not.toBeNull();
    expect(within(unpublished).queryByRole('button')).toBeNull();
    expect(within(takenDown).queryByRole('button')).toBeNull();
    expect(within(rowOf('Hello Term', '0.1.0')).queryByRole('button')).toBeNull();
    expect(
      screen.getByText(
        'A Store administrator took this Harness down. It is hidden from the Store and gets no new version.',
      ),
    ).toBeDefined();
  });

  it('confirms an Unpublish naming the version and saying existing installs keep working', async () => {
    const api = signedIn();
    await openMine();
    fireEvent.click(
      within(rowOf('Hello Web', '1.2.0')).getByRole('button', {
        name: 'Unpublish Hello Web 1.2.0?',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Unpublish Hello Web 1.2.0?' });
    expect(
      within(dialog).getByText(
        'Existing installs keep working. This version can no longer be downloaded.',
      ),
    ).toBeDefined();
    // Cancel changes nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.publish.unpublish).not.toHaveBeenCalled();
  });

  it('Unpublishes, says so and reads the list again: the version is Unpublished and the previous one current', async () => {
    const api = signedIn();
    api.publish.unpublish.mockResolvedValue({
      ok: true,
      data: { harnessId: 'octo-cat/hello-web', version: '1.2.0', latestVersion: '1.0.0' },
    });
    await openMine();
    api.publish.myHarnesses.mockResolvedValue({
      ok: true,
      data: [
        {
          ...HELLO_WEB,
          latestVersion: '1.0.0',
          versions: HELLO_WEB.versions.map((row) =>
            row.version === '1.2.0'
              ? { ...row, status: 'unpublished', unpublishedAt: '2026-10-28T12:00:00.000000+00:00' }
              : row,
          ),
        },
        HELLO_TERM,
      ],
    });
    fireEvent.click(within(rowOf('Hello Web', '1.2.0')).getByRole('button'));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unpublish' }));

    expect(
      await screen.findByText('Unpublished Hello Web 1.2.0. Existing installs keep working.'),
    ).toBeDefined();
    expect(api.publish.unpublish).toHaveBeenCalledExactlyOnceWith({
      harnessId: 'octo-cat/hello-web',
      version: '1.2.0',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    await screen.findByText('Current version in the Store: 1.0.0');
    expect(api.publish.myHarnesses).toHaveBeenCalledTimes(2);
    const row = rowOf('Hello Web', '1.2.0');
    expect(within(row).getByText('Unpublished')).toBeDefined();
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it('a double click Unpublishes once, and shows no error', async () => {
    const api = signedIn();
    let answer: (result: IpcResult<UnpublishedVersion>) => void = () => undefined;
    api.publish.unpublish.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await openMine();
    fireEvent.click(within(rowOf('Hello Web', '1.0.0')).getByRole('button'));
    const confirm = within(screen.getByRole('dialog')).getByRole('button', { name: 'Unpublish' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(api.publish.unpublish).toHaveBeenCalledOnce();
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Unpublishing…' }),
    ).toHaveProperty('disabled', true);

    await act(async () => {
      answer({
        ok: true,
        data: { harnessId: 'octo-cat/hello-web', version: '1.0.0', latestVersion: '1.2.0' },
      });
      await Promise.resolve();
    });
    await screen.findByText('Unpublished Hello Web 1.0.0. Existing installs keep working.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("shows the Store's refusal in the dialog, translated", async () => {
    const api = signedIn();
    api.publish.unpublish.mockResolvedValue(failure('harness_taken_down'));
    await openMine();
    fireEvent.click(within(rowOf('Hello Web', '1.0.0')).getByRole('button'));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unpublish' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This Harness was taken down from the Store, so it cannot be changed.',
    );
  });

  it('offline: Unpublish is off, with the reason', async () => {
    const api = signedIn();
    api.connectivity.get.mockResolvedValue(connectivityResult('offline'));
    await openMine();
    expect(
      screen.getByText("Unpublishing needs the Store. You're offline, so Unpublish is off."),
    ).toBeDefined();
    expect(within(rowOf('Hello Web', '1.2.0')).getByRole('button')).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('says when the Publisher has published nothing yet', async () => {
    signedIn([]);
    await renderApp('#/publish');
    fireEvent.click(await screen.findByRole('tab', { name: 'My Harnesses' }));
    expect(await screen.findByText('You have not published a Harness yet.')).toBeDefined();
  });

  it('shows a failed read with Retry, which reads the list again', async () => {
    const api = signedIn();
    api.publish.myHarnesses.mockResolvedValueOnce(failure('store_unreachable'));
    await renderApp('#/publish');
    fireEvent.click(await screen.findByRole('tab', { name: 'My Harnesses' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The Store did not answer. Check your connection and try again.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('heading', { name: 'Hello Web' });
    expect(api.publish.myHarnesses).toHaveBeenCalledTimes(2);
  });

  it('keeps the tab when the screen is left, and reads the list again on return', async () => {
    const api = signedIn();
    await openMine();
    fireEvent.click(screen.getByRole('link', { name: 'Library' }));
    await waitFor(() => {
      expect(screen.queryByRole('tab')).toBeNull();
    });
    fireEvent.click(screen.getByRole('link', { name: 'Publish' }));
    await screen.findByRole('heading', { name: 'Hello Web' });
    expect(screen.getByRole('tab', { name: 'My Harnesses' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(api.publish.myHarnesses).toHaveBeenCalledTimes(2);
  });

  it('has no tabs signed out', async () => {
    installFakeApi('en');
    await renderApp('#/publish');
    await screen.findByRole('button', { name: 'Sign in with GitHub' });
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('speaks Simplified Chinese', async () => {
    const api = signedIn();
    api.settings.get.mockResolvedValue({
      ok: true,
      data: { locale: 'zh-CN', resolvedLocale: 'zh-CN', onboardingDone: true },
    });
    await renderApp('#/publish');
    fireEvent.click(await screen.findByRole('tab', { name: '我的 Harness' }));
    await screen.findByRole('heading', { name: 'Hello Web' });
    fireEvent.click(screen.getByRole('button', { name: '撤下 Hello Web 1.2.0？' }));
    const dialog = screen.getByRole('dialog', { name: '撤下 Hello Web 1.2.0？' });
    expect(within(dialog).getByText('已安装的用户不受影响。此版本将无法再被下载。')).toBeDefined();
  });
});
