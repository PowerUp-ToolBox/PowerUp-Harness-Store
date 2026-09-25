import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { validateManifest } from '../src/index.js';
import type {
  Entry,
  HarnessRuntime,
  Manifest,
  ModelSlot,
  Platform,
  Problem,
  ValidationResult,
} from '../src/index.js';
import { packageRoot } from './helpers.js';

const generatedFile = join(packageRoot, 'src', 'manifest.generated.ts');

function runGenerator(...args: string[]) {
  return spawnSync(process.execPath, ['scripts/generate-types.mjs', ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
}

describe('src/manifest.generated.ts', () => {
  it('matches the schema (the drift check `pnpm typecheck` also runs)', () => {
    const result = runGenerator('--check');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('fails the drift check when the checked-in file no longer matches the schema', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'manifest-types-'));
    try {
      const stale = join(scratch, 'manifest.generated.ts');
      writeFileSync(stale, readFileSync(generatedFile, 'utf8').replace("'fun'", "'games'"));
      const result = runGenerator('--check', '--out', stale);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('out of date');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('is checked in, not git-ignored', () => {
    const ignored = spawnSync('git', ['check-ignore', '--quiet', '--no-index', generatedFile], {
      cwd: packageRoot,
    });
    expect(ignored.status).toBe(1);
  });

  it('says it is generated and how to regenerate it', () => {
    expect(readFileSync(generatedFile, 'utf8')).toMatch(
      /^\/\*\*\n \* GENERATED FILE - DO NOT EDIT\.[\s\S]*pnpm --filter @harness-store\/manifest generate/,
    );
  });
});

describe('the Manifest type', () => {
  it('accepts the section 8 example as written', () => {
    const example = {
      manifestVersion: 1,
      id: 'alice/hello-web',
      version: '0.1.0',
      name: 'Hello Web',
      summary: 'A minimal web-UI harness that says hello with your model.',
      tags: ['fun'],
      license: 'MIT',
      platforms: ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'],
      runtime: { kind: 'node', node: '22' },
      entry: 'dist/index.js',
      ui: { kind: 'web' },
      workspace: 'none',
      models: { slots: { default: { requirements: { tools: false } } } },
      permissions: { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } },
    } satisfies Manifest;
    expect(validateManifest(example).ok).toBe(true);
  });

  it('is what a successful result carries, and narrows on ok', () => {
    const result = validateManifest('{}');
    expectTypeOf(result).toEqualTypeOf<ValidationResult>();
    if (result.ok) {
      expectTypeOf(result.manifest).toEqualTypeOf<Manifest>();
      expectTypeOf(result).not.toHaveProperty('problems');
    } else {
      expectTypeOf(result.problems).toEqualTypeOf<Problem[]>();
      expectTypeOf(result).not.toHaveProperty('manifest');
    }
    expectTypeOf(result.warnings).toEqualTypeOf<Problem[]>();
  });

  it('models the spec precisely', () => {
    expectTypeOf<Manifest['manifestVersion']>().toEqualTypeOf<1>();
    expectTypeOf<Manifest['platforms']>().toEqualTypeOf<Platform[]>();
    expectTypeOf<Platform>().toEqualTypeOf<
      'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'win32-arm64' | 'linux-x64' | 'linux-arm64'
    >();
    expectTypeOf<HarnessRuntime['kind']>().toEqualTypeOf<'node' | 'binary'>();
    expectTypeOf<Manifest['ui']['kind']>().toEqualTypeOf<'web' | 'terminal'>();
    expectTypeOf<Manifest['channel']>().toEqualTypeOf<'stable' | undefined>();
    expectTypeOf<Manifest['models']['slots']['default']>().toEqualTypeOf<ModelSlot>();
    expectTypeOf<Manifest['permissions']['network']['any']>().toEqualTypeOf<true | undefined>();
    expectTypeOf<Extract<Entry, object>>().toHaveProperty('win32-x64');
    // No index signature: top-level x- keys are not part of the validated Manifest.
    expectTypeOf<Manifest>().not.toHaveProperty('x-internal');
  });
});
