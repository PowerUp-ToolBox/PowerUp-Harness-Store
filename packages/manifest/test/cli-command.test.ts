/**
 * Ticket P0-01.4, "How to verify": the `harness-manifest` command itself, run the way a
 * Publisher's shell or CI runs it. The package is built first with the command `pnpm build` runs
 * (`tsc --build tsconfig.build.json`); then package.json#bin is spawned with Node against every
 * fixture and every hostile archive, its output read through real pipes.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_ERROR, EXIT_PROBLEMS, EXIT_VALID, USAGE } from '../src/node/cli.js';
import { fixtureNames, fixturesRoot, loadFixture, packageRoot } from './helpers.js';
import { optionFlags, runInProcess, shapeErrors } from './support/cli.js';
import type { CliRun } from './support/cli.js';
import { fixtureDir, folderEntries, writeHostileArchive, zipFolder } from './support/packages.js';
import { buildZip } from './support/zip-writer.js';

const names = fixtureNames();
const withRecipe = names.filter((name) => loadFixture(name).expected.archive !== undefined);

const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  bin?: Record<string, string>;
  files?: string[];
};
const command = join(packageRoot, packageJson.bin?.['harness-manifest'] ?? 'no-bin');

let scratch = '';
const zipOf = (name: string) => join(scratch, 'zips', `${name}.zip`);
const hostileOf = (name: string) => join(scratch, 'hostile', `${name}.zip`);

beforeAll(() => {
  // What `pnpm build` runs: the command runs the compiled dist/, as it does once installed.
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const build = spawnSync(process.execPath, [tsc, '--build', 'tsconfig.build.json'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);

  scratch = mkdtempSync(join(tmpdir(), 'manifest-cli-command-'));
  mkdirSync(join(scratch, 'zips'));
  mkdirSync(join(scratch, 'hostile'));
  for (const name of names) writeFileSync(zipOf(name), zipFolder(fixtureDir(name)));
  for (const name of withRecipe) writeHostileArchive(name, hostileOf(name));
}, 180_000);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface CommandRun extends CliRun {
  signal: NodeJS.Signals | null;
}

/** Runs `harness-manifest <args>` as its own process, with `node` as the shebang names it. */
function harnessManifest(
  args: readonly string[],
  options: {
    cwd?: string;
    script?: string;
    onStdout?: (child: ReturnType<typeof spawn>) => void;
  } = {},
): Promise<CommandRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [options.script ?? command, ...args], {
      cwd: options.cwd ?? packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      options.onStdout?.(child);
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (status, signal) => {
      resolve({
        status: status ?? -1,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

/** Runs `work` on every item, a few processes at a time. */
async function eachConcurrently<T, R>(
  items: readonly T[],
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, availableParallelism()) }, worker));
  return results;
}

describe('the harness-manifest command', () => {
  it('is package.json#bin, a checked-in Node script published with dist/', () => {
    expect(packageJson.bin).toEqual({ 'harness-manifest': './bin/harness-manifest.js' });
    expect(packageJson.files).toEqual(expect.arrayContaining(['bin', 'dist']));
    expect(readFileSync(command, 'utf8').split('\n')[0]).toBe('#!/usr/bin/env node');
    if (process.platform !== 'win32') expect(statSync(command).mode & 0o111).toBe(0o111);
  });

  it('says so when dist/ is not built yet, instead of failing with a stack trace', async () => {
    const unbuilt = join(scratch, 'unbuilt', 'bin');
    mkdirSync(unbuilt, { recursive: true });
    cpSync(command, join(unbuilt, 'harness-manifest.js'));
    const run = await harnessManifest(['validate', fixtureDir('valid-minimal-node')], {
      script: join(unbuilt, 'harness-manifest.js'),
    });
    expect(run).toMatchObject({ status: EXIT_ERROR, stdout: '' });
    expect(run.stderr).toContain('harness-manifest: the CLI is not built yet.');
    expect(run.stderr).not.toMatch(/\n\s+at /);
  });
});

