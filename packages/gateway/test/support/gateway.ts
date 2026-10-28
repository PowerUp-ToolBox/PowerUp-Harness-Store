/** Starting a Model Gateway in-process for a test, with in-memory callbacks. */
import { request as httpRequest } from 'node:http';
import { validateManifest } from '@harness-store/manifest';
import type { Manifest, ModelSlot } from '@harness-store/manifest';
import { createGateway } from '../../src/index.js';
import type { Gateway, GatewayOptions, GatewayTokenClaims } from '../../src/index.js';

/** A valid Manifest for `alice/hello` declaring `slots`. */
export function manifestWith(slots: Record<string, ModelSlot>): Manifest {
  const result = validateManifest({
    manifestVersion: 1,
    id: 'alice/hello',
    version: '1.2.3',
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

/** Callbacks for the parts a test does not exercise: they fail loudly if reached. */
export function baseOptions(overrides: Partial<GatewayOptions> = {}): GatewayOptions {
  const unexpected = (name: string) => () => Promise.reject(new Error(`${name} was not expected`));
  return {
    resolveBinding: unexpected('resolveBinding'),
    getConnection: unexpected('getConnection'),
    getManifest: () => Promise.resolve(manifestWith({ default: {} })),
    onUsage: () => Promise.resolve(),
    // Keep expected internal errors out of the test output; tests that care pass their own.
    logger: { debug: () => undefined, error: () => undefined },
    ...overrides,
  };
}

export interface TestGateway {
  gateway: Gateway;
  port: number;
  /** `HARNESS_GATEWAY_URL`: `http://127.0.0.1:<port>/v1`. */
  url: string;
}

export async function startGateway(overrides: Partial<GatewayOptions> = {}): Promise<TestGateway> {
  const gateway = createGateway(baseOptions(overrides));
  const { port, url } = await gateway.listen();
  return { gateway, port, url };
}

export const claims = (
  overrides: Partial<Omit<GatewayTokenClaims, 'issuedAt'>> = {},
): Omit<GatewayTokenClaims, 'issuedAt'> => ({
  harnessId: 'alice/hello',
  harnessVersion: '1.2.3',
  launchId: 'launch-1',
  locale: 'en',
  ...overrides,
});

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/**
 * A request through node:http, which (unlike fetch) sends the `Host` header it is given, so a
 * test can forge one. `noHost` sends no `Host` header at all.
 */
export function rawRequest(
  port: number,
  {
    method = 'GET',
    path = '/v1/harness/context',
    headers = {},
    noHost = false,
  }: { method?: string; path?: string; headers?: Record<string, string>; noHost?: boolean } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers,
        setHost: !noHost,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}
