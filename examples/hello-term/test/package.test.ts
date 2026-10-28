/**
 * hello-term is installable and publishable: the Harness folder `pnpm build` writes to out/, and
 * the zip `pnpm run pack` makes of it, pass `validatePackage` and the `harness-manifest validate`
 * CLI with no problems and no warnings, and the bundled Entry runs with no node_modules around it,
 * answering every line of piped stdin before it quits. The model round trip (install, launch in a pty, chat, /model, /quit, one Usage Record) is proven
 * through the Runtime in apps/desktop/test/launch/reference-harnesses.test.ts.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { validatePackage } from '@harness-store/manifest';
import { DirectorySource, openArchiveFile } from '@harness-store/manifest/node';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const out = join(root, 'out');
const zip = join(root, 'dist', 'hello-term-0.1.0.zip');
const cli = join(root, 'node_modules', '@harness-store', 'manifest', 'bin', 'harness-manifest.js');

/** Every regular file under `dir`, as sorted `/`-separated paths. */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

/** Runs the pack script: on out/ into dist/, or with `args` (`<folder> [<output directory>]`). */
function pack(...args: string[]) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'pack.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

/** The environment of a process started by hand: not one launch contract variable. */
function handEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(HARNESS_|OPENAI_|NODE_OPTIONS$|NODE_PATH$)/i.test(name),
    ),
  );
}

function validateWithCli(path: string) {
  return spawnSync(process.execPath, [cli, 'validate', path], { encoding: 'utf8' });
}

beforeAll(() => {
  if (!existsSync(join(out, 'manifest.json'))) {
    throw new Error('examples/hello-term/out/ is not built: run `pnpm build` first.');
  }
  const packed = pack();
  if (packed.status !== 0) throw new Error(`pack failed: ${packed.stderr}`);
});

describe('the Harness folder out/', () => {
  it('holds exactly the Manifest, the README, the assets and the bundled Entry', () => {
    expect(listFiles(out)).toEqual([
      'README.md',
      'assets/icon.png',
      'assets/screenshot-1.png',
      'dist/index.mjs',
      'manifest.json',
    ]);
    for (const file of ['manifest.json', 'README.md', 'assets/icon.png']) {
      expect(readFileSync(join(out, file)), file).toEqual(readFileSync(join(root, file)));
    }
  });

  it('passes validatePackage with no problems and no warnings', async () => {
    const result = await validatePackage(await DirectorySource.open(out));
    expect(result).toMatchObject({ ok: true, warnings: [] });
    if (!result.ok) return;
    expect(result.manifest).toMatchObject({
      id: 'harness-store/hello-term',
      entry: 'dist/index.mjs',
      ui: { kind: 'terminal' },
      workspace: 'optional',
      models: { slots: { default: { requirements: { tools: false } } } },
      permissions: { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } },
    });
    // The package's version is the Harness Version, so the two never drift apart.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    expect(result.manifest.version).toBe(pkg.version);
  });

  it('passes `harness-manifest validate`', () => {
    const result = validateWithCli(out);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toBe(
      'The Harness Package harness-store/hello-term 0.1.0 is valid: no problems, no warnings.\n',
    );
  });

  it('bundles everything its Entry imports but Node built-ins', () => {
    const entry = readFileSync(join(out, 'dist', 'index.mjs'), 'utf8');
    const specifiers = [
      ...entry.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm),
      ...entry.matchAll(/\b(?:import|require)\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map(([, specifier]) => specifier);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) expect(specifier).toMatch(/^node:/);
  });
});

describe('the bundled Entry, copied outside the repository', () => {
  let scratch: string | undefined;
  afterEach(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it('runs without node_modules; outside Harness Store it says how to install it, exit 1', () => {
    scratch = mkdtempSync(join(tmpdir(), 'hello-term-'));
    cpSync(out, scratch, { recursive: true });
    const result = spawnSync(process.execPath, [join('dist', 'index.mjs')], {
      cwd: scratch,
      env: handEnvironment(),
      encoding: 'utf8',
      input: '',
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^Not running inside Harness Store: HARNESS_GATEWAY_URL, /);
    expect(result.stderr).toContain('"Install this folder locally"');
  });

  it('answers every line of piped stdin, then ends like /quit, exit 0', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'hello-term-'));
    cpSync(out, scratch, { recursive: true });
    // A stand-in for the Model Gateway: it streams `echo:<last message>` a little later, so stdin
    // has ended (and readline closed) while the first answer is still on its way.
    const conversations: string[][] = [];
    const gateway = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        const { messages } = JSON.parse(body) as { messages: { content: string }[] };
        conversations.push(messages.map((message) => message.content));
        const chunk = {
          choices: [{ index: 0, delta: { content: `echo:${messages.at(-1)?.content ?? ''}` } }],
        };
        setTimeout(() => {
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
        }, 100);
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = gateway.address() as AddressInfo;
      const child = spawn(process.execPath, [join('dist', 'index.mjs')], {
        cwd: scratch,
        env: {
          ...handEnvironment(),
          HARNESS_GATEWAY_URL: `http://127.0.0.1:${String(port)}/v1`,
          HARNESS_GATEWAY_TOKEN: 'hgt_test',
          HARNESS_ID: 'harness-store/hello-term',
          HARNESS_VERSION: '0.1.0',
          HARNESS_DATA_DIR: scratch,
          HARNESS_LOCALE: 'en',
          HARNESS_PLATFORM: `${process.platform}-${process.arch}`,
        },
      });
      let stdout = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stdin.end('first\nsecond\n\nthird\n');
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      expect(code, stdout).toBe(0);
      expect(conversations).toEqual([
        ['first'],
        ['first', 'echo:first', 'second'],
        ['first', 'echo:first', 'second', 'echo:second', 'third'],
      ]);
      const answers = stdout.split('\n').filter((line) => line.includes('echo:'));
      expect(answers.map((line) => line.replace(/^(> )+/, ''))).toEqual([
        'echo:first',
        'echo:second',
        'echo:third',
      ]);
      expect(stdout.endsWith('Bye.\n')).toBe(true);
    } finally {
      await new Promise((resolve) => gateway.close(resolve));
    }
  });
});

