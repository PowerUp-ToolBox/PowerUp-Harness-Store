// @vitest-environment jsdom
/**
 * Ticket P0-12.2: what a User sees of a Harness they installed that a Store administrator took
 * down, over the fake `window.api`, in en and zh-CN: the red warning on its Library card and on its
 * detail page (in place of the neutral "No longer available in the Store", which an Unpublished
 * one keeps), no Update, and Launch behind the one-time confirmation, which only "Launch anyway"
 * records (`installs.acknowledgeTakedown`). test/install/store-update.test.ts covers the same in
 * main, from the update check's `taken_down` to a launch that still works.
 */
import type { Manifest } from '@harness-store/manifest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { InstalledHarness } from '../../src/shared/ipc.js';
import { installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
});

const HARNESS_ID = 'alice/writer';

const MANIFEST: Manifest = {
  manifestVersion: 1,
  id: HARNESS_ID,
  version: '1.0.0',
  name: 'Writer',
  summary: 'Writes long texts.',
  license: 'MIT',
  platforms: ['darwin-arm64', 'linux-x64', 'win32-x64'],
  runtime: { kind: 'node', node: '22' },
  entry: 'index.mjs',
  ui: { kind: 'terminal' },
  models: { slots: { default: {} } },
  permissions: { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } },
};

function installed(fields: Partial<InstalledHarness> = {}): InstalledHarness {
  return {
    harnessId: HARNESS_ID,
    version: '1.0.0',
    name: 'Writer',
    publisher: 'alice',
    source: 'store',
    manifest: MANIFEST,
    installPath: '/profile/harnesses/alice/writer/1.0.0',
    installedAt: '2026-10-01T00:00:00.000Z',
    lastLaunchedAt: null,
    iconDataUrl: null,
    platformSupported: true,
    storeStatus: 'taken_down',
    takedownAcknowledged: false,
    availableUpdate: null,
    ...fields,
  };
}

const COPY = {
  en: {
    warning:
      'A Store administrator took this Harness down. It may be harmful: launch it only if you trust it.',
    confirm: 'This Harness was removed from the Store. Launch anyway?',
    cancel: 'Cancel',
    launchAnyway: 'Launch anyway',
    launch: 'Launch',
    notInStore: 'No longer available in the Store',
    report: 'Report',
  },
  'zh-CN': {
    warning: '该 Harness 已被商店管理员下架，可能有害。仅在你信任它时启动。',
    confirm: '该 Harness 已从商店移除。仍要启动吗？',
    cancel: '取消',
    launchAnyway: '仍然启动',
    launch: '启动',
    notInStore: '已不在商店中提供',
    report: '举报',
  },
} as const;

type Locale = keyof typeof COPY;

function setup(install: InstalledHarness, locale: Locale = 'en') {
  const api = installFakeApi(locale);
  api.installs.list.mockResolvedValue({ ok: true, data: [install] });
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
  // The Store no longer shows a taken-down Harness: the page is built from the install.
  api.store.detail.mockResolvedValue({
    ok: true,
    data: { platform: 'darwin-arm64', storeStatus: 'taken_down', harness: null },
  });
  return api;
}

async function openCard(): Promise<HTMLElement> {
  return screen.findByRole('article', { name: 'Writer' });
}

/** The buttons of the card outside its menu. */
function cardButtons(card: HTMLElement): string[] {
  return within(card)
    .getAllByRole('button')
    .filter((button) => !button.classList.contains('card-menu-button'))
    .map((button) => button.textContent.trim());
}

