/**
 * Ticket P0-01.2, "How to verify" step 4 and acceptance criterion 8: the package's main entry
 * bundles for a browser target (the Electron renderer) and runs without any Node-only global.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { build } from 'vite';
import type { Plugin, Rolldown } from 'vite';
import { beforeAll, describe, expect, it } from 'vitest';
import { findings, fixtureNames, loadFixture, packageRoot } from './helpers.js';
import type { FixtureExpectation } from './helpers.js';

/** Fails the build on any Node built-in instead of letting Vite stub it for the browser. */
function forbidNodeBuiltins(): Plugin {
  const builtins = new Set(builtinModules);
  return {
    name: 'forbid-node-builtins',
    enforce: 'pre',
    resolveId(source) {
      if (
        source.startsWith('node:') ||
        builtins.has(source) ||
        builtins.has(source.split('/')[0] ?? '')
      ) {
        this.error(`The browser bundle imports the Node built-in "${source}"`);
      }
      return null;
    },
  };
}

/** A browser build of `entry` as one IIFE script, the way a renderer bundler would see it. */
function bundleForBrowser(entry: string) {
  return build({
    root: packageRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [forbidNodeBuiltins()],
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      lib: { entry, formats: ['iife'], name: 'HarnessManifest' },
    },
  }) as Promise<Rolldown.RolldownOutput | Rolldown.RolldownOutput[]>;
}

let code = '';

beforeAll(async () => {
  const output = await bundleForBrowser('src/index.ts');
  const chunks = [output]
    .flat()
    .flatMap((result) => result.output)
    .filter((item): item is Rolldown.OutputChunk => item.type === 'chunk');
  expect(chunks).toHaveLength(1);
  code = chunks[0]?.code ?? '';
});

interface BundledPackage {
  validateManifest: (input: unknown, options?: unknown) => unknown;
  PROBLEM_CODES: Record<string, string>;
}

/**
 * Runs the bundle in a fresh V8 context holding only ECMAScript built-ins plus the two web
 * platform globals the package uses (TextDecoder for byte input, URL inside the JSON Schema
 * library), both of which browsers, Electron's renderer and Deno provide. No process, Buffer,
 * require, module or globalThis.fetch exists there.
 */
function loadInSandbox(): BundledPackage {
  const sandbox = createContext({ TextDecoder, URL });
  runInContext(code, sandbox, { filename: 'harness-manifest.iife.js' });
  const exported = (sandbox as { HarnessManifest?: BundledPackage }).HarnessManifest;
  if (!exported) throw new Error('The bundle did not define HarnessManifest');
  return exported;
}

describe('browser bundle of @harness-store/manifest', () => {
  it('builds for the browser without any Node built-in', () => {
    expect(code.length).toBeGreaterThan(1000);
  });

  it('would fail to build if the entry point imported a Node built-in (the guard works)', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'manifest-bundle-'));
    try {
      const entry = join(scratch, 'uses-fs.ts');
      writeFileSync(
        entry,
        "import { readFileSync } from 'node:fs';\nexport const read = readFileSync;\n",
      );
      await expect(bundleForBrowser(entry)).rejects.toThrow(/Node built-in "node:fs"/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('contains no eval or new Function, so it runs under a strict Content Security Policy', () => {
    expect(code).not.toMatch(/\beval\s*\(/);
    expect(code).not.toMatch(/\bnew\s+Function\s*\(/);
    expect(code).not.toMatch(/\bFunction\s*\(\s*["'`]/);
  });

  it.each(fixtureNames())(
    'validates fixtures/%s in a sandbox without Node globals exactly as in Node',
    (name) => {
      const { validateManifest } = loadInSandbox();
      const { manifestText, expected } = loadFixture(name);
      // Results cross the realm boundary as JSON.
      const result = JSON.parse(
        JSON.stringify(validateManifest(manifestText, expected.options)),
      ) as {
        ok: boolean;
        problems?: FixtureExpectation['problems'];
        warnings: FixtureExpectation['warnings'];
      };
      expect(result.ok).toBe(expected.problems.length === 0);
      expect(findings(result.problems ?? [])).toEqual(findings(expected.problems));
      expect(findings(result.warnings)).toEqual(findings(expected.warnings));
    },
  );

  it('accepts UTF-8 bytes in the sandbox too', () => {
    const { validateManifest } = loadInSandbox();
    const bytes = new TextEncoder().encode(loadFixture('valid-minimal-node').manifestText);
    expect((validateManifest(bytes) as { ok: boolean }).ok).toBe(true);
  });
});
