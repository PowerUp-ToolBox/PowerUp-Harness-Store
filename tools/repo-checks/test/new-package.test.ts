import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readPackageJson, REPO_ROOT_ENV, repoPath, repoRoot } from './repo.js';

/**
 * Regression tests for the "new package needs no root edit" contract (P0-01.1).
 *
 * workspace.test.ts proves that the root commands reach a new package. These tests
 * prove the other half: that this package's own layout checks, which the root
 * `pnpm test` also runs, stay green when the workspace grows. They copy the checkout
 * to a scratch directory, change it, and run the real test/layout.test.ts against the
 * copy through the REPO_CHECKS_ROOT override.
 */

const checksDir = fileURLToPath(new URL('../', import.meta.url));
const vitestCli = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);
const rootEngines = readPackageJson().engines?.node ?? '';

/** Tracked and new (not ignored) files of the checkout, as git sees them. */
function checkoutFiles(): string[] {
  const result = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split('\0').filter(Boolean);
}

let scratch: string | undefined;

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** Copies the checkout (without node_modules or build output) to a scratch directory. */
function copyCheckout(): string {
  scratch = mkdtempSync(join(tmpdir(), 'harness-store-layout-'));
  for (const file of checkoutFiles()) {
    const source = repoPath(file);
    // Skip files deleted in the working tree but still in the index.
    if (!lstatSync(source, { throwIfNoEntry: false })?.isFile()) continue;
    mkdirSync(dirname(join(scratch, file)), { recursive: true });
    copyFileSync(source, join(scratch, file));
  }
  return scratch;
}

/** Adds a package that follows the per-package conventions, as a contributor would. */
function addPackage(root: string, dir: string): void {
  const path = join(root, dir);
  mkdirSync(join(path, 'test'), { recursive: true });
  const manifest = {
    name: `@harness-store/${basename(dir)}`,
    version: '0.0.0',
    private: true,
    type: 'module',
    engines: { node: rootEngines },
    scripts: { test: 'vitest run' },
  };
  writeFileSync(join(path, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(path, 'README.md'), `# ${manifest.name}\n\nA package added after P0.\n`);
  writeFileSync(
    join(path, 'test', 'smoke.test.ts'),
    "import { expect, it } from 'vitest';\n\nit('runs', () => {\n  expect(true).toBe(true);\n});\n",
  );
}

/** Runs the real layout checks against `root` in a nested Vitest process. */
function runLayoutChecks(root: string): SpawnSyncReturns<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(VITEST|FORCE_COLOR$)/.test(key)),
  );
  return spawnSync(
    process.execPath,
    [vitestCli, 'run', 'test/layout.test.ts', '--reporter=verbose', '--no-color'],
    {
      cwd: checksDir,
      encoding: 'utf8',
      env: { ...env, [REPO_ROOT_ENV]: root, NO_COLOR: '1' },
      timeout: 120_000,
    },
  );
}

describe('layout checks on a growing workspace', () => {
  it('stay green when packages are added under packages/, apps/ and examples/', () => {
    const root = copyCheckout();
    for (const dir of ['packages/new-lib', 'apps/new-app', 'examples/new-harness']) {
      addPackage(root, dir);
    }

    const result = runLayoutChecks(root);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    // The new packages were discovered and held to the per-package conventions.
    expect(output).toContain('packages/new-lib defines a test script');
    expect(output).toContain('apps/new-app pins the same Node LTS range');
  }, 120_000);

  it('ignore stray files and leftover directories next to the packages', () => {
    const root = copyCheckout();
    // Finder writes .DS_Store files; a branch switch leaves ignored node_modules behind.
    for (const parent of ['apps', 'packages', 'examples']) {
      writeFileSync(join(root, parent, '.DS_Store'), '');
    }
    mkdirSync(join(root, 'packages', 'left-behind', 'node_modules'), { recursive: true });

    const result = runLayoutChecks(root);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 120_000);

  it('still fail when a P0 package directory is missing', () => {
    const root = copyCheckout();
    rmSync(join(root, 'packages', 'manifest'), { recursive: true, force: true });

    const result = runLayoutChecks(root);
    const output = `${result.stdout}\n${result.stderr}`;

    // Also proves the nested run really checked the scratch copy, not this checkout.
    expect(result.status, output).not.toBe(0);
    expect(output).toMatch(/FAIL .*packages\/ contains every P0 package directory/);
  }, 120_000);
});
