// @vitest-environment jsdom
/**
 * Ticket P0-08.1: "New version" on the Publish screen, over the fake `window.api`. A folder chosen
 * with the picker or dropped is validated at once (`publish.validateFolder`); problems are listed
 * by path with their translated message and code, and Continue is enabled exactly when there is
 * none. The folder is validated again on Re-check and when the Runtime reports it changed. The
 * review shows the Manifest's facts and the listing preview, whose trust block is the shared
 * TrustBlock component.
 */
import type { Manifest, Problem } from '@harness-store/manifest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LocaleProvider } from '../../src/renderer/src/i18n/I18nProvider.js';
import { TrustBlock } from '../../src/renderer/src/listing/TrustBlock.js';
import { translatorFor } from '../../src/shared/i18n/translate.js';
import type { FolderValidation } from '../../src/shared/ipc.js';
import { trustFactsOf } from '../../src/shared/permissions.js';
import { FAKE_PUBLISHER, installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
});

const FOLDER = '/Users/octo/hello-web';

const MANIFEST: Manifest = {
  manifestVersion: 1,
  id: 'octo-cat/hello-web',
  version: '1.1.0',
  name: 'Hello Web',
  summary: 'Chat with your default model in a window.',
  tags: ['writing', 'fun'],
  license: 'MIT',
  homepage: 'https://example.com/hello-web',
  platforms: ['darwin-arm64', 'linux-x64'],
  runtime: { kind: 'node', node: '22' },
  entry: 'dist/index.js',
  ui: { kind: 'web' },
  workspace: 'optional',
  models: {
    slots: {
      fast: { description: 'Quick replies.' },
      default: {
        description: 'Answers the User.',
        requirements: { tools: true },
        recommended: ['anthropic/claude-haiku-5-5'],
      },
    },
  },
  permissions: { filesystem: { scope: 'workspace' }, shell: true, network: { domains: [] } },
  changelog: '- Streams replies\n- Remembers the last chat',
};

/** A Problem as validatePackage returns it, its English message from the catalog. */
function problem(path: string, messageKey: string, params: Record<string, string>): Problem {
  const message = translatorFor('en').problemText({ messageKey, params, message: '' });
  const [code = messageKey] = messageKey.split('.');
  return { path, code, message, messageKey, params };
}

function validation(overrides: Partial<FolderValidation> = {}): FolderValidation {
  const problems = overrides.problems ?? [];
  return {
    archiveId: 'archive-1',
    problems,
    warnings: [],
    manifest: problems.length === 0 ? MANIFEST : null,
    iconDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    readme: '# Hello Web\n\nA chat window.',
    excluded: ['.DS_Store', '.git/'],
    archiveSize: 12_400,
    versionCheck: 'checked',
    lastPublishedVersion: '1.0.0',
    isNew: false,
    ...overrides,
  };
}

const ICON_PROBLEM = problem('assets/icon.png', 'icon_dimensions', { width: '256', height: '256' });

/** What the Runtime answers for a path that is not a folder. */
const NOT_A_FOLDER = {
  ok: false,
  error: {
    code: 'invalid_input',
    messageKey: 'error.invalid_input',
    message: 'Harness Store sent an invalid request internally.',
  },
} as const;

function signedIn(locale: 'en' | 'zh-CN' = 'en') {
  const api = installFakeApi(locale);
  api.auth.whoami.mockResolvedValue({ ok: true, data: FAKE_PUBLISHER });
  api.installs.chooseFolder.mockResolvedValue({ ok: true, data: FOLDER });
  return api;
}

async function chooseFolder(label = 'Choose a folder') {
  fireEvent.click(await screen.findByRole('button', { name: label }));
}

const continueButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' });

