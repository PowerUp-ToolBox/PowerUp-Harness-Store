/**
 * hello-term is installable and publishable: the Harness folder `pnpm build` writes to out/, and
 * the zip `pnpm run pack` makes of it, pass `validatePackage` and the `harness-manifest validate`
 * CLI with no problems and no warnings, and the bundled Entry runs with no node_modules around it.
 * The model round trip (install, launch in a pty, chat, /model, /quit, one Usage Record) is proven
 * through the Runtime in apps/desktop/test/launch/reference-harnesses.test.ts.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
    // Not one launch contract variable: started by hand, not by the Runtime.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(HARNESS_|OPENAI_|NODE_OPTIONS$|NODE_PATH$)/i.test(name),
      ),
    );
    const result = spawnSync(process.execPath, [join('dist', 'index.mjs')], {
      cwd: scratch,
      env,
      encoding: 'utf8',
      input: '',
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^Not running inside Harness Store: HARNESS_GATEWAY_URL, /);
    expect(result.stderr).toContain('"Install this folder locally"');
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

  it('is the same bytes every time', () => {
    const first = readFileSync(zip);
    expect(pack().status).toBe(0);
    expect(readFileSync(zip)).toEqual(first);
  });

  it('leaves out what the Publish flow leaves out', async () => {
    // A copy, so the Runtime's tests reading out/ meanwhile never see the strays.
    const scratch = mkdtempSync(join(tmpdir(), 'hello-term-pack-'));
    try {
      const folder = join(scratch, 'out');
      cpSync(out, folder, { recursive: true });
      const strays = ['.DS_Store', 'assets/Thumbs.db', 'dist/.index.mjs.swp', '.git/HEAD'];
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
