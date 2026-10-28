import { validateManifest, type Manifest, type ModelSlot } from '@harness-store/manifest';

/**
 * A valid Manifest for `acme/hello` declaring `slots`: what the Model Gateway's `getManifest`
 * answers in tests until Harnesses can be installed (P0-05).
 */
export function manifestWith(slots: Record<string, ModelSlot>): Manifest {
  const result = validateManifest({
    manifestVersion: 1,
    id: 'acme/hello',
    version: '1.0.0',
    name: 'Hello',
    summary: 'A test Harness.',
    license: 'MIT',
    platforms: ['darwin-arm64', 'linux-x64', 'win32-x64'],
    runtime: { kind: 'node', node: '22' },
    entry: 'dist/index.js',
    ui: { kind: 'web' },
    workspace: 'optional',
    models: { slots },
    permissions: { filesystem: { scope: 'none' }, shell: false, network: { domains: [] } },
  });
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.manifest;
}
