// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ConnectionDraft,
  ConnectionSummary,
  IpcResult,
  LocalProvider,
} from '../../src/shared/ipc.js';
import { connectionSummary, installFakeApi, renderApp } from './render-app.js';

/**
 * Local Provider detection in the UI: the Models page's Local Providers panel, and what the
 * wizard's Local Providers step adds. The Runtime is a fake `window.api`; what detection finds is
 * scripted per test.
 */

const OLLAMA: LocalProvider = {
  providerId: 'ollama',
  displayName: 'Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  models: ['qwen3:8b', 'llama3.2:3b'],
  added: false,
};
const LM_STUDIO: LocalProvider = {
  providerId: 'lmstudio',
  displayName: 'LM Studio',
  baseUrl: 'http://127.0.0.1:1234/v1',
  models: ['gemma-3'],
  added: false,
};

afterEach(() => {
  cleanup();
});

/** A fake Runtime whose connections.add saves what it is given, as the Runtime does. */
function installRuntime(locale: 'en' | 'zh-CN' = 'en', initial: readonly ConnectionSummary[] = []) {
  const api = installFakeApi(locale);
  let connections = [...initial];
  api.connections.list.mockImplementation(() => Promise.resolve({ ok: true, data: connections }));
  api.connections.add.mockImplementation(
    (draft: ConnectionDraft): Promise<IpcResult<ConnectionSummary>> => {
      const added = connectionSummary({
        id: draft.providerId,
        local: true,
        ...(draft.baseUrl === undefined ? {} : { baseUrl: draft.baseUrl }),
      });
      connections = [...connections.filter((item) => item.id !== added.id), added];
      return Promise.resolve({ ok: true, data: added });
    },
  );
  return api;
}

/** Lets the IPC answers the page waits for arrive. */
async function settle() {
  await act(async () => {
    for (let step = 0; step < 4; step += 1) await Promise.resolve();
  });
}

async function openModels() {
  await renderApp('#/models');
  await settle();
}

async function click(element: HTMLElement) {
  act(() => {
    fireEvent.click(element);
  });
  await settle();
}

function panel() {
  return screen.getByRole('group', { name: 'Local Providers' });
}

