// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ConnectionSummary,
  ConnectionUpdate,
  GlobalBinding,
  ModelInfo,
} from '../../src/shared/ipc.js';
import { connectionSummary, installFakeApi, renderApp } from './render-app.js';

const ANTHROPIC = connectionSummary({
  id: 'anthropic',
  keyHint: '6789',
  models: ['claude-opus-5-5', 'claude-haiku-5-5'],
});
const OLLAMA = connectionSummary({ id: 'ollama', models: ['qwen3:8b', 'llama3.2:3b'] });
const VLLM = connectionSummary({
  id: 'openai-compatible:vllm',
  displayName: 'vLLM',
  baseUrl: 'http://10.0.0.2:8000/v1',
});

const RESOLUTION_ORDER =
  'Each request resolves in order: Model Override, then the first Recommended Model with an enabled Connection, then the Default Model for that Slot, then the Default Model for `default`.';

afterEach(() => {
  cleanup();
});

/**
 * A fake Runtime holding `initial` Connections and `bindings`: Enable and Disable change what
 * connections.list answers next, and bindings.setGlobal what bindings.getGlobal answers (the fake
 * api's own).
 */
async function openModels(
  initial: readonly ConnectionSummary[],
  bindings: readonly GlobalBinding[] = [],
  locale: 'en' | 'zh-CN' = 'en',
) {
  const api = installFakeApi(locale);
  let connections = [...initial];
  api.connections.list.mockImplementation(() => Promise.resolve({ ok: true, data: connections }));
  api.connections.update.mockImplementation((update: ConnectionUpdate) => {
    const current = connections.find((item) => item.id === update.id);
    if (current === undefined) throw new Error(`unknown ${update.id}`);
    const next = {
      ...current,
      ...(update.enabled === undefined ? {} : { enabled: update.enabled }),
    };
    connections = connections.map((item) => (item.id === next.id ? next : item));
    return Promise.resolve({ ok: true, data: next });
  });
  api.connections.models.mockImplementation((id: string) =>
    Promise.resolve({
      ok: true,
      data: (connections.find((item) => item.id === id)?.models ?? []).map((model): ModelInfo => ({
        id: model,
      })),
    }),
  );
  for (const binding of bindings) {
    await api.bindings.setGlobal({
      slot: binding.slot,
      target: { connectionId: binding.connectionId, model: binding.model },
    });
  }
  api.bindings.setGlobal.mockClear();
  await renderApp('#/models');
  await settle();
  return api;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function section() {
  return screen.getByRole('region', { name: 'Default Models' });
}

function rows() {
  return within(section()).getAllByRole('listitem');
}

function rowFor(slot: string) {
  const row = rows().find(
    (item) => item.querySelector('.default-model-slot')?.textContent === slot,
  );
  if (row === undefined) throw new Error(`No row for ${slot}`);
  return row;
}

function pickerFor(slot: string) {
  return within(section()).getByRole<HTMLSelectElement>('combobox', {
    name: `Default Model for ${slot}`,
  });
}

async function choose(slot: string, value: string) {
  await act(async () => {
    fireEvent.change(pickerFor(slot), { target: { value } });
    await Promise.resolve();
  });
  await settle();
}

describe('Default Models on the Models page', () => {
  it('always has a `default` row, Not set, with the resolution order', async () => {
    await openModels([]);
    expect(within(section()).getByRole('heading', { level: 2 }).textContent).toBe('Default Models');
    expect(within(section()).getByText(RESOLUTION_ORDER)).toBeDefined();
    expect(rows().map((row) => row.querySelector('.default-model-slot')?.textContent)).toEqual([
      'default',
    ]);
    expect(pickerFor('default').selectedOptions[0]?.textContent).toBe('Not set');
    expect(
      within(section()).getByText('Add a Connection to choose a Default Model.'),
    ).toBeDefined();
  });

  it('lists `default` first, then every other bound Slot by name, each showing its model', async () => {
    await openModels(
      [ANTHROPIC, OLLAMA],
      [
        { slot: 'summarize', connectionId: 'ollama', model: 'llama3.2:3b' },
        { slot: 'fast', connectionId: 'ollama', model: 'qwen3:8b' },
      ],
    );
    expect(rows().map((row) => row.querySelector('.default-model-slot')?.textContent)).toEqual([
      'default',
      'fast',
      'summarize',
    ]);
    expect(pickerFor('default').value).toBe('');
    expect(pickerFor('fast').value).toBe('ollama/qwen3:8b');
    expect(pickerFor('summarize').value).toBe('ollama/llama3.2:3b');
    expect(screen.queryByText('Add a Connection to choose a Default Model.')).toBeNull();
  });

  it("groups each picker's models by Connection, with Not set first", async () => {
    await openModels([ANTHROPIC, OLLAMA, VLLM]);
    const picker = pickerFor('default');
    expect(
      within(picker)
        .getAllByRole('group')
        .map((group) => group.getAttribute('label')),
    ).toEqual(['Anthropic', 'Ollama', 'vLLM']);
    expect(
      within(within(picker).getByRole('group', { name: 'Ollama' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['qwen3:8b', 'llama3.2:3b']);
    expect(picker.options[0]?.textContent).toBe('Not set');
  });

  it('saves a chosen model as the Default Model at once, and a change replaces it', async () => {
    const api = await openModels([ANTHROPIC, OLLAMA]);
    await choose('default', 'anthropic/claude-opus-5-5');
    expect(api.bindings.setGlobal).toHaveBeenCalledExactlyOnceWith({
      slot: 'default',
      target: { connectionId: 'anthropic', model: 'claude-opus-5-5' },
    });
    expect(pickerFor('default').value).toBe('anthropic/claude-opus-5-5');

    await choose('default', 'ollama/qwen3:8b');
    expect(api.bindings.setGlobal).toHaveBeenLastCalledWith({
      slot: 'default',
      target: { connectionId: 'ollama', model: 'qwen3:8b' },
    });
    expect(pickerFor('default').value).toBe('ollama/qwen3:8b');
  });

  it('saves a typed provider/model, for a model the Connection does not list', async () => {
    const api = await openModels([VLLM]);
    const row = rowFor('default');
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Type a model name' }));
      await Promise.resolve();
    });
    fireEvent.change(within(row).getByRole('textbox', { name: 'Type a model name' }), {
      target: { value: 'openai-compatible:vllm/meta/llama-4-scout' },
    });
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Use' }));
      await Promise.resolve();
    });
    await settle();
    expect(api.bindings.setGlobal).toHaveBeenCalledExactlyOnceWith({
      slot: 'default',
      target: { connectionId: 'openai-compatible:vllm', model: 'meta/llama-4-scout' },
    });
    expect(pickerFor('default').selectedOptions[0]?.textContent).toBe('meta/llama-4-scout (typed)');
  });

  it('Not set clears a Default Model; a cleared Slot stays, saying it falls back to `default`', async () => {
    const api = await openModels(
      [OLLAMA],
      [
        { slot: 'default', connectionId: 'ollama', model: 'qwen3:8b' },
        { slot: 'fast', connectionId: 'ollama', model: 'llama3.2:3b' },
      ],
    );
    expect(within(rowFor('fast')).queryByText(/falls back/)).toBeNull();
    await choose('fast', '');
    expect(api.bindings.setGlobal).toHaveBeenCalledExactlyOnceWith({ slot: 'fast', target: null });
    expect(pickerFor('fast').value).toBe('');
    expect(
      within(rowFor('fast')).getByText(
        'Not set: this Slot falls back to the `default` Default Model.',
      ),
    ).toBeDefined();
    // `default` never says so: there is nothing to fall back to.
    await choose('default', '');
    expect(within(rowFor('default')).queryByText(/falls back/)).toBeNull();
  });

  it('marks a Default Model whose Connection is disabled, and still shows the model', async () => {
    await openModels(
      [{ ...OLLAMA, enabled: false }, ANTHROPIC],
      [{ slot: 'default', connectionId: 'ollama', model: 'qwen3:8b' }],
    );
    const note = within(rowFor('default')).getByRole('note');
    expect(note.querySelector('.status-chip')?.textContent).toBe('Connection disabled');
    expect(note.textContent).toContain(
      'Ollama is disabled, so requests for this Slot fall back to the next choice in the resolution order.',
    );
    expect(pickerFor('default').value).toBe('ollama/qwen3:8b');
    // Only enabled Connections are offered beyond the saved value.
    expect(
      within(pickerFor('default'))
        .getAllByRole('group')
        .map((group) => group.getAttribute('label')),
    ).toEqual(['Ollama', 'Anthropic']);
    expect(
      within(within(pickerFor('default')).getByRole('group', { name: 'Ollama' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['qwen3:8b']);
  });

  it('disabling and enabling a Connection on the same page updates the rows that use it', async () => {
    await openModels([OLLAMA], [{ slot: 'default', connectionId: 'ollama', model: 'qwen3:8b' }]);
    expect(within(rowFor('default')).queryByRole('note')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disable Ollama' }));
      await Promise.resolve();
    });
    await settle();
    expect(within(rowFor('default')).getByRole('note').textContent).toContain(
      'Connection disabled',
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable Ollama' }));
      await Promise.resolve();
    });
    await settle();
    expect(within(rowFor('default')).queryByRole('note')).toBeNull();
  });

  it('shows why a Default Model could not be saved, keeping the row as it was', async () => {
    const api = await openModels([OLLAMA]);
    api.bindings.setGlobal.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'provider_not_connected',
        messageKey: 'error.provider_not_connected',
        message: 'There is no Connection for this Provider. Add one on the Models page.',
      },
    });
    await choose('default', 'ollama/qwen3:8b');
    expect(within(rowFor('default')).getByRole('alert').textContent).toBe(
      'There is no Connection for this Provider. Add one on the Models page.',
    );
    expect(pickerFor('default').value).toBe('');
  });

  it('waits while a choice is being saved', async () => {
    const api = await openModels([OLLAMA]);
    let answer: () => void = () => undefined;
    api.bindings.setGlobal.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = () => {
          resolve({
            ok: true,
            data: [{ slot: 'default', connectionId: 'ollama', model: 'qwen3:8b' }],
          });
        };
      }),
    );
    await choose('default', 'ollama/qwen3:8b');
    expect(pickerFor('default').disabled).toBe(true);
    expect(rowFor('default').getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      answer();
      await Promise.resolve();
    });
    expect(pickerFor('default').disabled).toBe(false);
    expect(pickerFor('default').value).toBe('ollama/qwen3:8b');
  });

  it('is in Chinese with the zh-CN catalog', async () => {
    await openModels([OLLAMA], [], 'zh-CN');
    const region = screen.getByRole('region', { name: '默认模型' });
    expect(
      within(region).getByRole('combobox', { name: 'default 的默认模型' }).querySelector('option')
        ?.textContent,
    ).toBe('未设置');
  });
});
