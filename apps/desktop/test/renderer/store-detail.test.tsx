// @vitest-environment jsdom
/**
 * Ticket P0-09.3: the Harness detail page with a mocked `store.detail`, in en and zh-CN. Its
 * sections in docs/ux order, every Manifest field in its place (the few left out listed), the trust
 * block's shell permission in red, a hostile README rendered without its scripts and iframes, each
 * Model Slot's "Will use" or "No Connection can fill this Slot", the version history newest first
 * with changelogs, the primary button in each of its six states, the page opened from a Library
 * card, an installed Harness the Store no longer offers, the not-found page, an inline error with
 * Retry, and Back.
 */
import { manifestSchema, type Manifest } from '@harness-store/manifest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/renderer/src/i18n/I18nProvider.js';
import { DetailAction } from '../../src/renderer/src/store/DetailAction.js';
import type {
  InstalledHarness,
  StoreDetail,
  StoreHarness,
  StoreHome,
  StoreListing,
} from '../../src/shared/ipc.js';
import { connectionSummary, installFakeApi, renderApp } from './render-app.js';

afterEach(() => {
  cleanup();
});

/** A Manifest with every field the schema has, each with a value the page can show. */
const MANIFEST: Manifest = {
  manifestVersion: 1,
  id: 'alice/writer',
  version: '1.2.0',
  name: 'Writer',
  summary: 'Drafts and edits long texts.',
  tags: ['writing', 'research'],
  license: 'Apache-2.0',
  homepage: 'https://writer.example.com',
  sourceRepo: 'http://git.example.com/alice/writer',
  channel: 'stable',
  platforms: ['darwin-arm64', 'linux-x64'],
  runtime: { kind: 'node', node: '22' },
  entry: 'dist/server-entry.js',
  ui: {
    kind: 'web',
    path: '/app-path',
    readyTimeoutSeconds: 47,
    window: { width: 913, height: 707 },
  },
  workspace: 'required',
  models: {
    slots: {
      default: {
        description: 'Drafts the text.',
        requirements: { tools: true, minContext: 32000 },
        recommended: ['ollama/qwen3:8b'],
      },
      review: {
        description: 'Checks the draft.',
        requirements: { vision: true, json: true },
        recommended: ['anthropic/claude-x'],
      },
    },
  },
  permissions: {
    filesystem: { scope: 'workspace' },
    shell: true,
    network: { domains: ['api.example.com'] },
  },
  changelog: 'Adds **outlines**.',
};

const README = `# Writer

It writes long texts.

<script>window.owned = true</script>

<iframe src="https://evil.example.com/frame"></iframe>

<img src="x" onerror="window.owned = true">

Read [the guide](https://writer.example.com/guide).
`;

const WRITER: StoreHarness = {
  harnessId: 'alice/writer',
  publisher: {
    login: 'alice',
    displayName: 'Alice Liddell',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1',
  },
  iconUrl: 'store-asset://harness-assets/alice/writer/1.2.0/icon.png',
  downloadCount: 1260,
  manifest: MANIFEST,
  readme: README,
  screenshotUrls: [
    'store-asset://harness-assets/alice/writer/1.2.0/screenshots/1.png',
    'store-asset://harness-assets/alice/writer/1.2.0/screenshots/2.png',
  ],
  versions: [
    {
      version: '1.2.0',
      publishedAt: '2026-10-20T09:00:00.000000+00:00',
      changelog: 'Adds **outlines**.',
      permissionsChanged: true,
    },
    {
      version: '1.1.0',
      publishedAt: '2026-10-10T09:00:00.000000+00:00',
      changelog: 'Fixes typos.',
      permissionsChanged: false,
    },
    {
      version: '1.0.0',
      publishedAt: '2026-10-01T09:00:00.000000+00:00',
      changelog: 'First release.',
      permissionsChanged: false,
    },
  ],
};

const DETAIL: StoreDetail = { platform: 'darwin-arm64', storeStatus: 'available', harness: WRITER };

