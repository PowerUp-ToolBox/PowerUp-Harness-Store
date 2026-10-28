// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ConnectionSummary,
  IpcResult,
  LocalProvider,
  SettingsPatch,
} from '../../src/shared/ipc.js';
import { installFakeApi, renderApp } from './render-app.js';

const WELCOME = 'Run any AI agent on any model you already have.';
const DETECT = 'Local Providers';
const CLOUD = 'Remote Provider (optional)';
const DEFAULT_MODEL = 'Choose the model Harnesses use by default';
const DONE = 'Setup complete';

afterEach(() => {
  cleanup();
});

/** A fake Runtime on a fresh profile: the wizard has never run. */
function installFreshProfile() {
  return installFakeApi('en', undefined, { onboardingDone: false });
}

function heading() {
  return screen.getByRole('heading', { level: 1 }).textContent;
}

/** Clicks a button and lets the IPC answers it waits for arrive. */
async function click(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
    await Promise.resolve();
  });
}

/** The step marked current in the progress list. */
function currentStep() {
  const steps = within(screen.getByRole('list', { name: 'Setup steps' })).getAllByRole('listitem');
  return steps.find((item) => item.getAttribute('aria-current') === 'step')?.textContent;
}

function onboardingDoneWrites(api: ReturnType<typeof installFakeApi>) {
  return api.settings.set.mock.calls
    .map(([patch]: [SettingsPatch]) => patch.onboardingDone)
    .filter((value) => value !== undefined);
}

const OLLAMA: LocalProvider = {
  providerId: 'ollama',
  displayName: 'Ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  models: ['qwen3:8b', 'llama3.2:3b'],
};
const LM_STUDIO: LocalProvider = {
  providerId: 'lmstudio',
  displayName: 'LM Studio',
  baseUrl: 'http://127.0.0.1:1234/v1',
  models: ['gemma-3'],
};

/** connections.add as P0-03 will answer: the Connection, with the models it lists. */
function connectionFor(providerId: string, displayName: string, models: string[]) {
  return (): Promise<IpcResult<ConnectionSummary>> =>
    Promise.resolve({
      ok: true,
      data: {
        id: providerId,
        providerId,
        displayName,
        local: providerId === 'ollama' || providerId === 'lmstudio',
        models,
      },
    });
}

