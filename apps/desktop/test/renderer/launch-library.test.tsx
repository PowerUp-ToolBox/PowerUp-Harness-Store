// @vitest-environment jsdom
/**
 * Ticket P0-05.2: launching from a Library card, over the fake `window.api`. The primary button
 * follows the launch (`launch.status`, then `launch.state` events): Launch, Starting…, Running…
 * with Show window, Stopping…; "Set up a model first" when nothing fills the `default` Slot.
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
  storeStatus: null,
  takedownAcknowledged: false,
  availableUpdate: null,
};

function status(state: LaunchStatus['state'], extra: Partial<LaunchStatus> = {}): LaunchStatus {
  return {
    harnessId: 'acme/hello-term',
    launchId: 'launch-1',
    state,
    startedAt: '2026-10-28T09:00:00.000Z',
    ...extra,
  };
}

function setup(locale: 'en' | 'zh-CN' = 'en') {
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
    data: { outcome: 'started', launchId: 'launch-1' },
  });
  return api;
}

const card = () => screen.findByRole('article', { name: 'Hello Term' });

describe('Launching from the Library', () => {
  it('Launch starts the Harness, and the button follows its launch', async () => {
    const api = setup();
    await renderApp('#/library');
    fireEvent.click(within(await card()).getByRole('button', { name: 'Launch' }));
    expect(api.launch.start).toHaveBeenCalledWith({ harnessId: 'acme/hello-term' });

    act(() => {
      api.emit('launch.state', status('preparing'));
    });
    expect(
      within(await card()).getByRole<HTMLButtonElement>('button', { name: 'Starting…' }).disabled,
    ).toBe(true);

    act(() => {
      api.emit('launch.state', status('ready'));
    });
    const running = within(await card());
    fireEvent.click(running.getByRole('button', { name: 'Running…' }));
    fireEvent.click(running.getByRole('button', { name: 'Show window' }));
    // Both bring its window to the front: a launch while it runs focuses it.
    expect(api.launch.start).toHaveBeenCalledTimes(3);

    act(() => {
      api.emit('launch.state', status('stopping'));
    });
    expect(
      within(await card()).getByRole<HTMLButtonElement>('button', { name: 'Stopping…' }).disabled,
    ).toBe(true);

    act(() => {
      api.emit('launch.state', status('stopped', { exitCode: 0 }));
    });
    expect(within(await card()).getByRole('button', { name: 'Launch' })).toBeDefined();
  });

  it('shows a launch that is running when the Library opens', async () => {
    const api = setup('zh-CN');
    api.launch.status.mockResolvedValue({ ok: true, data: [status('ready')] });
    await renderApp('#/library');
    const zh = within(await card());
    expect(await zh.findByRole('button', { name: '运行中…' })).toBeDefined();
    expect(zh.getByRole('button', { name: '显示窗口' })).toBeDefined();
  });

  it('without a model for the default Slot, offers "Set up a model first", which opens Models', async () => {
    const api = setup();
    api.bindings.resolveAll.mockResolvedValue({
      ok: true,
      data: [{ slot: 'default', binding: null }],
    });
    await renderApp('#/library');
    const button = await within(await card()).findByRole('button', {
      name: 'Set up a model first',
    });
    fireEvent.click(button);
    await waitFor(() => {
      expect(window.location.hash).toBe('#/models?harness=acme%2Fhello-term');
    });
    expect(api.launch.start).not.toHaveBeenCalled();
  });

  it('a launch the Runtime refuses shows why', async () => {
    const api = setup();
    api.launch.start.mockResolvedValue({
      ok: false,
      error: {
        code: 'not_implemented',
        messageKey: 'error.not_implemented',
        message: 'This is not available in this version of Harness Store yet.',
      },
    });
    await renderApp('#/library');
    fireEvent.click(within(await card()).getByRole('button', { name: 'Launch' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'This is not available in this version of Harness Store yet.',
    );
  });
});

describe('app.navigate', () => {
  it("shows the route a Harness window's model indicator asks for", async () => {
    const api = setup();
    await renderApp('#/library');
    await card();
    act(() => {
      api.emit('app.navigate', { path: '/models?harness=acme%2Fhello-term' });
    });
    await waitFor(() => {
      expect(window.location.hash).toBe('#/models?harness=acme%2Fhello-term');
    });
  });
});