function installed(version: string, fields: Partial<InstalledHarness> = {}): InstalledHarness {
  return {
    harnessId: 'alice/writer',
    version,
    name: 'Writer',
    publisher: 'alice',
    source: 'store',
    manifest: { ...MANIFEST, version },
    installPath: `/profile/harnesses/alice/writer/${version}`,
    installedAt: '2026-10-21T00:00:00.000Z',
    lastLaunchedAt: null,
    iconDataUrl: null,
    platformSupported: true,
    storeStatus: null,
    availableUpdate: null,
    ...fields,
  };
}

interface Setup {
  readonly locale?: 'en' | 'zh-CN';
  readonly detail?: StoreDetail;
  readonly install?: InstalledHarness;
}

/** A fake Runtime with the Store's `alice/writer`, an Ollama Connection and what it resolves. */
function setup({ locale = 'en', detail = DETAIL, install }: Setup = {}) {
  const api = installFakeApi(locale);
  api.store.detail.mockResolvedValue({ ok: true, data: detail });
  api.connections.list.mockResolvedValue({ ok: true, data: [connectionSummary({ id: 'ollama' })] });
  api.bindings.resolveManifest.mockResolvedValue({
    ok: true,
    data: [
      {
        slot: 'default',
        binding: { connectionId: 'ollama', model: 'qwen3:8b', source: 'recommended' },
      },
      { slot: 'review', binding: null },
    ],
  });
  api.bindings.resolveAll.mockResolvedValue({
    ok: true,
    data: [
      {
        slot: 'default',
        binding: { connectionId: 'ollama', model: 'qwen3:8b', source: 'recommended' },
      },
    ],
  });
  if (install !== undefined) api.installs.list.mockResolvedValue({ ok: true, data: [install] });
  return api;
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

async function openDetail(options: Setup = {}) {
  const api = setup(options);
  await renderApp('#/store/h/alice/writer');
  await settle();
  return api;
}

function page() {
  return screen.getByRole('article', { name: 'Writer' });
}

function region(name: string) {
  return within(page()).getByRole('region', { name });
}

function actions() {
  const container = page().querySelector('.listing-detail-actions');
  if (!(container instanceof HTMLElement)) throw new Error('No actions');
  return container;
}

/** The buttons of the primary action, each as `label` or `label (disabled)`. */
function buttons(container: HTMLElement = actions()) {
  return within(container)
    .getAllByRole('button')
    .map(
      (button) =>
        `${button.textContent}${(button as HTMLButtonElement).disabled ? ' (disabled)' : ''}`,
    );
}

describe('Harness detail page', () => {
  it('shows header, screenshots, trust block, Models, README, versions and footer in that order', async () => {
    const api = await openDetail();
    expect(api.store.detail).toHaveBeenCalledWith('alice/writer');
    expect(
      within(page())
        .getAllByRole('heading')
        // The README's own headings are its content.
        .filter((heading) => heading.closest('.markdown') === null)
        .map((heading) => [heading.tagName, heading.textContent]),
    ).toEqual([
      ['H2', 'Writer'],
      ['H3', 'Screenshots'],
      ['H3', 'Permissions'],
      ['H3', 'Models'],
      ['H3', 'About'],
      ['H3', 'Version history'],
    ]);
    // The header.
    expect(
      within(page()).getByRole('link', { name: 'by Alice Liddell' }).getAttribute('href'),
    ).toBe('#/store/p/alice');
    expect(within(page()).getByText('alice/writer')).toBeDefined();
    expect(within(page()).getByText('Version 1.2.0')).toBeDefined();
    expect(within(page()).getByText('Drafts and edits long texts.')).toBeDefined();
    expect(within(page()).getByText('1,260 downloads')).toBeDefined();
    const badges = within(within(page()).getByRole('list', { name: 'Platforms' })).getAllByRole(
      'listitem',
    );
    expect(badges.map((badge) => [badge.textContent, badge.className])).toEqual([
      ['darwin-arm64 (this computer)', 'current'],
      ['linux-x64', ''],
    ]);
    expect(
      within(within(page()).getByRole('list', { name: 'Tags' }))
        .getAllByRole('listitem')
        .map((chip) => chip.textContent),
    ).toEqual(['Writing', 'Research']);
    // The screenshots.
    expect(
      within(region('Screenshots'))
        .getAllByRole('img')
        .map((image) => [image.getAttribute('alt'), image.getAttribute('src')]),
    ).toEqual([
      ['Screenshot 1', 'store-asset://harness-assets/alice/writer/1.2.0/screenshots/1.png'],
      ['Screenshot 2', 'store-asset://harness-assets/alice/writer/1.2.0/screenshots/2.png'],
    ]);
    // The footer.
    const footer = page().querySelector('footer');
    if (!(footer instanceof HTMLElement)) throw new Error('No footer');
    expect(within(footer).getByText('License: Apache-2.0')).toBeDefined();
    expect(within(footer).getByRole('link', { name: 'Homepage' }).getAttribute('href')).toBe(
      'https://writer.example.com',
    );
    expect(within(footer).getByRole('link', { name: 'Source' }).getAttribute('href')).toBe(
      'http://git.example.com/alice/writer',
    );
    expect(within(footer).getByRole('button', { name: 'Report' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('shows shell commands in red, with the concrete sentence and the no-sandbox sentence', async () => {
    await openDetail();
    const permissions = within(region('Permissions')).getAllByRole('listitem');
    const shell = permissions.find((item) => item.textContent.includes('Runs shell commands'));
    expect(shell?.getAttribute('data-severity')).toBe('high');
    expect(shell?.textContent).toBe(
      'High · Runs shell commandsIt can run any program on your machine as you.',
    );
    expect(
      within(region('Permissions')).getByText(
        'Harness Store does not sandbox Harnesses. Installing means trusting this Publisher.',
      ),
    ).toBeDefined();
    // How it runs, inside the trust block.
    expect(
      within(within(region('Permissions')).getByRole('list', { name: 'About this Harness' }))
        .getAllByRole('listitem')
        .map((fact) => fact.textContent),
    ).toEqual([
      'Runs on the bundled Node runtime',
      'Opens as a window',
      'Needs a folder to work in',
    ]);
  });

  it('says for each Model Slot what it would use here, or that no Connection can fill it', async () => {
    const api = await openDetail();
    expect(api.bindings.resolveManifest).toHaveBeenCalledWith({
      harnessId: 'alice/writer',
      models: MANIFEST.models,
    });
    const reachable = within(region('Models')).getByRole('listitem', { name: 'default' });
    expect(within(reachable).getByText('Will use: Ollama · qwen3:8b').dataset.reachable).toBe(
      'true',
    );
    expect(within(reachable).getByText('Drafts the text.')).toBeDefined();
    expect(
      within(reachable).getByText('Needs: tool calling and context window ≥ 32,000'),
    ).toBeDefined();
    expect(within(reachable).getByText('Recommended: ollama/qwen3:8b')).toBeDefined();
    const unreachable = within(region('Models')).getByRole('listitem', { name: 'review' });
    expect(
      within(unreachable).getByText('No Connection can fill this Slot').dataset.reachable,
    ).toBe('false');
  });

  it('renders the README without its script, iframe and onerror image, the rest intact', async () => {
    await openDetail();
    const about = region('About');
    expect(about.querySelector('script, iframe, [onerror]')).toBeNull();
    expect(within(about).getByRole('heading', { name: 'Writer', level: 1 })).toBeDefined();
    expect(within(about).getByText('It writes long texts.')).toBeDefined();
    expect((window as unknown as { owned?: boolean }).owned).toBeUndefined();
    // An external link opens in a new window, which main hands to the User's browser.
    const guide = within(about).getByRole('link', { name: 'the guide' });
    expect(guide.getAttribute('href')).toBe('https://writer.example.com/guide');
    expect(guide.getAttribute('target')).toBe('_blank');
    expect(guide.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('lists the published versions newest first, each with its date and changelog', async () => {
    await openDetail();
    const entries = within(region('Version history')).getAllByRole('listitem');
    // The dates are local time: 09:00 UTC is the day before west of UTC-9.
    const texts = entries.map((entry) => entry.textContent.trim());
    expect(texts[0]).toMatch(/^1\.2\.0Oct (19|20), 2026Permissions changedAdds outlines\.$/);
    expect(texts[1]).toMatch(/^1\.1\.0Oct (9|10), 2026Fixes typos\.$/);
    expect(texts[2]).toMatch(/^1\.0\.0(Sep 30|Oct 1), 2026First release\.$/);
    expect(texts).toHaveLength(3);
    expect(entries[0]?.querySelector('strong')?.textContent).toBe('outlines');
  });

  it('labels the page in Chinese', async () => {
    await openDetail({ locale: 'zh-CN' });
    expect(
      within(page())
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['截图', '声明权限', '模型', '简介', '版本历史']);
    expect(within(page()).getByText('版本 1.2.0')).toBeDefined();
    expect(within(page()).getByText('将使用：Ollama · qwen3:8b')).toBeDefined();
    expect(within(page()).getByText('没有模型连接可以填充此槽位')).toBeDefined();
    expect(within(page()).getByText('权限有变化')).toBeDefined();
    expect(
      within(page()).getByText('Harness Store 不会隔离 Harness 进程。安装即代表你信任该发布者。'),
    ).toBeDefined();
    expect(buttons()).toEqual(['安装']);
    expect(within(page()).getByRole('button', { name: '举报' })).toBeDefined();
  });
});

describe('the primary button', () => {
  it('Install: not installed, on a platform the Harness declares', async () => {
    await openDetail();
    expect(buttons()).toEqual(['Install']);
  });

  it('Not available for your platform: its latest version does not declare this one', async () => {
    await openDetail({ detail: { ...DETAIL, platform: 'win32-x64' } });
    expect(buttons()).toEqual(['Not available for your platform (disabled)']);
    const badges = within(within(page()).getByRole('list', { name: 'Platforms' })).getAllByRole(
      'listitem',
    );
    expect(badges.at(-1)?.className).toBe('unsupported');
  });

  it('Removed from Store: taken down and not installed, on the not-found page', async () => {
    await openDetail({
      detail: { platform: 'darwin-arm64', storeStatus: 'taken_down', harness: null },
    });
    const gone = screen.getByRole('region', { name: 'This Harness is no longer available' });
    expect(
      within(gone).getByText('It was unpublished or taken down. Installed copies keep working.'),
    ).toBeDefined();
    expect(buttons(gone)).toEqual(['Removed from Store (disabled)']);
  });

  it('Launch with Uninstall: installed at the latest version, marked in the history', async () => {
    const api = await openDetail({ install: installed('1.2.0') });
    expect(buttons()).toEqual(['Launch', 'Uninstall']);
    const entries = within(region('Version history')).getAllByRole('listitem');
    expect(entries.map((entry) => entry.textContent.includes('Installed'))).toEqual([
      true,
      false,
      false,
    ]);
    // The Library's launcher: this Harness asks for a Workspace, so the sheet opens first.
    await act(async () => {
      fireEvent.click(within(actions()).getByRole('button', { name: 'Launch' }));
      await Promise.resolve();
    });
    expect(screen.getByRole('dialog', { name: 'Choose a folder for Writer' })).toBeDefined();
    expect(api.launch.start).not.toHaveBeenCalled();
  });

  it('Update with Launch: installed at an older version', async () => {
    await openDetail({ install: installed('1.1.0') });
    expect(buttons()).toEqual(['Update', 'Launch']);
    const entries = within(region('Version history')).getAllByRole('listitem');
    expect(entries.map((entry) => entry.textContent.includes('Installed'))).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('Update with "Set up a model first" when nothing can fill the default Slot, as in the Library', async () => {
    const api = setup({
      install: installed('1.1.0', {
        manifest: { ...MANIFEST, version: '1.1.0', workspace: 'none' },
      }),
    });
    api.launch.start.mockResolvedValue({
      ok: false,
      error: { code: 'slot_unbound', messageKey: 'error.slot_unbound', message: 'Unbound.' },
    });
    await renderApp('#/store/h/alice/writer');
    await settle();
    expect(buttons()).toEqual(['Update', 'Launch']);
    await act(async () => {
      fireEvent.click(within(actions()).getByRole('button', { name: 'Launch' }));
      await Promise.resolve();
    });
    await settle();
    expect(api.launch.start).toHaveBeenCalledWith({ harnessId: 'alice/writer' });
    expect(buttons()).toEqual(['Update', 'Set up a model first']);
    // The Models page scrolls to the Harness a deep link names; jsdom does not scroll.
    Element.prototype.scrollIntoView = vi.fn();
    await act(async () => {
      fireEvent.click(within(actions()).getByRole('button', { name: 'Set up a model first' }));
      await Promise.resolve();
    });
    expect(window.location.hash).toBe('#/models?harness=alice%2Fwriter');
  });

  it.each([
    ['starting', 'spawning', ['Starting… (disabled)']],
    ['running', 'ready', ['Running…', 'Show window']],
    ['stopping', 'stopping', ['Stopping… (disabled)']],
  ] as const)(
    'Update gives way to the Library’s launch state while the Harness is %s',
    async (_, state, expected) => {
      const api = setup({ install: installed('1.1.0') });
      api.launch.status.mockResolvedValue({
        ok: true,
        data: [
          {
            harnessId: 'alice/writer',
            launchId: 'launch-1',
            state,
            startedAt: '2026-10-28T09:00:00.000Z',
          },
        ],
      });
      await renderApp('#/store/h/alice/writer');
      await settle();
      expect(buttons()).toEqual(expected);
    },
  );

  it('Running…, as in the Library, while the installed Harness runs', async () => {
    const api = setup({
      install: installed('1.2.0', { manifest: { ...MANIFEST, workspace: 'none' } }),
    });
    api.launch.status.mockResolvedValue({
      ok: true,
      data: [
        {
          harnessId: 'alice/writer',
          launchId: 'launch-1',
          state: 'ready',
          startedAt: '2026-10-28T09:00:00.000Z',
        },
      ],
    });
    await renderApp('#/store/h/alice/writer');
    await settle();
    expect(buttons()).toEqual(['Running…', 'Show window']);
  });

  it('progress and Cancel while downloading', async () => {
    installFakeApi();
    const cancel = vi.fn();
    await act(async () => {
      render(
        <I18nProvider>
          <MemoryRouter>
            <DetailAction
              state="downloading"
              install={null}
              launch={undefined}
              download={{ percent: 42, onCancel: cancel }}
              onError={() => undefined}
            />
          </MemoryRouter>
        </I18nProvider>,
      );
      await Promise.resolve();
    });
    expect(
      screen
        .getAllByRole('button')
        .map((button) => [button.textContent, (button as HTMLButtonElement).disabled]),
    ).toEqual([
      ['Downloading 42%', true],
      ['Cancel', false],
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('opening the page', () => {
  it('opens the same page from a Library card’s View in Store', async () => {
    const api = setup({ install: installed('1.2.0') });
    await renderApp('#/library');
    await settle();
    const card = screen.getByRole('article', { name: 'Writer' });
    fireEvent.click(within(card).getByRole('button', { name: 'More actions for Writer' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: 'View in Store' }));
      await Promise.resolve();
    });
    await settle();
    expect(window.location.hash).toBe('#/store/h/alice/writer');
    expect(api.store.detail).toHaveBeenCalledWith('alice/writer');
    expect(within(page()).getByRole('heading', { level: 2, name: 'Writer' })).toBeDefined();
    expect(buttons()).toEqual(['Launch', 'Uninstall']);
  });

  it('keeps the page of an installed Harness the Store no longer offers, with Launch and a note', async () => {
    await openDetail({
      detail: { platform: 'darwin-arm64', storeStatus: 'unpublished', harness: null },
      install: installed('1.1.0'),
    });
    expect(within(page()).getByText('Version 1.1.0')).toBeDefined();
    // The Publisher may still have other Harnesses in the Store.
    expect(within(page()).getByRole('link', { name: 'by alice' }).getAttribute('href')).toBe(
      '#/store/p/alice',
    );
    expect(buttons()).toEqual(['Launch', 'Uninstall']);
    // Its installed Manifest's changelog is its only version history.
    const entries = within(region('Version history')).getAllByRole('listitem');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.textContent).toContain('1.1.0');
    expect(entries[0]?.querySelector('strong')?.textContent).toBe('outlines');
    expect(within(actions()).getByText('No longer available in the Store')).toBeDefined();
  });

  it('shows a failed read inline, and Retry reads again', async () => {
    const api = setup();
    api.store.detail.mockResolvedValueOnce({
      ok: false,
      error: { code: 'store_error', messageKey: 'error.store_error', message: 'Unexpected.' },
    });
    await renderApp('#/store/h/alice/writer');
    await settle();
    const failed = screen.getByRole('region', { name: "Couldn't load the Store" });
    await act(async () => {
      fireEvent.click(within(failed).getByRole('button', { name: 'Retry' }));
      await Promise.resolve();
    });
    await settle();
    expect(api.store.detail).toHaveBeenCalledTimes(2);
    expect(page()).toBeDefined();
  });

  it('goes back to the Store home from a page opened directly, and back where it came from otherwise', async () => {
    // A new history entry, as when the app opens: nothing in the app to go back to.
    window.location.hash = '#/settings';
    const api = await openDetail();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      await Promise.resolve();
    });
    expect(window.location.hash).toBe('#/store');
    cleanup();

    const listing: StoreListing = {
      harnessId: 'alice/writer',
      publisher: 'alice',
      name: 'Writer',
      summary: 'Drafts and edits long texts.',
      iconUrl: null,
      tags: ['writing'],
      downloadCount: 1260,
      latestVersion: '1.2.0',
      latestPublishedAt: '2026-10-20T09:00:00.000000+00:00',
      platforms: ['darwin-arm64'],
    };
    const home: StoreHome = {
      platform: 'darwin-arm64',
      featured: [listing],
      mostDownloaded: [],
      newest: [],
    };
    api.store.home.mockResolvedValue({ ok: true, data: home });
    api.store.search.mockResolvedValue({
      ok: true,
      data: { platform: 'darwin-arm64', listings: [listing], hasMore: false },
    });
    await renderApp('#/store');
    await settle();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search Harnesses' }), {
      target: { value: 'writer' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByRole('search'));
      await Promise.resolve();
    });
    await settle();
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('list', { name: 'Search results' })).getByRole('link', {
          name: 'Writer',
        }),
      );
      await Promise.resolve();
    });
    await settle();
    expect(window.location.hash).toBe('#/store/h/alice/writer');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      await Promise.resolve();
    });
    await settle();
    expect(window.location.hash).toBe('#/store');
    // The search is as it was left.
    expect(
      screen.getByRole<HTMLInputElement>('searchbox', { name: 'Search Harnesses' }).value,
    ).toBe('writer');
    expect(screen.getByRole('list', { name: 'Search results' })).toBeDefined();
  });
});

/**
 * Every Manifest field the page leaves out, on purpose: they say nothing to a User deciding whether
 * to install. Everything else in the schema has a place on the page.
 */
const OMITTED = [
  '$schema',
  'manifestVersion',
  'x-*',
  'entry',
  'ui.path',
  'ui.readyTimeoutSeconds',
  'ui.window',
  'runtime.node',
  'channel',
];

/** Where the page shows each other field of {@link MANIFEST}, as text it contains. */
const SHOWN: Readonly<Record<string, string>> = {
  id: 'alice/writer',
  version: 'Version 1.2.0',
  name: 'Writer',
  summary: 'Drafts and edits long texts.',
  tags: 'WritingResearch',
  license: 'License: Apache-2.0',
  homepage: 'Homepage',
  sourceRepo: 'Source',
  platforms: 'darwin-arm64 (this computer)linux-x64',
  'runtime.kind': 'Runs on the bundled Node runtime',
  'ui.kind': 'Opens as a window',
  workspace: 'Needs a folder to work in',
  'models.slots.default.description': 'Drafts the text.',
  // Each Slot's Model Requirements share one line: `default` asks for these two, `review` for the
  // other two.
  'models.slots.default.requirements.tools': 'tool calling',
  'models.slots.default.requirements.minContext': 'context window ≥ 32,000',
  'models.slots.default.requirements.vision': 'vision',
  'models.slots.default.requirements.json': 'JSON output',
  'models.slots.default.recommended': 'Recommended: ollama/qwen3:8b',
  'models.slots.*.description': 'Checks the draft.',
  'models.slots.*.requirements.vision': 'vision',
  'models.slots.*.requirements.json': 'JSON output',
  'models.slots.*.requirements.tools': 'tool calling',
  'models.slots.*.requirements.minContext': 'context window ≥ 32,000',
  'models.slots.*.recommended': 'Recommended: anthropic/claude-x',
  'permissions.filesystem.scope': 'Reads and writes files in the folder you choose',
  'permissions.shell': 'Runs shell commands',
  'permissions.network.domains': 'Connects to: api.example.com',
  changelog: 'Adds outlines.',
};

/** Fields one Manifest cannot show together, each with the Manifest that shows it. */
const SHOWN_ELSEWHERE: Readonly<Record<string, readonly [Partial<Manifest>, string]>> = {
  'permissions.filesystem.paths': [
    {
      permissions: { ...MANIFEST.permissions, filesystem: { scope: 'paths', paths: ['~/notes'] } },
    },
    'Reads and writes these paths: ~/notes',
  ],
  'permissions.network.any': [
    { permissions: { ...MANIFEST.permissions, network: { any: true } } },
    'Connects to the internet (any site)',
  ],
};

interface SchemaNode {
  readonly $ref?: string;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly additionalProperties?: SchemaNode | boolean;
  readonly patternProperties?: Readonly<Record<string, SchemaNode>>;
}

/** The dotted path of every leaf field of the schema; `*` for any key, `x-*` for `^x-` keys. */
function schemaFields(node: SchemaNode, path: readonly string[] = []): string[] {
  const here = path.join('.');
  if (OMITTED.includes(here)) return [here];
  const defs = (manifestSchema as { $defs: Record<string, SchemaNode> }).$defs;
  const resolved =
    node.$ref === undefined ? node : { ...defs[node.$ref.replace('#/$defs/', '')], ...node };
  const fields = Object.entries(resolved.properties ?? {}).flatMap(([key, child]) =>
    schemaFields(child, [...path, key]),
  );
  if (typeof resolved.additionalProperties === 'object') {
    fields.push(...schemaFields(resolved.additionalProperties, [...path, '*']));
  }
  if (resolved.patternProperties !== undefined) fields.push('x-*');
  return fields.length === 0 ? [here] : fields;
}

describe('every Manifest field', () => {
  it('has a place on the page, but the fields left out on purpose', async () => {
    const fields = schemaFields(manifestSchema);
    expect([...fields].sort()).toEqual(
      [...OMITTED, ...Object.keys(SHOWN), ...Object.keys(SHOWN_ELSEWHERE)].sort(),
    );

    await openDetail();
    const text = page().textContent;
    for (const [field, shown] of Object.entries(SHOWN)) expect(text, field).toContain(shown);
    // The fields left out really are not shown.
    for (const hidden of ['dist/server-entry.js', '/app-path', '47', '913', 'stable']) {
      expect(text).not.toContain(hidden);
    }
    cleanup();

    for (const [field, [patch, shown]] of Object.entries(SHOWN_ELSEWHERE)) {
      await openDetail({
        detail: { ...DETAIL, harness: { ...WRITER, manifest: { ...MANIFEST, ...patch } } },
      });
      expect(page().textContent, field).toContain(shown);
      cleanup();
    }
  });
});
