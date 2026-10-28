// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ConnectionSummary,
  IpcResult,
  LocalProvider,
  SettingsPatch,
} from '../../src/shared/ipc.js';
import {
  connectionSummary,
  FAKE_PRESETS,
  installFakeApi,
  renderApp,
  ZHIPU_PRESET,
} from './render-app.js';

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
  added: false,
};
const LM_STUDIO: LocalProvider = {
  providerId: 'lmstudio',
  displayName: 'LM Studio',
  baseUrl: 'http://127.0.0.1:1234/v1',
  models: ['gemma-3'],
  added: false,
};

/** connections.add as the Runtime answers: the Connection, with the models it lists. */
function connectionFor(providerId: string, displayName: string, models: string[]) {
  return (): Promise<IpcResult<ConnectionSummary>> =>
    Promise.resolve({
      ok: true,
      data: connectionSummary({
        id: providerId,
        displayName,
        local: providerId === 'ollama' || providerId === 'lmstudio',
        models,
      }),
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

    fireEvent.change(picker, { target: { value: 'ollama/llama3.2:3b' } });
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

  it('offers the presets from providers.list without the local ones, the custom endpoint by name', async () => {
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

  it('shows a key with a space inside under the key field, without calling the Runtime', async () => {
    const api = await openCloudStep();
    const key = screen.getByLabelText<HTMLInputElement>('API key');
    fireEvent.change(key, { target: { value: 'sk-ant 1' } });
    await click('Test connection');
    expect(api.connections.add).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Connection failed' })).toBeNull();
    expect(screen.getByText('An API key has no spaces or line breaks.')).toBeDefined();
    expect(key.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(key.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'An API key has no spaces or line breaks.',
    );
    expect(document.activeElement).toBe(key);

    await click('Continue');
    expect(heading()).toBe(CLOUD);
    expect(api.connections.add).not.toHaveBeenCalled();

    // Fixing the key clears the message.
    fireEvent.change(key, { target: { value: 'sk-ant-1' } });
    expect(screen.queryByText('An API key has no spaces or line breaks.')).toBeNull();
    expect(key.getAttribute('aria-invalid')).toBe('false');
  });

  it('asks the custom endpoint for a base URL with its scheme, without calling the Runtime', async () => {
    const api = await openCloudStep();
    fireEvent.change(screen.getByLabelText('Provider'), {
      target: { value: 'openai-compatible' },
    });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'vLLM' } });
    const url = screen.getByLabelText<HTMLInputElement>('Base URL');
    fireEvent.change(url, { target: { value: 'localhost:8000/v1' } });
    await click('Test connection');
    expect(api.connections.add).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Connection failed' })).toBeNull();
    expect(screen.getByText('Enter a URL that starts with http:// or https://.')).toBeDefined();
    expect(url.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(url);

    fireEvent.change(url, { target: { value: 'http://localhost:8000/v1' } });
    await click('Test connection');
    expect(api.connections.add).toHaveBeenCalledExactlyOnceWith({
      providerId: 'openai-compatible',
      displayName: 'vLLM',
      baseUrl: 'http://localhost:8000/v1',
    });
  });

  it('refuses a custom endpoint name a saved Connection already has, ignoring letter case', async () => {
    const api = await openCloudStep();
    api.connections.list.mockResolvedValue({
      ok: true,
      data: [
        connectionSummary({
          id: 'openai-compatible:vllm',
          displayName: 'vLLM',
          baseUrl: 'http://10.0.0.2:8000/v1',
        }),
      ],
    });
    fireEvent.change(screen.getByLabelText('Provider'), {
      target: { value: 'openai-compatible' },
    });
    const name = screen.getByLabelText<HTMLInputElement>('Name');
    fireEvent.change(name, { target: { value: ' VLLM ' } });
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'http://10.0.0.3:8000/v1' },
    });
    await click('Test connection');
    expect(api.connections.add).not.toHaveBeenCalled();
    expect(screen.getByText('Another Connection already has this name.')).toBeDefined();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(name);
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
    expect(screen.getByLabelText<HTMLSelectElement>('Default Model').value).toBe(
      'anthropic/claude-sonnet-4-5',
    );

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

describe('Remote Provider without a model list', () => {
  it('asks for the model to test with, and adds the Connection with it', async () => {
    const api = installFreshProfile();
    api.providers.list.mockResolvedValue({ ok: true, data: [...FAKE_PRESETS, ZHIPU_PRESET] });
    api.connections.add.mockImplementation(connectionFor('zhipu', 'Zhipu AI (GLM)', []));
    await renderApp('');
    await click('Continue');
    await click('Skip');
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'zhipu' } });
    fireEvent.change(screen.getByLabelText('API key'), {
      target: { value: 'zhipu-key-0123456789' },
    });
    const test = screen.getByRole('button', { name: 'Test connection' });
    expect(test.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Model to test with'), {
      target: { value: 'glm-4.5' },
    });
    await click('Test connection');
    expect(api.connections.add).toHaveBeenCalledExactlyOnceWith({
      providerId: 'zhipu',
      apiKey: 'zhipu-key-0123456789',
      testModel: 'glm-4.5',
    });
  });
});

