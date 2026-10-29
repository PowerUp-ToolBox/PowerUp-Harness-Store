import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeProvider, type FakeProvider } from '@harness-store/gateway/testing/fake-provider';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnNodePty, type PtySpawner } from '../../src/main/runtime/pty.js';
import {
  endSmoke,
  runSmoke,
  showsPrompt,
  SMOKE_HARNESS_VARIABLE,
  SMOKE_PROVIDER_VARIABLE,
  smokeRequest,
  terminalText,
  type SmokeOptions,
} from '../../src/main/runtime/smoke.js';
import { removeFolder } from '../support/harness-processes.js';

/**
 * Ticket P0-13.3, the post-build smoke run (src/main/runtime/smoke.ts) under plain Node: the real
 * Runtime installs examples/hello-term/out, binds `default` to `qwen3:8b` on an `ollama`
 * Connection at the fake Provider, and runs one turn in a pty. A built app runs the same code
 * with its own executable as the Node runtime (apps/desktop/scripts/smoke.mjs); here the Node
 * runtime is this test's Node, and the failure cases break it on purpose, as a build missing its
 * Node runtime would be.
 */

const HELLO_TERM = join(import.meta.dirname, '../../../../examples/hello-term/out');

let root: string;
let fake: FakeProvider | undefined;
let lines: string[];

beforeAll(() => {
  if (!existsSync(join(HELLO_TERM, 'manifest.json'))) {
    throw new Error(
      'examples/hello-term/out/ is not built: run `pnpm build` at the repository root first.',
    );
  }
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-store-smoke-'));
  lines = [];
});
afterEach(async () => {
  await fake?.close();
  fake = undefined;
  removeFolder(root);
});

function smoke(overrides: Partial<SmokeOptions> = {}) {
  return runSmoke({
    harnessFolder: HELLO_TERM,
    providerUrl: fake?.url ?? '',
    dataDir: join(root, 'userData'),
    version: '1.0.0',
    log: (line) => lines.push(line),
    // This test's Node; ELECTRON_RUN_AS_NODE, which the default adds, means nothing to it.
    nodeCommand: { path: process.execPath, env: {} },
    ...overrides,
  });
}

const chatModels = () =>
  (fake?.requests ?? [])
    .filter((request) => request.path === '/v1/chat/completions')
    .map((request) => (request.body as { model: string }).model);

describe('smokeRequest', () => {
  it('is null without a Harness folder, so the app starts as usual', () => {
    expect(smokeRequest({})).toBeNull();
    expect(smokeRequest({ [SMOKE_HARNESS_VARIABLE]: '' })).toBeNull();
    expect(smokeRequest({ [SMOKE_PROVIDER_VARIABLE]: 'http://127.0.0.1:1' })).toBeNull();
  });

  it('takes a loopback http:// Provider URL', () => {
    for (const url of ['http://127.0.0.1:4000', 'http://localhost:4000/', 'http://[::1]:4000']) {
      expect(
        smokeRequest({ [SMOKE_HARNESS_VARIABLE]: '/h', [SMOKE_PROVIDER_VARIABLE]: url }),
      ).toEqual({ ok: true, request: { harnessFolder: '/h', providerUrl: url } });
    }
  });

  it('refuses a missing, malformed or non-loopback Provider URL', () => {
    for (const url of [
      undefined,
      'not a url',
      'https://127.0.0.1:4000',
      'http://api.openai.com',
      'http://10.0.0.2:11434',
    ]) {
      expect(
        smokeRequest({ [SMOKE_HARNESS_VARIABLE]: '/h', [SMOKE_PROVIDER_VARIABLE]: url }),
      ).toMatchObject({
        ok: false,
        error: expect.stringContaining(SMOKE_PROVIDER_VARIABLE) as string,
      });
    }
  });
});

/**
 * node-pty, with what the Harness prints rendered the way Windows' ConPTY may render it: every
 * space as a cursor forward, the blank after a prompt at the end of a row as an erase, each chunk
 * between hiding and showing the cursor.
 */
const conptyLike: PtySpawner = (options) => {
  const pty = spawnNodePty(options);
  return {
    get pid() {
      return pty.pid;
    },
    onData(listener) {
      pty.onData((data) => {
        listener(`\x1b[?25l${data.replace(/> $/, '>\x1b[K').replace(/ /g, '\x1b[1C')}\x1b[?25h`);
      });
    },
    onExit: (listener) => {
      pty.onExit(listener);
    },
    write: (data) => {
      pty.write(data);
    },
    resize: (cols, rows) => {
      pty.resize(cols, rows);
    },
  };
};

describe('terminalText', () => {
  it('drops control sequences and carriage returns, and turns a cursor forward into spaces', () => {
    expect(
      terminalText(
        '\x1b]0;Hello Term\x07\x1b[?25lHello\x1b[1CTerm\x1b[3C0.1.0\x1b[K\r\n' +
          '\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\\x1b[>4;1m\x1b=\x1b[2;1H>\x1b[98X\x1b[?25h',
      ),
    ).toBe('Hello Term   0.1.0\nlink>');
  });

  it('sees the prompt with or without the space after it', () => {
    expect(showsPrompt('Hello Term 0.1.0\nhint\n\n> ')).toBe(true);
    expect(showsPrompt(terminalText('hint\r\n\r\n>\x1b[K\x1b[3;2H'))).toBe(true);
    expect(showsPrompt('Hello Term 0.1.0\n')).toBe(false);
    expect(showsPrompt('> smoke 1\nsmoke 1\n')).toBe(false);
  });
});

