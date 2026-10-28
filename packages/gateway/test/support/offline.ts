/**
 * Vitest setup file: every test in this package runs offline. A TCP connection to anything but
 * loopback throws, so a test that would reach a real Provider (or an SDK that would download an
 * image URL) fails instead of silently depending on the network. The live conformance tests, which
 * run only when a developer sets their API keys, lift the guard with {@link allowNetwork}.
 */
import { Socket } from 'node:net';

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\]|::ffff:127(\.\d{1,3}){3})$/i;

type Connect = (this: Socket, ...args: unknown[]) => Socket;

/** The host a `socket.connect(...)` call targets; undefined for IPC paths and the default host. */
function targetHost(args: unknown[]): string | undefined {
  const [first, second] = args;
  if (Array.isArray(first)) return targetHost(first as unknown[]);
  if (typeof first === 'object' && first !== null) {
    const { host, path } = first as { host?: unknown; path?: unknown };
    return path === undefined && typeof host === 'string' ? host : undefined;
  }
  return typeof first === 'number' && typeof second === 'string' ? second : undefined;
}

// Kept unbound on purpose: it is re-applied with each socket as `this`.
// eslint-disable-next-line @typescript-eslint/unbound-method
const original = Socket.prototype.connect as unknown as Connect;
/** Shared through `globalThis`, in case a test file loads this module apart from the setup. */
const ALLOWED = Symbol.for('harness-store.gateway.test.allow-network');
type Flags = typeof globalThis & { [ALLOWED]?: boolean };

/** Lets the current test file reach beyond loopback. Only for the live conformance tests. */
export function allowNetwork(): void {
  (globalThis as Flags)[ALLOWED] = true;
}

const guarded: Connect = function (this: Socket, ...args) {
  const host = targetHost(args);
  if (host !== undefined && !LOOPBACK.test(host) && (globalThis as Flags)[ALLOWED] !== true) {
    throw new Error(`Tests must stay offline, but a connection to ${host} was attempted.`);
  }
  return original.apply(this, args);
};
Socket.prototype.connect = guarded;
