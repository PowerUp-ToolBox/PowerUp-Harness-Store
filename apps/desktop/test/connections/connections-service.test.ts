import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MODEL_CATALOGUE } from '@harness-store/gateway';
import type { SafeStorage } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionStore } from '../../src/main/runtime/connection-store.js';
import {
  createConnectionsService,
  type ConnectionTester,
  type ConnectionsService,
  type ModelLister,
} from '../../src/main/runtime/connections.js';
import { openDatabase } from '../../src/main/runtime/database.js';
import { createSafeStorageCipher } from '../../src/main/runtime/secret-cipher.js';
import type {
  ConnectionDraft,
  ConnectionSummary,
  ConnectionUpdate,
  IpcResult,
} from '../../src/shared/ipc.js';
import { createFakeCipher, type FakeCipher } from '../support/fake-cipher.js';

const ANTHROPIC_KEY = 'sk-ant-api03-secret-0123456789';
const OPENAI_KEY = 'sk-proj-another-secret-abcd';

let dir: string;
let db: DatabaseSync;
let cipher: FakeCipher;
let tester: ReturnType<typeof vi.fn<ConnectionTester>>;
let lister: ReturnType<typeof vi.fn<ModelLister>>;
/** The service's clock: test times and the model-list cache. */
let clock: Date;
let service: ConnectionsService;

const T0 = '2026-10-28T09:00:00.000Z';
const ANTHROPIC_MODELS = MODEL_CATALOGUE.anthropic.map((model) => model.id);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-store-connections-'));
  db = openDatabase(join(dir, 'harness-store.sqlite'));
  cipher = createFakeCipher();
  tester = vi.fn<ConnectionTester>(() => Promise.resolve({ ok: true }));
  lister = vi.fn<ModelLister>(() => Promise.resolve({ ok: true, models: [] }));
  clock = new Date(T0);
  service = createConnectionsService({
    store: createConnectionStore(db),
    cipher,
    test: tester,
    listModels: lister,
    now: () => clock,
  });
});

/** Moves the service's clock on by `ms`. */
function advance(ms: number) {
  clock = new Date(clock.getTime() + ms);
}
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function data<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(`Expected ok, got ${result.error.code}`);
  return result.data;
}

function secretRows() {
  return db.prepare('SELECT id, ciphertext FROM secrets ORDER BY id').all() as {
    id: string;
    ciphertext: Uint8Array;
  }[];
}

function connectionRows() {
  return db.prepare('SELECT * FROM connections ORDER BY id').all() as Record<string, unknown>[];
}

function bindingRows() {
  return db.prepare('SELECT * FROM slot_bindings ORDER BY scope, slot').all();
}

function bind(scope: string, slot: string, connectionId: string, model: string) {
  db.prepare('INSERT INTO slot_bindings (scope, slot, provider_id, model) VALUES (?, ?, ?, ?)').run(
    scope,
    slot,
    connectionId,
    model,
  );
}

function summaryOf(id: string) {
  return service.list().find((connection) => connection.id === id);
}

const invalid = (method: string) => ({
  ok: false,
  error: { code: 'invalid_input', params: { method } },
});

