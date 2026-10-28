import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SafeStorage } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConnectionStore } from '../../src/main/runtime/connection-store.js';
import {
  createConnectionsService,
  type ConnectionTester,
  type ConnectionsService,
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
let service: ConnectionsService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-store-connections-'));
  db = openDatabase(join(dir, 'harness-store.sqlite'));
  cipher = createFakeCipher();
  tester = vi.fn<ConnectionTester>(() => Promise.resolve({ ok: true }));
  service = createConnectionsService({
    store: createConnectionStore(db),
    cipher,
    test: tester,
  });
});
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
      lastTestedAt: null,
      lastTestOk: null,
      lastTestError: null,
      models: [],
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
        last_tested_at: null,
        last_test_ok: null,
        last_test_error: null,
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
    tester.mockResolvedValueOnce({ ok: false, detail: 'Incorrect API key provided.' });
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
    tester.mockResolvedValueOnce({ ok: false, detail: 'invalid x-api-key' });
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