describe('the packed zip', () => {
  it('holds the files of out/ at the archive root', async () => {
    const source = await openArchiveFile(zip);
    expect([...source.listFiles()].sort()).toEqual(listFiles(out));
  });

  it('passes validatePackage with no problems and no warnings', async () => {
    const result = await validatePackage(await openArchiveFile(zip));
    expect(result).toMatchObject({ ok: true, warnings: [] });
  });

  it('passes `harness-manifest validate`', () => {
    const result = validateWithCli(zip);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toBe(
      'The Harness Package harness-store/hello-term 0.1.0 is valid: no problems, no warnings.\n',
    );
  });

  it('stamps every entry 1980-01-01 00:00, never the time it was packed', () => {
    // Walks the central directory from the end-of-central-directory record (no comment, so it is
    // the last 22 bytes) and reads the DOS time and date words of each entry and of its local
    // header: 00:00 is 0, 1980-01-01 is ((1980 - 1980) << 9) | (1 << 5) | 1 = 0x0021.
    const bytes = readFileSync(zip);
    const end = bytes.length - 22;
    expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
    const count = bytes.readUInt16LE(end + 10);
    expect(count).toBe(listFiles(out).length);
    let at = bytes.readUInt32LE(end + 16);
    for (let entry = 0; entry < count; entry++) {
      expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
      const local = bytes.readUInt32LE(at + 42);
      expect(bytes.readUInt32LE(local)).toBe(0x04034b50);
      expect([bytes.readUInt16LE(at + 12), bytes.readUInt16LE(at + 14)]).toEqual([0, 0x0021]);
      expect([bytes.readUInt16LE(local + 10), bytes.readUInt16LE(local + 12)]).toEqual([0, 0x0021]);
      at +=
        46 +
        bytes.readUInt16LE(at + 28) +
        bytes.readUInt16LE(at + 30) +
        bytes.readUInt16LE(at + 32);
    }
  });

  it('is the same bytes every time, whatever the modification times of its files', () => {
    // A copy whose files were touched: the zip must not depend on their times.
    const scratch = mkdtempSync(join(tmpdir(), 'hello-term-pack-'));
    try {
      const folder = join(scratch, 'out');
      cpSync(out, folder, { recursive: true });
      const touched = new Date(2001, 8, 9, 10, 11, 13);
      for (const file of listFiles(folder)) utimesSync(join(folder, file), touched, touched);
      expect(pack(folder, scratch).status).toBe(0);
      expect(readFileSync(join(scratch, 'hello-term-0.1.0.zip'))).toEqual(readFileSync(zip));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('leaves out what the Publish flow leaves out', async () => {
    // A copy, so the Runtime's tests reading out/ meanwhile never see the strays.
    const scratch = mkdtempSync(join(tmpdir(), 'hello-term-pack-'));
    try {
      const folder = join(scratch, 'out');
      cpSync(out, folder, { recursive: true });
      const strays = [
        '.DS_Store',
        'assets/Thumbs.db',
        'dist/.index.mjs.swp',
        '.git/HEAD',
        'node_modules/.cache/x',
        'dist/node_modules/.cache/y',
      ];
      for (const stray of strays) {
        mkdirSync(dirname(join(folder, stray)), { recursive: true });
        writeFileSync(join(folder, stray), 'stray');
      }
      expect(pack(folder, scratch).status).toBe(0);
      const source = await openArchiveFile(join(scratch, 'hello-term-0.1.0.zip'));
      expect([...source.listFiles()].sort()).toEqual(listFiles(out));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
