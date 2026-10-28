// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ConnectionDraft,
  ConnectionSummary,
  ConnectionUpdate,
  GlobalBinding,
  IpcResult,
} from '../../src/shared/ipc.js';
import { connectionSummary, installFakeApi, renderApp } from './render-app.js';

const KEY = 'sk-ant-api03-secret-0123456789';

const ANTHROPIC = connectionSummary({ id: 'anthropic', keyHint: '6789' });
const OLLAMA = connectionSummary({ id: 'ollama' });
const VLLM = connectionSummary({
  id: 'openai-compatible:vllm',
  displayName: 'vLLM',
  baseUrl: 'http://10.0.0.2:8000/v1',
});

afterEach(() => {
  cleanup();
});

/**
 * A fake Runtime holding `initial` Connections: add, update and remove change what
 * connections.list answers next, as the Runtime does (the test step always passes).
 */
function installConnections(initial: readonly ConnectionSummary[], locale: 'en' | 'zh-CN' = 'en') {
  const api = installFakeApi(locale);
  let connections = [...initial];
  api.connections.list.mockImplementation(() => Promise.resolve({ ok: true, data: connections }));
  api.connections.add.mockImplementation((draft: ConnectionDraft) => {
    const id =
      draft.providerId === 'openai-compatible'
        ? `openai-compatible:${(draft.displayName ?? '').toLowerCase()}`
        : draft.providerId;
    const added = connectionSummary({
      id,
      ...(draft.displayName === undefined ? {} : { displayName: draft.displayName }),
      ...(draft.baseUrl === undefined ? {} : { baseUrl: draft.baseUrl }),
      keyHint: draft.apiKey === undefined ? null : draft.apiKey.slice(-4),
    });
    connections = [...connections.filter((item) => item.id !== id), added];
    return Promise.resolve({ ok: true, data: added });
  });
  api.connections.update.mockImplementation((update: ConnectionUpdate) => {
    const current = connections.find((item) => item.id === update.id);
    if (current === undefined) throw new Error(`unknown ${update.id}`);
    const next: ConnectionSummary = {
      ...current,
      ...(update.enabled === undefined ? {} : { enabled: update.enabled }),
      ...(update.displayName === undefined ? {} : { displayName: update.displayName }),
      ...(update.apiKey === undefined ? {} : { keyHint: update.apiKey.slice(-4) }),
    };
    connections = connections.map((item) => (item.id === next.id ? next : item));
    return Promise.resolve({ ok: true, data: next });
  });
  api.connections.remove.mockImplementation((id: string) => {
    connections = connections.filter((item) => item.id !== id);
    return Promise.resolve({ ok: true, data: null });
  });
  return api;
}

async function openModels() {
  await renderApp('#/models');
  await act(async () => {
    await Promise.resolve();
  });
}

/** Clicks a button and lets the IPC answers it waits for arrive. */
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function connectionList() {
  const list = document.querySelector<HTMLElement>('.connection-list');
  if (list === null) throw new Error('No Connection list');
  return list;
}

function rowFor(name: string) {
  const row = within(connectionList())
    .getAllByRole('listitem')
    .find((item) => item.querySelector('.connection-row-name')?.textContent === name);
  if (row === undefined) throw new Error(`No row for ${name}`);
  return row;
}

function dialog() {
  return screen.getByRole('dialog');
}