describe('first launch on a fresh profile', () => {
  it.each(['', '#/', '#/nowhere'])(
    'opens the wizard at welcome (hash %j), without the sidebar',
    async (hash) => {
      installFreshProfile();
      await renderApp(hash);
      expect(window.location.hash).toBe('#/onboarding');
      expect(heading()).toBe(WELCOME);
      expect(currentStep()).toContain('Welcome and language');
      expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    },
  );

  it('shows five numbered steps and a Skip control on welcome, with no Back', async () => {
    installFreshProfile();
    await renderApp('');
    const steps = within(screen.getByRole('list', { name: 'Setup steps' })).getAllByRole(
      'listitem',
    );
    expect(steps.map((item) => item.textContent)).toEqual([
      '1Welcome and language',
      '2Local Providers',
      '3Remote Provider (optional)',
      '4Default model',
      '5Done',
    ]);
    expect(screen.getByRole('button', { name: 'Skip setup' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(
      screen.getByText(
        'Harness Store does not sandbox Harnesses. Installing means trusting this Publisher.',
      ),
    ).toBeDefined();
  });
});

describe('Skip', () => {
  it('Skip setup on welcome opens the summary and sets onboardingDone; Open Store lands on Store home', async () => {
    const api = installFreshProfile();
    await renderApp('');
    await click('Skip setup');
    expect(heading()).toBe(DONE);
    expect(currentStep()).toContain('Done');
    expect(onboardingDoneWrites(api)).toEqual([true]);

    await click('Open Store');
    expect(window.location.hash).toBe('#/store');
    expect(screen.getByRole('heading', { level: 1, name: 'Store' })).toBeDefined();
  });

  it('Skip on every later step advances one step, then Skip on done lands on Store home', async () => {
    const api = installFreshProfile();
    await renderApp('');
    await click('Continue');
    const visited = [heading()];
    for (let i = 0; i < 3; i += 1) {
      await click('Skip');
      visited.push(heading());
    }
    expect(visited).toEqual([DETECT, CLOUD, DEFAULT_MODEL, DONE]);
    expect(api.connections.add).not.toHaveBeenCalled();

    await click('Skip');
    expect(window.location.hash).toBe('#/store');
    expect(onboardingDoneWrites(api)).toEqual([true]);
  });
});

describe('Continue', () => {
  it('through all five steps reaches done, then Store home, never the Library', async () => {
    const api = installFreshProfile();
    await renderApp('');
    const visited = [heading()];
    for (let i = 0; i < 4; i += 1) {
      await click('Continue');
      visited.push(heading());
    }
    expect(visited).toEqual([WELCOME, DETECT, CLOUD, DEFAULT_MODEL, DONE]);
    // An empty key form behaves like Skip: nothing is sent.
    expect(api.connections.add).not.toHaveBeenCalled();
    expect(onboardingDoneWrites(api)).toEqual([true]);

    await click('Open Store');
    expect(window.location.hash).toBe('#/store');
  });
});

describe('Back', () => {
  it('steps back from every step but welcome', async () => {
    installFreshProfile();
    await renderApp('');
    const order = [WELCOME, DETECT, CLOUD, DEFAULT_MODEL, DONE];
    for (let index = 1; index < order.length; index += 1) {
      await click('Continue');
      expect(heading()).toBe(order[index]);
      await click('Back');
      expect(heading()).toBe(order[index - 1]);
      await click('Continue');
    }
    expect(heading()).toBe(DONE);
    // Back from done returns to the Default Model step.
    await click('Back');
    expect(heading()).toBe(DEFAULT_MODEL);
  });
});

describe('after the wizard', () => {
  it('a relaunch opens on the Library, not the wizard', async () => {
    installFreshProfile();
    await renderApp('');
    await click('Skip setup');
    await click('Open Store');
    cleanup();

    // The same fake Runtime, which now has onboardingDone: a new window.
    window.location.hash = '';
    await renderApp('');
    expect(window.location.hash).toBe('#/library');
    expect(screen.getByRole('heading', { level: 1, name: 'Library' })).toBeDefined();
  });

  it('Re-run setup in Settings opens the wizard at welcome and clears nothing', async () => {
    const api = installFakeApi('en');
    await renderApp('#/settings');
    await click('Re-run setup');
    expect(window.location.hash).toBe('#/onboarding');
    expect(heading()).toBe(WELCOME);
    expect(currentStep()).toContain('Welcome and language');
    expect(api.settings.set).not.toHaveBeenCalled();
    expect(api.connections.add).not.toHaveBeenCalled();
  });
});

describe('welcome', () => {
  it('prefills the language from the UI locale and switches the whole wizard when changed', async () => {
    const api = installFreshProfile();
    await renderApp('');
    const select = screen.getByLabelText<HTMLSelectElement>('Language');
    expect(select.value).toBe('en');
    await act(async () => {
      fireEvent.change(select, { target: { value: 'zh-CN' } });
      await Promise.resolve();
    });
    expect(api.settings.set).toHaveBeenCalledWith({ locale: 'zh-CN' });
    expect(heading()).toBe('用你已有的任何模型运行任何 AI Agent。');
    expect(screen.getByRole('button', { name: '跳过设置' })).toBeDefined();
    expect(screen.getByLabelText<HTMLSelectElement>('语言').value).toBe('zh-CN');
  });

  it('starts in Chinese on a zh-CN OS', async () => {
    installFakeApi('zh-CN', undefined, { onboardingDone: false });
    await renderApp('');
    expect(heading()).toBe('用你已有的任何模型运行任何 AI Agent。');
    expect(screen.getByLabelText<HTMLSelectElement>('语言').value).toBe('zh-CN');
  });
});

describe('Local Providers', () => {
  it('shows the search while it runs: Continue waits, Skip does not', async () => {
    const api = installFreshProfile();
    api.connections.detectLocal.mockReturnValue(new Promise(() => undefined));
    await renderApp('');
    await click('Continue');
    expect(screen.getByRole('status').textContent).toBe('Looking for Ollama and LM Studio…');
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(true);
    await click('Skip');
    expect(heading()).toBe(CLOUD);
  });

  it('explains and links to both installers when nothing is found', async () => {
    installFreshProfile();
    await renderApp('');
    await click('Continue');
    expect(screen.getByText(/were not found on this computer/)).toBeDefined();
    const ollama = screen.getByRole('link', { name: 'Install Ollama' });
    const lmStudio = screen.getByRole('link', { name: 'Install LM Studio' });
    expect(ollama.getAttribute('href')).toBe('https://ollama.com/download');
    expect(lmStudio.getAttribute('href')).toBe('https://lmstudio.ai');
    expect(ollama.getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('button', { name: 'Continue' }).hasAttribute('disabled')).toBe(false);
  });

  it('shows a failed search with the installer links, and Continue still moves on', async () => {
    const api = installFreshProfile();
    api.connections.detectLocal.mockResolvedValue({
      ok: false,
      error: {
        code: 'internal_error',
        messageKey: 'error.internal_error',
        params: {},
        message: 'Something went wrong inside Harness Store.',
      },
    });
    await renderApp('');
    await click('Continue');
    expect(screen.getByRole('alert').textContent).toBe(
      'Something went wrong inside Harness Store. Try again, and restart the app if it keeps happening.',
    );
    expect(screen.getByRole('link', { name: 'Install Ollama' })).toBeDefined();
    await click('Continue');
    expect(heading()).toBe(CLOUD);
    expect(api.connections.add).not.toHaveBeenCalled();
  });

  it('adds the checked Providers on Continue, then offers their models, the first local one picked', async () => {
    const api = installFreshProfile();
    api.connections.detectLocal.mockResolvedValue({ ok: true, data: [OLLAMA, LM_STUDIO] });
    api.connections.add.mockImplementation(
      connectionFor('ollama', 'Ollama', ['qwen3:8b', 'llama3.2:3b']),
    );
    await renderApp('');
    await click('Continue');

    const addOllama = screen.getByRole('checkbox', { name: 'Add Ollama' });
    const addLmStudio = screen.getByRole('checkbox', { name: 'Add LM Studio' });
    expect((addOllama as HTMLInputElement).checked).toBe(true);
    expect((addLmStudio as HTMLInputElement).checked).toBe(true);
    fireEvent.click(addLmStudio);

    await click('Continue');
    expect(api.connections.add).toHaveBeenCalledExactlyOnceWith({
      providerId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
    expect(heading()).toBe(CLOUD);

    await click('Continue');
    expect(heading()).toBe(DEFAULT_MODEL);
    const picker = screen.getByLabelText<HTMLSelectElement>('Default Model');
    expect(picker.selectedOptions[0]?.textContent).toBe('qwen3:8b');
    expect(within(picker).getByRole('group', { name: 'Ollama' })).toBeDefined();

    fireEvent.change(picker, { target: { value: '1' } });
    await click('Continue');
    expect(heading()).toBe(DONE);
    const [connections, defaultModel] = screen.getAllByRole('definition');
    expect(connections?.textContent).toBe('Ollama (Local)');
    expect(defaultModel?.textContent).toBe('llama3.2:3b on Ollama');
  });

  it('stays on the step with the error when adding fails', async () => {
    const api = installFreshProfile();
    api.connections.detectLocal.mockResolvedValue({ ok: true, data: [OLLAMA] });
    await renderApp('');
    await click('Continue');
    await click('Continue');
    expect(heading()).toBe(DETECT);
    expect(screen.getByRole('alert').textContent).toBe(
      'This is not available in this version of Harness Store yet.',
    );
  });
});

describe('Remote Provider', () => {
  async function openCloudStep() {
    const api = installFreshProfile();
    await renderApp('');
    await click('Continue');
    await click('Skip');
    expect(heading()).toBe(CLOUD);
    return api;
  }

  it('offers the presets from providers.list, the custom endpoint by name', async () => {
    await openCloudStep();
    const provider = screen.getByLabelText<HTMLSelectElement>('Provider');
    expect([...provider.options].map((option) => option.textContent)).toEqual([
      'Anthropic',
      'OpenAI',
      'Custom (OpenAI-compatible)',
    ]);
    expect(screen.getByLabelText('API key').getAttribute('placeholder')).toBe('sk-ant-...');
    expect(
      screen.getByText('Your API keys stay in Harness Store. Harnesses never see them.'),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: 'Test connection' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('asks the custom endpoint for a name and a base URL, its key being optional', async () => {
    const api = await openCloudStep();
    fireEvent.change(screen.getByLabelText('Provider'), {
      target: { value: 'openai-compatible' },
    });
    const test = screen.getByRole('button', { name: 'Test connection' });
    expect(test.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'vLLM' } });
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'http://10.0.0.2:8000/v1' },
    });
    expect(screen.getByLabelText('API key (optional)')).toBeDefined();
    await click('Test connection');
    expect(api.connections.add).toHaveBeenCalledWith({
      providerId: 'openai-compatible',
      displayName: 'vLLM',
      baseUrl: 'http://10.0.0.2:8000/v1',
    });
  });

  it('shows a failed test inline with Retry, Edit and Skip, keeping the key', async () => {
    const api = await openCloudStep();
    const key = screen.getByLabelText<HTMLInputElement>('API key');
    fireEvent.change(key, { target: { value: 'sk-ant-bad' } });
    await click('Test connection');
    expect(api.connections.add).toHaveBeenCalledWith({
      providerId: 'anthropic',
      apiKey: 'sk-ant-bad',
    });
    const failure = screen.getByRole('group', { name: 'Connection failed' });
    expect(within(failure).getByRole('alert').textContent).toBe(
      'This is not available in this version of Harness Store yet.',
    );
    expect(key.value).toBe('sk-ant-bad');

    await act(async () => {
      fireEvent.click(within(failure).getByRole('button', { name: 'Retry' }));
      await Promise.resolve();
    });
    expect(api.connections.add).toHaveBeenCalledTimes(2);

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Connection failed' })).getByRole('button', {
        name: 'Edit',
      }),
    );
    expect(screen.queryByRole('group', { name: 'Connection failed' })).toBeNull();
    expect(document.activeElement).toBe(key);

    await click('Test connection');
    await act(async () => {
      fireEvent.click(
        within(screen.getByRole('group', { name: 'Connection failed' })).getByRole('button', {
          name: 'Skip',
        }),
      );
      await Promise.resolve();
    });
    expect(heading()).toBe(DEFAULT_MODEL);
  });

  it('Continue with an untested key tests it first, and moves on only when it is added', async () => {
    const api = await openCloudStep();
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-1' } });
    await click('Continue');
    expect(heading()).toBe(CLOUD);
    expect(screen.getByRole('group', { name: 'Connection failed' })).toBeDefined();

    api.connections.add.mockImplementation(
      connectionFor('anthropic', 'Anthropic', ['claude-sonnet-4-5']),
    );
    await click('Continue');
    expect(heading()).toBe(DEFAULT_MODEL);
    expect(screen.getByLabelText<HTMLSelectElement>('Default Model').value).toBe('0');

    await click('Back');
    expect(screen.getByText('Connected: Anthropic')).toBeDefined();
    // Coming back remounts the step with an empty form, so Continue is Skip; the Connection stays.
    await click('Continue');
    expect(api.connections.add).toHaveBeenCalledTimes(2);
    await click('Continue');
    expect(screen.getByText('claude-sonnet-4-5 on Anthropic')).toBeDefined();
  });

  it('Continue after a successful Test connection moves on without adding it again', async () => {
    const api = await openCloudStep();
    api.connections.add.mockImplementation(
      connectionFor('anthropic', 'Anthropic', ['claude-sonnet-4-5']),
    );
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-1' } });
    await click('Test connection');
    expect(screen.getByText('Connected: Anthropic')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Test connection' }).hasAttribute('disabled')).toBe(
      true,
    );
    await click('Continue');
    expect(heading()).toBe(DEFAULT_MODEL);
    expect(api.connections.add).toHaveBeenCalledExactlyOnceWith({
      providerId: 'anthropic',
      apiKey: 'sk-ant-1',
    });
  });

  it('Continue waits while a started form misses a field, as Test connection does', async () => {
    const api = await openCloudStep();
    const continueButton = () => screen.getByRole('button', { name: 'Continue' });
    fireEvent.change(screen.getByLabelText('Provider'), {
      target: { value: 'openai-compatible' },
    });
    expect(continueButton().hasAttribute('disabled')).toBe(false);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'vLLM' } });
    expect(continueButton().hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('API key (optional)'), {
      target: { value: 'secret' },
    });
    expect(continueButton().hasAttribute('disabled')).toBe(true);
    await click('Skip');
    expect(heading()).toBe(DEFAULT_MODEL);
    expect(api.connections.add).not.toHaveBeenCalled();
  });

  it('ignores hidden custom fields: Continue on a form that looks empty is Skip', async () => {
    const api = await openCloudStep();
    fireEvent.change(screen.getByLabelText('Provider'), {
      target: { value: 'openai-compatible' },
    });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'vLLM' } });
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'anthropic' } });
    expect(screen.queryByLabelText('Name')).toBeNull();
    await click('Continue');
    expect(heading()).toBe(DEFAULT_MODEL);
    expect(api.connections.add).not.toHaveBeenCalled();
  });

  it('locks the form while a test runs, so the result matches what is shown', async () => {
    const api = await openCloudStep();
    let answer: (result: IpcResult<ConnectionSummary>) => void = () => undefined;
    api.connections.add.mockReturnValue(
      new Promise<IpcResult<ConnectionSummary>>((resolve) => {
        answer = resolve;
      }),
    );
    const key = screen.getByLabelText<HTMLInputElement>('API key');
    fireEvent.change(key, { target: { value: 'sk-ant-a' } });
    await click('Test connection');
    expect(key.disabled).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>('Provider').disabled).toBe(true);

    await act(async () => {
      answer(await connectionFor('anthropic', 'Anthropic', ['claude-sonnet-4-5'])());
    });
    expect(screen.getByText('Connected: Anthropic')).toBeDefined();
    expect(key.disabled).toBe(false);
    expect(key.value).toBe('sk-ant-a');
    // An edit after the test starts over: Test connection is offered again for the new key.
    fireEvent.change(key, { target: { value: 'sk-ant-b' } });
    expect(screen.getByRole('button', { name: 'Test connection' }).hasAttribute('disabled')).toBe(
      false,
    );
  });
});

describe('Default model and Done', () => {
  it('says the Default Model can be set later when no Connection was added, and the summary lists nothing', async () => {
    installFreshProfile();
    await renderApp('');
    await click('Continue');
    await click('Continue');
    await click('Continue');
    expect(screen.getByText('You can set this later in Models.')).toBeDefined();
    expect(screen.queryByRole('combobox')).toBeNull();
    await click('Continue');
    expect(screen.getAllByText('None')).toHaveLength(2);
    expect(screen.getByText(/^No Connection yet\./)).toBeDefined();
  });

  it('shows the error when onboardingDone cannot be saved, and Open Store still works', async () => {
    const api = installFreshProfile();
    api.settings.set.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'internal_error',
        messageKey: 'error.internal_error',
        params: {},
        message: 'Something went wrong inside Harness Store.',
      },
    });
    await renderApp('');
    await click('Skip setup');
    expect(heading()).toBe(DONE);
    expect(api.settings.set).toHaveBeenCalledExactlyOnceWith({ onboardingDone: true });
    expect(screen.getByRole('alert').textContent).toBe(
      'Something went wrong inside Harness Store. Try again, and restart the app if it keeps happening.',
    );
    await click('Open Store');
    expect(window.location.hash).toBe('#/store');
  });
});
