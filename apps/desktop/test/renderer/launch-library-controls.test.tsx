// @vitest-environment jsdom
/**
 * Ticket P0-05.6: a Library card's running controls, over the fake `window.api`. The card follows
 * `launch.state` events live; a failed launch shows why with Show logs and Dismiss, and Launch
 * retries; the overflow menu offers Model Overrides, Show logs and Open data folder.
 * test/launch/library-controls.test.ts covers the same calls in main, with real launches.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Manifest } from '@harness-store/manifest';
import type { InstalledHarness, LaunchStatus } from '../../src/shared/ipc.js';
import { installFakeApi, renderApp } from './render-app.js';

beforeEach(() => {
  // The Models page scrolls to the Harness a deep link names; jsdom does not scroll.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
});

const MANIFEST: Manifest = {
  manifestVersion: 1,
  id: 'acme/hello-term',
  version: '1.0.0',
  name: 'Hello Term',
  summary: 'A test Harness.',
  license: 'MIT',
  platforms: ['darwin-arm64', 'linux-x64', 'win32-x64'],
  runtime: { kind: 'node', node: '22' },
  entry: 'index.mjs',
  ui: { kind: 'terminal' },
  models: { slots: { default: {} } },
  permissions: { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } },
};

const INSTALLED: InstalledHarness = {
  harnessId: 'acme/hello-term',
  version: '1.0.0',
  name: 'Hello Term',
  publisher: 'acme',
  source: 'local',
  manifest: MANIFEST,
  installPath: '/profile/harnesses/acme/hello-term/1.0.0',
  installedAt: '2026-10-01T00:00:00.000Z',
  lastLaunchedAt: null,
  iconDataUrl: null,
  platformSupported: true,
};

/** Launch ids are unique per test: a dismissed error line stays dismissed while the app runs. */
let nextLaunch = 0;

function status(state: LaunchStatus['state'], extra: Partial<LaunchStatus> = {}): LaunchStatus {
  return {
    harnessId: 'acme/hello-term',
    launchId: `launch-${String(nextLaunch)}`,
    state,
    startedAt: '2026-10-28T09:00:00.000Z',
    ...extra,
  };
}

function setup(locale: 'en' | 'zh-CN' = 'en') {
  nextLaunch += 1;
  const api = installFakeApi(locale);
  api.installs.list.mockResolvedValue({ ok: true, data: [INSTALLED] });
  api.bindings.resolveAll.mockResolvedValue({
    ok: true,
    data: [
      { slot: 'default', binding: { connectionId: 'ollama', model: 'qwen3', source: 'default' } },
    ],
  });
  api.launch.start.mockResolvedValue({
    ok: true,
    data: { outcome: 'started', launchId: `launch-${String(nextLaunch)}` },
  });
  return api;
}

const card = async () => within(await screen.findByRole('article', { name: 'Hello Term' }));