describe('the Connections list', () => {
  it('explains the empty state and offers Add Connection', async () => {
    installConnections([]);
    await openModels();
    expect(screen.getByRole('heading', { level: 2, name: 'Connections' })).toBeDefined();
    expect(screen.getByText('Add a Connection to run Harnesses')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Add Connection' })).toBeDefined();
  });

  it('shows each Connection with its status, and a saved key only as encrypted and masked', async () => {
    installConnections([
      ANTHROPIC,
      OLLAMA,
      connectionSummary({ id: 'openai', keyHint: 'abcd', enabled: false }),
      connectionSummary({
        id: 'groq',
        displayName: 'Groq',
        keyHint: 'zzzz',
        lastTestOk: false,
        lastTestError: '401 Incorrect API key provided.',
      }),
      connectionSummary({ id: 'deepseek', displayName: 'DeepSeek', keyHint: '', lastTestOk: true }),
      VLLM,
    ]);
    await openModels();
    const status = (name: string) => rowFor(name).querySelector('.status-chip')?.textContent;
    expect(status('Anthropic')).toBe('Not tested');
    expect(status('Ollama')).toBe('Local');
    expect(status('OpenAI')).toBe('Disabled');
    expect(status('Groq')).toBe('Connection failed');
    expect(status('DeepSeek')).toBe('Connected');
    expect(status('vLLM')).toBe('Not tested');

    expect(
      within(rowFor('Anthropic')).getByText('Key stored encrypted on this machine, ending in 6789'),
    ).toBeDefined();
    expect(
      within(rowFor('DeepSeek')).getByText('Key stored encrypted on this machine'),
    ).toBeDefined();
    expect(within(rowFor('Ollama')).getByText('http://127.0.0.1:11434/v1')).toBeDefined();
    expect(within(rowFor('vLLM')).getByText('http://10.0.0.2:8000/v1')).toBeDefined();
    // The Provider's text, verbatim.
    expect(within(rowFor('Groq')).getByText('401 Incorrect API key provided.')).toBeDefined();
    expect(within(rowFor('OpenAI')).getByRole('button', { name: 'Enable OpenAI' })).toBeDefined();
    expect(
      within(rowFor('Anthropic')).getByRole('button', { name: 'Disable Anthropic' }),
    ).toBeDefined();
  });

  it('Disable and Enable update the Connection and keep it listed', async () => {
    const api = installConnections([ANTHROPIC]);
    await openModels();
    await click(screen.getByRole('button', { name: 'Disable Anthropic' }));
    expect(api.connections.update).toHaveBeenCalledWith({ id: 'anthropic', enabled: false });
    expect(rowFor('Anthropic').querySelector('.status-chip')?.textContent).toBe('Disabled');
    await click(screen.getByRole('button', { name: 'Enable Anthropic' }));
    expect(api.connections.update).toHaveBeenLastCalledWith({ id: 'anthropic', enabled: true });
    expect(rowFor('Anthropic').querySelector('.status-chip')?.textContent).toBe('Not tested');
  });

  it('shows Provider names and statuses in Chinese', async () => {
    installConnections(
      [connectionSummary({ id: 'qwen', displayName: 'Qwen (Alibaba Cloud Model Studio)' }), OLLAMA],
      'zh-CN',
    );
    await openModels();
    expect(screen.getByRole('heading', { level: 2, name: '模型连接' })).toBeDefined();
    expect(rowFor('通义千问（阿里云百炼）').querySelector('.status-chip')?.textContent).toBe(
      '未测试',
    );
    expect(rowFor('Ollama').querySelector('.status-chip')?.textContent).toBe('本地');
  });
});

describe('Add Connection', () => {
  async function openAdd(initial: readonly ConnectionSummary[] = []) {
    const api = installConnections(initial);
    await openModels();
    await click(screen.getByRole('button', { name: 'Add Connection' }));
    return api;
  }

  it('starts with every Provider, each with a monogram, its kind and a docs link once picked', async () => {
    await openAdd([OLLAMA]);
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect(within(dialog()).getByRole('heading', { name: 'Add Connection' })).toBeDefined();
    const presets = within(dialog())
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(presets).toEqual([
      'AAnthropicAPI key',
      'OOpenAIAPI key',
      'OOllamaAdded: opens it to edit',
      'OOpenAI-compatible endpointAny OpenAI-compatible endpoint, several allowed',
    ]);
    expect(
      within(dialog()).getByRole('button', { name: 'Ollama' }).getAttribute('aria-describedby'),
    ).toBeTruthy();
    await click(within(dialog()).getByRole('button', { name: 'Anthropic' }));
    expect(
      within(dialog()).getByRole('link', { name: 'Anthropic documentation' }).getAttribute('href'),
    ).toBe('https://docs.claude.com/en/api/overview');
  });

  it('requires a key for a key-based Provider, then saves it and lists it masked', async () => {
    const api = await openAdd();
    await click(within(dialog()).getByRole('button', { name: 'Anthropic' }));
    expect(
      within(dialog()).getByRole('heading', { name: 'Add Connection · Anthropic' }),
    ).toBeDefined();
    const key = within(dialog()).getByLabelText<HTMLInputElement>('API key');
    expect(key.type).toBe('password');
    expect(key.placeholder).toBe('sk-ant-...');
    expect(
      within(dialog()).getByLabelText<HTMLInputElement>('Base URL (optional)').placeholder,
    ).toBe('https://api.anthropic.com/v1');

    await click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(within(dialog()).getByText('Enter the API key.')).toBeDefined();
    expect(key.getAttribute('aria-invalid')).toBe('true');
    expect(api.connections.add).not.toHaveBeenCalled();

    fireEvent.change(key, { target: { value: 'two words' } });
    await click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(within(dialog()).getByText('An API key has no spaces or line breaks.')).toBeDefined();

    fireEvent.change(key, { target: { value: ` ${KEY} ` } });
    await click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(api.connections.add).toHaveBeenCalledWith({ providerId: 'anthropic', apiKey: KEY });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      within(rowFor('Anthropic')).getByText('Key stored encrypted on this machine, ending in 6789'),
    ).toBeDefined();
    // The full key is nowhere on the page once saved.
    expect(document.body.textContent).not.toContain(KEY);
    const values = [...document.querySelectorAll('input')].map((input) => input.value);
    expect(values.join()).not.toContain(KEY);
  });

  it('asks a custom endpoint for a unique name and a base URL; its key is optional', async () => {
    const api = await openAdd([VLLM]);
    await click(within(dialog()).getByRole('button', { name: 'OpenAI-compatible endpoint' }));
    expect(within(dialog()).getByLabelText('API key (optional)')).toBeDefined();
    await click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(within(dialog()).getByText('Enter a name for this endpoint.')).toBeDefined();
    expect(within(dialog()).getByText('Enter the base URL of the endpoint.')).toBeDefined();
    // Focus goes to the first field with a problem.
    expect(document.activeElement).toBe(within(dialog()).getByLabelText('Name'));

    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'VLLM' } });
    fireEvent.change(within(dialog()).getByLabelText('Base URL'), {
      target: { value: 'ftp://10.0.0.3' },
    });
    await click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(within(dialog()).getByText('Another Connection already has this name.')).toBeDefined();
    expect(
      within(dialog()).getByText('Enter a URL that starts with http:// or https://.'),
    ).toBeDefined();

    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'Home' } });
    fireEvent.change(within(dialog()).getByLabelText('Base URL'), {
      target: { value: 'http://10.0.0.3:8000/v1' },
    });
    await click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(api.connections.add).toHaveBeenCalledWith({
      providerId: 'openai-compatible',
      displayName: 'Home',
      baseUrl: 'http://10.0.0.3:8000/v1',
    });
    expect(rowFor('Home')).toBeDefined();
    expect(rowFor('vLLM')).toBeDefined();
  });

  it('a Provider that already has its one Connection opens it to edit instead', async () => {
    const api = await openAdd([OLLAMA]);
    await click(within(dialog()).getByRole('button', { name: 'Ollama' }));
    expect(within(dialog()).getByRole('heading', { name: 'Edit Ollama' })).toBeDefined();
    expect(within(dialog()).queryByLabelText(/API key/)).toBeNull();
    fireEvent.change(within(dialog()).getByLabelText('Base URL (optional)'), {
      target: { value: 'http://10.0.0.5:11434/v1' },
    });
    await click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(api.connections.update).toHaveBeenCalledWith({
      id: 'ollama',
      baseUrl: 'http://10.0.0.5:11434/v1',
    });
    expect(api.connections.add).not.toHaveBeenCalled();
  });

  it('shows the keyring explanation when the key cannot be stored encrypted, keeping the input', async () => {
    const api = await openAdd();
    api.connections.add.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'encryption_unavailable',
        messageKey: 'error.encryption_unavailable',
        message: 'fallback',
      },
    });
    await click(within(dialog()).getByRole('button', { name: 'Anthropic' }));
    fireEvent.change(within(dialog()).getByLabelText('API key'), { target: { value: KEY } });
    await click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(within(dialog()).getByText('Could not save the Connection')).toBeDefined();
    expect(within(dialog()).getByRole('alert').textContent).toMatch(
      /no secure storage for secrets\. On Linux, install and unlock a keyring/,
    );
    expect(within(dialog()).getByLabelText<HTMLInputElement>('API key').value).toBe(KEY);
    expect(screen.queryByText('Add a Connection to run Harnesses')).not.toBeNull();
  });

  it('shows the Provider error text from a failed test verbatim', async () => {
    const api = await openAdd();
    api.connections.add.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'provider_error',
        messageKey: 'error.provider_error',
        params: { detail: 'Incorrect API key provided.' },
        message: 'The Provider answered with an error: Incorrect API key provided.',
      },
    });
    await click(within(dialog()).getByRole('button', { name: 'Anthropic' }));
    fireEvent.change(within(dialog()).getByLabelText('API key'), { target: { value: KEY } });
    await click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(within(dialog()).getByRole('alert').textContent).toBe(
      'The Provider answered with an error: Incorrect API key provided.',
    );
  });

  it('Escape and Cancel close the dialog without saving; Choose another Provider goes back', async () => {
    const api = await openAdd();
    await click(within(dialog()).getByRole('button', { name: 'OpenAI' }));
    await click(within(dialog()).getByRole('button', { name: 'Choose another Provider' }));
    expect(within(dialog()).getByText('Choose a Provider')).toBeDefined();
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await click(screen.getByRole('button', { name: 'Add Connection' }));
    await click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.connections.add).not.toHaveBeenCalled();
  });
});

