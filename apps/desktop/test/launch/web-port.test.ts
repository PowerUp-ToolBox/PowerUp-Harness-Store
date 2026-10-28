import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { pickPort, waitForPort } from '../../src/main/runtime/web-port.js';

/** Ticket P0-05.3: a web Harness's `HARNESS_PORT` and the readiness probe on it. */

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

function listen(port: number): Promise<void> {
  const server = createServer((socket) => socket.end());
  servers.push(server);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

describe('pickPort', () => {
  it('answers a port the OS assigned on 127.0.0.1 and released, so it can be bound', async () => {
    const port = await pickPort();
    expect(port).toBeGreaterThan(0);
    await expect(listen(port)).resolves.toBeUndefined();
  });

  it('never answers a port a running Harness has, even when the OS offers it again', async () => {
    const offered = [41001, 41002, 41003];
    const free = () => Promise.resolve(offered.shift() ?? 0);
    await expect(pickPort(new Set([41001, 41002]), free)).resolves.toBe(41003);
  });

  it('gives up when the OS keeps offering ports in use', async () => {
    await expect(pickPort(new Set([41001]), () => Promise.resolve(41001))).rejects.toThrow(
      /No free port/,
    );
  });
});

describe('waitForPort', () => {
  it('is ready as soon as the port accepts a connection, polling every 250 ms', async () => {
    const port = await pickPort();
    const started = Date.now();
    setTimeout(() => void listen(port), 600);
    await expect(waitForPort(port, 5000)).resolves.toBe('ready');
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(elapsed).toBeLessThan(1200);
  });

  it('times out at its timeout when nothing listens', async () => {
    const port = await pickPort();
    const started = Date.now();
    await expect(waitForPort(port, 700)).resolves.toBe('timeout');
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(690);
    expect(elapsed).toBeLessThan(1000);
  });

  it('stops when it is cancelled (the process exited, the window closed)', async () => {
    const port = await pickPort();
    let cancelled = false;
    setTimeout(() => {
      cancelled = true;
    }, 300);
    const started = Date.now();
    await expect(waitForPort(port, 5000, () => cancelled)).resolves.toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