describe('adding a Connection for a key-based Provider', () => {
  it('requires a non-empty key', async () => {
    await expect(service.add({ providerId: 'anthropic' })).resolves.toMatchObject(
      invalid('connections.add'),
    );
    await expect(service.add({ providerId: 'anthropic', apiKey: '   ' })).resolves.toMatchObject(
      invalid('connections.add'),
    );
    expect(connectionRows()).toEqual([]);
    expect(tester).not.toHaveBeenCalled();
  });

  it('stores the key encrypted, never in plaintext, and shows only its last 4 characters', async () => {
    const added = data(
      await service.add({ providerId: 'anthropic', apiKey: ` ${ANTHROPIC_KEY}\n` }),
    );
    expect(added).toEqual({
      id: 'anthropic',
      providerId: 'anthropic',
      displayName: 'Anthropic',
      local: false,
      enabled: true,
      baseUrl: 'https://api.anthropic.com/v1',
      keyHint: '6789',
      // The test it passed before it was saved.
      lastTestedAt: T0,
      lastTestOk: true,
      lastTestError: null,
      lastTestFailure: null,
      testModel: null,
      // The app's catalogue, known without a network call.
      models: ANTHROPIC_MODELS,
    });

    const [secret] = secretRows();
    expect(secret?.id).toBe('anthropic');
    const ciphertext = Buffer.from(secret?.ciphertext ?? []);
    expect(ciphertext.toString('utf8')).not.toContain(ANTHROPIC_KEY);
    expect(ciphertext.toString('latin1')).not.toContain(ANTHROPIC_KEY);
    // It is the cipher's output for the trimmed key, so the Gateway can decrypt it.
    expect(cipher.reveal(new Uint8Array(ciphertext))).toBe(ANTHROPIC_KEY);
    expect(connectionRows()).toEqual([
      {
        id: 'anthropic',
        provider_id: 'anthropic',
        display_name: 'Anthropic',
        base_url: null,
        secret_ref: 'anthropic',
        key_hint: '6789',
        enabled: 1,
        last_tested_at: T0,
        last_test_ok: 1,
        last_test_error: null,
        last_test_failure: null,
        test_model: null,
      },
    ]);
    // Nothing the renderer is given holds the key.
    expect(JSON.stringify(service.list())).not.toContain(ANTHROPIC_KEY);
    expect(JSON.stringify(added)).not.toContain(ANTHROPIC_KEY.slice(0, -4));
  });

  it('tests the Connection with its key and base URL before saving it', async () => {
    await service.add({
      providerId: 'openai',
      apiKey: OPENAI_KEY,
      baseUrl: 'https://proxy.example.com/v1/',
    });
    expect(tester).toHaveBeenCalledWith({
      providerId: 'openai',
      apiKey: OPENAI_KEY,
      baseUrl: 'https://proxy.example.com/v1',
    });
  });

  it('stores nothing when the test fails, and answers provider_error with the Provider text', async () => {
    tester.mockResolvedValueOnce({
      ok: false,
      reason: 'provider_error',
      detail: 'Incorrect API key provided.',
    });
    await expect(
      service.add({ providerId: 'anthropic', apiKey: ANTHROPIC_KEY }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'provider_error',
        params: { detail: 'Incorrect API key provided.' },
        message: 'The Provider answered with an error: Incorrect API key provided.',
      },
    });
    expect(connectionRows()).toEqual([]);
    expect(secretRows()).toEqual([]);
  });

  it('shows no characters of a key shorter than 12', async () => {
    expect(data(await service.add({ providerId: 'groq', apiKey: 'gsk_short' })).keyHint).toBe('');
  });

  it.each<{ reason: string; draft: ConnectionDraft }>([
    {
      reason: 'a key with a space inside',
      draft: { providerId: 'anthropic', apiKey: 'sk-ant one' },
    },
    {
      reason: 'a key with a control character',
      draft: { providerId: 'anthropic', apiKey: 'sk-ant\u0007x' },
    },
    {
      reason: 'a name for a preset',
      draft: { providerId: 'anthropic', apiKey: ANTHROPIC_KEY, displayName: 'Mine' },
    },
    {
      reason: 'a key for a keyless preset',
      draft: { providerId: 'ollama', apiKey: 'sk-local-0123456789' },
    },
    {
      reason: 'a non-http base URL',
      draft: { providerId: 'anthropic', apiKey: ANTHROPIC_KEY, baseUrl: 'ftp://x' },
    },
    {
      reason: 'a Connection id instead of a Provider id',
      draft: { providerId: 'openai-compatible:vllm', displayName: 'x', baseUrl: 'http://x' },
    },
  ])('rejects $reason as invalid_input', async ({ draft }) => {
    await expect(service.add(draft)).resolves.toMatchObject(invalid('connections.add'));
    expect(connectionRows()).toEqual([]);
  });
});

