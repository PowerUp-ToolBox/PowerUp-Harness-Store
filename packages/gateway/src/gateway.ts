/**
 * `createGateway`: the Model Gateway as an object its host embeds. The Runtime creates one at app
 * start, `listen`s on loopback, issues a Gateway Token per Harness launch and revokes it when the
 * process exits; tests do the same in-process against the fake Provider.
 */
import { EventEmitter } from 'node:events';
import { createApp, invalidHost } from './app.js';
import { InFlightRegistry } from './in-flight.js';
import { safeLogger } from './logging.js';
import { serveLoopback, urlHost } from './serve.js';
import type { LoopbackServer } from './serve.js';
import { createInMemoryTokenVerifier, hashToken } from './tokens.js';
import type { GatewayTokenClaims } from './tokens.js';
import type { GatewayOptions, UsageRecord } from './types.js';

/** The events a {@link Gateway} emits. */
export interface GatewayEvents {
  /** A Usage Record, after `onUsage` received it. */
  usage: [record: UsageRecord];
}

export interface ListenResult {
  port: number;
  /** `http://<host>:<port>/v1`, IPv6 in brackets: exactly the Harness's `HARNESS_GATEWAY_URL`. */
  url: string;
}

export interface Gateway extends EventEmitter<GatewayEvents> {
  /**
   * Starts serving on a loopback host (`127.0.0.1`, `::1` or `localhost`; anything else rejects)
   * and resolves once it listens. Port 0 lets the OS choose. Rejects when called again, or after
   * {@link close}.
   */
  listen(host?: string, port?: number): Promise<ListenResult>;
  /**
   * Revokes every Gateway Token, stops every in-flight request, destroys open connections and
   * stops listening. Idempotent: later calls return the first call's promise.
   */
  close(): Promise<void>;
  /**
   * Issues a Gateway Token for one Harness launch; the Gateway stamps `issuedAt`. The token is
   * valid from the next request on, until it is revoked or the Gateway closes.
   */
  issueToken(claims: Omit<GatewayTokenClaims, 'issuedAt'>): string;
  /** Revokes one token and fails the requests it has in flight with 401 `invalid_token`. */
  revokeToken(token: string): void;
  /** Revokes every token of a launch and fails their requests in flight, like {@link revokeToken}. */
  revokeLaunch(launchId: string): void;
}

export function createGateway(options: GatewayOptions): Gateway {
  return new ModelGateway(options);
}

type GatewayState = 'new' | 'listening' | 'closed';

class ModelGateway extends EventEmitter<GatewayEvents> implements Gateway {
  readonly #verifier;
  readonly #inFlight = new InFlightRegistry();
  readonly #app;
  /** Launches with tokens from {@link issueToken}, so {@link close} can revoke them all. */
  readonly #launches = new Set<string>();
  #state: GatewayState = 'new';
  #server: Promise<LoopbackServer> | undefined;
  #port: number | undefined;
  #closed: Promise<void> | undefined;

  constructor(options: GatewayOptions) {
    super();
    this.#verifier = options.tokenVerifier ?? createInMemoryTokenVerifier();
    this.#app = createApp({
      options,
      verifier: this.#verifier,
      inFlight: this.#inFlight,
      logger: safeLogger(options.logger),
      port: () => this.#port,
    });
  }

  async listen(host = '127.0.0.1', port = 0): Promise<ListenResult> {
    if (this.#state !== 'new') {
      throw new Error(`The Model Gateway cannot listen: it is already ${this.#state}.`);
    }
    this.#state = 'listening';
    this.#server = serveLoopback(this.#app.fetch, { host, port, onBadRequest: invalidHost });
    let server: LoopbackServer;
    try {
      server = await this.#server;
    } catch (error) {
      // Nothing is listening: allow another attempt (a free port, a valid host).
      if (this.#currentState() === 'listening') {
        this.#state = 'new';
        this.#server = undefined;
      }
      throw error;
    }
    if (this.#currentState() === 'closed') {
      throw new Error('The Model Gateway was closed while starting.');
    }
    this.#port = server.port;
    return { port: server.port, url: `http://${urlHost(server.host)}:${String(server.port)}/v1` };
  }

  /** `#state` as of now: TypeScript would otherwise keep its narrowing across an `await`. */
  #currentState(): GatewayState {
    return this.#state;
  }

  close(): Promise<void> {
    this.#closed ??= (async () => {
      this.#state = 'closed';
      for (const launchId of this.#launches) this.#verifier.revokeLaunch(launchId);
      this.#launches.clear();
      this.#inFlight.abortAll();
      const server = await this.#server?.catch(() => undefined);
      await server?.close();
    })();
    return this.#closed;
  }

  issueToken(claims: Omit<GatewayTokenClaims, 'issuedAt'>): string {
    if (this.#state === 'closed') throw new Error('The Model Gateway is closed.');
    const token = this.#verifier.issue({ ...claims, issuedAt: Date.now() });
    this.#launches.add(claims.launchId);
    return token;
  }

  revokeToken(token: string): void {
    this.#verifier.revoke(token);
    this.#inFlight.abortToken(hashToken(token));
  }

  revokeLaunch(launchId: string): void {
    this.#verifier.revokeLaunch(launchId);
    this.#launches.delete(launchId);
    this.#inFlight.abortLaunch(launchId);
  }
}
