// @vitest-environment jsdom
/**
 * Ticket P0-05.4: the Workspace sheet before a launch from a Library card, over the fake
 * `window.api` (docs/ux/screens.md, Workspace picker). A Harness whose Manifest asks for a
 * Workspace gets the sheet; one that declares none never does.
 */
import type { BoundFunctions, queries } from '@testing-library/dom';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Manifest } from '@harness-store/manifest';
import type { InstalledHarness } from '../../src/shared/ipc.js';
import { installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
});

const HARNESS_ID = 'acme/code-reviewer';

function installed(workspace: Manifest['workspace']): InstalledHarness {
  const manifest: Manifest = {
    manifestVersion: 1,
    id: HARNESS_ID,
    version: '1.0.0',
    name: 'Code Reviewer',
    summary: 'A test Harness.',
    license: 'MIT',
    platforms: ['darwin-arm64', 'linux-x64', 'win32-x64'],
    runtime: { kind: 'node', node: '22' },
    entry: 'index.mjs',
    ui: { kind: 'terminal' },
    ...(workspace === undefined ? {} : { workspace }),
    models: { slots: { default: {} } },
    permissions: { filesystem: { scope: 'workspace' }, shell: false, network: { domains: [] } },
  };
  return {
    harnessId: HARNESS_ID,
    version: '1.0.0',
    name: 'Code Reviewer',
    publisher: 'acme',
    source: 'local',
    manifest,
    installPath: '/profile/harnesses/acme/code-reviewer/1.0.0',
    installedAt: '2026-10-01T00:00:00.000Z',
    lastLaunchedAt: null,
    iconDataUrl: null,
    platformSupported: true,
  };
}