describe('single-instance Providers', () => {
  it('adding a second anthropic Connection edits the first in place, with the new key, enabled', async () => {
    data(await service.add({ providerId: 'anthropic', apiKey: ANTHROPIC_KEY }));
    data(await service.update({ id: 'anthropic', enabled: false }));
    const again = data(
      await service.add({ providerId: 'anthropic', apiKey: 'sk-ant-api03-replaced-wxyz' }),
    );
    expect(again).toMatchObject({ id: 'anthropic', keyHint: 'wxyz', enabled: true });
    expect(service.list().map((connection) => connection.id)).toEqual(['anthropic']);
    expect(secretRows()).toHaveLength(1);
    expect(cipher.reveal(secretRows()[0]?.ciphertext ?? new Uint8Array())).toBe(
      'sk-ant-api03-replaced-wxyz',
    );
  });

  it('adding it again without a base URL keeps the custom one stored, and tests with it', async () => {
    data(
      await service.add({
        providerId: 'openai',
        apiKey: OPENAI_KEY,
        baseUrl: 'https://proxy.example.com/v1',
      }),
    );
    data(await service.update({ id: 'openai', enabled: false }));
    tester.mockClear();
    // What the wizard's Remote Provider step sends for a preset, when setup is run again.
    const again = data(
      await service.add({ providerId: 'openai', apiKey: 'sk-proj-replaced-wxyz' }),
    );
    expect(tester).toHaveBeenCalledWith({
      providerId: 'openai',
      apiKey: 'sk-proj-replaced-wxyz',
      baseUrl: 'https://proxy.example.com/v1',
    });
    expect(again).toMatchObject({
      id: 'openai',
      baseUrl: 'https://proxy.example.com/v1',
      keyHint: 'wxyz',
      enabled: true,
    });
    expect(connectionRows()).toEqual([
      expect.objectContaining({ id: 'openai', base_url: 'https://proxy.example.com/v1' }),
    ]);
  });

  it('adding it again with a base URL replaces the stored one; an empty one means the default', async () => {
    data(await service.add({ providerId: 'ollama', baseUrl: 'http://10.0.0.5:11434/v1' }));
    const moved = data(
      await service.add({ providerId: 'ollama', baseUrl: 'http://10.0.0.6:11434/v1' }),
    );
    expect(moved.baseUrl).toBe('http://10.0.0.6:11434/v1');
    const reset = data(await service.add({ providerId: 'ollama', baseUrl: '' }));
    expect(reset.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(connectionRows()).toEqual([expect.objectContaining({ id: 'ollama', base_url: null })]);
  });

  it('a local Provider needs no key; its default base URL is stored as NULL', async () => {
    const ollama = data(
      await service.add({ providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1/' }),
    );
    expect(ollama).toMatchObject({
      id: 'ollama',
      local: true,
      keyHint: null,
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
    expect(connectionRows()[0]).toMatchObject({ base_url: null, secret_ref: null });
    expect(secretRows()).toEqual([]);

    const moved = data(await service.update({ id: 'ollama', baseUrl: 'http://10.0.0.5:11434/v1' }));
    expect(moved.baseUrl).toBe('http://10.0.0.5:11434/v1');
    expect(connectionRows()[0]).toMatchObject({ base_url: 'http://10.0.0.5:11434/v1' });
  });
});

describe('custom OpenAI-compatible endpoints', () => {
  it('require a name and a base URL; the key is optional', async () => {
    await expect(
      service.add({ providerId: 'openai-compatible', baseUrl: 'http://10.0.0.2:8000/v1' }),
    ).resolves.toMatchObject(invalid('connections.add'));
    await expect(
      service.add({ providerId: 'openai-compatible', displayName: 'vLLM at work' }),
    ).resolves.toMatchObject(invalid('connections.add'));

    const keyless = data(
      await service.add({
        providerId: 'openai-compatible',
        displayName: 'vLLM at work',
        baseUrl: 'http://10.0.0.2:8000/v1',
      }),
    );
    expect(keyless).toMatchObject({
      id: 'openai-compatible:vllm-at-work',
      providerId: 'openai-compatible',
      displayName: 'vLLM at work',
      baseUrl: 'http://10.0.0.2:8000/v1',
      keyHint: null,
    });
    const keyed = data(
      await service.add({
        providerId: 'openai-compatible',
        displayName: 'Home proxy',
        baseUrl: 'https://proxy.home.example/v1',
        apiKey: 'proxy-token-0123456789',
      }),
    );
    expect(keyed).toMatchObject({ id: 'openai-compatible:home-proxy', keyHint: '6789' });
  });

  it('allow many, with unique names (ignoring case) and ids that never change', async () => {
    const add = (displayName: string) =>
      service.add({ providerId: 'openai-compatible', displayName, baseUrl: 'http://10.0.0.2/v1' });
    expect(data(await add('vLLM')).id).toBe('openai-compatible:vllm');
    await expect(add('VLLM')).resolves.toMatchObject(invalid('connections.add'));
    expect(data(await add('vLLM!')).id).toBe('openai-compatible:vllm-2');
    expect(data(await add('我的端点')).id).toBe('openai-compatible:endpoint');

    const renamed = data(
      await service.update({ id: 'openai-compatible:vllm', displayName: 'Lab' }),
    );
    expect(renamed).toMatchObject({ id: 'openai-compatible:vllm', displayName: 'Lab' });
    // The old name is free again; the id it would have had is not, so it gets the next one.
    expect(data(await add('vllm')).id).toBe('openai-compatible:vllm-3');
    await expect(
      service.update({ id: 'openai-compatible:vllm-2', displayName: 'lab' }),
    ).resolves.toMatchObject(invalid('connections.update'));
    await expect(
      service.update({ id: 'openai-compatible:vllm', baseUrl: '' }),
    ).resolves.toMatchObject(invalid('connections.update'));
    // Renaming is not a new credential: no test.
    expect(tester).toHaveBeenCalledTimes(4);
  });
});

describe('updating a Connection', () => {
  beforeEach(async () => {
    data(await service.add({ providerId: 'anthropic', apiKey: ANTHROPIC_KEY }));
    tester.mockClear();
  });

  it('keeps the stored key when apiKey is left out, and cannot clear it', async () => {
    data(await service.update({ id: 'anthropic', baseUrl: 'https://gateway.example.com/v1' }));
    // A new base URL is tested with the stored key.
    expect(tester).toHaveBeenCalledWith({
      providerId: 'anthropic',
      apiKey: ANTHROPIC_KEY,
      baseUrl: 'https://gateway.example.com/v1',
    });
    expect(cipher.reveal(secretRows()[0]?.ciphertext ?? new Uint8Array())).toBe(ANTHROPIC_KEY);
    await expect(service.update({ id: 'anthropic', apiKey: '' })).resolves.toMatchObject(
      invalid('connections.update'),
    );
    expect(service.list()[0]?.keyHint).toBe('6789');
  });

  it('a new key is tested, then replaces the secret in the same row', async () => {
    const updated = data(await service.update({ id: 'anthropic', apiKey: 'sk-ant-new-key-9999' }));
    expect(tester).toHaveBeenCalledWith({
      providerId: 'anthropic',
      apiKey: 'sk-ant-new-key-9999',
      baseUrl: 'https://api.anthropic.com/v1',
    });
    expect(updated.keyHint).toBe('9999');
    expect(secretRows().map((row) => row.id)).toEqual(['anthropic']);
    expect(cipher.reveal(secretRows()[0]?.ciphertext ?? new Uint8Array())).toBe(
      'sk-ant-new-key-9999',
    );
  });

  it('keeps everything as it was when the test of a new key fails', async () => {
    tester.mockResolvedValueOnce({
      ok: false,
      reason: 'provider_error',
      detail: 'invalid x-api-key',
    });
    await expect(
      service.update({ id: 'anthropic', apiKey: 'sk-ant-bad-key-0000' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'provider_error' } });
    expect(service.list()[0]?.keyHint).toBe('6789');
    expect(cipher.reveal(secretRows()[0]?.ciphertext ?? new Uint8Array())).toBe(ANTHROPIC_KEY);
  });

  it('disabling keeps the Connection listed, marked inactive, with its secret; no test runs', async () => {
    const disabled = data(await service.update({ id: 'anthropic', enabled: false }));
    expect(disabled).toMatchObject({ id: 'anthropic', enabled: false, keyHint: '6789' });
    expect(service.list()).toEqual([disabled]);
    expect(secretRows()).toHaveLength(1);
    expect(data(await service.update({ id: 'anthropic', enabled: true })).enabled).toBe(true);
    expect(tester).not.toHaveBeenCalled();
    // Decrypting is only for the Gateway and tests of a new base URL.
    expect(cipher.decrypts).toBe(0);
  });

  it.each<{ reason: string; update: ConnectionUpdate }>([
    { reason: 'an unknown id', update: { id: 'openai' } },
    { reason: 'a name for a preset', update: { id: 'anthropic', displayName: 'My Claude' } },
    { reason: 'a key with a space', update: { id: 'anthropic', apiKey: 'two words' } },
    { reason: 'a bad base URL', update: { id: 'anthropic', baseUrl: 'not a url' } },
  ])('rejects $reason as invalid_input', async ({ update }) => {
    await expect(service.update(update)).resolves.toMatchObject(invalid('connections.update'));
  });
});

describe('without OS encryption (no keyring)', () => {
  beforeEach(() => {
    cipher.available = false;
  });

  it('refuses to add a Connection with a key, and stores nothing, not even in plaintext', async () => {
    const result = await service.add({ providerId: 'anthropic', apiKey: ANTHROPIC_KEY });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'encryption_unavailable', messageKey: 'error.encryption_unavailable' },
    });
    expect(result.ok ? '' : result.error.message).toMatch(/keyring/);
    expect(connectionRows()).toEqual([]);
    expect(secretRows()).toEqual([]);
    expect(tester).not.toHaveBeenCalled();
  });

  it('still adds Connections without a key', async () => {
    expect(data(await service.add({ providerId: 'ollama' })).id).toBe('ollama');
    expect(
      data(
        await service.add({
          providerId: 'openai-compatible',
          displayName: 'LAN',
          baseUrl: 'http://192.168.1.9:8000/v1',
        }),
      ).keyHint,
    ).toBeNull();
  });

  it('refuses a new key for a saved Connection', async () => {
    data(await service.add({ providerId: 'ollama' }));
    data(
      await service.add({
        providerId: 'openai-compatible',
        displayName: 'LAN',
        baseUrl: 'http://192.168.1.9:8000/v1',
      }),
    );
    await expect(
      service.update({ id: 'openai-compatible:lan', apiKey: 'lan-token-0123456789' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'encryption_unavailable' } });
    expect(secretRows()).toEqual([]);
  });
});

describe('removing a Connection', () => {
  it('deletes it, its secret and every Slot Binding that uses it, and nothing else', async () => {
    data(await service.add({ providerId: 'anthropic', apiKey: ANTHROPIC_KEY }));
    data(await service.add({ providerId: 'ollama' }));
    bind('global', 'default', 'anthropic', 'claude-sonnet-4-5');
    bind('global', 'fast', 'ollama', 'qwen3:8b');
    bind('harness:acme/reviewer', 'default', 'anthropic', 'claude-opus-4-1');

    expect(service.remove('anthropic')).toEqual({ ok: true, data: null });
    expect(service.list().map((connection) => connection.id)).toEqual(['ollama']);
    expect(secretRows()).toEqual([]);
    expect(bindingRows()).toEqual([
      { scope: 'global', slot: 'fast', provider_id: 'ollama', model: 'qwen3:8b' },
    ]);
  });

  it('answers invalid_input for an unknown id', () => {
    expect(service.remove('anthropic')).toMatchObject(invalid('connections.remove'));
  });
});

describe('connections.list', () => {
  it('follows the Provider table, then custom endpoints by name', async () => {
    const custom = (displayName: string) =>
      service.add({ providerId: 'openai-compatible', displayName, baseUrl: 'http://10.0.0.2/v1' });
    data(await custom('zeta'));
    data(await service.add({ providerId: 'groq', apiKey: 'gsk_0123456789abcdef' }));
    data(await custom('Alpha'));
    data(await service.add({ providerId: 'ollama' }));
    data(await service.add({ providerId: 'anthropic', apiKey: ANTHROPIC_KEY }));
    expect(service.list().map((connection: ConnectionSummary) => connection.id)).toEqual([
      'anthropic',
      'ollama',
      'groq',
      'openai-compatible:alpha',
      'openai-compatible:zeta',
    ]);
  });

  it('globalBindings lists default first, then by Slot name, global scope only', () => {
    const store = createConnectionStore(db);
    bind('global', 'fast', 'ollama', 'qwen3:8b');
    bind('global', 'default', 'anthropic', 'claude-sonnet-4-5');
    bind('global', 'coder', 'ollama', 'qwen3-coder');
    bind('harness:acme/reviewer', 'default', 'ollama', 'llama3.2');
    expect(store.globalBindings()).toEqual([
      { slot: 'default', connectionId: 'anthropic', model: 'claude-sonnet-4-5' },
      { slot: 'coder', connectionId: 'ollama', model: 'qwen3-coder' },
      { slot: 'fast', connectionId: 'ollama', model: 'qwen3:8b' },
    ]);
  });
});

describe('createSafeStorageCipher', () => {
  const safeStorage = (available: boolean, backend: string) => ({
    isAsyncEncryptionAvailable: () => Promise.resolve(available),
    getSelectedStorageBackend: () =>
      backend as ReturnType<SafeStorage['getSelectedStorageBackend']>,
    encryptStringAsync: (text: string) => Promise.resolve(Buffer.from(`enc(${text})`)),
    decryptStringAsync: (buffer: Buffer) =>
      Promise.resolve({ shouldReEncrypt: false, result: buffer.toString().slice(4, -1) }),
  });

  it('is available where safeStorage is, and round-trips through it', async () => {
    const cipher = createSafeStorageCipher(safeStorage(true, 'unknown'), 'darwin');
    await expect(cipher.isAvailable()).resolves.toBe(true);
    await expect(cipher.decrypt(await cipher.encrypt('sk-123'))).resolves.toBe('sk-123');
  });

  it('counts the Linux basic_text backend (a hard-coded password) as unavailable', async () => {
    await expect(
      createSafeStorageCipher(safeStorage(true, 'basic_text'), 'linux').isAvailable(),
    ).resolves.toBe(false);
    await expect(
      createSafeStorageCipher(safeStorage(true, 'gnome_libsecret'), 'linux').isAvailable(),
    ).resolves.toBe(true);
  });

  it('refuses to encrypt while unavailable', async () => {
    const cipher = createSafeStorageCipher(safeStorage(false, 'unknown'), 'win32');
    await expect(cipher.isAvailable()).resolves.toBe(false);
    await expect(cipher.encrypt('sk-123')).rejects.toThrow(/not available/);
  });
});

describe('testing a saved Connection', () => {
  beforeEach(async () => {
    data(await service.add({ providerId: 'openai', apiKey: OPENAI_KEY }));
    tester.mockClear();
  });

  it('stores a passed test with its time, and the models it listed', async () => {
    advance(60_000);
    tester.mockResolvedValueOnce({ ok: true, models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] });
    const tested = data(await service.test({ id: 'openai' }));
    expect(tester).toHaveBeenCalledWith({
      providerId: 'openai',
      apiKey: OPENAI_KEY,
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(tested).toMatchObject({
      lastTestedAt: '2026-10-28T09:01:00.000Z',
      lastTestOk: true,
      lastTestError: null,
      models: ['gpt-5', 'gpt-5-mini'],
    });
    expect(service.list()).toEqual([tested]);
  });

  it("stores a failed test with the Provider's own text; the call itself still succeeds", async () => {
    tester.mockResolvedValueOnce({
      ok: false,
      reason: 'provider_error',
      detail: 'Incorrect API key provided.',
    });
    const failed = await service.test({ id: 'openai' });
    expect(failed).toMatchObject({
      ok: true,
      data: { lastTestOk: false, lastTestError: 'Incorrect API key provided.', lastTestedAt: T0 },
    });
    expect(connectionRows()[0]).toMatchObject({
      last_test_ok: 0,
      last_test_error: 'Incorrect API key provided.',
    });
    // The Connection is kept as it was: a failed test changes nothing else.
    expect(service.list()[0]).toMatchObject({ enabled: true, keyHint: 'abcd' });

    const passed = data(await service.test({ id: 'openai' }));
    expect(passed).toMatchObject({ lastTestOk: true, lastTestError: null });
  });

  it('does not record a result that belongs to a key replaced while the test ran', async () => {
    tester.mockImplementationOnce(async () => {
      // The User saves a new key (which passes its own test) before this test answers.
      tester.mockResolvedValueOnce({ ok: true });
      data(await service.update({ id: 'openai', apiKey: 'sk-proj-replaced-wxyz' }));
      return { ok: false, reason: 'provider_error', detail: 'Incorrect API key provided.' };
    });
    const result = data(await service.test({ id: 'openai' }));
    expect(result).toMatchObject({ keyHint: 'wxyz', lastTestOk: true, lastTestError: null });
    expect(service.list()[0]).toEqual(result);
  });

  it('needs a model to test with where the Provider neither lists models nor is catalogued', async () => {
    data(
      await service.add({
        providerId: 'zhipu',
        apiKey: 'zhipu-key-0123456789',
        testModel: 'glm-4.5',
      }),
    );
    expect(tester).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'glm-4.5' }));
    expect(summaryOf('zhipu')?.testModel).toBe('glm-4.5');
    // A later test that names none uses the one the last passed test used.
    data(await service.test({ id: 'zhipu' }));
    expect(tester).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'glm-4.5' }));
    data(await service.test({ id: 'zhipu', model: ' glm-4.5-air ' }));
    expect(tester).toHaveBeenLastCalledWith({
      providerId: 'zhipu',
      apiKey: 'zhipu-key-0123456789',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.5-air',
    });
    data(await service.update({ id: 'zhipu', apiKey: 'zhipu-key-replaced-wxyz' }));
    expect(tester).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'glm-4.5-air' }));
    // Adding a Connection without one is refused: there is none to fall back on.
    await expect(
      service.add({ providerId: 'minimax', apiKey: 'minimax-key-0123456789' }),
    ).resolves.toMatchObject(invalid('connections.add'));
    // Renaming or disabling runs no test, so needs none.
    expect(data(await service.update({ id: 'zhipu', enabled: false })).enabled).toBe(false);
  });

  it("tests Anthropic and Google with the catalogue's model, or with one the User names", async () => {
    data(await service.add({ providerId: 'google', apiKey: 'AIza-google-key-0123456789' }));
    expect(tester).toHaveBeenLastCalledWith({
      providerId: 'google',
      apiKey: 'AIza-google-key-0123456789',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    });
    expect(summaryOf('google')?.testModel).toBeNull();
    // A key that cannot use the catalogue's test model is tested with another one.
    data(await service.test({ id: 'google', model: 'gemini-3.6-flash' }));
    expect(tester).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerId: 'google', model: 'gemini-3.6-flash' }),
    );
    data(
      await service.update({
        id: 'google',
        apiKey: 'AIza-google-key-replaced-wxyz',
        testModel: 'gemini-3.8-flash',
      }),
    );
    expect(tester).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'gemini-3.8-flash' }));
  });

  it("tests again with the model a Connection was added with, not the catalogue's", async () => {
    // The key cannot use the catalogue's test model, so the User named another when adding it.
    data(
      await service.add({
        providerId: 'google',
        apiKey: 'AIza-google-key-0123456789',
        testModel: ' gemini-3.6-flash ',
      }),
    );
    expect(summaryOf('google')?.testModel).toBe('gemini-3.6-flash');
    expect(connectionRows().find((row) => row.id === 'google')).toMatchObject({
      test_model: 'gemini-3.6-flash',
    });

    // The row's Test names none: it uses that model, so a working Connection passes.
    expect(data(await service.test({ id: 'google' })).lastTestOk).toBe(true);
    expect(tester).toHaveBeenLastCalledWith({
      providerId: 'google',
      apiKey: 'AIza-google-key-0123456789',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-3.6-flash',
    });
    // So does a new key or base URL saved without one, and a test of the edit form.
    data(await service.update({ id: 'google', apiKey: 'AIza-google-key-replaced-wxyz' }));
    expect(tester).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'gemini-3.6-flash' }));
    data(await service.testDraft({ id: 'google', providerId: 'google' }));
    expect(tester).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'gemini-3.6-flash' }));
    // Adding Google again keeps it, as it keeps what else the draft leaves out.
    data(await service.add({ providerId: 'google', apiKey: 'AIza-google-key-third-0000' }));
    expect(tester).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'gemini-3.6-flash' }));

    // A model that fails is not kept: the next test uses the one that passed.
    tester.mockResolvedValueOnce({ ok: false, reason: 'provider_error', detail: 'not found' });
    expect(data(await service.test({ id: 'google', model: 'gemini-9' })).testModel).toBe(
      'gemini-3.6-flash',
    );
    data(await service.test({ id: 'google' }));
    expect(tester).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'gemini-3.6-flash' }));
  });

  it('keeps no test model for a Provider whose test lists its models instead', async () => {
    data(await service.add({ providerId: 'openai', apiKey: OPENAI_KEY, testModel: 'gpt-5' }));
    expect(tester).toHaveBeenLastCalledWith({
      providerId: 'openai',
      apiKey: OPENAI_KEY,
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(summaryOf('openai')?.testModel).toBeNull();
  });

  it.each([
    { reason: 'provider_timeout', label: 'did not answer in time' },
    { reason: 'unexpected_response', label: 'answered with something its API does not return' },
  ] as const)(
    'stores a failed test whose Provider $label as a reason, with no app-written text',
    async ({ reason }) => {
      tester.mockResolvedValueOnce({ ok: false, reason });
      const failed = data(await service.test({ id: 'openai' }));
      expect(failed).toMatchObject({
        lastTestOk: false,
        lastTestError: null,
        lastTestFailure: reason,
      });
      expect(connectionRows()[0]).toMatchObject({
        last_test_ok: 0,
        last_test_error: null,
        last_test_failure: reason,
      });

      const passed = data(await service.test({ id: 'openai' }));
      expect(passed).toMatchObject({
        lastTestOk: true,
        lastTestError: null,
        lastTestFailure: null,
      });
    },
  );

  it.each([
    { reason: 'an unknown id', request: { id: 'anthropic' } },
    { reason: 'a model name with a space', request: { id: 'openai', model: 'gpt 5' } },
  ])('rejects $reason as invalid_input', async ({ request }) => {
    await expect(service.test(request)).resolves.toMatchObject(invalid('connections.test'));
    expect(tester).not.toHaveBeenCalled();
  });
});

