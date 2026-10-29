// @vitest-environment jsdom
/**
 * Ticket P0-03.5 on the Models page, over the fake `window.api`: one card per installed Harness
 * with a row per Model Slot (description, Model Requirements, Recommended Models, the resolved
 * model and why), Model Overrides set and cleared, requirement warnings, and the deep link
 * `models?harness=<id>`. The fake Runtime resolves a Slot to its override when it has one, else to
 * what the test says the automatic order would choose.
 */
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { Manifest, ModelSlot } from '@harness-store/manifest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConnectionSummary,
  InstalledHarness,
  ModelInfo,
  ResolvedBinding,
  ResolvedSlot,
} from '../../src/shared/ipc.js';
import { connectionSummary, installFakeApi, renderApp } from './render-app.js';

const REVIEWER = 'alice/code-reviewer';
const NOTES = 'bob/notes';

/** Anthropic's catalogue as `connections.models` answers it: one model without tools. */
const CATALOGUE: readonly ModelInfo[] = [
  { id: 'claude-opus-5-5', contextWindow: 1_000_000, tools: true, vision: true },
  { id: 'claude-mini', contextWindow: 32_000, tools: false, vision: false },
];
const ANTHROPIC = connectionSummary({
  id: 'anthropic',
  keyHint: '6789',
  models: CATALOGUE.map((model) => model.id),
});
const OLLAMA = connectionSummary({ id: 'ollama', models: ['qwen3:8b'] });

function manifest(id: string, name: string, slots: Record<string, ModelSlot>): Manifest {
  return {
    manifestVersion: 1,
    id,
    version: '1.0.0',
    name,
    summary: 'A test Harness.',
    license: 'MIT',
    platforms: ['darwin-arm64', 'linux-x64', 'win32-x64'],
    runtime: { kind: 'node', node: '22' },
    entry: 'dist/index.js',
    ui: { kind: 'web' },
    models: { slots: { default: {}, ...slots } },
    permissions: { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } },
  };
}

function installed(id: string, name: string, slots: Record<string, ModelSlot>): InstalledHarness {
  const [publisher = '', slug = ''] = id.split('/');
  return {
    harnessId: id,
    version: '1.0.0',
    name,
    publisher,
    source: 'store',
    manifest: manifest(id, name, slots),
    installPath: `/profile/harnesses/${publisher}/${slug}/1.0.0`,
    installedAt: '2026-10-01T00:00:00.000Z',
    lastLaunchedAt: null,
    iconDataUrl: null,
    platformSupported: true,
    storeStatus: null,
    installedVersionTakenDown: false,
    takedownAcknowledged: false,
    availableUpdate: null,
  };
}

const CODE_REVIEWER = installed(REVIEWER, 'Code Reviewer', {
  default: {
    description: 'Reviews the diff',
    requirements: { tools: true, minContext: 100_000 },
    recommended: ['anthropic/claude-opus-5-5', 'ollama/qwen3:8b'],
  },
  fast: { description: 'Names the review' },
});
const NOTES_APP = installed(NOTES, 'Notes', { default: { description: 'Writes notes' } });

/** jsdom has no scrolling: records which element was scrolled into view. */
let scrollIntoView: ReturnType<typeof vi.fn<(options?: ScrollIntoViewOptions) => void>>;

/** What the automatic order picks per Harness and Slot, when no override is set. */
let automatic: Record<string, Record<string, ResolvedBinding | null>>;

beforeEach(() => {
  automatic = {
    [REVIEWER]: {
      default: { connectionId: 'anthropic', model: 'claude-opus-5-5', source: 'recommended' },
      fast: { connectionId: 'ollama', model: 'qwen3:8b', source: 'default' },
    },
    [NOTES]: { default: null },
  };
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  cleanup();
});