// Each run stops hello-term with the shutdown sequence. On Windows the polite step of it
// (`taskkill` without /F) cannot end a console process in a pty, so the run takes the whole
// STOP_GRACE_MS (5 s) on top of its own time, past Vitest's default 5 s.
describe('runSmoke', { timeout: 20_000 }, () => {
  it('installs hello-term, gets one echoed answer through the Model Gateway and one Usage Record', async () => {
    fake = await startFakeProvider({ aliases: { 'qwen3:8b': 'fake/echo' } });
    await expect(smoke()).resolves.toBe(true);
    expect(chatModels()).toEqual(['qwen3:8b']);
    expect(lines.at(-1)).toMatch(/PASSED$/);
    expect(lines.join('\n')).toMatch(
      /Answer received \("smoke [0-9a-f-]+"\) and one Usage Record on ollama\/qwen3:8b/,
    );
  });

  it('passes when the pty renders the screen as ConPTY does, not byte for byte', async () => {
    fake = await startFakeProvider({ aliases: { 'qwen3:8b': 'fake/echo' } });
    await expect(smoke({ spawnPty: conptyLike })).resolves.toBe(true);
    expect(chatModels()).toEqual(['qwen3:8b']);
  });

  it('fails when the Node runtime is missing', async () => {
    fake = await startFakeProvider({ aliases: { 'qwen3:8b': 'fake/echo' } });
    const missing = join(root, process.platform === 'win32' ? 'node.exe' : 'node');
    await expect(smoke({ nodeCommand: { path: missing, env: {} } })).resolves.toBe(false);
    expect(chatModels()).toEqual([]);
    expect(lines.join('\n')).toMatch(/FAILED: (?:Launching failed|The Harness ended)/);
  });

  it('fails when the Node runtime is broken', async () => {
    fake = await startFakeProvider({ aliases: { 'qwen3:8b': 'fake/echo' } });
    // Node fails before running the Entry: a preload that is not there (relative to the Harness's
    // working directory, its Data Directory, so no path needs quoting in NODE_OPTIONS).
    const broken = { NODE_OPTIONS: '--require ./missing-runtime-part.cjs' };
    await expect(smoke({ nodeCommand: { path: process.execPath, env: broken } })).resolves.toBe(
      false,
    );
    expect(lines.join('\n')).toMatch(
      /FAILED: The Harness ended (?:stopped|failed).* before its prompt/,
    );
    // Its terminal output says why.
    expect(lines.join('\n')).toContain('missing-runtime-part.cjs');
  });

  it('fails when no answer comes within its time limit', async () => {
    fake = await startFakeProvider({ aliases: { 'qwen3:8b': 'fake/stall' } });
    await expect(smoke({ timeoutMs: 3000 })).resolves.toBe(false);
    expect(lines.join('\n')).toContain('FAILED: Timed out after 3 s');
  });

  it('fails when the model is not the one the Provider serves', async () => {
    fake = await startFakeProvider({ aliases: { 'llama3:8b': 'fake/echo' } });
    await expect(smoke({ timeoutMs: 3000 })).resolves.toBe(false);
    expect(lines.join('\n')).toContain('FAILED: Timed out after 3 s');
  });
});

describe('endSmoke', () => {
  const end = (removeDir?: (dir: string) => void) => {
    const exit = vi.fn<(code: number) => void>();
    const logError = vi.fn<(line: string, error: unknown) => void>();
    const dataDir = join(root, 'userData');
    return { dataDir, exit, logError, ...(removeDir ? { removeDir } : {}) };
  };

  it('deletes the temporary profile, then exits 0 when the run passed and 1 when it failed', () => {
    for (const [passed, code] of [
      [true, 0],
      [false, 1],
    ] as const) {
      const options = end();
      mkdirSync(join(options.dataDir, 'logs'), { recursive: true });
      endSmoke(passed, options);
      expect(existsSync(options.dataDir)).toBe(false);
      expect(options.exit.mock.calls).toEqual([[code]]);
      expect(options.logError).not.toHaveBeenCalled();
    }
  });

  it('still exits with the result when the profile cannot be deleted, logging why', () => {
    // As on Windows, while Chromium's own processes still hold files in the profile.
    const busy = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    for (const [passed, code] of [
      [true, 0],
      [false, 1],
    ] as const) {
      const options = end(() => {
        throw busy;
      });
      expect(() => {
        endSmoke(passed, options);
      }).not.toThrow();
      expect(options.exit.mock.calls).toEqual([[code]]);
      expect(options.logError).toHaveBeenCalledWith(expect.stringContaining(options.dataDir), busy);
    }
  });
});