describe('Remote Provider with a catalogue (Anthropic, Google)', () => {
  it("tests with the catalogue's model unless the User names another", async () => {
    const api = installFreshProfile();
    api.connections.add.mockImplementation(connectionFor('anthropic', 'Anthropic', []));
    await renderApp('');
    await click('Continue');
    await click('Skip');
    const model = screen.getByLabelText<HTMLInputElement>('Model to test with (optional)');
    expect(model.placeholder).toBe('claude-haiku-5-5');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-0123456789' } });
    fireEvent.change(model, { target: { value: ' claude-sonnet-5-5 ' } });
    await click('Test connection');
    expect(api.connections.add).toHaveBeenCalledExactlyOnceWith({
      providerId: 'anthropic',
      apiKey: 'sk-ant-0123456789',
      testModel: 'claude-sonnet-5-5',
    });
  });
});

describe('the Default Model picker', () => {
  /** The wizard at its Default Model step, with `connection` added on the Remote Provider step. */
  async function openDefaultStep(connection: ConnectionSummary) {
    const api = installFreshProfile();
    api.connections.add.mockResolvedValue({ ok: true, data: connection });
    await renderApp('');
    await click('Continue');
    await click('Skip');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-0123' } });
    await click('Continue');
    await act(async () => {
      await Promise.resolve();
    });
    expect(heading()).toBe(DEFAULT_MODEL);
    return api;
  }

  const ANTHROPIC = connectionSummary({
    id: 'anthropic',
    models: ['claude-opus-5-5', 'claude-haiku-5-5'],
  });

  it("annotates the catalogue's models with context window, tool calling and vision", async () => {
    const api = installFreshProfile();
    api.connections.models.mockResolvedValue({
      ok: true,
      data: [
        { id: 'claude-opus-5-5', contextWindow: 1_000_000, tools: true, vision: true },
        { id: 'claude-haiku-5-5', contextWindow: 200_000, tools: true, vision: false },
      ],
    });
    api.connections.add.mockResolvedValue({ ok: true, data: ANTHROPIC });
    await renderApp('');
    await click('Continue');
    await click('Skip');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-ant-0123' } });
    await click('Continue');
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.connections.models).toHaveBeenCalledWith('anthropic');
    const picker = screen.getByLabelText<HTMLSelectElement>('Default Model');
    expect(
      within(within(picker).getByRole('group', { name: 'Anthropic' }))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'claude-opus-5-5 · 1M context · tools · vision',
      'claude-haiku-5-5 · 200K context · tools',
    ]);
  });

  it('accepts any typed model name for a Connection, and keeps it as the choice', async () => {
    await openDefaultStep(ANTHROPIC);
    await click('Type a model name');
    const typed = screen.getByRole('textbox', { name: 'Type a model name' });
    expect(typed.getAttribute('placeholder')).toBe('provider/model, e.g. ollama/mistral:7b');

    fireEvent.change(typed, { target: { value: 'my-nonsense-model' } });
    await click('Use');
    expect(
      screen.getByText('Type it as provider/model, for example ollama/mistral:7b.'),
    ).toBeDefined();
    fireEvent.change(typed, { target: { value: 'groq/llama-4' } });
    await click('Use');
    expect(screen.getByText('No enabled Connection is called groq.')).toBeDefined();

    fireEvent.change(typed, { target: { value: 'anthropic/my-nonsense-model:v0' } });
    await click('Use');
    const picker = screen.getByLabelText<HTMLSelectElement>('Default Model');
    expect(picker.value).toBe('anthropic/my-nonsense-model:v0');
    expect(picker.selectedOptions[0]?.textContent).toBe('my-nonsense-model:v0 (typed)');
    await click('Continue');
    expect(heading()).toBe(DONE);
    expect(screen.getByText('my-nonsense-model:v0 on Anthropic')).toBeDefined();
  });

  it("says when a Connection's models cannot be listed, with the Provider's text", async () => {
    const api = installFreshProfile();
    api.connections.models.mockResolvedValue({
      ok: false,
      error: {
        code: 'provider_error',
        messageKey: 'error.provider_error',
        params: { detail: 'Invalid API Key' },
        message: 'The Provider answered with an error: Invalid API Key',
      },
    });
    api.connections.add.mockResolvedValue({ ok: true, data: connectionSummary({ id: 'openai' }) });
    await renderApp('');
    await click('Continue');
    await click('Skip');
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-0123' } });
    await click('Continue');
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.getByText('Could not list the models of OpenAI. You can still type a model name.'),
    ).toBeDefined();
    expect(screen.getByRole('alert').textContent).toBe(
      'The Provider answered with an error: Invalid API Key',
    );
    expect(screen.getByRole('button', { name: 'Type a model name' })).toBeDefined();
  });
});