describe('Models page: Local Providers', () => {
  it('detects when the page opens, and offers Add without adding anything', async () => {
    const api = installRuntime();
    api.connections.detectLocal.mockResolvedValue({ ok: true, data: [OLLAMA] });
    await openModels();
    expect(api.connections.detectLocal).toHaveBeenCalledTimes(1);
    const row = within(panel()).getByText('Ollama').closest('li');
    if (row === null) throw new Error('No Ollama row');
    expect(row.textContent).toContain('http://127.0.0.1:11434/v1 · qwen3:8b · llama3.2:3b');
    expect(within(row).getByRole('button', { name: 'Add Ollama' })).toBeDefined();
    expect(api.connections.add).not.toHaveBeenCalled();
    expect(screen.getByText('Add a Connection to run Harnesses')).toBeDefined();
  });

  it('Add creates the Connection at the detected base URL, without a key, and lists it', async () => {
    const api = installRuntime();
    api.connections.detectLocal.mockResolvedValue({ ok: true, data: [OLLAMA, LM_STUDIO] });
    await openModels();
    await click(within(panel()).getByRole('button', { name: 'Add Ollama' }));
    expect(api.connections.add).toHaveBeenCalledExactlyOnceWith({
      providerId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
    const list = document.querySelector<HTMLElement>('.connection-list');
    expect(list?.textContent).toContain('Ollama');
    // Ollama is now added; LM Studio is still only offered.
    expect(within(panel()).queryByRole('button', { name: 'Add Ollama' })).toBeNull();
    expect(within(panel()).getByText('Added')).toBeDefined();
    expect(within(panel()).getByRole('button', { name: 'Add LM Studio' })).toBeDefined();
  });

  it('shows Added, with no Add, for a Provider that already has its Connection', async () => {
    const api = installRuntime('en', [
      connectionSummary({ id: 'ollama', baseUrl: 'http://10.0.0.5:11434/v1' }),
    ]);
    // The detection flag disagrees on purpose: the page's live Connections list decides.
    api.connections.detectLocal.mockResolvedValue({
      ok: true,
      data: [{ ...OLLAMA, added: false }],
    });
    await openModels();
    expect(within(panel()).getByText('Added')).toBeDefined();
    expect(within(panel()).queryByRole('button', { name: /^Add/ })).toBeNull();
  });

  it('offers Add when the Connection is gone, even if detection said added', async () => {
    const api = installRuntime();
    api.connections.detectLocal.mockResolvedValue({
      ok: true,
      data: [{ ...OLLAMA, added: true }],
    });
    await openModels();
    expect(within(panel()).queryByText('Added')).toBeNull();
    expect(within(panel()).getByRole('button', { name: 'Add Ollama' })).toBeDefined();
  });

  it('shows the error of a failed Add, and keeps offering it', async () => {
    const api = installRuntime();
    api.connections.detectLocal.mockResolvedValue({ ok: true, data: [OLLAMA] });
    api.connections.add.mockResolvedValue({
      ok: false,
      error: {
        code: 'provider_error',
        messageKey: 'error.provider_error',
        params: { detail: 'fetch failed: connect ECONNREFUSED 127.0.0.1:11434' },
        message: 'The Provider returned an error.',
      },
    });
    await openModels();
    await click(within(panel()).getByRole('button', { name: 'Add Ollama' }));
    expect(within(panel()).getByRole('alert').textContent).toContain(
      'fetch failed: connect ECONNREFUSED 127.0.0.1:11434',
    );
    expect(within(panel()).getByRole('button', { name: 'Add Ollama' })).toBeDefined();
  });

  it('says it is looking while detection runs, then explains when nothing was found', async () => {
    const api = installRuntime();
    let answer: (result: IpcResult<readonly LocalProvider[]>) => void = () => undefined;
    api.connections.detectLocal.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await openModels();
    expect(within(panel()).getByRole('status').textContent).toBe(
      'Looking for Ollama and LM Studio…',
    );
    expect(within(panel()).getByRole('button', { name: 'Detect again' })).toHaveProperty(
      'disabled',
      true,
    );
    await act(async () => {
      answer({ ok: true, data: [] });
      await Promise.resolve();
    });
    expect(within(panel()).queryByRole('status')).toBeNull();
    expect(within(panel()).getByText(/were not found on this computer/).textContent).toBe(
      'Ollama and LM Studio were not found on this computer. They run models on your own machine, with no API key. Install one and start it, then choose Detect again.',
    );
    expect(within(panel()).getByRole('link', { name: 'Install Ollama' }).getAttribute('href')).toBe(
      'https://ollama.com/download',
    );
    expect(
      within(panel()).getByRole('link', { name: 'Install LM Studio' }).getAttribute('href'),
    ).toBe('https://lmstudio.ai');
  });

  it('Detect again probes again and shows what is running now', async () => {
    const api = installRuntime();
    await openModels();
    expect(within(panel()).getByText(/were not found/)).toBeDefined();
    api.connections.detectLocal.mockResolvedValue({ ok: true, data: [LM_STUDIO] });
    await click(within(panel()).getByRole('button', { name: 'Detect again' }));
    expect(api.connections.detectLocal).toHaveBeenCalledTimes(2);
    expect(within(panel()).queryByText(/were not found/)).toBeNull();
    expect(within(panel()).getByRole('button', { name: 'Add LM Studio' })).toBeDefined();
    expect(api.connections.add).not.toHaveBeenCalled();
  });

  it('shows a failed detection as an error, with the installer links', async () => {
    const api = installRuntime();
    api.connections.detectLocal.mockResolvedValue({
      ok: false,
      error: {
        code: 'internal_error',
        messageKey: 'error.internal_error',
        params: {},
        message: 'Something went wrong inside Harness Store.',
      },
    });
    await openModels();
    expect(within(panel()).getByRole('alert')).toBeDefined();
    expect(within(panel()).getByRole('link', { name: 'Install Ollama' })).toBeDefined();
  });

  it('speaks Chinese', async () => {
    const api = installRuntime('zh-CN');
    await openModels();
    const local = screen.getByRole('group', { name: '本地 Provider' });
    expect(within(local).getByRole('button', { name: '重新检测' })).toBeDefined();
    expect(within(local).getByText(/没有找到 Ollama 或 LM Studio/)).toBeDefined();
    api.connections.detectLocal.mockResolvedValue({ ok: true, data: [OLLAMA] });
    await click(within(local).getByRole('button', { name: '重新检测' }));
    expect(within(local).getByRole('button', { name: '添加 Ollama' })).toBeDefined();
  });
});

describe('wizard: Local Providers', () => {
  function installFreshProfile() {
    const api = installFakeApi('en', undefined, { onboardingDone: false });
    api.connections.add.mockImplementation(
      (draft: ConnectionDraft): Promise<IpcResult<ConnectionSummary>> =>
        Promise.resolve({
          ok: true,
          data: connectionSummary({ id: draft.providerId, local: true }),
        }),
    );
    return api;
  }

  async function openStep() {
    await renderApp('');
    await click(screen.getByRole('button', { name: 'Continue' }));
  }

  it('Detect again probes again from the nothing-found panel', async () => {
    const api = installFreshProfile();
    await openStep();
    expect(screen.getByText(/were not found on this computer/)).toBeDefined();
    api.connections.detectLocal.mockResolvedValue({ ok: true, data: [OLLAMA] });
    await click(screen.getByRole('button', { name: 'Detect again' }));
    expect(api.connections.detectLocal).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('checkbox', { name: 'Add Ollama' })).toBeDefined();
    expect(api.connections.add).not.toHaveBeenCalled();
  });

  it('shows a Provider that already has its Connection as Added, and Continue leaves it alone', async () => {
    // Setup run again: Ollama was added before, and may since have been disabled or moved to
    // another port. Continue must neither re-enable it nor test it again.
    const api = installFreshProfile();
    api.connections.detectLocal.mockResolvedValue({
      ok: true,
      data: [{ ...OLLAMA, added: true }, LM_STUDIO],
    });
    await openStep();
    expect(screen.queryByRole('checkbox', { name: 'Add Ollama' })).toBeNull();
    const ollamaRow = screen.getByText('Ollama').closest('li');
    expect(ollamaRow?.querySelector('.status-chip')?.textContent).toBe('Added');
    expect(screen.getByRole('checkbox', { name: 'Add LM Studio' })).toBeDefined();
    await click(screen.getByRole('button', { name: 'Continue' }));
    expect(api.connections.add.mock.calls).toEqual([
      [{ providerId: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' }],
    ]);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Remote Provider (optional)',
    );
  });

  it('adds nothing on Continue when every Provider found already has its Connection', async () => {
    const api = installFreshProfile();
    api.connections.detectLocal.mockResolvedValue({ ok: true, data: [{ ...OLLAMA, added: true }] });
    await openStep();
    expect(screen.queryByRole('checkbox')).toBeNull();
    await click(screen.getByRole('button', { name: 'Continue' }));
    expect(api.connections.add).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Remote Provider (optional)',
    );
  });
});