describe('model listing', () => {
  it('offers the catalogue for Anthropic and Google, with what is known of each model', async () => {
    data(await service.add({ providerId: 'anthropic', apiKey: ANTHROPIC_KEY }));
    expect(data(await service.models('anthropic'))).toEqual(MODEL_CATALOGUE.anthropic);
    expect(lister).not.toHaveBeenCalled();
  });

  it('lists live once, then reuses the list for 10 minutes; after that it lists again', async () => {
    data(await service.add({ providerId: 'ollama' }));
    lister.mockResolvedValue({ ok: true, models: [{ id: 'qwen3:8b' }] });
    expect(data(await service.models('ollama'))).toEqual([{ id: 'qwen3:8b' }]);
    expect(lister).toHaveBeenCalledExactlyOnceWith({
      providerId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
    expect(service.list()[0]?.models).toEqual(['qwen3:8b']);

    advance(10 * 60 * 1000 - 1);
    expect(data(await service.models('ollama'))).toEqual([{ id: 'qwen3:8b' }]);
    expect(lister).toHaveBeenCalledTimes(1);

    advance(1);
    // Stale: connections.list never lists live, so it knows no models until the picker asks.
    expect(service.list()[0]?.models).toEqual([]);
    data(await service.models('ollama'));
    expect(lister).toHaveBeenCalledTimes(2);
  });

  it('a passed test fills the cache, so the picker opened after adding lists nothing again', async () => {
    tester.mockResolvedValueOnce({ ok: true, models: [{ id: 'gpt-5' }] });
    expect(data(await service.add({ providerId: 'openai', apiKey: OPENAI_KEY })).models).toEqual([
      'gpt-5',
    ]);
    expect(data(await service.models('openai'))).toEqual([{ id: 'gpt-5' }]);
    expect(lister).not.toHaveBeenCalled();
  });

  it('answers a listing that timed out with provider_timeout', async () => {
    data(await service.add({ providerId: 'groq', apiKey: 'gsk_0123456789abcdef' }));
    lister.mockResolvedValueOnce({ ok: false, reason: 'provider_timeout' });
    await expect(service.models('groq')).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_timeout', messageKey: 'error.provider_timeout' },
    });
  });

  it("does not keep a failed listing, and answers provider_error with the Provider's text", async () => {
    data(await service.add({ providerId: 'groq', apiKey: 'gsk_0123456789abcdef' }));
    lister.mockResolvedValueOnce({
      ok: false,
      reason: 'provider_error',
      detail: 'Invalid API Key',
    });
    await expect(service.models('groq')).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_error', params: { detail: 'Invalid API Key' } },
    });
    data(await service.models('groq'));
    expect(lister).toHaveBeenCalledTimes(2);
    expect(lister).toHaveBeenLastCalledWith({
      providerId: 'groq',
      apiKey: 'gsk_0123456789abcdef',
      baseUrl: 'https://api.groq.com/openai/v1',
    });
  });

  it('forgets the list when the key changes', async () => {
    data(await service.add({ providerId: 'groq', apiKey: 'gsk_0123456789abcdef' }));
    lister.mockResolvedValueOnce({ ok: true, models: [{ id: 'llama-old-key' }] });
    expect(data(await service.models('groq'))).toEqual([{ id: 'llama-old-key' }]);
    expect(lister).toHaveBeenCalledTimes(1);

    // The new key's test lists no models, so only a new listing can know them.
    data(await service.update({ id: 'groq', apiKey: 'gsk_replaced_key_wxyz' }));
    expect(service.list()[0]?.models).toEqual([]);
    lister.mockResolvedValueOnce({ ok: true, models: [{ id: 'llama-new-key' }] });
    expect(data(await service.models('groq'))).toEqual([{ id: 'llama-new-key' }]);
    expect(lister).toHaveBeenCalledTimes(2);
    expect(lister).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: 'gsk_replaced_key_wxyz' }),
    );

    // Where the new key's test lists models, they replace the old list: no listing is needed.
    tester.mockResolvedValueOnce({ ok: true, models: [{ id: 'llama-third-key' }] });
    data(await service.update({ id: 'groq', apiKey: 'gsk_third_key_0000' }));
    expect(data(await service.models('groq'))).toEqual([{ id: 'llama-third-key' }]);
    expect(lister).toHaveBeenCalledTimes(2);
  });

  it('does not keep a listing made with a key replaced while it was listed', async () => {
    data(await service.add({ providerId: 'groq', apiKey: 'gsk_0123456789abcdef' }));
    lister.mockImplementationOnce(async () => {
      // The User saves a new key (whose test lists no models) before this listing answers.
      data(await service.update({ id: 'groq', apiKey: 'gsk_replaced_key_wxyz' }));
      return { ok: true, models: [{ id: 'llama-old-key' }] };
    });
    expect(data(await service.models('groq'))).toEqual([{ id: 'llama-old-key' }]);
    expect(service.list()[0]?.models).toEqual([]);

    lister.mockResolvedValueOnce({ ok: true, models: [{ id: 'llama-new-key' }] });
    expect(data(await service.models('groq'))).toEqual([{ id: 'llama-new-key' }]);
    expect(lister).toHaveBeenCalledTimes(2);
    expect(lister).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: 'gsk_replaced_key_wxyz' }),
    );
    // The new key's listing is the one kept.
    expect(data(await service.models('groq'))).toEqual([{ id: 'llama-new-key' }]);
    expect(lister).toHaveBeenCalledTimes(2);
  });

  it('forgets the list when the base URL changes, or the Connection is removed', async () => {
    data(await service.add({ providerId: 'ollama' }));
    data(await service.models('ollama'));
    data(await service.update({ id: 'ollama', enabled: false }));
    data(await service.models('ollama'));
    expect(lister).toHaveBeenCalledTimes(1);

    data(await service.update({ id: 'ollama', baseUrl: 'http://10.0.0.5:11434/v1' }));
    data(await service.models('ollama'));
    expect(lister).toHaveBeenCalledTimes(2);

    expect(service.remove('ollama')).toEqual({ ok: true, data: null });
    data(await service.add({ providerId: 'ollama' }));
    data(await service.models('ollama'));
    expect(lister).toHaveBeenCalledTimes(3);
  });

  it('lists nothing, and asks nobody, for a Provider without a model list', async () => {
    data(await service.add({ providerId: 'doubao', apiKey: 'ark-0123456789', testModel: 'x' }));
    expect(data(await service.models('doubao'))).toEqual([]);
    expect(lister).not.toHaveBeenCalled();
    await expect(service.models('nope')).resolves.toMatchObject(invalid('connections.models'));
  });
});

