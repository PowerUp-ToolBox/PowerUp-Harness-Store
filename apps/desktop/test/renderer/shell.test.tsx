// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeApi, renderApp as renderAt } from './render-app.js';

function sidebar() {
  return screen.getByRole('navigation', { name: 'Main' });
}

let api: ReturnType<typeof installFakeApi>;

beforeEach(() => {
  api = installFakeApi();
});

afterEach(() => {
  cleanup();
});

describe('main window shell', () => {
  it('shows the six sections in sidebar order', async () => {
    await renderAt('#/library');
    const labels = within(sidebar())
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(labels).toEqual(['Library', 'Store', 'Models', 'Publish', 'Usage', 'Settings']);
  });

  it.each([
    ['Library', '#/library'],
    ['Store', '#/store'],
    ['Models', '#/models'],
    ['Publish', '#/publish'],
    ['Usage', '#/usage'],
    ['Settings', '#/settings'],
  ])('navigates to %s and reflects it in the hash', async (label, hash) => {
    await renderAt(label === 'Library' ? '#/settings' : '#/library');
    fireEvent.click(within(sidebar()).getByRole('link', { name: label }));
    expect(window.location.hash).toBe(hash);
    expect(screen.getByRole('heading', { level: 1, name: label })).toBeDefined();
    expect(within(sidebar()).getByRole('link', { name: label }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it.each(['#/', '', '#/nowhere'])('sends %j to the Library', async (hash) => {
    await renderAt(hash);
    expect(window.location.hash).toBe('#/library');
    expect(screen.getByRole('heading', { level: 1, name: 'Library' })).toBeDefined();
  });

  it('reads a Harness ID with its slash from the detail route, under the Store section', async () => {
    await renderAt('#/store/h/acme/code-reviewer');
    expect(api.store.detail).toHaveBeenCalledWith('acme/code-reviewer');
    expect(
      within(sidebar()).getByRole('link', { name: 'Store' }).getAttribute('aria-current'),
    ).toBe('page');
  });

  it('reads the Publisher login from its route', async () => {
    await renderAt('#/store/p/octocat');
    expect(screen.getByText(/\boctocat\b/)).toBeDefined();
  });

  it('shows the first-run wizard without the sidebar', async () => {
    await renderAt('#/onboarding');
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('shows the version the Runtime returns over IPC on Settings', async () => {
    await renderAt('#/settings');
    expect(await screen.findByText('4.5.6')).toBeDefined();
    expect(window.api.diagnostics.get).toHaveBeenCalled();
  });
});
