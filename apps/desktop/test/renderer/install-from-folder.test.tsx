// @vitest-environment jsdom
/**
 * Ticket P0-05.1: "Install this folder locally" on the Publish screen (docs/ux/flows.md F5) and
 * the shared consent dialog, over the fake `window.api`. Validate, then consent, then install:
 * nothing is installed before Install is pressed, and Cancel installs nothing.
 */
import type { Problem } from '@harness-store/manifest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translatorFor } from '../../src/shared/i18n/translate.js';
import type { FolderInspection, ManifestSummary } from '../../src/shared/ipc.js';
import { installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
});

const FOLDER = '/Users/octo/hello-web';

const SUMMARY: ManifestSummary = {
  harnessId: 'octo-cat/hello-web',
  version: '0.1.0',
  name: 'Hello Web',
  runtimeKind: 'node',
  uiKind: 'web',
  workspace: 'optional',
  platforms: ['darwin-arm64', 'linux-x64'],
  entry: 'dist/index.js',
  permissions: { filesystem: { scope: 'workspace' }, shell: true, network: { domains: [] } },
  platformSupported: true,
};

const VALID: FolderInspection = {
  valid: true,
  manifestSummary: SUMMARY,
  problems: [],
  warnings: [],
};

/** A Problem as validatePackage returns it, its English message from the catalog. */
function problem(path: string, messageKey: string, params: Record<string, string>): Problem {
  const message = translatorFor('en').problemText({ messageKey, params, message: '' });
  const [code = messageKey] = messageKey.split('.');
  return { path, code, message, messageKey, params };
}

const VERSION_PROBLEM = problem('version', 'version_invalid', { version: '1.0' });
const ICON_PROBLEM = problem('assets/icon.png', 'file_missing', { file: 'assets/icon.png' });
const PROBLEMS: readonly Problem[] = [VERSION_PROBLEM, ICON_PROBLEM];

function folderPicked() {
  const api = installFakeApi();
  api.installs.chooseFolder.mockResolvedValue({ ok: true, data: FOLDER });
  return api;
}

async function chooseFolder() {
  await renderApp('#/publish');
  fireEvent.click(await screen.findByRole('button', { name: 'Install this folder locally' }));
}