async function openModels(
  hash = '#/models',
  options: {
    installs?: readonly InstalledHarness[];
    connections?: readonly ConnectionSummary[];
    locale?: 'en' | 'zh-CN';
    /** Runs on the fake Runtime before the page renders, such as setting an override. */
    before?: (api: ReturnType<typeof installFakeApi>) => Promise<unknown>;
  } = {},
) {
  const api = installFakeApi(options.locale ?? 'en');
  const installs = options.installs ?? [CODE_REVIEWER, NOTES_APP];
  const connections = options.connections ?? [ANTHROPIC, OLLAMA];
  api.installs.list.mockResolvedValue({ ok: true, data: installs });
  api.connections.list.mockResolvedValue({ ok: true, data: connections });
  api.connections.models.mockImplementation((id: string) =>
    Promise.resolve({
      ok: true,
      data:
        id === 'anthropic'
          ? CATALOGUE
          : (connections.find((item) => item.id === id)?.models ?? []).map((model) => ({
              id: model,
            })),
    }),
  );
  api.bindings.resolveAll.mockImplementation(async (harnessId: string) => {
    const result = await api.bindings.getForHarness(harnessId);
    const overrides = result.ok ? result.data : [];
    const install = installs.find((item) => item.harnessId === harnessId);
    const slots = Object.keys(install?.manifest.models.slots ?? {});
    return {
      ok: true,
      data: slots.map((slot): ResolvedSlot => {
        const override = overrides.find((row) => row.slot === slot);
        return {
          slot,
          binding:
            override === undefined
              ? (automatic[harnessId]?.[slot] ?? null)
              : { connectionId: override.connectionId, model: override.model, source: 'override' },
        };
      }),
    };
  });
  await options.before?.(api);
  await renderApp(hash);
  await settle();
  return api;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
  await settle();
}

function section() {
  return screen.getByRole('region', { name: 'Per-Harness Overrides' });
}

function card(name: string) {
  return within(section()).getByRole('article', { name });
}

function toggle(name: string) {
  return within(card(name)).getByRole('button', { name: new RegExp(`^${name}`) });
}

function slotRow(name: string, slot: string) {
  const row = within(card(name))
    .getAllByRole('listitem')
    .find((item) => item.querySelector('.override-row-slot')?.textContent === slot);
  if (row === undefined) throw new Error(`No row for ${slot}`);
  return row;
}

async function choose(row: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.change(within(row).getByRole('combobox'), { target: { value } });
    await Promise.resolve();
  });
  await settle();
}