describe('Edit', () => {
  it('never shows the saved key: the field is empty, masked in its placeholder, and kept unless replaced', async () => {
    const api = installConnections([ANTHROPIC]);
    await openModels();
    await click(screen.getByRole('button', { name: 'Edit Anthropic' }));
    const key = within(dialog()).getByLabelText<HTMLInputElement>('API key');
    expect(key.value).toBe('');
    expect(key.placeholder).toBe('••••6789');
    expect(
      within(dialog()).getByText(
        'Key stored encrypted on this machine. Leave this empty to keep it, or paste a new key to replace it.',
      ),
    ).toBeDefined();
    // Nothing changed: nothing to save.
    await click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.connections.update).not.toHaveBeenCalled();

    await click(screen.getByRole('button', { name: 'Edit Anthropic' }));
    fireEvent.change(within(dialog()).getByLabelText('API key'), {
      target: { value: 'sk-ant-api03-replaced-wxyz' },
    });
    await click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(api.connections.update).toHaveBeenCalledWith({
      id: 'anthropic',
      apiKey: 'sk-ant-api03-replaced-wxyz',
    });
    expect(
      within(rowFor('Anthropic')).getByText('Key stored encrypted on this machine, ending in wxyz'),
    ).toBeDefined();
  });

  it('renames a custom endpoint', async () => {
    const api = installConnections([VLLM]);
    await openModels();
    await click(screen.getByRole('button', { name: 'Edit vLLM' }));
    expect(within(dialog()).getByLabelText<HTMLInputElement>('Base URL').value).toBe(
      'http://10.0.0.2:8000/v1',
    );
    fireEvent.change(within(dialog()).getByLabelText('Name'), { target: { value: 'Lab' } });
    await click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(api.connections.update).toHaveBeenCalledWith({
      id: 'openai-compatible:vllm',
      displayName: 'Lab',
    });
    expect(rowFor('Lab')).toBeDefined();
  });
});