describe('Install this folder locally', () => {
  it('is on the Publish screen while signed out, and a cancelled picker does nothing', async () => {
    const api = installFakeApi();
    await chooseFolder();
    await waitFor(() => {
      expect(api.installs.chooseFolder).toHaveBeenCalledOnce();
    });
    expect(api.installs.inspectFolder).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows every problem of an invalid folder with its path, and installs nothing', async () => {
    const api = folderPicked();
    api.installs.inspectFolder.mockResolvedValue({
      ok: true,
      data: {
        valid: false,
        manifestSummary: null,
        problems: PROBLEMS,
        warnings: [problem('runtime.node', 'ignored_key.runtime_node', { kind: 'binary' })],
      },
    });
    await chooseFolder();
    const panel = await screen.findByRole('alert');
    expect(screen.getByText('1 warning')).toBeDefined();
    expect(api.installs.inspectFolder).toHaveBeenCalledWith(FOLDER);
    expect(within(panel).getByText('2 problems must be fixed before installing')).toBeDefined();
    const items = within(panel).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      `version${VERSION_PROBLEM.message}`,
      `assets/icon.png${ICON_PROBLEM.message}`,
    ]);
    expect(screen.getByText(FOLDER)).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();

    // Re-check validates the same folder again.
    api.installs.inspectFolder.mockResolvedValue({ ok: true, data: VALID });
    fireEvent.click(within(panel).getByRole('button', { name: 'Re-check' }));
    expect(await screen.findByRole('dialog')).toBeDefined();
    expect(api.installs.inspectFolder).toHaveBeenCalledTimes(2);
    expect(api.installs.installFromFolder).not.toHaveBeenCalled();
  });

  it('shows problems in zh-CN through the manifest catalog', async () => {
    const api = installFakeApi('zh-CN');
    api.installs.chooseFolder.mockResolvedValue({ ok: true, data: FOLDER });
    api.installs.inspectFolder.mockResolvedValue({
      ok: true,
      data: { valid: false, manifestSummary: null, problems: [ICON_PROBLEM], warnings: [] },
    });
    await renderApp('#/publish');
    fireEvent.click(await screen.findByRole('button', { name: '本地安装此文件夹' }));
    const panel = await screen.findByRole('alert');
    expect(within(panel).getByText('安装前需修复 1 个问题')).toBeDefined();
    expect(within(panel).getByText('Harness 包必须包含 "assets/icon.png"。')).toBeDefined();
  });

  it('a valid folder opens the consent dialog; Install, enabled after a second, installs it', async () => {
    const api = folderPicked();
    api.installs.inspectFolder.mockResolvedValue({ ok: true, data: VALID });
    api.installs.installFromFolder.mockResolvedValue({
      ok: true,
      data: { harnessId: SUMMARY.harnessId, version: '0.1.0' },
    });
    await chooseFolder();
    const dialog = await screen.findByRole('dialog', { name: 'Install Hello Web 0.1.0?' });

    const permissions = within(dialog).getByRole('list', { name: 'Permissions' });
    expect(
      within(permissions)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Medium · Reads and writes files in the folder you choose',
      'High · Runs shell commandsIt can run any program on your machine as you.',
      'Low · No network access besides the Model Gateway',
    ]);
    const facts = within(dialog).getByRole('list', { name: 'About this Harness' });
    expect(
      within(facts)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Runs on the bundled Node runtime',
      'Opens as a window',
      'Can use a folder you choose',
      'darwin-arm64',
      'linux-x64',
    ]);
    expect(within(dialog).getByText('octo-cat/hello-web · 0.1.0 · dist/index.js')).toBeDefined();
    expect(
      within(dialog).getByText(
        'Harness Store does not sandbox Harnesses. Installing means trusting this Publisher.',
      ),
    ).toBeDefined();

    const install = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Install' });
    expect(install.disabled).toBe(true);
    // Nothing is installed before the User consents.
    expect(api.installs.installFromFolder).not.toHaveBeenCalled();
    await waitFor(
      () => {
        expect(install.disabled).toBe(false);
      },
      { timeout: 2000 },
    );
    fireEvent.click(install);

    expect(
      await screen.findByText(
        'Installed Hello Web 0.1.0 from the folder. It is marked Local in the Library.',
        { exact: false },
      ),
    ).toBeDefined();
    expect(api.installs.installFromFolder).toHaveBeenCalledExactlyOnceWith(FOLDER);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Open Library' }));
    expect(window.location.hash).toBe('#/library');
  });

  it('Cancel closes the dialog and installs nothing', async () => {
    const api = folderPicked();
    api.installs.inspectFolder.mockResolvedValue({ ok: true, data: VALID });
    await chooseFolder();
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.installs.installFromFolder).not.toHaveBeenCalled();
  });

  it('a folder that changed after it was checked is checked again before anything installs', async () => {
    const api = folderPicked();
    api.installs.inspectFolder.mockResolvedValue({ ok: true, data: VALID });
    api.installs.installFromFolder.mockResolvedValue({
      ok: false,
      error: {
        code: 'package_invalid',
        messageKey: 'error.package_invalid',
        message: 'This folder is not a valid Harness, or it changed since it was checked.',
      },
    });
    await chooseFolder();
    const install = within(await screen.findByRole('dialog')).getByRole<HTMLButtonElement>(
      'button',
      { name: 'Install' },
    );
    await waitFor(
      () => {
        expect(install.disabled).toBe(false);
      },
      { timeout: 2000 },
    );
    api.installs.inspectFolder.mockResolvedValue({
      ok: true,
      data: { valid: false, manifestSummary: null, problems: [VERSION_PROBLEM], warnings: [] },
    });
    fireEvent.click(install);
    expect(await screen.findByText('1 problem must be fixed before installing')).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.installs.inspectFolder).toHaveBeenCalledTimes(2);
  });

  it('another install error stays in the dialog', async () => {
    const api = folderPicked();
    api.installs.inspectFolder.mockResolvedValue({ ok: true, data: VALID });
    api.installs.installFromFolder.mockResolvedValue({
      ok: false,
      error: {
        code: 'harness_running',
        messageKey: 'error.harness_running',
        message: 'This Harness is running. Close it, then try again.',
      },
    });
    await chooseFolder();
    const dialog = await screen.findByRole('dialog');
    const install = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Install' });
    await waitFor(
      () => {
        expect(install.disabled).toBe(false);
      },
      { timeout: 2000 },
    );
    fireEvent.click(install);
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This Harness is running. Close it, then try again.',
    );
  });

  it('shows warnings, and notes in the dialog a platform the Harness does not run on', async () => {
    const api = folderPicked();
    api.installs.inspectFolder.mockResolvedValue({
      ok: true,
      data: {
        ...VALID,
        manifestSummary: { ...SUMMARY, platforms: ['win32-x64'], platformSupported: false },
        warnings: [
          problem('ui.path', 'ignored_key.ui_web_only', { key: 'path', kind: 'terminal' }),
        ],
      },
    });
    await chooseFolder();
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(
        'This Harness does not run on your platform: it can be installed, but not launched here.',
      ),
    ).toBeDefined();
    expect(within(dialog).getByText('1 warning')).toBeDefined();
    expect(
      within(dialog).getByText(
        '"path" applies to UI Kind "web" only; it is ignored for "terminal".',
      ),
    ).toBeDefined();
  });
});
