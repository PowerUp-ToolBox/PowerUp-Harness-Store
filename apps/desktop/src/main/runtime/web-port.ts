import { connect, createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

/** The only address a web Harness listens on (docs/tech/manifest-spec.md, `ui.kind = web`). */
export const LOOPBACK = '127.0.0.1';
/** How often the readiness probe tries to connect (P0-05 spec). */
export const READY_POLL_MS = 250;
/** `ui.readyTimeoutSeconds` when the Manifest leaves it out. */
export const DEFAULT_READY_TIMEOUT_SECONDS = 30;
/** How many ports {@link pickPort} asks the OS for before it gives up. */
const PICK_ATTEMPTS = 10;
/** The longest one connection attempt of the probe may take. */
const CONNECT_TIMEOUT_MS = 1000;

/**
 * A free TCP port on {@link LOOPBACK} for a web Harness's `HARNESS_PORT`: bound with port 0 so the
 * OS picks it, then released at once so the Harness can bind it itself. Each port the OS answers
 * is offered to `claim`, which takes it (true) or turns it down (false: a running Harness holds
 * it, as the OS may hand a just-released port out again). `claim` runs right after the OS
 * answered, with no await in between, so a caller that checks and records its ports there never
 * gives one port to two Harnesses, even when several picks run at once. Rejects when no port can
 * be claimed. `free` asks the OS; tests replace it.
 */
export async function pickPort(
  claim: (port: number) => boolean = () => true,
  free: () => Promise<number> = freePort,
): Promise<number> {
  for (let attempt = 0; attempt < PICK_ATTEMPTS; attempt += 1) {
    const port = await free();
    if (claim(port)) return port;
  }
  throw new Error(`No port on ${LOOPBACK} could be claimed in ${String(PICK_ATTEMPTS)} attempts`);
}

/** Asks the OS for a free port on {@link LOOPBACK}: binds port 0, then releases it. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: LOOPBACK, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('The OS did not assign a port'));
      });
    });
  });
}

/** How the readiness probe ended. */
export type ReadyOutcome = 'ready' | 'timeout' | 'cancelled';

/**
 * The readiness probe of a web Harness: tries a TCP connection to `127.0.0.1:<port>` every
 * {@link READY_POLL_MS} until one is accepted (`ready`), `timeoutMs` has passed (`timeout`), or
 * `cancelled()` answers true (the process exited, or the User closed the window). Only
 * 127.0.0.1 is tried: a Harness that listens on `localhost` resolving to `::1` times out, as the
 * Manifest spec requires 127.0.0.1.
 */
export async function waitForPort(
  port: number,
  timeoutMs: number,
  cancelled: () => boolean = () => false,
): Promise<ReadyOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cancelled()) return 'cancelled';
    const left = deadline - Date.now();
    if (left <= 0) return 'timeout';
    if (await accepts(port, Math.min(CONNECT_TIMEOUT_MS, left))) {
      return cancelled() ? 'cancelled' : 'ready';
    }
    const wait = Math.min(READY_POLL_MS, deadline - Date.now());
    if (wait > 0) await sleep(wait);
  }
}

/** Whether `127.0.0.1:<port>` accepts a TCP connection within `ms`; the connection is closed. */
function accepts(port: number, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: LOOPBACK, port });
    const done = (accepted: boolean) => {
      socket.destroy();
      resolve(accepted);
    };
    socket.setTimeout(ms, () => {
      done(false);
    });
    socket.once('connect', () => {
      done(true);
    });
    socket.once('error', () => {
      done(false);
    });
  });
}