describe('Remove', () => {
  it('names the Slot Bindings that use the Connection, then removes it', async () => {
    const api = installConnections([ANTHROPIC, OLLAMA]);
    const bindings: readonly GlobalBinding[] = [
      { slot: 'default', connectionId: 'anthropic', model: 'claude-sonnet-4-5' },
      { slot: 'fast', connectionId: 'ollama', model: 'qwen3:8b' },
    ];
    api.bindings.getGlobal.mockResolvedValue({ ok: true, data: bindings });
    await openModels();
    await click(screen.getByRole('button', { name: 'Remove Anthropic' }));
    expect(
      within(dialog()).getByRole('heading', { name: 'Remove the Anthropic Connection?' }),
    ).toBeDefined();
    const affected = within(dialog()).getByRole('list', {
      name: 'These Slot Bindings use it. They will fall back to the next choice in the resolution order:',
    });
    expect(
      within(affected)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['defaultanthropic/claude-sonnet-4-5']);
    expect(within(dialog()).getByText('Its key is deleted from this machine.')).toBeDefined();
    await click(within(dialog()).getByRole('button', { name: 'Remove' }));
    expect(api.connections.remove).toHaveBeenCalledWith('anthropic');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      within(connectionList())
        .getAllByRole('listitem')
        .map((item) => item.querySelector('.connection-row-name')?.textContent),
    ).toEqual(['Ollama']);
  });

  it('says when no Slot Binding uses it; Cancel keeps it', async () => {
    const api = installConnections([OLLAMA]);
    await openModels();
    await click(screen.getByRole('button', { name: 'Remove Ollama' }));
    expect(within(dialog()).getByText('No Slot Binding uses it.')).toBeDefined();
    expect(within(dialog()).queryByText('Its key is deleted from this machine.')).toBeNull();
    await click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(api.connections.remove).not.toHaveBeenCalled();
    expect(rowFor('Ollama')).toBeDefined();
  });

  it('still removes when the Slot Bindings cannot be read, showing why', async () => {
    const api = installConnections([OLLAMA]);
    const failed: IpcResult<readonly GlobalBinding[]> = {
      ok: false,
      error: { code: 'internal_error', messageKey: 'error.internal_error', message: 'x' },
    };
    api.bindings.getGlobal.mockResolvedValue(failed);
    await openModels();
    await click(screen.getByRole('button', { name: 'Remove Ollama' }));
    expect(within(dialog()).getByRole('alert')).toBeDefined();
    await click(within(dialog()).getByRole('button', { name: 'Remove' }));
    expect(api.connections.remove).toHaveBeenCalledWith('ollama');
  });
});
