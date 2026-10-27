import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import type { HttpBindings } from '@hono/node-server';

/** The only hosts a loopback server may bind to. */
export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;
export type LoopbackHost = (typeof LOOPBACK_HOSTS)[number];

export function isLoopbackHost(host: string): host is LoopbackHost {
  return (LOOPBACK_HOSTS as readonly string[]).includes(host);
}

/** `host` as it appears in a URL: IPv6 literals in brackets. */
export function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

/** A fetch handler with access to the Node request and response (a Hono app's `fetch`). */
export type NodeFetch = (request: Request, env: HttpBindings) => Response | Promise<Response>;

export interface LoopbackServer {
  readonly host: LoopbackHost;
  /** The bound port (the OS-assigned one when 0 was asked for). */
  readonly port: number;
  /** `http://<host>:<port>`, IPv6 in brackets, no trailing slash. */
  readonly origin: string;
  /**
   * Stops listening and destroys every open connection, idle or busy, so nothing outlives it.
   * Idempotent: later calls return the first call's promise.
   */
  close(): Promise<void>;
}

export interface ServeLoopbackOptions {
  host: string;
  port: number;
  /**
   * Answers a request that never reaches `fetch` because it cannot be turned into a `Request`,
   * which over HTTP/1.1 means a malformed `Host` header. Default: an empty 400.
   */
  onBadRequest?: () => Response;
}

/**
 * Serves `fetch` (typically a Hono app's) over HTTP/1.1 on a loopback host. Shared by the Model
 * Gateway and the fake Provider so both bind, report their port and shut down the same way.
 * Throws for a host that is not loopback or a port outside 0-65535, and rejects when the port is
 * taken.
 */
export async function serveLoopback(
  fetch: NodeFetch,
  { host, port, onBadRequest }: ServeLoopbackOptions,
): Promise<LoopbackServer> {
  if (!isLoopbackHost(host)) {
    throw new Error(
      `Refusing to listen on ${host}: only ${LOOPBACK_HOSTS.join(', ')} are allowed.`,
    );
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port ${String(port)}: expected an integer from 0 to 65535.`);
  }
  const listener = getRequestListener(
    // Only HTTP/1.1 servers are created here, so env is always the HTTP/1.1 bindings.
    (request, env) => fetch(request, env as HttpBindings),
    {
      hostname: host,
      // Keep the process-wide Request and Response untouched: the host process (Electron's main
      // process, a test runner) shares them.
      overrideGlobalObjects: false,
      ...(onBadRequest && { errorHandler: onBadRequest }),
    },
  );
  // A request without a Host header reaches `fetch` (Node would answer it with a bare 400), so
  // the app's own Host check answers it like any other bad Host.
  const server = createServer({ requireHostHeader: false }, (request, response) => {
    void listener(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const bound = (server.address() as AddressInfo).port;
  let closed: Promise<void> | undefined;
  return {
    host,
    port: bound,
    origin: `http://${urlHost(host)}:${String(bound)}`,
    close() {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
      return closed;
    },
  };
}