describe('Default model and Done', () => {
  /** The wizard at its Default Model step, with a detected Ollama added on the way. */
  async function openWithOllama() {
    const api = installFreshProfile();
    api.connections.detectLocal.mockResolvedValue({ ok: true, data: [OLLAMA] });
    api.connections.add.mockImplementation(
      connectionFor('ollama', 'Ollama', ['qwen3:8b', 'llama3.2:3b']),
    );
    await renderApp('');
    await click('Continue');
    await click('Continue');
    await click('Skip');
    expect(heading()).toBe(DEFAULT_MODEL);
    return api;
  }

  it('Continue saves the picked model as the global `default` Slot Binding, then shows it', async () => {
    const api = await openWithOllama();
    fireEvent.change(screen.getByLabelText('Default Model'), {
      target: { value: 'ollama/llama3.2:3b' },
    });
    await click('Continue');
    expect(api.bindings.setGlobal).toHaveBeenCalledExactlyOnceWith({
      slot: 'default',
      target: { connectionId: 'ollama', model: 'llama3.2:3b' },
    });
    expect(heading()).toBe(DONE);
    expect(screen.getByText('llama3.2:3b on Ollama')).toBeDefined();
    await expect(api.bindings.getGlobal()).resolves.toEqual({
      ok: true,
      data: [{ slot: 'default', connectionId: 'ollama', model: 'llama3.2:3b' }],
    });
  });

  it('stays on the step with the error when the Default Model cannot be saved', async () => {
    const api = await openWithOllama();
    api.bindings.setGlobal.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'provider_not_connected',
        messageKey: 'error.provider_not_connected',
        message: 'There is no Connection for this Provider. Add one on the Models page.',
      },
    });
    await click('Continue');
    expect(heading()).toBe(DEFAULT_MODEL);
    expect(screen.getByRole('alert').textContent).toBe(
      'There is no Connection for this Provider. Add one on the Models page.',
    );
    await click('Continue');
    expect(api.bindings.setGlobal).toHaveBeenCalledTimes(2);
    expect(heading()).toBe(DONE);
    expect(screen.getByText('qwen3:8b on Ollama')).toBeDefined();
  });

  it('Skip sets no Default Model, keeping any set before', async () => {
    const api = await openWithOllama();
    await click('Skip');
    expect(heading()).toBe(DONE);
    expect(api.bindings.setGlobal).not.toHaveBeenCalled();
    const [, defaultModel] = screen.getAllByRole('definition');
    expect(defaultModel?.textContent).toBe('None');
  });

  it('says the Default Model can be set later when no Connection was added, and the summary lists nothing', async () => {
    const api = installFreshProfile();
    await renderApp('');
    await click('Continue');
    await click('Continue');
    await click('Continue');
    expect(screen.getByText('You can set this later in Models.')).toBeDefined();
    expect(screen.queryByRole('combobox')).toBeNull();
    await click('Continue');
    expect(screen.getAllByText('None')).toHaveLength(2);
    expect(screen.getByText(/^No Connection yet\./)).toBeDefined();
    expect(api.bindings.setGlobal).not.toHaveBeenCalled();
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