describe('P0-01.4 How to verify, with the built command', () => {
  it('1. the exit code for every fixture says whether its expected.json lists problems, and the output is what main() prints', async () => {
    const runs = await eachConcurrently(names, async (name) => {
      const { options, problems } = loadFixture(name).expected;
      const args = ['validate', fixtureDir(name), ...optionFlags(options)];
      return {
        name,
        expectedStatus: problems.length > 0 ? EXIT_PROBLEMS : EXIT_VALID,
        human: await harnessManifest(args),
        zipped: await harnessManifest(['validate', zipOf(name), ...optionFlags(options)]),
        inProcess: await runInProcess(args),
      };
    });
    for (const { name, expectedStatus, human, zipped, inProcess } of runs) {
      expect({ name, status: human.status, signal: human.signal }).toEqual({
        name,
        status: expectedStatus,
        signal: null,
      });
      expect({ name, ...human }).toEqual({ name, ...inProcess, signal: null });
      expect({ name, ...zipped }).toEqual({ name, ...human });
    }
  });

  it('1. the exit code for every hostile archive says whether it has problems', async () => {
    const runs = await eachConcurrently(withRecipe, async (name) => {
      const { options, archive } = loadFixture(name).expected;
      const args = ['validate', hostileOf(name), ...optionFlags(options)];
      return {
        name,
        expectedStatus: (archive?.problems.length ?? 0) > 0 ? EXIT_PROBLEMS : EXIT_VALID,
        run: await harnessManifest(args),
        inProcess: await runInProcess(args),
      };
    });
    for (const { name, expectedStatus, run, inProcess } of runs) {
      expect({ name, status: run.status }).toEqual({ name, status: expectedStatus });
      expect({ name, ...run }).toEqual({ name, ...inProcess, signal: null });
    }
  });

  it('2. --json output piped into a JSON validator parses and round-trips as a ValidationResult', async () => {
    // A second process reads the pipe, parses it strictly and writes it back as JSON.
    const validator = [
      'let text = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { text += chunk; });',
      'process.stdin.on("end", () => { process.stdout.write(JSON.stringify(JSON.parse(text))); });',
    ].join('\n');
    const pipe = (args: readonly string[]) =>
      new Promise<{ status: number; parsed: string; stderr: string }>((resolve, reject) => {
        const cli = spawn(process.execPath, [command, ...args], {
          cwd: packageRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const parser = spawn(process.execPath, ['-e', validator], {
          stdio: ['pipe', 'pipe', 'inherit'],
        });
        cli.stdout.pipe(parser.stdin);
        let parsed = '';
        let stderr = '';
        parser.stdout.setEncoding('utf8').on('data', (chunk: string) => (parsed += chunk));
        cli.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        cli.on('error', reject);
        parser.on('error', reject);
        // The parser can close before the command does, so its status and stderr are awaited.
        const cliClosed = new Promise<number>((done) => {
          cli.on('close', (code) => {
            done(code ?? -1);
          });
        });
        parser.on('close', (code) => {
          if (code !== 0) reject(new Error(`the JSON validator exited with ${String(code)}`));
          else {
            void cliClosed.then((status) => {
              resolve({ status, parsed, stderr });
            });
          }
        });
      });

    const runs = await eachConcurrently(names, async (name) => {
      const { options } = loadFixture(name).expected;
      const args = ['validate', fixtureDir(name), '--json', ...optionFlags(options)];
      return { name, piped: await pipe(args), inProcess: await runInProcess(args) };
    });
    for (const { name, piped, inProcess } of runs) {
      const value = JSON.parse(piped.parsed) as unknown;
      expect({ name, errors: shapeErrors(value) }).toEqual({ name, errors: [] });
      expect({ name, json: piped.parsed }).toEqual({
        name,
        json: JSON.stringify(JSON.parse(inProcess.stdout)),
      });
      expect({ name, status: piped.status, stderr: piped.stderr }).toEqual({
        name,
        status: inProcess.status,
        stderr: '',
      });
    }
  });

  it('3. with no arguments, it prints the usage help rather than crashing', async () => {
    expect(await harnessManifest([])).toEqual({
      status: EXIT_ERROR,
      signal: null,
      stdout: '',
      stderr: USAGE,
    });
    expect(await harnessManifest(['--help'])).toEqual({
      status: EXIT_VALID,
      signal: null,
      stdout: USAGE,
      stderr: '',
    });
  });
});

describe('the command in a shell', () => {
  /** A zip of the minimal fixture plus `count` entries with `..` names: one problem each. */
  function zipWithProblems(count: number): string {
    const path = join(scratch, `problems-${String(count)}.zip`);
    const escapes = Array.from({ length: count }, (_, index) => ({
      name: `../escape-${String(index).padStart(5, '0')}-${'x'.repeat(40)}.txt`,
      data: 'x',
    }));
    writeFileSync(path, buildZip([...folderEntries(fixtureDir('valid-minimal-node')), ...escapes]));
    return path;
  }

  it('writes a large --json result through a pipe in full before it exits', async () => {
    const run = await harnessManifest(['validate', zipWithProblems(3000), '--json']);
    expect(run.status).toBe(EXIT_PROBLEMS);
    // Far more than a pipe holds (64 KB on Linux): exiting early would cut it off.
    expect(run.stdout.length).toBeGreaterThan(512 * 1024);
    const result = JSON.parse(run.stdout) as { problems: unknown[] };
    expect(result.problems).toHaveLength(3000);
  });

  it('exits quietly with its status when the reader closes the pipe early (| head)', async () => {
    const run = await harnessManifest(['validate', zipWithProblems(3001), '--json'], {
      onStdout: (child) => child.stdout?.destroy(),
    });
    expect(run).toMatchObject({ status: EXIT_PROBLEMS, signal: null, stderr: '' });
  });

  it('reads a relative path from the working directory, and a path starting with "-" after --', async () => {
    const relative = await harnessManifest(['validate', 'file_missing'], { cwd: fixturesRoot });
    expect(relative).toEqual(await harnessManifest(['validate', fixtureDir('file_missing')]));
    expect(relative.status).toBe(EXIT_PROBLEMS);

    cpSync(fixtureDir('valid-minimal-node'), join(scratch, '-package'), { recursive: true });
    const dashed = await harnessManifest(['validate', '--', '-package'], { cwd: scratch });
    expect(dashed).toMatchObject({ status: EXIT_VALID, stderr: '' });
    const misread = await harnessManifest(['validate', '-package'], { cwd: scratch });
    expect(misread).toMatchObject({ status: EXIT_ERROR, stdout: '' });
  });
});
