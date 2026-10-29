/**
 * The SDK is a pure-Node library a third-party Harness can depend on: no Electron, no workspace
 * package at runtime, only `openai` and Node built-ins.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

describe('@harness-store/sdk package', () => {
  it('depends at runtime on openai only: no electron, no workspace package', () => {
    expect(manifest.dependencies).toEqual({ openai: expect.any(String) as string });
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('imports nothing but openai and Node built-ins from its sources', () => {
    const sources = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' }).filter(
      (file) => file.endsWith('.ts'),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = readFileSync(join(root, 'src', file), 'utf8');
      for (const [, specifier] of text.matchAll(/\bfrom '([^']+)'/g)) {
        expect(specifier, `${file} imports ${String(specifier)}`).toMatch(
          /^(openai|node:[a-z_/]+|\.\/[\w-]+\.js)$/,
        );
      }
    }
  });
});