describe('Per-Harness Overrides', () => {
  it('has one collapsed card per installed Harness, with its Slot count', async () => {
    await openModels();
    expect(
      within(section())
        .getAllByRole('article')
        .map((item) => item.getAttribute('aria-label')),
    ).toEqual(['Code Reviewer', 'Notes']);
    expect(toggle('Code Reviewer').getAttribute('aria-expanded')).toBe('false');
    expect(within(card('Code Reviewer')).getByText('2 Slots')).toBeDefined();
    expect(within(card('Notes')).getByText('1 Slot')).toBeDefined();
    expect(within(card('Code Reviewer')).queryByRole('combobox')).toBeNull();
  });

  it('says so when nothing is installed', async () => {
    await openModels('#/models', { installs: [] });
    expect(
      within(section()).getByText(
        'Nothing installed yet. Each Harness you install gets a card here to override its Model Slots.',
      ),
    ).toBeDefined();
  });

  it('expanded: each Slot with its description, requirements, Recommended Models and resolution', async () => {
    await openModels();
    await click(toggle('Code Reviewer'));
    expect(toggle('Code Reviewer').getAttribute('aria-expanded')).toBe('true');

    const main = slotRow('Code Reviewer', 'default');
    expect(within(main).getByText('Reviews the diff')).toBeDefined();
    expect(
      within(main).getByText('Needs: tool calling and context window ≥ 100,000'),
    ).toBeDefined();
    expect(
      within(main).getByText('Recommended: anthropic/claude-opus-5-5, ollama/qwen3:8b'),
    ).toBeDefined();
    expect(within(main).getByText('Anthropic · claude-opus-5-5')).toBeDefined();
    expect(within(main).getByText('Uses: Recommended')).toBeDefined();
    expect(
      within(main).getByRole<HTMLSelectElement>('combobox', { name: 'Model Override for default' })
        .selectedOptions[0]?.textContent,
    ).toBe('No override');
    expect(within(main).queryByRole('button', { name: 'Clear override' })).toBeNull();
    // claude-opus-5-5 meets the requirements: no warning.
    expect(within(main).queryByRole('note')).toBeNull();

    const fast = slotRow('Code Reviewer', 'fast');
    expect(within(fast).getByText('Ollama · qwen3:8b')).toBeDefined();
    expect(within(fast).getByText('Uses: Default')).toBeDefined();
  });

  it('a Default Model of the same Slot name is also shown as Default; nothing at all as Unbound', async () => {
    automatic[REVIEWER] = {
      default: { connectionId: 'ollama', model: 'qwen3:8b', source: 'default_same_name' },
      fast: null,
    };
    await openModels();
    await click(toggle('Code Reviewer'));
    expect(within(slotRow('Code Reviewer', 'default')).getByText('Uses: Default')).toBeDefined();
    const fast = slotRow('Code Reviewer', 'fast');
    expect(within(fast).getByText('Unbound')).toBeDefined();
    expect(within(fast).getByText('No Connection can fill this Slot')).toBeDefined();
  });

  it('an override is saved at once and wins; Clear override reverts to the automatic choice', async () => {
    const api = await openModels();
    await click(toggle('Code Reviewer'));
    await choose(slotRow('Code Reviewer', 'fast'), 'anthropic/claude-opus-5-5');
    expect(api.bindings.setOverride).toHaveBeenCalledExactlyOnceWith({
      harnessId: REVIEWER,
      slot: 'fast',
      target: { connectionId: 'anthropic', model: 'claude-opus-5-5' },
    });
    let fast = slotRow('Code Reviewer', 'fast');
    expect(within(fast).getByText('Uses: Override')).toBeDefined();
    expect(within(fast).getByText('Anthropic · claude-opus-5-5')).toBeDefined();
    expect(within(fast).getByRole<HTMLSelectElement>('combobox').value).toBe(
      'anthropic/claude-opus-5-5',
    );

    await click(within(fast).getByRole('button', { name: 'Clear override' }));
    expect(api.bindings.clearOverride).toHaveBeenCalledExactlyOnceWith({
      harnessId: REVIEWER,
      slot: 'fast',
    });
    fast = slotRow('Code Reviewer', 'fast');
    expect(within(fast).getByText('Uses: Default')).toBeDefined();
    expect(within(fast).getByText('Ollama · qwen3:8b')).toBeDefined();
    expect(within(fast).queryByRole('button', { name: 'Clear override' })).toBeNull();
  });

  it('No override in the picker clears an override too', async () => {
    const api = await openModels('#/models', {
      before: (fake) =>
        fake.bindings.setOverride({
          harnessId: REVIEWER,
          slot: 'default',
          target: { connectionId: 'ollama', model: 'qwen3:8b' },
        }),
    });
    await click(toggle('Code Reviewer'));
    const main = slotRow('Code Reviewer', 'default');
    expect(within(main).getByText('Uses: Override')).toBeDefined();
    expect(within(main).getByRole<HTMLSelectElement>('combobox').value).toBe('ollama/qwen3:8b');
    await choose(main, '');
    expect(api.bindings.clearOverride).toHaveBeenCalledWith({
      harnessId: REVIEWER,
      slot: 'default',
    });
    expect(
      within(slotRow('Code Reviewer', 'default')).getByText('Uses: Recommended'),
    ).toBeDefined();
  });

  it('a model that fails the requirements warns, naming what is missing, and is still used', async () => {
    const api = await openModels();
    await click(toggle('Code Reviewer'));
    await choose(slotRow('Code Reviewer', 'default'), 'anthropic/claude-mini');
    expect(api.bindings.setOverride).toHaveBeenCalledOnce();
    const main = slotRow('Code Reviewer', 'default');
    expect(within(main).getByText('Uses: Override')).toBeDefined();
    expect(within(main).getByRole('note').textContent).toBe(
      "This model may not meet the requirements of Code Reviewer's `default` Slot (tool calling and context window ≥ 100,000).",
    );
  });

  it('the warning in Chinese follows the same pattern', async () => {
    automatic[REVIEWER] = {
      default: { connectionId: 'anthropic', model: 'claude-mini', source: 'recommended' },
      fast: null,
    };
    await openModels('#/models', { locale: 'zh-CN' });
    const reviewer = within(
      screen.getByRole('region', { name: '各 Harness 的槽位覆盖' }),
    ).getByRole('article', { name: 'Code Reviewer' });
    await click(within(reviewer).getByRole('button', { name: /^Code Reviewer/ }));
    expect(within(reviewer).getByText('来源：推荐模型')).toBeDefined();
    expect(within(reviewer).getByRole('note').textContent).toBe(
      '此模型可能不满足 Code Reviewer 的 `default` 槽位要求（工具调用和上下文 ≥ 100,000）。',
    );
  });

  it('a typed model with no catalogue entry has unknown capabilities, never a failure', async () => {
    await openModels();
    await click(toggle('Code Reviewer'));
    const main = slotRow('Code Reviewer', 'default');
    await act(async () => {
      fireEvent.click(within(main).getByRole('button', { name: 'Type a model name' }));
      await Promise.resolve();
    });
    fireEvent.change(within(main).getByRole('textbox', { name: 'Type a model name' }), {
      target: { value: 'ollama/my-own-model' },
    });
    await click(within(main).getByRole('button', { name: 'Use' }));
    const row = slotRow('Code Reviewer', 'default');
    expect(within(row).getByText('Uses: Override')).toBeDefined();
    expect(within(row).getByRole('note').textContent).toBe(
      "Capabilities unknown: this model cannot be checked against the requirements of Code Reviewer's `default` Slot.",
    );
    expect(within(row).queryByText(/may not meet/)).toBeNull();
  });

  it('an override whose Connection is disabled is kept and marked', async () => {
    automatic[NOTES] = {
      default: { connectionId: 'anthropic', model: 'claude-opus-5-5', source: 'default' },
    };
    await openModels('#/models', {
      connections: [ANTHROPIC, { ...OLLAMA, enabled: false }],
      before: (fake) =>
        fake.bindings.setOverride({
          harnessId: NOTES,
          slot: 'default',
          target: { connectionId: 'ollama', model: 'qwen3:8b' },
        }),
    });
    await click(toggle('Notes'));
    const row = slotRow('Notes', 'default');
    expect(within(row).getByText('Connection disabled')).toBeDefined();
    expect(within(row).getByRole<HTMLSelectElement>('combobox').value).toBe('ollama/qwen3:8b');
    expect(within(row).getByRole('button', { name: 'Clear override' })).toBeDefined();
  });
});

