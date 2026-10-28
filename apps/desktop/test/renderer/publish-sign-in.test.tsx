// @vitest-environment jsdom
/**
 * Ticket P0-07.2: the placeholder Sign in / Sign out on the Publish screen, the only screen that
 * shows the Store sign-in (P0-08.1 replaces it with the sign-in card). It drives `auth.*` over
 * the fake `window.api`; the sign-in itself happens in the User's browser, so the app shows no
 * GitHub credential field.
 */
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_PUBLISHER, installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
});

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
  });

  it('Sign in calls auth.signIn and shows the signed-in login; Sign out signs out', async () => {
    const api = installFakeApi();
    await renderApp('#/publish');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with GitHub' }));
    expect(await screen.findByText('Signed in as octo-cat')).toBeDefined();
    expect(api.auth.signIn).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeDefined();
    expect(api.auth.signOut).toHaveBeenCalledOnce();
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

  it('follows auth.changed: an expired session shows Sign in again', async () => {
    const api = installFakeApi();
    api.auth.whoami.mockResolvedValue({ ok: true, data: FAKE_PUBLISHER });
    await renderApp('#/publish');
    expect(await screen.findByText('Signed in as octo-cat')).toBeDefined();
    act(() => {
      api.emit('auth.changed', { signedIn: false, reason: 'session_expired' });
    });
    expect(await screen.findByRole('button', { name: 'Sign in with GitHub' })).toBeDefined();
  });
});