describe('choosing and validating a folder', () => {
  it('validates a picked folder at once and lists its problem with path, message and code', async () => {
    const api = signedIn();
    api.publish.validateFolder.mockResolvedValue({
      ok: true,
      data: validation({ problems: [ICON_PROBLEM] }),
    });
    await renderApp('#/publish');
    await chooseFolder();
    const panel = await screen.findByRole('alert');
    expect(api.publish.validateFolder).toHaveBeenCalledExactlyOnceWith(FOLDER);
    expect(within(panel).getByText('1 problem must be fixed before publishing')).toBeDefined();
    const rows = within(panel).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toBe(`assets/icon.png${ICON_PROBLEM.message}icon_dimensions`);
    expect(screen.getByText(FOLDER)).toBeDefined();
    expect(continueButton().disabled).toBe(true);
  });

  it('enables Continue the moment the folder, changed on disk, validates without problems', async () => {
    const api = signedIn();
    api.publish.validateFolder.mockResolvedValueOnce({
      ok: true,
      data: validation({ problems: [ICON_PROBLEM] }),
    });
    await renderApp('#/publish');
    await chooseFolder();
    await screen.findByText('1 problem must be fixed before publishing');
    expect(continueButton().disabled).toBe(true);

    // The Publisher swaps in a valid icon: the Runtime's watcher reports the change.
    api.publish.validateFolder.mockResolvedValueOnce({ ok: true, data: validation() });
    act(() => {
      api.emit('publish.folderChanged', { path: FOLDER });
    });
    expect(await screen.findByText('No problems found.')).toBeDefined();
    expect(continueButton().disabled).toBe(false);
    expect(api.publish.validateFolder).toHaveBeenCalledTimes(2);
  });

  it('ignores a change reported for another folder', async () => {
    const api = signedIn();
    api.publish.validateFolder.mockResolvedValue({ ok: true, data: validation() });
    await renderApp('#/publish');
    await chooseFolder();
    await screen.findByText('No problems found.');
    act(() => {
      api.emit('publish.folderChanged', { path: '/Users/octo/other' });
    });
    expect(api.publish.validateFolder).toHaveBeenCalledOnce();
  });

  it('Re-check validates again at once', async () => {
    const api = signedIn();
    api.publish.validateFolder.mockResolvedValue({
      ok: true,
      data: validation({ problems: [ICON_PROBLEM] }),
    });
    await renderApp('#/publish');
    await chooseFolder();
    await screen.findByText('1 problem must be fixed before publishing');
    api.publish.validateFolder.mockResolvedValue({ ok: true, data: validation() });
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(await screen.findByText('No problems found.')).toBeDefined();
    expect(api.publish.validateFolder).toHaveBeenNthCalledWith(2, FOLDER);
  });

  it('validates a dropped folder at once; a dropped file is refused and the folder stays', async () => {
    const api = signedIn();
    api.publish.validateFolder.mockResolvedValueOnce({ ok: true, data: validation() });
    await renderApp('#/publish');
    const zone = await screen.findByRole('region', { name: 'Drop a Harness folder here' });
    fireEvent.drop(zone, { dataTransfer: { files: [new File([], 'hello-web')] } });
    expect(await screen.findByText('/dropped/hello-web')).toBeDefined();
    expect(api.publish.validateFolder).toHaveBeenCalledExactlyOnceWith('/dropped/hello-web');
    await screen.findByText('No problems found.');

    api.publish.validateFolder.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'invalid_input',
        messageKey: 'error.invalid_input',
        message: 'Harness Store sent an invalid request internally.',
      },
    });
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'], 'notes.txt')] } });
    expect((await screen.findByRole('alert')).textContent).toBe('Drop a folder, not a file.');
    expect(screen.getByText('/dropped/hello-web')).toBeDefined();
    expect(screen.getByText('No problems found.')).toBeDefined();
  });

  it('the chosen folder, now a file, is an error rather than a refused drop', async () => {
    const api = signedIn();
    api.publish.validateFolder.mockResolvedValueOnce({ ok: true, data: validation() });
    await renderApp('#/publish');
    await chooseFolder();
    await screen.findByText('No problems found.');

    api.publish.validateFolder.mockResolvedValue(NOT_A_FOLDER);
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This folder is not a valid Harness, or it changed since it was checked. Check it again.',
    );
    expect(screen.queryByText('Drop a folder, not a file.')).toBeNull();
    expect(screen.queryByText('No problems found.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(api.publish.validateFolder).toHaveBeenCalledTimes(2);
  });

  it('two overlapping runs of the chosen folder, now a file, end without running it again', async () => {
    const api = signedIn();
    api.publish.validateFolder.mockResolvedValueOnce({ ok: true, data: validation() });
    await renderApp('#/publish');
    await chooseFolder();
    await screen.findByText('No problems found.');

    api.publish.validateFolder.mockResolvedValue(NOT_A_FOLDER);
    act(() => {
      api.emit('publish.folderChanged', { path: FOLDER });
      api.emit('publish.folderChanged', { path: FOLDER });
    });
    await screen.findByText(
      'This folder is not a valid Harness, or it changed since it was checked. Check it again.',
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(api.publish.validateFolder).toHaveBeenCalledTimes(3);
  });

  it('accepts drag-over, so the drop reaches the screen', async () => {
    signedIn();
    await renderApp('#/publish');
    const zone = await screen.findByRole('region', { name: 'Drop a Harness folder here' });
    const event = new Event('dragover', { bubbles: true, cancelable: true });
    Object.assign(event, { dataTransfer: { dropEffect: 'none' } });
    zone.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('shows publisher_mismatch in the UI language', async () => {
    const api = signedIn('zh-CN');
    api.publish.validateFolder.mockResolvedValue({
      ok: true,
      data: validation({
        problems: [
          problem('id', 'publisher_mismatch', {
            idPublisher: 'someone-else',
            publisher: 'octo-cat',
          }),
        ],
        versionCheck: 'skipped',
        lastPublishedVersion: null,
      }),
    });
    await renderApp('#/publish');
    await chooseFolder('选择文件夹');
    const panel = await screen.findByRole('alert');
    const expected = translatorFor('zh-CN').problemText({
      messageKey: 'publisher_mismatch',
      params: { idPublisher: 'someone-else', publisher: 'octo-cat' },
      message: '',
    });
    expect(within(panel).getByText(expected)).toBeDefined();
    expect(expected).toContain('someone-else');
    expect(within(panel).getByText('publisher_mismatch')).toBeDefined();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '继续' }).disabled).toBe(true);
  });

  it('shows version_not_greater with the last version, and what the Store said otherwise', async () => {
    const api = signedIn();
    api.publish.validateFolder.mockResolvedValue({
      ok: true,
      data: validation({
        problems: [
          problem('version', 'version_not_greater', { version: '1.0.0', latest: '1.0.0' }),
        ],
      }),
    });
    await renderApp('#/publish');
    await chooseFolder();
    expect(
      await screen.findByText(
        'Version 1.0.0 must be greater than every published version of this Harness; the latest is 1.0.0.',
      ),
    ).toBeDefined();
    expect(screen.getByText('Last published version: 1.0.0')).toBeDefined();

    api.publish.validateFolder.mockResolvedValue({
      ok: true,
      data: validation({ isNew: true, lastPublishedVersion: null }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(await screen.findByText('New Harness')).toBeDefined();

    api.publish.validateFolder.mockResolvedValue({
      ok: true,
      data: validation({ versionCheck: 'failed', lastPublishedVersion: null }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Re-check' }));
    expect(
      await screen.findByText(
        'Harness Store could not ask the Store for your published versions. The Store checks them again when you publish.',
      ),
    ).toBeDefined();
    expect(continueButton().disabled).toBe(false);
  });

  it('lists warnings apart, and they do not block Continue', async () => {
    const api = signedIn();
    api.publish.validateFolder.mockResolvedValue({
      ok: true,
      data: validation({ warnings: [problem('readme', 'ignored_key', { key: 'readme' })] }),
    });
    await renderApp('#/publish');
    await chooseFolder();
    expect(await screen.findByText('1 warning')).toBeDefined();
    expect(continueButton().disabled).toBe(false);
  });

  it('keeps the folder and its validation when the Publisher leaves the screen and comes back', async () => {
    const api = signedIn();
    api.publish.validateFolder.mockResolvedValue({
      ok: true,
      data: validation({ problems: [ICON_PROBLEM] }),
    });
    await renderApp('#/publish');
    await chooseFolder();
    await screen.findByText('1 problem must be fixed before publishing');
    fireEvent.click(screen.getByRole('link', { name: 'Library' }));
    await screen.findByRole('heading', { level: 1, name: 'Library' });
    fireEvent.click(screen.getByRole('link', { name: 'Publish' }));
    expect(await screen.findByText('1 problem must be fixed before publishing')).toBeDefined();
    expect(screen.getByText(FOLDER)).toBeDefined();
    expect(api.publish.validateFolder).toHaveBeenCalledOnce();
    expect(api.publish.stopWatching).not.toHaveBeenCalled();
  });
});

describe('the review and the listing preview', () => {
  async function openReview(overrides: Partial<FolderValidation> = {}) {
    const api = signedIn();
    api.publish.validateFolder.mockResolvedValue({ ok: true, data: validation(overrides) });
    const view = await renderApp('#/publish');
    await chooseFolder();
    await screen.findByText('No problems found.');
    fireEvent.click(continueButton());
    await screen.findByText('From the Manifest (read-only)');
    return { api, view };
  }

  it('shows the Manifest’s facts, the changelog, what is left out and the package size', async () => {
    await openReview();
    expect(screen.getByText('octo-cat/hello-web', { selector: 'dd' })).toBeDefined();
    expect(screen.getByText('darwin-arm64, linux-x64')).toBeDefined();
    expect(screen.getByText('fast, default')).toBeDefined();
    expect(screen.getByText('Last published version: 1.0.0')).toBeDefined();
    expect(screen.getAllByText(/Streams replies/).length).toBeGreaterThan(0);
    expect(screen.getByText('.git/')).toBeDefined();
    expect(screen.getByText('.DS_Store')).toBeDefined();
    expect(screen.getByText('Harness Package size: 12.4 kB')).toBeDefined();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('warns about a package over 100 MB, without blocking', async () => {
    await openReview({ archiveSize: 104_857_601 });
    expect(screen.getByRole('note').textContent).toMatch(/^This Harness Package is over 100 MB/);
  });

  it('previews the Store card and detail page from the Manifest, with the signed-in Publisher', async () => {
    await openReview();
    const card = document.querySelector('.listing-card');
    expect(card?.getAttribute('aria-label')).toBe('Hello Web');
    expect(card?.textContent).toContain('octo-cat · 0 downloads');
    expect(card?.textContent).toContain('Chat with your default model in a window.');
    const detail = document.querySelector<HTMLElement>('.listing-detail');
    if (detail === null) throw new Error('No detail page in the preview');
    const page = within(detail);
    expect(page.getByText('by octo-cat')).toBeDefined();
    expect(page.getByText('Writing')).toBeDefined();
    expect(page.getByText('Fun')).toBeDefined();
    expect(page.getByText('Quick replies.')).toBeDefined();
    expect(page.getByText('Needs: tool calling')).toBeDefined();
    expect(page.getByText('Recommended: anthropic/claude-haiku-5-5')).toBeDefined();
    expect(page.getByText(/A chat window\./)).toBeDefined();
    expect(page.getByText('1.1.0')).toBeDefined();
    expect(page.getByText('License: MIT')).toBeDefined();
    // `default` comes first among the Slots.
    const slots = [...detail.querySelectorAll('.listing-slot code')].map(
      (node) => node.textContent,
    );
    expect(slots).toEqual(['default', 'fast']);
    expect(detail.querySelector('img.listing-detail-icon')?.getAttribute('src')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    );
  });

  it('renders the trust block with the shared TrustBlock component, identically', async () => {
    await openReview();
    const preview = document.querySelector('.listing-detail .trust-block')?.outerHTML;
    expect(preview).toContain('Runs shell commands');
    expect(preview).toContain(
      'Harness Store does not sandbox Harnesses. Installing means trusting this Publisher.',
    );
    cleanup();
    const standalone = render(
      <LocaleProvider locale="en">
        <TrustBlock facts={trustFactsOf(MANIFEST)} />
      </LocaleProvider>,
    );
    expect(standalone.container.querySelector('.trust-block')?.outerHTML).toBe(preview);
  });

  it('Back returns to the validation; a change that brings a problem ends the review', async () => {
    const { api } = await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('No problems found.')).toBeDefined();
    fireEvent.click(continueButton());
    await screen.findByText('From the Manifest (read-only)');

    api.publish.validateFolder.mockResolvedValue({
      ok: true,
      data: validation({ problems: [ICON_PROBLEM] }),
    });
    act(() => {
      api.emit('publish.folderChanged', { path: FOLDER });
    });
    expect(await screen.findByText('1 problem must be fixed before publishing')).toBeDefined();
    expect(screen.queryByText('From the Manifest (read-only)')).toBeNull();
    await waitFor(() => {
      expect(continueButton().disabled).toBe(true);
    });
  });
});
