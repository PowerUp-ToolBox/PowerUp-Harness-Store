// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { HashRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApi } from '../../src/shared/ipc.js';
import { App } from '../../src/renderer/src/App.js';

function renderAt(hash: string) {
  window.location.hash = hash;
  return render(
    <HashRouter>
      <App />
    </HashRouter>,
  );
}

function sidebar() {
  return screen.getByRole('navigation', { name: 'Main' });
}

beforeEach(() => {
  const api = {
    app: { ping: vi.fn(() => Promise.resolve({ ok: true, data: { version: '4.5.6' } })) },
    on: vi.fn(() => () => undefined),
  } as unknown as DesktopApi;
  Object.defineProperty(window, 'api', { value: api, configurable: true });
});

afterEach(() => {
  cleanup();
});

describe('main window shell', () => {
  it('shows the six sections in sidebar order', () => {
    renderAt('#/library');
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
  ])('navigates to %s and reflects it in the hash', (label, hash) => {
    renderAt(label === 'Library' ? '#/settings' : '#/library');
    fireEvent.click(within(sidebar()).getByRole('link', { name: label }));
    expect(window.location.hash).toBe(hash);
    expect(screen.getByRole('heading', { level: 1, name: label })).toBeDefined();
    expect(within(sidebar()).getByRole('link', { name: label }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it.each(['#/', '', '#/nowhere'])('sends %j to the Library', (hash) => {
    renderAt(hash);
    expect(window.location.hash).toBe('#/library');
    expect(screen.getByRole('heading', { level: 1, name: 'Library' })).toBeDefined();
  });

  it('reads a Harness ID with its slash from the detail route, under the Store section', () => {
    renderAt('#/store/h/acme/code-reviewer');
    expect(screen.getByText('acme/code-reviewer')).toBeDefined();
    expect(
      within(sidebar()).getByRole('link', { name: 'Store' }).getAttribute('aria-current'),
    ).toBe('page');
  });

  it('reads the Publisher login from its route', () => {
    renderAt('#/store/p/octocat');
    expect(screen.getByText('octocat')).toBeDefined();
  });

  it('shows the first-run wizard without the sidebar', () => {
    renderAt('#/onboarding');
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
  });

  it('shows the version the Runtime returns over IPC on Settings', async () => {
    renderAt('#/settings');
    await act(() => Promise.resolve());
    expect(screen.getByText('Version 4.5.6')).toBeDefined();
    expect(window.api.app.ping).toHaveBeenCalled();
  });
});
