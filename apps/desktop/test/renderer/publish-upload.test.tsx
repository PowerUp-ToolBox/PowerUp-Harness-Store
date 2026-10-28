// @vitest-environment jsdom
/**
 * Ticket P0-08.2: Publish on the review step, over the fake `window.api`. Publish uploads the
 * archive the validation built (`publish.publish`), the progress bar follows `progress:<jobId>`,
 * Cancel works until the whole request is sent, and the outcome is the success screen (its link
 * opens the listing, and it says published versions are immutable) or the Store's refusal, by its
 * code and problems, with Retry sending the same archive again. Offline, Publish is disabled and
 * nothing is attempted. An expired session asks to sign in again and keeps the folder.
 */
import type { Manifest, Problem } from '@harness-store/manifest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translatorFor } from '../../src/shared/i18n/translate.js';
import type {
  FolderValidation,
  IpcError,
  IpcResult,
  PublishedVersion,
} from '../../src/shared/ipc.js';
import { connectivityResult, FAKE_PUBLISHER, installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
});

const FOLDER = '/Users/octo/hello-web';

const MANIFEST: Manifest = {
  manifestVersion: 1,
  id: 'octo-cat/hello-web',
  version: '1.1.0',
  name: 'Hello Web',
  summary: 'Chat with your default model in a window.',
  license: 'MIT',
  platforms: ['darwin-arm64', 'linux-x64'],
  runtime: { kind: 'node', node: '22' },
  entry: 'dist/index.js',
  ui: { kind: 'web' },
  workspace: 'none',
  models: { slots: { default: { description: 'Answers the User.' } } },
  permissions: { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } },
};

const VALID: FolderValidation = {
  archiveId: 'archive-1',
  problems: [],
  warnings: [],
  manifest: MANIFEST,
  iconDataUrl: null,
  readme: null,
  excluded: ['.git/'],
  archiveSize: 12_400,
  versionCheck: 'checked',
  lastPublishedVersion: '1.0.0',
  isNew: false,
};

const PUBLISHED: PublishedVersion = {
  harnessId: 'octo-cat/hello-web',
  version: '1.1.0',
  url: '/store/h/octo-cat/hello-web',
};