describe('a launch that failed', () => {
  it('shows why, with Show logs, which opens its logs, and Launch, which retries', async () => {
    const api = setup();
    await renderApp('#/library');
    const view = await card();
    act(() => {
      api.emit('launch.state', status('ready'));
    });
    expect(view.getByRole('button', { name: 'Running…' })).toBeDefined();
    act(() => {
      api.emit('launch.state', status('failed', { reason: 'exit_nonzero', exitCode: 3 }));
    });

    const alert = view.getByRole('alert');
    expect(within(alert).getByText('Exited with an error')).toBeDefined();
    fireEvent.click(within(alert).getByRole('button', { name: 'Show logs' }));
    expect(api.launch.openLogs).toHaveBeenCalledWith('acme/hello-term');

    fireEvent.click(view.getByRole('button', { name: 'Launch' }));
    expect(api.launch.start).toHaveBeenCalledWith({ harnessId: 'acme/hello-term' });
  });

  it.each([
    ['ready_timeout', 'Did not start in time'],
    ['spawn_error', 'Could not start'],
  ] as const)('%s reads "%s"', async (reason, text) => {
    const api = setup();
    api.launch.status.mockResolvedValue({ ok: true, data: [status('failed', { reason })] });
    await renderApp('#/library');
    const alert = await (await card()).findByRole('alert');
    expect(within(alert).getByText(text)).toBeDefined();
  });

  it('reads in the UI language', async () => {
    const api = setup('zh-CN');
    api.launch.status.mockResolvedValue({
      ok: true,
      data: [status('failed', { reason: 'exit_nonzero', exitCode: 1 })],
    });
    await renderApp('#/library');
    const alert = await (await card()).findByRole('alert');
    expect(within(alert).getByText('异常退出')).toBeDefined();
    expect(within(alert).getByRole('button', { name: '查看日志' })).toBeDefined();
    expect(within(alert).getByRole('button', { name: '忽略' })).toBeDefined();
  });

  it('Dismiss hides the error line, also after leaving the Library and coming back', async () => {
    const api = setup();
    api.launch.status.mockResolvedValue({
      ok: true,
      data: [status('failed', { reason: 'exit_nonzero', exitCode: 3 })],
    });
    await renderApp('#/library');
    const view = await card();
    fireEvent.click(
      within(await view.findByRole('alert')).getByRole('button', { name: 'Dismiss' }),
    );
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByRole('button', { name: 'Launch' })).toBeDefined();

    cleanup();
    await renderApp('#/library');
    await (await card()).findByRole('button', { name: 'Launch' });
    expect((await card()).queryByRole('alert')).toBeNull();

    // The next launch that fails shows its own error line.
    nextLaunch += 1;
    act(() => {
      api.emit('launch.state', status('failed', { reason: 'spawn_error' }));
    });
    expect(within((await card()).getByRole('alert')).getByText('Could not start')).toBeDefined();
  });

  it.each(['workspace_cancelled', 'platform_unsupported'] as const)(
    '%s shows no error line: the card offers Launch again',
    async (reason) => {
      const api = setup();
      await renderApp('#/library');
      const view = await card();
      act(() => {
        api.emit('launch.state', status('failed', { reason }));
      });
      expect(view.getByRole('button', { name: 'Launch' })).toBeDefined();
      expect(view.queryByRole('alert')).toBeNull();
    },
  );
});

describe('the card menu', () => {
  const openMenu = async () => {
    const view = await card();
    const button = view.getByRole('button', { name: 'More actions for Hello Term' });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    return view.getByRole('menu', { name: 'More actions for Hello Term' });
  };

  it('lists Model Overrides, Show logs and Open data folder, the first one focused', async () => {
    setup();
    await renderApp('#/library');
    const menu = await openMenu();
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Model Overrides',
      'Show logs',
      'Open data folder',
    ]);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);

    fireEvent.keyDown(menu, { key: 'Escape' });
    expect((await card()).queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(
      (await card()).getByRole('button', { name: 'More actions for Hello Term' }),
    );
  });

  it('Show logs and Open data folder ask main to open them, for this Harness', async () => {
    const api = setup();
    await renderApp('#/library');
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Show logs' }));
    expect(api.launch.openLogs).toHaveBeenCalledWith('acme/hello-term');
    expect((await card()).queryByRole('menu')).toBeNull();

    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Open data folder' }));
    expect(api.launch.openDataFolder).toHaveBeenCalledWith('acme/hello-term');
  });

  it('Model Overrides opens the Models page at this Harness', async () => {
    setup();
    await renderApp('#/library');
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Model Overrides' }));
    await waitFor(() => {
      expect(window.location.hash).toBe('#/models?harness=acme%2Fhello-term');
    });
  });

  it('a click elsewhere closes it', async () => {
    setup();
    await renderApp('#/library');
    await openMenu();
    fireEvent.mouseDown(document.body);
    expect((await card()).queryByRole('menu')).toBeNull();
  });

  it('shows on the card why main could not open the folder', async () => {
    const api = setup();
    api.launch.openDataFolder.mockResolvedValue({
      ok: false,
      error: {
        code: 'not_installed',
        messageKey: 'error.not_installed',
        message: 'This Harness is not installed.',
      },
    });
    await renderApp('#/library');
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Open data folder' }));
    expect(await (await card()).findByRole('alert')).toHaveProperty(
      'textContent',
      'This Harness is not installed.',
    );
  });

  it('shows on the card that the OS could not open the log, naming it', async () => {
    const api = setup();
    api.launch.openLogs.mockResolvedValue({
      ok: false,
      error: {
        code: 'open_failed',
        messageKey: 'error.open_failed',
        params: { path: '/logs/acme/hello-term' },
        message: 'unused: the catalog renders it',
      },
    });
    await renderApp('#/library');
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Show logs' }));
    expect(await (await card()).findByRole('alert')).toHaveProperty(
      'textContent',
      'Harness Store could not open "/logs/acme/hello-term": no app on this computer opened it. Open it from your file browser instead.',
    );
  });
});
