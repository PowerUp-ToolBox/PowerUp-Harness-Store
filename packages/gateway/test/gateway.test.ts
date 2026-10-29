/**
 * The Model Gateway server through its HTTP seam: loopback binding, the `Host` check, Gateway
 * Token authentication and revocation, routing and `GET /v1/harness/context`. Driven with plain
 * fetch (and node:http where a `Host` header must be forged).
 */
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGateway, createInMemoryTokenVerifier } from '../src/index.js';
import type {
  Gateway,
  GatewayOptions,
  GatewayTokenClaims,
  Logger,
  TokenVerifier,
} from '../src/index.js';
import { baseOptions, claims, manifestWith, rawRequest, startGateway } from './support/gateway.js';
import type { TestGateway } from './support/gateway.js';

/** Gateways started by the current test, closed after it. */
const started: Gateway[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((gateway) => gateway.close()));
});

async function start(...args: Parameters<typeof startGateway>): Promise<TestGateway> {
  const test = await startGateway(...args);
  started.push(test.gateway);
  return test;
}

function get(url: string, path: string, token?: string, init: RequestInit = {}) {
  return fetch(`${url}${path}`, {
    ...init,
    headers: {
      ...(token !== undefined && { authorization: `Bearer ${token}` }),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function errorOf(response: Response) {
  return ((await response.json()) as { error: Record<string, unknown> }).error;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Whether a TCP connection to host:port is accepted. */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

describe('listen and close', () => {
  it('listens on 127.0.0.1 by default and resolves to the HARNESS_GATEWAY_URL', async () => {
    const { port, url } = await start();
    expect(port).toBeGreaterThan(0);
    expect(url).toBe(`http://127.0.0.1:${String(port)}/v1`);
    // Bound to the IPv4 loopback address only, not to every interface.
    expect(await accepts('127.0.0.1', port)).toBe(true);
    expect(await accepts('::1', port)).toBe(false);
  });

  it.each(['0.0.0.0', '::', '192.168.1.10', 'example.com'])(
    'refuses to listen on %s',
    async (host) => {
      const gateway = createGateway(baseOptions());
      started.push(gateway);
      await expect(gateway.listen(host)).rejects.toThrow(/Refusing to listen/);
    },
  );

  it('listens on ::1 with the IPv6 address in brackets in the URL', async () => {
    const gateway = createGateway(baseOptions());
    started.push(gateway);
    const { port, url } = await gateway.listen('::1');
    expect(url).toBe(`http://[::1]:${String(port)}/v1`);
    const token = gateway.issueToken(claims());
    expect((await get(url, '/harness/context', token)).status).toBe(200);
  });

  it('is an EventEmitter, for its usage events', () => {
    const gateway = createGateway(baseOptions());
    expect(gateway).toBeInstanceOf(EventEmitter);
  });

  it('listens on a fixed port', async () => {
    const probe = createGateway(baseOptions());
    const { port } = await probe.listen();
    await probe.close();
    const gateway = createGateway(baseOptions());
    started.push(gateway);
    expect((await gateway.listen('127.0.0.1', port)).port).toBe(port);
  });

  it('rejects a second listen, and a listen after close', async () => {
    const { gateway } = await start();
    await expect(gateway.listen()).rejects.toThrow(/already listening/);
    const unused = createGateway(baseOptions());
    await unused.close();
    await expect(unused.listen()).rejects.toThrow(/already closed/);
  });

  it('can listen again after a failed listen', async () => {
    const gateway = createGateway(baseOptions());
    started.push(gateway);
    await expect(gateway.listen('0.0.0.0')).rejects.toThrow();
    await expect(gateway.listen()).resolves.toMatchObject({ port: expect.any(Number) as number });
  });

  it('closes idempotently, stops listening and revokes every token', async () => {
    const verifier = createInMemoryTokenVerifier();
    const { gateway, port } = await start({ tokenVerifier: verifier });
    const token = gateway.issueToken(claims());
    const first = gateway.close();
    expect(gateway.close()).toBe(first);
    await first;
    expect(verifier.verify(token)).toBeNull();
    expect(await accepts('127.0.0.1', port)).toBe(false);
    expect(() => gateway.issueToken(claims())).toThrow(/closed/);
  });
});

describe('Gateway Token authentication', () => {
  it('rejects a request without Authorization with 401 invalid_token, on every path', async () => {
    const { url } = await start();
    for (const [method, path] of [
      ['GET', '/harness/context'],
      ['GET', '/models'],
      ['POST', '/chat/completions'],
      ['GET', '/unknown-path'],
      ['DELETE', '/harness/context'],
    ] as const) {
      const response = await get(url, path, undefined, { method });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(await errorOf(response)).toEqual({
        code: 'invalid_token',
        message: expect.any(String) as string,
        type: 'harness_store',
      });
    }
  });

  it.each([
    ['a token that was never issued', 'Bearer never-issued-token'],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['a scheme without a token', 'Bearer'],
    ['two tokens', 'Bearer a b'],
  ])('rejects %s', async (_name, authorization) => {
    const { url } = await start();
    const response = await get(url, '/harness/context', undefined, { headers: { authorization } });
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe('invalid_token');
  });

  it('issues distinct 256-bit base64url tokens', async () => {
    const { gateway } = await start();
    const tokens = new Set(Array.from({ length: 50 }, () => gateway.issueToken(claims())));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('accepts a token on the very next request, then rejects it once revoked', async () => {
    const { gateway, url } = await start();
    const token = gateway.issueToken(claims());
    expect((await get(url, '/harness/context', token)).status).toBe(200);
    gateway.revokeToken(token);
    const response = await get(url, '/harness/context', token);
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe('invalid_token');
  });

  it('matches the Bearer scheme case-insensitively', async () => {
    const { gateway, url } = await start();
    const token = gateway.issueToken(claims());
    const response = await get(url, '/harness/context', undefined, {
      headers: { authorization: `bearer ${token}` },
    });
    expect(response.status).toBe(200);
  });

  it('revokeLaunch revokes every token of that launch and only those', async () => {
    const { gateway, url } = await start();
    const first = gateway.issueToken(claims({ launchId: 'launch-1' }));
    const second = gateway.issueToken(claims({ launchId: 'launch-1' }));
    const other = gateway.issueToken(claims({ launchId: 'launch-2' }));
    gateway.revokeLaunch('launch-1');
    expect((await get(url, '/harness/context', first)).status).toBe(401);
    expect((await get(url, '/harness/context', second)).status).toBe(401);
    expect((await get(url, '/harness/context', other)).status).toBe(200);
  });

  it('revoking one token leaves the other tokens of its launch valid', async () => {
    const { gateway, url } = await start();
    const first = gateway.issueToken(claims());
    const second = gateway.issueToken(claims());
    gateway.revokeToken(first);
    expect((await get(url, '/harness/context', second)).status).toBe(200);
  });

  it('delegates to a custom TokenVerifier and stamps issuedAt', async () => {
    const inner = createInMemoryTokenVerifier();
    const issue = vi.fn((issued: GatewayTokenClaims) => inner.issue(issued));
    const verify = vi.fn((token: string) => inner.verify(token));
    const revoke = vi.fn((token: string) => {
      inner.revoke(token);
    });
    const revokeLaunch = vi.fn((launchId: string) => {
      inner.revokeLaunch(launchId);
    });
    const verifier: TokenVerifier = { issue, verify, revoke, revokeLaunch };
    const { gateway, url } = await start({ tokenVerifier: verifier });
    const before = Date.now();
    const token = gateway.issueToken(claims());
    expect(issue).toHaveBeenCalledWith({
      ...claims(),
      issuedAt: expect.any(Number) as number,
    });
    expect(inner.verify(token)?.issuedAt).toBeGreaterThanOrEqual(before);
    expect(inner.verify(token)?.issuedAt).toBeLessThanOrEqual(Date.now());
    expect((await get(url, '/harness/context', token)).status).toBe(200);
    expect(verify).toHaveBeenCalledWith(token);
    gateway.revokeToken(token);
    expect(revoke).toHaveBeenCalledWith(token);
    gateway.revokeLaunch('launch-9');
    expect(revokeLaunch).toHaveBeenCalledWith('launch-9');
  });
});

describe('revoking requests in flight', () => {
  /** A Gateway whose getManifest waits until the test releases it. */
  async function startHeld(overrides: Partial<GatewayOptions> = {}) {
    const calls: string[] = [];
    const release = deferred<null>();
    const test = await start({
      ...overrides,
      getManifest: (harnessId) => {
        calls.push(harnessId);
        return release.promise;
      },
    });
    const reached = async (count: number) => {
      await vi.waitFor(() => {
        expect(calls).toHaveLength(count);
      });
    };
    return {
      ...test,
      release: () => {
        release.resolve(null);
      },
      reached,
    };
  }

  it('revokeToken fails a request already in flight with 401 invalid_token', async () => {
    const { gateway, url, release, reached } = await startHeld();
    const token = gateway.issueToken(claims());
    const pending = get(url, '/harness/context', token);
    await reached(1);
    gateway.revokeToken(token);
    release();
    const response = await pending;
    expect(response.status).toBe(401);
    expect((await errorOf(response)).code).toBe('invalid_token');
  });

  it('revokeLaunch fails only the requests of that launch', async () => {
    const { gateway, url, release, reached } = await startHeld();
    const revoked = gateway.issueToken(claims({ launchId: 'launch-1' }));
    const kept = gateway.issueToken(claims({ launchId: 'launch-2' }));
    const failing = get(url, '/harness/context', revoked);
    const passing = get(url, '/harness/context', kept);
    await reached(2);
    gateway.revokeLaunch('launch-1');
    release();
    expect((await failing).status).toBe(401);
    expect((await passing).status).toBe(200);
  });

  it('close() ends requests in flight and resolves without waiting for them', async () => {
    const debug = vi.fn<Logger['debug']>();
    const { gateway, url, reached } = await startHeld({
      logger: { debug, error: () => undefined },
    });
    const token = gateway.issueToken(claims());
    const pending = get(url, '/harness/context', token).then(
      (response) => response.status,
      () => 'connection closed',
    );
    await reached(1);
    await gateway.close();
    expect(await pending).toBe('connection closed');
    // The handler itself was stopped, not only its connection: getManifest never settles, so the
    // request is logged only because close() aborted it (401 invalid_token, like a revoke).
    await vi.waitFor(() => {
      expect(debug).toHaveBeenCalledWith(
        'request',
        expect.objectContaining({ path: '/v1/harness/context', status: 401 }),
      );
    });
  });
});

describe('Host check', () => {
  it('rejects a forged non-loopback Host with 403 invalid_host, whatever the token', async () => {
    const { gateway, port } = await start();
    const token = gateway.issueToken(claims());
    for (const authorization of [`Bearer ${token}`, 'Bearer nope', undefined]) {
      const response = await rawRequest(port, {
        headers: {
          host: `evil.example:${String(port)}`,
          ...(authorization !== undefined && { authorization }),
        },
      });
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual({
        error: {
          code: 'invalid_host',
          message: expect.any(String) as string,
          type: 'harness_store',
        },
      });
    }
  });

  it.each([
    ['another port', (port: number) => `127.0.0.1:${String(port + 1)}`],
    ['no port', () => '127.0.0.1'],
    ['a LAN address', (port: number) => `192.168.1.10:${String(port)}`],
    ['a malformed value', (port: number) => `evil host:${String(port)}`],
    ['userinfo', (port: number) => `127.0.0.1:${String(port)}@evil.example`],
  ])('rejects a Host with %s', async (_name, host) => {
    const { gateway, port } = await start();
    const token = gateway.issueToken(claims());
    const response = await rawRequest(port, {
      headers: { host: host(port), authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'invalid_host' } });
  });

  it('rejects a request without a Host header', async () => {
    const { gateway, port } = await start();
    const token = gateway.issueToken(claims());
    const response = await rawRequest(port, {
      noHost: true,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(403);
  });

  it.each(['127.0.0.1', 'localhost', 'LOCALHOST', '[::1]'])(
    'accepts Host %s:<port>',
    async (name) => {
      const { gateway, port } = await start();
      const token = gateway.issueToken(claims());
      const response = await rawRequest(port, {
        headers: { host: `${name}:${String(port)}`, authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
    },
  );
});

describe('no CORS', () => {
  it('never sets a CORS header, on success, on errors or on a preflight', async () => {
    const { gateway, url, port } = await start();
    const token = gateway.issueToken(claims());
    const origin = { origin: 'https://evil.example' };
    const responses = [
      await get(url, '/harness/context', token, { headers: origin }),
      await get(url, '/harness/context', undefined, { headers: origin }),
      await get(url, '/unknown-path', token, { headers: origin }),
      await get(url, '/chat/completions', undefined, {
        method: 'OPTIONS',
        headers: {
          ...origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type',
        },
      }),
      await get(url, '/chat/completions', token, { method: 'OPTIONS', headers: origin }),
    ];
    const forged = await rawRequest(port, { headers: { ...origin, host: 'evil.example' } });
    const names = [
      ...responses.flatMap((response) => [...response.headers.keys()]),
      ...Object.keys(forged.headers),
    ];
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => name.toLowerCase().startsWith('access-control-'))).toEqual([]);
  });
});

describe('routing', () => {
  it.each([
    ['GET', '/v1/unknown-path'],
    ['POST', '/v1/harness/context'],
    ['PUT', '/v1/harness/context'],
    ['HEAD', '/v1/harness/context'],
    ['GET', '/v1/chat/completions'],
    ['POST', '/v1/models'],
    ['HEAD', '/v1/models'],
    ['GET', '/'],
    ['GET', '/harness/context'],
  ])('%s %s with a valid token is 404 not_supported', async (method, path) => {
    const { gateway, port } = await start();
    const token = gateway.issueToken(claims());
    const response = await rawRequest(port, {
      method,
      path,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
    if (method !== 'HEAD') {
      expect(JSON.parse(response.body)).toEqual({
        error: {
          code: 'not_supported',
          message: expect.any(String) as string,
          type: 'harness_store',
        },
      });
    }
  });
});

describe('GET /v1/harness/context', () => {
  it("returns the token's Harness, version and locale and every Slot of its Manifest", async () => {
    const getManifest = vi.fn(() =>
      Promise.resolve(
        manifestWith({
          default: { description: 'Main model', requirements: { tools: true, minContext: 32000 } },
          fast: { recommended: ['openai/gpt-5-mini'] },
        }),
      ),
    );
    const { gateway, url } = await start({ getManifest });
    const token = gateway.issueToken(
      claims({ harnessId: 'alice/hello', harnessVersion: '1.2.3', locale: 'zh-CN' }),
    );
    const response = await get(url, '/harness/context', token);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await response.json()).toEqual({
      harnessId: 'alice/hello',
      version: '1.2.3',
      locale: 'zh-CN',
      slots: {
        default: { description: 'Main model', requirements: { tools: true, minContext: 32000 } },
        fast: { requirements: {} },
      },
    });
    expect(getManifest).toHaveBeenCalledWith('alice/hello');
  });

  it('includes the Workspace when the launch has one', async () => {
    const { gateway, url } = await start();
    const token = gateway.issueToken(claims({ workspace: '/Users/alice/project' }));
    const body = (await (await get(url, '/harness/context', token)).json()) as Record<
      string,
      unknown
    >;
    expect(body.workspace).toBe('/Users/alice/project');
  });

  it('answers each Harness from its own token', async () => {
    const getManifest = vi.fn((harnessId: string) =>
      Promise.resolve(harnessId === 'bob/other' ? null : manifestWith({ default: {} })),
    );
    const { gateway, url } = await start({ getManifest });
    const token = gateway.issueToken(claims({ harnessId: 'bob/other', launchId: 'launch-2' }));
    const body = (await (await get(url, '/harness/context', token)).json()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({ harnessId: 'bob/other', slots: {} });
    expect(getManifest).toHaveBeenLastCalledWith('bob/other');
  });

  it('asks for the Manifest on every request', async () => {
    const getManifest = vi.fn(() => Promise.resolve(manifestWith({ default: {} })));
    const { gateway, url } = await start({ getManifest });
    const token = gateway.issueToken(claims());
    await get(url, '/harness/context', token);
    await get(url, '/harness/context', token);
    expect(getManifest).toHaveBeenCalledTimes(2);
  });

  it('answers 500 internal_error and logs it when getManifest fails', async () => {
    const debug = vi.fn<Logger['debug']>();
    const error = vi.fn<Logger['error']>();
    const logger: Logger = { debug, error };
    const { gateway, url } = await start({
      logger,
      getManifest: () => Promise.reject(new Error('database is locked (key sk-abcdefgh12345678)')),
    });
    const token = gateway.issueToken(claims());
    const response = await get(url, '/harness/context', token);
    expect(response.status).toBe(500);
    expect(await errorOf(response)).toEqual({
      code: 'internal_error',
      message: expect.any(String) as string,
      type: 'harness_store',
    });
    expect(error).toHaveBeenCalledOnce();
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain('database is locked');
    expect(logged).not.toContain('sk-abcdefgh12345678');
  });

  it('answers 500 internal_error, not invalid_host, when a callback rejects with a non-Error', async () => {
    const error = vi.fn<Logger['error']>();
    const { gateway, url } = await start({
      logger: { debug: () => undefined, error },
      // Hono's onError only sees Errors; anything else makes the app's fetch reject.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      getManifest: () => Promise.reject('database is locked'),
    });
    const token = gateway.issueToken(claims());
    const response = await get(url, '/harness/context', token);
    expect(response.status).toBe(500);
    expect(await errorOf(response)).toEqual({
      code: 'internal_error',
      message: expect.any(String) as string,
      type: 'harness_store',
    });
    expect(error).toHaveBeenCalledWith('internal error', {
      method: 'GET',
      path: '/v1/harness/context',
      error: 'database is locked',
    });
  });
});

describe('debug logging', () => {
  it('logs request metadata without the Gateway Token', async () => {
    const debug = vi.fn<Logger['debug']>();
    const error = vi.fn<Logger['error']>();
    const logger: Logger = { debug, error };
    const { gateway, url } = await start({ logger });
    const token = gateway.issueToken(claims());
    await get(url, '/harness/context', token);
    await get(url, '/harness/context', 'wrong-token');
    expect(debug).toHaveBeenCalledWith('request', {
      method: 'GET',
      path: '/v1/harness/context',
      harnessId: 'alice/hello',
      status: 200,
      durationMs: expect.any(Number) as number,
    });
    expect(debug).toHaveBeenCalledWith(
      'request',
      expect.objectContaining({ status: 401, harnessId: undefined }),
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain(token);
  });

  it('keeps serving when the logger throws', async () => {
    const { gateway, url } = await start({
      logger: {
        debug: () => {
          throw new Error('broken logger');
        },
        error: () => undefined,
      },
    });
    const token = gateway.issueToken(claims());
    expect((await get(url, '/harness/context', token)).status).toBe(200);
  });
});
