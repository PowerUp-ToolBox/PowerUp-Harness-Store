// @vitest-environment jsdom
/**
 * Ticket P0-05.1: the Library's basic cards for installed Harnesses (icon, name, Publisher,
 * version, the Local badge, the primary button) and its empty state, over the fake `window.api`.
 */
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Manifest } from '@harness-store/manifest';
import type { InstalledHarness } from '../../src/shared/ipc.js';
import { installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
});

const ICON = 'data:image/png;base64,iVBORw0KGgo=';

/** The Library reads only the summary fields; any valid Manifest does. */
const MANIFEST: Manifest = {
  manifestVersion: 1,
  id: 'acme/hello',
  version: '1.0.0',
  name: 'Hello',
  summary: 'A test Harness.',
  license: 'MIT',
  platforms: ['darwin-arm64', 'linux-x64', 'win32-x64'],
  runtime: { kind: 'node', node: '22' },
  entry: 'dist/index.js',
  ui: { kind: 'web' },
  models: { slots: { default: {} } },
  permissions: { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } },
};

function installed(overrides: Partial<InstalledHarness> & Pick<InstalledHarness, 'harnessId'>) {
  const [publisher = '', slug = ''] = overrides.harnessId.split('/');
  return {
    version: '1.0.0',
    name: slug,
    publisher,
    source: 'store',
    manifest: MANIFEST,
    installPath: `/profile/harnesses/${overrides.harnessId}/1.0.0`,
    installedAt: '2026-10-01T00:00:00.000Z',
    lastLaunchedAt: null,
    iconDataUrl: ICON,
    platformSupported: true,
    ...overrides,
  } satisfies InstalledHarness;
}

describe('Library', () => {
  it('empty: says nothing is installed and offers Browse the Store', async () => {
    installFakeApi();
    await renderApp('#/library');
    expect(await screen.findByText('Nothing installed yet')).toBeDefined();
    fireEvent.click(screen.getByRole('link', { name: 'Browse the Store' }));
    expect(window.location.hash).toBe('#/store');
  });

  it('shows one card per install in the order installs.list gives, a local one marked Local', async () => {
    const api = installFakeApi();
    api.installs.list.mockResolvedValue({
      ok: true,
      data: [
        installed({ harnessId: 'octo-cat/hello-web', name: 'Hello Web', source: 'local' }),
        installed({ harnessId: 'alice/code-reviewer', name: 'Code Reviewer', version: '1.1.0' }),
      ],
    });
    await renderApp('#/library');
    const cards = await screen.findAllByRole('article');
    expect(cards.map((card) => card.getAttribute('aria-label'))).toEqual([
      'Hello Web',
      'Code Reviewer',
    ]);

    const [local, fromStore] = cards as [HTMLElement, HTMLElement];
    expect(within(local).getByRole('heading', { name: 'Hello Web' })).toBeDefined();
    expect(within(local).getByText('Local')).toBeDefined();
    expect(local.querySelector('.harness-card-subtitle')?.textContent).toBe('octo-cat · 1.0.0');
    expect(local.querySelector('img')?.getAttribute('src')).toBe(ICON);
    expect(within(local).getByRole('button', { name: 'Launch' })).toBeDefined();

    expect(within(fromStore).queryByText('Local')).toBeNull();
    expect(fromStore.querySelector('.harness-card-subtitle')?.textContent).toBe('alice · 1.1.0');
  });

  it('links each card’s Publisher to their Store page, a local install’s too', async () => {
    const api = installFakeApi();
    api.installs.list.mockResolvedValue({
      ok: true,
      data: [
        installed({ harnessId: 'octo-cat/hello-web', name: 'Hello Web', source: 'local' }),
        installed({ harnessId: 'alice/code-reviewer', name: 'Code Reviewer', version: '1.1.0' }),
      ],
    });
    await renderApp('#/library');
    const [local, fromStore] = (await screen.findAllByRole('article')) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(within(local).getByRole('link', { name: 'octo-cat' }).getAttribute('href')).toBe(
      '#/store/p/octo-cat',
    );
    const alice = within(fromStore).getByRole('link', { name: 'alice' });
    expect(alice.getAttribute('href')).toBe('#/store/p/alice');
    // Apart from the card's menu: no link inside another.
    expect(alice.closest('a')?.parentElement?.closest('a')).toBeNull();
    fireEvent.click(alice);
    expect(window.location.hash).toBe('#/store/p/alice');
  });

  it('a Harness that does not run on this platform says so on a disabled button', async () => {
    const api = installFakeApi();
    api.installs.list.mockResolvedValue({
      ok: true,
      data: [
        installed({ harnessId: 'acme/win-only', platformSupported: false, iconDataUrl: null }),
      ],
    });
    await renderApp('#/library');
    const button = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Not available for your platform',
    });
    expect(button.disabled).toBe(true);
  });

  it('reloads on installs.changed', async () => {
    const api = installFakeApi();
    await renderApp('#/library');
    expect(await screen.findByText('Nothing installed yet')).toBeDefined();
    api.installs.list.mockResolvedValue({
      ok: true,
      data: [installed({ harnessId: 'octo-cat/hello-web', name: 'Hello Web', source: 'local' })],
    });
    act(() => {
      api.emit('installs.changed', { harnessId: 'octo-cat/hello-web' });
    });
    expect(await screen.findByRole('article', { name: 'Hello Web' })).toBeDefined();
  });

  it('renders in zh-CN', async () => {
    const api = installFakeApi('zh-CN');
    api.installs.list.mockResolvedValue({
      ok: true,
      data: [installed({ harnessId: 'octo-cat/hello-web', name: 'Hello Web', source: 'local' })],
    });
    await renderApp('#/library');
    const card = await screen.findByRole('article', { name: 'Hello Web' });
    expect(within(card).getByText('本地')).toBeDefined();
    expect(within(card).getByRole('button', { name: '启动' })).toBeDefined();
  });
});