/** A failed result as the Runtime answers it: the catalog's copy unless the Store sent its own. */
function failure(code: IpcError['code'], extra: Partial<IpcError> = {}) {
  const messageKey = `error.${code}` as const;
  return {
    ok: false as const,
    error: { code, messageKey, message: translatorFor('en').t(messageKey), ...extra },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function signedIn() {
  const api = installFakeApi('en');
  api.auth.whoami.mockResolvedValue({ ok: true, data: FAKE_PUBLISHER });
  api.installs.chooseFolder.mockResolvedValue({ ok: true, data: FOLDER });
  api.publish.validateFolder.mockResolvedValue({ ok: true, data: VALID });
  return api;
}

/** Chooses the folder, which validates without problems, and continues to the review. */
async function toReview() {
  await renderApp('#/publish');
  fireEvent.click(await screen.findByRole('button', { name: 'Choose a folder' }));
  await screen.findByText('No problems found.');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  return screen.getByRole<HTMLButtonElement>('button', { name: 'Publish' });
}

/** The job the renderer named in its `publish.publish` call. */
function jobOf(api: ReturnType<typeof signedIn>, call = 0): string {
  const request = api.publish.publish.mock.calls[call]?.[0];
  if (request === undefined) throw new Error('publish.publish was not called');
  return request.jobId;
}

describe('publishing from the review', () => {
  it('uploads the validated archive with a progress bar, then shows the success screen', async () => {
    const api = signedIn();
    const answer = deferred<IpcResult<PublishedVersion>>();
    api.publish.publish.mockReturnValue(answer.promise);
    fireEvent.click(await toReview());

    expect(api.publish.publish).toHaveBeenCalledExactlyOnceWith({
      archiveId: 'archive-1',
      jobId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
    });
    const jobId = jobOf(api);
    // Subscribed to the job's progress before the call, so no report is missed.
    const subscribe = api.on.mock.calls.findIndex(([event]) => event === `progress:${jobId}`);
    expect(api.on.mock.invocationCallOrder[subscribe]).toBeLessThan(
      api.publish.publish.mock.invocationCallOrder[0] ?? 0,
    );

    act(() => {
      api.emit(`progress:${jobId}`, { sent: 50, total: 200 });
    });
    expect(screen.getByText('Uploading 25%')).toBeDefined();
    const bar = screen.getByRole('progressbar', { name: 'Upload progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    // The folder can be neither changed nor checked again while it uploads.
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Choose another folder' }).disabled,
    ).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Re-check' }).disabled).toBe(true);

    act(() => {
      api.emit(`progress:${jobId}`, { sent: 200, total: 200 });
    });
    expect(screen.getByText(/^Processing…/)).toBeDefined();
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel upload' }).disabled).toBe(
      true,
    );

    await act(async () => {
      answer.resolve({ ok: true, data: PUBLISHED });
      await answer.promise;
    });
    expect(
      screen.getByText(
        'Published! Versions are immutable; publish a new version to change anything.',
      ),
    ).toBeDefined();
    expect(screen.getByText('octo-cat/hello-web 1.1.0 is now in the Store.')).toBeDefined();
    expect(api.publish.stopWatching).toHaveBeenCalledOnce();
    expect(screen.queryByRole('progressbar')).toBeNull();

    const link = screen.getByRole('link', { name: 'View listing' });
    expect(link.getAttribute('href')).toBe('#/store/h/octo-cat/hello-web');
    fireEvent.click(link);
    await waitFor(() => {
      expect(window.location.hash).toBe('#/store/h/octo-cat/hello-web');
    });
  });

  it('Publish another starts again with no folder', async () => {
    const api = signedIn();
    api.publish.publish.mockResolvedValue({ ok: true, data: PUBLISHED });
    fireEvent.click(await toReview());
    fireEvent.click(await screen.findByRole('button', { name: 'Publish another' }));
    expect(await screen.findByRole('button', { name: 'Choose a folder' })).toBeDefined();
    expect(screen.queryByText(FOLDER)).toBeNull();
  });

  it('Cancel aborts the upload while it is sent, back to the review saying so', async () => {
    const api = signedIn();
    const answer = deferred<IpcResult<PublishedVersion>>();
    api.publish.publish.mockReturnValue(answer.promise);
    fireEvent.click(await toReview());
    const jobId = jobOf(api);
    act(() => {
      api.emit(`progress:${jobId}`, { sent: 64, total: 200 });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
    expect(api.publish.cancel).toHaveBeenCalledExactlyOnceWith(jobId);

    await act(async () => {
      answer.resolve(failure('upload_cancelled'));
      await answer.promise;
    });
    expect(screen.getByText('Upload cancelled. Nothing was published.')).toBeDefined();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Publish' }).disabled).toBe(false);
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('a refusal shows the Store’s code and problems; Retry sends the same archive again', async () => {
    const api = signedIn();
    const problem: Problem = {
      path: 'version',
      code: 'version_not_greater',
      messageKey: 'version_not_greater',
      params: { version: '1.1.0', latest: '1.1.0' },
      message: 'Version 1.1.0 must be greater than every published version; the latest is 1.1.0.',
    };
    api.publish.publish.mockResolvedValueOnce(
      failure('version_not_greater', { message: 'Not greater.', problems: [problem] }),
    );
    fireEvent.click(await toReview());

    const panel = await screen.findByRole('alert');
    expect(within(panel).getByText('The Store did not publish this version.')).toBeDefined();
    expect(
      within(panel).getByText(
        'The Store already has this version of the Harness, or a greater one. Raise "version" in the Manifest.',
      ),
    ).toBeDefined();
    expect(within(panel).getByText('version_not_greater', { selector: 'p > code' })).toBeDefined();
    const [row] = within(panel).getAllByRole('listitem');
    expect(row?.textContent).toBe(
      `version${translatorFor('en').problemText(problem)}version_not_greater`,
    );

    api.publish.publish.mockResolvedValueOnce({ ok: true, data: PUBLISHED });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'View listing' })).toBeDefined();
    expect(api.publish.publish).toHaveBeenCalledTimes(2);
    expect(api.publish.publish.mock.calls[1]?.[0]).toMatchObject({ archiveId: 'archive-1' });
    expect(jobOf(api, 1)).not.toBe(jobOf(api, 0));
    // Neither the folder nor its validation was needed again.
    expect(api.installs.chooseFolder).toHaveBeenCalledOnce();
    expect(api.publish.validateFolder).toHaveBeenCalledOnce();
  });

  it('offline: the offline banner shows, and Publish is disabled with nothing attempted', async () => {
    const api = signedIn();
    api.connectivity.get.mockResolvedValue(connectivityResult('offline'));
    const publish = await toReview();
    expect(screen.getByText("You're offline. Library and Models still work.")).toBeDefined();
    expect(
      screen.getByText("Publishing needs the Store. You're offline, so Publish is off."),
    ).toBeDefined();
    expect(publish.disabled).toBe(true);
    fireEvent.click(publish);
    expect(api.publish.publish).not.toHaveBeenCalled();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('an expired session asks to sign in again, then returns to the review with the same folder', async () => {
    const api = signedIn();
    api.publish.publish.mockImplementationOnce(() => {
      // The Store refused the session: the Runtime ends it, then answers.
      api.emit('auth.changed', { signedIn: false, reason: 'session_expired' });
      return Promise.resolve(failure('unauthenticated'));
    });
    fireEvent.click(await toReview());

    const signInAgain = await screen.findByRole('button', { name: 'Sign in again' });
    expect(
      screen.getByText(
        'Your session expired. Sign in again to keep publishing; your folder stays selected.',
      ),
    ).toBeDefined();
    fireEvent.click(signInAgain);

    expect(await screen.findByRole('button', { name: 'Publish' })).toBeDefined();
    expect(screen.getByText(FOLDER)).toBeDefined();
    expect(api.publish.validateFolder).toHaveBeenCalledTimes(2);
    expect(api.publish.validateFolder).toHaveBeenLastCalledWith(FOLDER);
    expect(api.installs.chooseFolder).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a change on disk during the upload is validated once it failed, not before', async () => {
    const api = signedIn();
    const answer = deferred<IpcResult<PublishedVersion>>();
    api.publish.publish.mockReturnValue(answer.promise);
    fireEvent.click(await toReview());
    act(() => {
      api.emit('publish.folderChanged', { path: FOLDER });
    });
    expect(api.publish.validateFolder).toHaveBeenCalledOnce();

    await act(async () => {
      answer.resolve(failure('store_unreachable'));
      await answer.promise;
    });
    await waitFor(() => {
      expect(api.publish.validateFolder).toHaveBeenCalledTimes(2);
    });
    // The edit path: validated again, back to the review without the failure.
    expect(await screen.findByRole('button', { name: 'Publish' })).toBeDefined();
    expect(screen.queryByText('The Store did not publish this version.')).toBeNull();
  });

  it('an archive the Runtime no longer has is validated again, back to the review', async () => {
    const api = signedIn();
    api.publish.publish.mockResolvedValueOnce(failure('package_invalid'));
    fireEvent.click(await toReview());
    await waitFor(() => {
      expect(api.publish.validateFolder).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByRole('button', { name: 'Publish' })).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
