// @vitest-environment jsdom
/**
 * Tickets P0-07.2 and P0-08.1: the GitHub sign-in card of the Publish screen, the only screen
 * that shows the Store sign-in. It drives `auth.*` over the fake `window.api`; the sign-in itself
 * happens in the User's browser, so the app shows no GitHub credential field.
 */
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthState, IpcResult } from '../../src/shared/ipc.js';
import { connectivityResult, FAKE_PUBLISHER, installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
});

const WITH_AVATAR: AuthState = {
  signedIn: true,
  githubLogin: 'octo-cat',
  displayName: 'Octo Cat',
  avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
};

describe('Publish screen sign-in', () => {
  it('signed out: explains who needs an account and offers Sign in with GitHub, no credential field', async () => {
    installFakeApi();
    const view = await renderApp('#/publish');
    expect(
      await screen.findByText(
        'Only Publishers need to sign in. Browsing and installing never require an account.',
      ),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeDefined();
    expect(view.container.querySelector('input')).toBeNull();
    // Nothing of the publishing flow shows signed out; installing a folder locally still does.
    expect(screen.queryByRole('button', { name: 'Choose a folder' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Install this folder locally' })).toBeDefined();
  });

  it('Sign in shows the GitHub identity: avatar, login, name and the Harness ID prefix', async () => {
    const api = installFakeApi();
    api.auth.signIn.mockResolvedValue({ ok: true, data: WITH_AVATAR });
    const view = await renderApp('#/publish');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }));
    expect(await screen.findByText('Signed in as octo-cat')).toBeDefined();
    expect(screen.getByText('Octo Cat')).toBeDefined();
    expect(screen.getByText('Your Harness IDs start with octo-cat/')).toBeDefined();
    expect(view.container.querySelector('img.avatar')?.getAttribute('src')).toBe(
      'https://avatars.githubusercontent.com/u/1?v=4',
    );
    expect(screen.getByRole('button', { name: 'Choose a folder' })).toBeDefined();
    expect(api.auth.signIn).toHaveBeenCalledOnce();
  });

  it('Sign out signs out and shows the sign-in card again', async () => {
    const api = installFakeApi();
    api.auth.whoami.mockResolvedValue({ ok: true, data: FAKE_PUBLISHER });
    await renderApp('#/publish');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeDefined();
    expect(api.auth.signOut).toHaveBeenCalledOnce();
  });

  it('waits for the browser with Cancel, which cancels the sign-in without an error', async () => {
    const api = installFakeApi();
    let finish: (result: IpcResult<AuthState>) => void = () => undefined;
    api.auth.signIn.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    api.auth.signOut.mockImplementation(() => {
      finish({
        ok: false,
        error: {
          code: 'sign_in_cancelled',
          messageKey: 'error.sign_in_cancelled',
          message: 'This sign-in was replaced.',
        },
      });
      return Promise.resolve({ ok: true, data: { signedIn: false } });
    });
    await renderApp('#/publish');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }));
    expect(await screen.findByText('Finish signing in in your browser…')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeDefined();
    expect(api.auth.signOut).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a failed sign-in as its translated error', async () => {
    const api = installFakeApi('zh-CN');
    api.auth.signIn.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'sign_in_timeout',
        messageKey: 'error.sign_in_timeout',
        message: 'Signing in took too long.',
      },
    });
    await renderApp('#/publish');
    fireEvent.click(await screen.findByRole('button', { name: '使用 GitHub 登录' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      '登录耗时过长。请重试，并在 5 分钟内在浏览器中完成。',
    );
  });

  it('offline: Sign in is disabled and says why', async () => {
    const api = installFakeApi();
    api.connectivity.get.mockResolvedValue(connectivityResult('offline'));
    await renderApp('#/publish');
    expect(
      await screen.findByText("Signing in needs the Store, and you're offline."),
    ).toBeDefined();
    const button = screen.getByRole('button', { name: 'Sign in with GitHub' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('an expired session asks to sign in again, keeps the folder, and validates it again after', async () => {
    const api = installFakeApi();
    api.auth.whoami.mockResolvedValue({ ok: true, data: FAKE_PUBLISHER });
    api.installs.chooseFolder.mockResolvedValue({ ok: true, data: '/Users/octo/hello' });
    api.publish.validateFolder.mockResolvedValue({
      ok: true,
      data: {
        archiveId: 'a1',
        problems: [],
        warnings: [],
        manifest: null,
        iconDataUrl: null,
        readme: null,
        excluded: [],
        archiveSize: 1000,
        versionCheck: 'checked',
        lastPublishedVersion: null,
        isNew: true,
      },
    });
    await renderApp('#/publish');
    fireEvent.click(await screen.findByRole('button', { name: 'Choose a folder' }));
    expect(await screen.findByText('/Users/octo/hello')).toBeDefined();
    expect(api.publish.validateFolder).toHaveBeenCalledOnce();

    act(() => {
      api.emit('auth.changed', { signedIn: false, reason: 'session_expired' });
    });
    expect(
      await screen.findByText(
        'Your session expired. Sign in again to keep publishing; your folder stays selected.',
      ),
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(await screen.findByText('/Users/octo/hello')).toBeDefined();
    await waitFor(() => {
      expect(api.publish.validateFolder).toHaveBeenCalledTimes(2);
    });
    expect(api.publish.validateFolder).toHaveBeenLastCalledWith('/Users/octo/hello');
  });
});