describe.each(['en', 'zh-CN'] as const)('a taken-down install (%s)', (locale) => {
  const copy = COPY[locale];

  it('has the red warning on its Library card instead of the note, and only Launch', async () => {
    setup(installed(), locale);
    await renderApp('#/library');
    const card = await openCard();
    const warning = within(card).getByText(copy.warning);
    expect(warning.className).toBe('takedown-warning');
    expect(within(card).queryByText(copy.notInStore)).toBeNull();
    await waitFor(() => {
      expect(cardButtons(card)).toEqual([copy.launch]);
    });
  });

  it('asks before Launch; Cancel launches nothing and records nothing', async () => {
    const api = setup(installed(), locale);
    await renderApp('#/library');
    const card = await openCard();
    fireEvent.click(await within(card).findByRole('button', { name: copy.launch }));

    const dialog = screen.getByRole('dialog', { name: copy.confirm });
    expect(within(dialog).getByText(copy.warning)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: copy.cancel }));
    expect(screen.queryByRole('dialog')).toBeNull();

    // Escape is a Cancel too.
    fireEvent.click(within(card).getByRole('button', { name: copy.launch }));
    fireEvent.keyDown(screen.getByRole('dialog', { name: copy.confirm }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();

    expect(api.installs.acknowledgeTakedown).not.toHaveBeenCalled();
    expect(api.launch.start).not.toHaveBeenCalled();
  });

  it('"Launch anyway" records the acknowledgement, then launches', async () => {
    const api = setup(installed(), locale);
    await renderApp('#/library');
    const card = await openCard();
    fireEvent.click(await within(card).findByRole('button', { name: copy.launch }));
    const dialog = screen.getByRole('dialog', { name: copy.confirm });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: copy.launchAnyway }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(api.launch.start).toHaveBeenCalledWith({ harnessId: HARNESS_ID });
    });
    expect(api.installs.acknowledgeTakedown).toHaveBeenCalledExactlyOnceWith(HARNESS_ID);
    expect(api.installs.acknowledgeTakedown.mock.invocationCallOrder[0]).toBeLessThan(
      api.launch.start.mock.invocationCallOrder[0] ?? 0,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('launches without asking once the Takedown was acknowledged, still with the warning', async () => {
    const api = setup(installed({ takedownAcknowledged: true }), locale);
    await renderApp('#/library');
    const card = await openCard();
    expect(within(card).getByText(copy.warning)).toBeDefined();
    fireEvent.click(await within(card).findByRole('button', { name: copy.launch }));
    await waitFor(() => {
      expect(api.launch.start).toHaveBeenCalledWith({ harnessId: HARNESS_ID });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.installs.acknowledgeTakedown).not.toHaveBeenCalled();
  });

  it('has the warning on its detail page, built from the install, with Report, and asks before Launch', async () => {
    const api = setup(installed(), locale);
    await renderApp(`#/store/h/${HARNESS_ID}`);
    await screen.findByRole('heading', { level: 2, name: 'Writer' });
    expect(screen.getByText(copy.warning)).toBeDefined();
    expect(screen.queryByText(copy.notInStore)).toBeNull();
    expect(screen.getByRole('button', { name: copy.report })).toBeDefined();

    fireEvent.click(await screen.findByRole('button', { name: copy.launch }));
    const dialog = screen.getByRole('dialog', { name: copy.confirm });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: copy.launchAnyway }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(api.launch.start).toHaveBeenCalledWith({ harnessId: HARNESS_ID });
    });
    expect(api.installs.acknowledgeTakedown).toHaveBeenCalledWith(HARNESS_ID);
  });
});

describe('the takedown confirmation', () => {
  it('comes before the Workspace sheet of a Harness that asks for a Workspace', async () => {
    const api = setup(installed({ manifest: { ...MANIFEST, workspace: 'required' } }));
    await renderApp('#/library');
    const card = await openCard();
    fireEvent.click(await within(card).findByRole('button', { name: 'Launch' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Launch anyway' }));
      await Promise.resolve();
    });
    // The Workspace sheet replaces it; nothing is launched before a folder is chosen.
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: COPY.en.confirm })).toBeNull();
    });
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(api.installs.acknowledgeTakedown).toHaveBeenCalledWith(HARNESS_ID);
    expect(api.launch.start).not.toHaveBeenCalled();
  });

  it('shows why the acknowledgement failed and launches nothing', async () => {
    const api = setup(installed());
    api.installs.acknowledgeTakedown.mockResolvedValue({
      ok: false,
      error: {
        code: 'not_installed',
        messageKey: 'error.not_installed',
        message: 'This Harness is not installed.',
      },
    });
    await renderApp('#/library');
    const card = await openCard();
    fireEvent.click(await within(card).findByRole('button', { name: 'Launch' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Launch anyway' }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(api.launch.start).not.toHaveBeenCalled();
    expect(card.querySelector('.error-message')).not.toBeNull();
  });

  it('is not asked of an Unpublished install, which keeps the neutral note', async () => {
    const api = setup(installed({ storeStatus: 'unpublished' }));
    await renderApp('#/library');
    const card = await openCard();
    expect(within(card).getByText(COPY.en.notInStore)).toBeDefined();
    expect(within(card).queryByText(COPY.en.warning)).toBeNull();
    fireEvent.click(await within(card).findByRole('button', { name: 'Launch' }));
    await waitFor(() => {
      expect(api.launch.start).toHaveBeenCalledWith({ harnessId: HARNESS_ID });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is not asked to bring a running taken-down Harness to the front', async () => {
    const api = setup(installed());
    api.launch.status.mockResolvedValue({
      ok: true,
      data: [
        {
          harnessId: HARNESS_ID,
          launchId: 'launch-0',
          state: 'ready',
          startedAt: '2026-10-28T09:00:00.000Z',
        },
      ],
    });
    api.launch.start.mockResolvedValue({
      ok: true,
      data: { outcome: 'focused', launchId: 'launch-0' },
    });
    await renderApp('#/library');
    const card = await openCard();
    fireEvent.click(await within(card).findByRole('button', { name: 'Show window' }));
    await waitFor(() => {
      expect(api.launch.start).toHaveBeenCalledWith({ harnessId: HARNESS_ID });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