function setup(workspace: Manifest['workspace'], locale: 'en' | 'zh-CN' = 'en') {
  const api = installFakeApi(locale);
  api.installs.list.mockResolvedValue({ ok: true, data: [installed(workspace)] });
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

type Sheet = BoundFunctions<typeof queries>;

async function openSheet(launchLabel = 'Launch'): Promise<Sheet> {
  const card = await screen.findByRole('article', { name: 'Code Reviewer' });
  fireEvent.click(within(card).getByRole('button', { name: launchLabel }));
  return within(await screen.findByRole('dialog'));
}

const button = (sheet: Sheet, name: string) =>
  sheet.getByRole<HTMLButtonElement>('button', { name });

describe('the Workspace sheet', () => {
  it.each([undefined, 'none'] as const)(
    'never opens for a Harness whose workspace is %s: Launch launches at once',
    async (workspace) => {
      const api = setup(workspace);
      await renderApp('#/library');
      const card = await screen.findByRole('article', { name: 'Code Reviewer' });
      fireEvent.click(within(card).getByRole('button', { name: 'Launch' }));
      expect(api.launch.start).toHaveBeenCalledWith({ harnessId: HARNESS_ID });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(api.launch.lastWorkspace).not.toHaveBeenCalled();
      expect(api.launch.chooseWorkspace).not.toHaveBeenCalled();
    },
  );

  it('required: Choose folder, then Continue launches in that folder; no skipping', async () => {
    const api = setup('required');
    api.launch.chooseWorkspace.mockResolvedValue({ ok: true, data: '/Users/me/project' });
    await renderApp('#/library');
    const sheet = await openSheet();

    expect(screen.getByRole('dialog', { name: 'Choose a folder for Code Reviewer' })).toBeDefined();
    expect(await sheet.findByText('No folder chosen yet')).toBeDefined();
    expect(sheet.getByText('The Harness can read and write files in this folder.')).toBeDefined();
    expect(sheet.queryByRole('button', { name: 'Continue without a folder' })).toBeNull();
    expect(button(sheet, 'Continue').disabled).toBe(true);

    fireEvent.click(button(sheet, 'Choose folder'));
    expect(api.launch.chooseWorkspace).toHaveBeenCalledWith(HARNESS_ID);
    expect(await sheet.findByText('/Users/me/project')).toBeDefined();
    await waitFor(() => {
      expect(button(sheet, 'Continue').disabled).toBe(false);
    });
    fireEvent.click(button(sheet, 'Continue'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(api.launch.start).toHaveBeenCalledWith({
      harnessId: HARNESS_ID,
      workspace: '/Users/me/project',
    });
  });

  it('Cancel launches nothing, and a cancelled folder picker keeps the sheet as it was', async () => {
    const api = setup('required');
    await renderApp('#/library');
    const sheet = await openSheet();
    // The fake picker is cancelled.
    fireEvent.click(button(sheet, 'Choose folder'));
    await waitFor(() => {
      expect(button(sheet, 'Choose folder').disabled).toBe(false);
    });
    expect(sheet.getByText('No folder chosen yet')).toBeDefined();

    fireEvent.click(button(sheet, 'Cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.launch.start).not.toHaveBeenCalled();
  });

  it('preselects the last folder, so Continue launches there at once', async () => {
    const api = setup('required');
    api.launch.lastWorkspace.mockResolvedValue({
      ok: true,
      data: { path: '/Users/me/project', exists: true },
    });
    await renderApp('#/library');
    const sheet = await openSheet();
    expect(await sheet.findByText('/Users/me/project')).toBeDefined();
    expect(sheet.getByText('Last used folder')).toBeDefined();
    expect(api.launch.lastWorkspace).toHaveBeenCalledWith(HARNESS_ID);

    fireEvent.click(button(sheet, 'Continue'));
    await waitFor(() => {
      expect(api.launch.start).toHaveBeenCalledWith({
        harnessId: HARNESS_ID,
        workspace: '/Users/me/project',
      });
    });
  });

  it('says when the last folder no longer exists, and preselects nothing', async () => {
    const api = setup('required');
    api.launch.lastWorkspace.mockResolvedValue({
      ok: true,
      data: { path: '/Users/me/gone', exists: false },
    });
    await renderApp('#/library');
    const sheet = await openSheet();
    expect(await sheet.findByText('The last folder no longer exists')).toBeDefined();
    expect(sheet.queryByText('/Users/me/gone')).toBeNull();
    expect(button(sheet, 'Continue').disabled).toBe(true);
  });

  it('optional: Continue without a folder launches without a Workspace', async () => {
    const api = setup('optional');
    api.launch.lastWorkspace.mockResolvedValue({
      ok: true,
      data: { path: '/Users/me/project', exists: true },
    });
    await renderApp('#/library');
    const sheet = await openSheet();
    await sheet.findByText('/Users/me/project');
    fireEvent.click(button(sheet, 'Continue without a folder'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(api.launch.start).toHaveBeenCalledWith({ harnessId: HARNESS_ID, workspace: null });
  });

  it('shows in the sheet why the Runtime refused the folder, and stays open', async () => {
    const api = setup('required');
    api.launch.lastWorkspace.mockResolvedValue({
      ok: true,
      data: { path: '/Users/me/project', exists: true },
    });
    api.launch.start.mockResolvedValue({
      ok: false,
      error: {
        code: 'harness_installing',
        messageKey: 'error.harness_installing',
        message: 'This Harness is being installed.',
      },
    });
    await renderApp('#/library');
    const sheet = await openSheet();
    await sheet.findByText('/Users/me/project');
    fireEvent.click(button(sheet, 'Continue'));
    expect(await sheet.findByRole('alert')).toBeDefined();
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it.each(['required', 'optional'] as const)(
    'never opens while a Harness whose workspace is %s runs: Running… and Show window focus it',
    async (workspace) => {
      const api = setup(workspace);
      api.launch.status.mockResolvedValue({
        ok: true,
        data: [
          {
            harnessId: HARNESS_ID,
            launchId: 'launch-1',
            state: 'ready',
            startedAt: '2026-10-28T09:00:00.000Z',
          },
        ],
      });
      api.launch.start.mockResolvedValue({
        ok: true,
        data: { outcome: 'focused', launchId: 'launch-1' },
      });
      await renderApp('#/library');
      const card = within(await screen.findByRole('article', { name: 'Code Reviewer' }));
      fireEvent.click(await card.findByRole('button', { name: 'Running…' }));
      fireEvent.click(card.getByRole('button', { name: 'Show window' }));

      expect(api.launch.start).toHaveBeenCalledTimes(2);
      expect(api.launch.start).toHaveBeenNthCalledWith(1, { harnessId: HARNESS_ID });
      expect(api.launch.start).toHaveBeenNthCalledWith(2, { harnessId: HARNESS_ID });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(api.launch.lastWorkspace).not.toHaveBeenCalled();
      expect(api.launch.chooseWorkspace).not.toHaveBeenCalled();
    },
  );

  it('is in Chinese with the zh-CN catalog', async () => {
    setup('optional', 'zh-CN');
    await renderApp('#/library');
    const sheet = await openSheet('启动');
    expect(screen.getByRole('dialog', { name: '为 Code Reviewer 选择工作目录' })).toBeDefined();
    expect(button(sheet, '选择文件夹')).toBeDefined();
    expect(button(sheet, '不选择目录继续')).toBeDefined();
    expect(sheet.getByText('该 Harness 可以读写此目录中的文件。')).toBeDefined();
  });
});
