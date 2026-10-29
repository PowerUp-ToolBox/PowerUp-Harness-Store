import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import type { AddressInfo, Server as NetServer } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from '../src/index.js';
import { LAUNCH_ENV, stubLaunchEnv } from './support/env.js';

const open: (Server | NetServer)[] = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) resolve();
          else
            server.close(() => {
              resolve();
            });
        }),
    ),
  );
});

/** A port that was free a moment ago, as the Runtime picks one (bind port 0, release it). */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

describe('createServer', () => {
  it('listens on 127.0.0.1:HARNESS_PORT and serves the handler', async () => {
    const port = await freePort();
    stubLaunchEnv({ ...LAUNCH_ENV, HARNESS_PORT: String(port) });
    const server = createServer((_req, res) => res.end('hello'));
    open.push(server);
    await once(server, 'listening');

    expect(server.address()).toEqual({ address: '127.0.0.1', family: 'IPv4', port });
    const response = await fetch(`http://127.0.0.1:${String(port)}/`);
    expect(await response.text()).toBe('hello');
  });

  it('reads only HARNESS_PORT, not the other launch variables', async () => {
    const port = await freePort();
    stubLaunchEnv({ HARNESS_PORT: String(port) });
    const server = createServer((_req, res) => res.end());
    open.push(server);
    await once(server, 'listening');
    expect((server.address() as AddressInfo).port).toBe(port);
  });

  it('throws a clear error when HARNESS_PORT is unset (not UI Kind web)', () => {
    stubLaunchEnv({ ...LAUNCH_ENV, HARNESS_PORT: undefined });
    expect(() => createServer((_req, res) => res.end())).toThrow(
      'HARNESS_PORT is not set: createServer() is only for Harnesses with UI Kind "web"',
    );
  });

  it('throws when HARNESS_PORT is not a port number', () => {
    stubLaunchEnv({ ...LAUNCH_ENV, HARNESS_PORT: 'eighty' });
    expect(() => createServer((_req, res) => res.end())).toThrow(/HARNESS_PORT must be/);
  });

  it('returns at once and reports a listen failure as an error event', async () => {
    const taken = createNetServer();
    open.push(taken);
    taken.listen(0, '127.0.0.1');
    await once(taken, 'listening');
    const { port } = taken.address() as AddressInfo;
    stubLaunchEnv({ ...LAUNCH_ENV, HARNESS_PORT: String(port) });

    const server = createServer((_req, res) => res.end());
    const [error] = (await once(server, 'error')) as [NodeJS.ErrnoException];
    expect(error.code).toBe('EADDRINUSE');
  });
});