describe('the deep link models?harness=<id>', () => {
  it("opens that Harness's card and scrolls it into view; the others stay closed", async () => {
    await openModels(`#/models?harness=${encodeURIComponent(REVIEWER)}`);
    expect(toggle('Code Reviewer').getAttribute('aria-expanded')).toBe('true');
    expect(toggle('Notes').getAttribute('aria-expanded')).toBe('false');
    expect(within(card('Code Reviewer')).getAllByRole('combobox')).toHaveLength(2);
    expect(scrollIntoView.mock.contexts).toEqual([card('Code Reviewer')]);
  });

  it('an unknown Harness ID opens nothing', async () => {
    await openModels('#/models?harness=nobody%2Fnothing');
    expect(toggle('Code Reviewer').getAttribute('aria-expanded')).toBe('false');
    expect(toggle('Notes').getAttribute('aria-expanded')).toBe('false');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('Default Models with installed Harnesses', () => {
  function defaults() {
    return screen.getByRole('region', { name: 'Default Models' });
  }

  it('has a row for every Slot name an installed Harness declares, beside `default`', async () => {
    await openModels();
    expect(
      within(defaults())
        .getAllByRole('listitem')
        .map((item) => item.querySelector('.default-model-slot')?.textContent),
    ).toEqual(['default', 'fast']);
  });

  it('warns about each installed Harness whose same-name Slot the Default Model may not meet', async () => {
    const api = await openModels();
    await act(async () => {
      fireEvent.change(
        within(defaults()).getByRole('combobox', { name: 'Default Model for default' }),
        { target: { value: 'anthropic/claude-mini' } },
      );
      await Promise.resolve();
    });
    await settle();
    expect(api.bindings.setGlobal).toHaveBeenCalledOnce();
    expect(
      within(defaults())
        .getAllByRole('note')
        .map((note) => note.textContent),
    ).toEqual([
      "This model may not meet the requirements of Code Reviewer's `default` Slot (tool calling and context window ≥ 100,000).",
    ]);
  });

  it('a Default Model change makes the Harness cards resolve again', async () => {
    const api = await openModels();
    await click(toggle('Notes'));
    const calls = api.bindings.resolveAll.mock.calls.length;
    automatic[NOTES] = {
      default: { connectionId: 'ollama', model: 'qwen3:8b', source: 'default' },
    };
    await act(async () => {
      fireEvent.change(
        within(defaults()).getByRole('combobox', { name: 'Default Model for default' }),
        { target: { value: 'ollama/qwen3:8b' } },
      );
      await Promise.resolve();
    });
    await settle();
    expect(api.bindings.resolveAll.mock.calls.length).toBeGreaterThan(calls);
    expect(within(slotRow('Notes', 'default')).getByText('Uses: Default')).toBeDefined();
  });
});

describe('Remove Connection', () => {
  it('names the Model Overrides that use the Connection, with their Harness', async () => {
    const api = await openModels();
    await api.bindings.setOverride({
      harnessId: REVIEWER,
      slot: 'fast',
      target: { connectionId: 'ollama', model: 'qwen3:8b' },
    });
    await api.bindings.setGlobal({
      slot: 'default',
      target: { connectionId: 'ollama', model: 'qwen3:8b' },
    });
    await click(screen.getByRole('button', { name: 'Remove Ollama' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['defaultollama/qwen3:8b', 'Code Reviewerfastollama/qwen3:8b']);
  });
});