describe('testing a draft', () => {
  it('tests a new Connection without saving anything, and returns the models it found', async () => {
    tester.mockResolvedValueOnce({ ok: true, models: [{ id: 'gpt-5' }] });
    await expect(service.testDraft({ providerId: 'openai', apiKey: OPENAI_KEY })).resolves.toEqual({
      ok: true,
      data: { models: [{ id: 'gpt-5' }] },
    });
    expect(connectionRows()).toEqual([]);
    expect(secretRows()).toEqual([]);
    // Anthropic's models come from the catalogue.
    await expect(
      service.testDraft({ providerId: 'anthropic', apiKey: ANTHROPIC_KEY }),
    ).resolves.toEqual({ ok: true, data: { models: MODEL_CATALOGUE.anthropic } });
  });

  it.each([
    {
      reason: 'provider_timeout',
      message: 'The Provider did not answer in time.',
    },
    {
      reason: 'unexpected_response',
      message: 'The Provider answered with something its API does not return. Check the base URL.',
    },
  ] as const)(
    'answers a test that failed as $reason with that code',
    async ({ reason, message }) => {
      tester.mockResolvedValueOnce({ ok: false, reason });
      await expect(
        service.testDraft({ providerId: 'openai-compatible', baseUrl: 'http://10.0.0.1' }),
      ).resolves.toEqual({
        ok: false,
        error: { code: reason, messageKey: `error.${reason}`, message },
      });
      tester.mockResolvedValueOnce({ ok: false, reason });
      await expect(
        service.add({
          providerId: 'openai-compatible',
          displayName: 'Box',
          baseUrl: 'http://10.0.0.1',
        }),
      ).resolves.toMatchObject({ ok: false, error: { code: reason } });
      expect(connectionRows()).toEqual([]);
    },
  );

  it("answers a failed test with provider_error and the Provider's text", async () => {
    tester.mockResolvedValueOnce({
      ok: false,
      reason: 'provider_error',
      detail: 'invalid x-api-key',
    });
    await expect(
      service.testDraft({ providerId: 'anthropic', apiKey: ANTHROPIC_KEY }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'provider_error', params: { detail: 'invalid x-api-key' } },
    });
  });

  it('for a saved Connection, takes what the draft leaves out from it, its key included', async () => {
    data(
      await service.add({
        providerId: 'openai',
        apiKey: OPENAI_KEY,
        baseUrl: 'https://proxy.example.com/v1',
      }),
    );
    tester.mockClear();
    data(await service.testDraft({ id: 'openai', providerId: 'openai' }));
    expect(tester).toHaveBeenCalledWith({
      providerId: 'openai',
      apiKey: OPENAI_KEY,
      baseUrl: 'https://proxy.example.com/v1',
    });
    data(await service.testDraft({ id: 'openai', providerId: 'openai', baseUrl: '' }));
    expect(tester).toHaveBeenLastCalledWith(
      expect.objectContaining({ baseUrl: 'https://api.openai.com/v1' }),
    );
    // Nothing about the saved Connection changed.
    expect(service.list()[0]).toMatchObject({ baseUrl: 'https://proxy.example.com/v1' });
  });

  it.each([
    { reason: 'a missing key', draft: { providerId: 'anthropic' } },
    { reason: 'a missing test model', draft: { providerId: 'zhipu', apiKey: 'k-0123456789' } },
    { reason: 'an id of another Provider', draft: { id: 'ollama', providerId: 'openai' } },
    { reason: 'a custom endpoint without a base URL', draft: { providerId: 'openai-compatible' } },
  ])('rejects $reason as invalid_input', async ({ draft }) => {
    await expect(service.testDraft(draft)).resolves.toMatchObject(invalid('connections.testDraft'));
    expect(tester).not.toHaveBeenCalled();
  });
});
