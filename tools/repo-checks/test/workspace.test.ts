import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  findWorkspacePackages,
  LAYOUT_GLOBS,
  readPackageJson,
  readText,
  repoRoot,
  ROOT_COMMANDS,
  runPnpm,
} from './repo.js';

const rootManifest = readPackageJson();
const workspaceYaml = readText('pnpm-workspace.yaml');
const workspaceConfig = parse(workspaceYaml) as { packages: string[]; engineStrict?: boolean };
const workspaceGlobs = workspaceConfig.packages;

describe('pnpm workspace', () => {
  it('pins pnpm through the packageManager field so corepack and CI use one version', () => {
    expect(rootManifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('refuses to install on a Node version outside engines.node', () => {
    expect(workspaceConfig.engineStrict).toBe(true);
  });

  it('matches packages by directory glob, so a new package needs no root edit', () => {
    expect(workspaceGlobs).toEqual(expect.arrayContaining(LAYOUT_GLOBS));
  });

  it('pnpm itself discovers exactly the packages found on disk', () => {
    const result = runPnpm(['list', '--recursive', '--depth', '-1', '--json'], repoRoot);
    expect(result.status, result.stderr).toBe(0);
    const listed = (JSON.parse(result.stdout) as { path: string }[])
      .map((pkg) => pkg.path)
      .filter((path) => path !== repoRoot.replace(/[\\/]$/, ''))
      .sort();
    const onDisk = findWorkspacePackages(workspaceGlobs)
      .map((pkg) => pkg.path)
      .sort();
    expect(listed).toEqual(onDisk);
  });

  it.each(ROOT_COMMANDS)('root `pnpm %s` fans out to every workspace package', (command) => {
    const script = rootManifest.scripts?.[command] ?? '';
    expect(script).toMatch(new RegExp(`^pnpm --recursive run ${command}(\\s|$)`));
    // Never hard-code a package list or filter in the root command.
    expect(script).not.toMatch(/--filter|-F\s/);
  });
});

/**
 * Builds a throwaway workspace from the repository's real root package.json and
 * pnpm-workspace.yaml, adds packages to it and runs the root commands there. This
 * proves the fan-out contract end to end without touching the real repository.
 */
describe('root command fan-out in a scratch workspace', () => {
  let scratch: string | undefined;

  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  const markerScript = (name: string): string =>
    `node -e "require('node:fs').writeFileSync('${name}.ran', '')"`;

  function createWorkspace(): string {
    scratch = mkdtempSync(join(tmpdir(), 'harness-store-fanout-'));
    const scripts = { ...rootManifest.scripts };
    // `lint` also runs Prettier over the repo; the scratch workspace has no
    // dependencies installed, so only the fan-out half is exercised here.
    scripts['format:check'] = 'node -e ""';
    writeFileSync(
      join(scratch, 'package.json'),
      JSON.stringify({ name: 'scratch-root', private: true, scripts }, null, 2),
    );
    writeFileSync(join(scratch, 'pnpm-workspace.yaml'), workspaceYaml);
    return scratch;
  }

  function addPackage(root: string, dir: string, scripts: Record<string, string>): string {
    const path = join(root, dir);
    mkdirSync(path, { recursive: true });
    const name = `@scratch/${dir.replaceAll('/', '-')}`;
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, private: true, scripts }));
    return path;
  }

  it.each(ROOT_COMMANDS)(
    'root `pnpm %s` runs the script in a newly added package under packages/, apps/ and examples/',
    (command) => {
      const root = createWorkspace();
      const added = ['packages/new-lib', 'apps/new-app', 'examples/new-harness'].map((dir) =>
        addPackage(root, dir, { [command]: markerScript(command) }),
      );
      // A package without the script is skipped rather than failing the run.
      addPackage(root, 'packages/no-scripts', {});

      const result = runPnpm([command], root);

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      for (const path of added) expect(existsSync(join(path, `${command}.ran`))).toBe(true);
    },
  );

  it('root `pnpm test` fails when any package test fails', () => {
    const root = createWorkspace();
    addPackage(root, 'packages/passing', { test: markerScript('test') });
    addPackage(root, 'apps/failing', { test: 'node -e "process.exit(3)"' });

    const result = runPnpm(['test'], root);

    expect(result.status).not.toBe(0);
  });
});
