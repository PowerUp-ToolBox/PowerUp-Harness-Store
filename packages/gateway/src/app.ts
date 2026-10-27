/**
 * The Model Gateway's HTTP app. Every request passes, in order: the `Host` check (loopback names
 * at the bound port only, so a web page cannot reach the Gateway through DNS rebinding), Gateway
 * Token authentication, then routing. No response ever carries a CORS header.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import type { ModelRequirements } from '@harness-store/manifest';
import { errorResponse } from './errors.js';
import { RequestAbortedError, unlessAborted } from './in-flight.js';
import type { InFlightRegistry } from './in-flight.js';
import type { Logger } from './logging.js';
import { hashToken } from './tokens.js';
import type { GatewayTokenClaims, TokenVerifier } from './tokens.js';
import type { GatewayOptions } from './types.js';

/** The body of `GET /v1/harness/context`. */
export interface HarnessContext {
  harnessId: string;
  /** The Harness Version. */
  version: string;
  locale: string;
  workspace?: string;
  /** Every Model Slot the Manifest declares. Bindings are listed by `/v1/models`, not here. */
  slots: Record<string, { description?: string; requirements: ModelRequirements }>;
}

export interface AppDeps {
  readonly options: Pick<GatewayOptions, 'getManifest'>;
  readonly verifier: TokenVerifier;
  readonly inFlight: InFlightRegistry;
  readonly logger: Logger;
  /** The bound port; undefined until the Gateway listens. */
  port(): number | undefined;
}

interface AppEnv {
  Bindings: HttpBindings;
  Variables: {
    claims: GatewayTokenClaims;
    /** Aborted when the request's token is revoked or the Gateway closes. */
    signal: AbortSignal;
  };
}

type Ctx = Context<AppEnv>;

const BEARER = /^Bearer (\S+)$/i;

/** The `Host` values a request may carry: loopback names at the bound port. */
export function allowedHosts(port: number): string[] {
  return ['127.0.0.1', 'localhost', '[::1]'].map((host) => `${host}:${String(port)}`);
}

export function invalidHost(): Response {
  return errorResponse('invalid_host', 'The Host header must name the Gateway on loopback.');
}

function notSupported(c: Ctx): Response {
  return errorResponse(
    'not_supported',
    `${c.req.method} ${c.req.path} is not supported by the Model Gateway.`,
  );
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { options, verifier, inFlight, logger } = deps;
  const app = new Hono<AppEnv>();

  // Request metadata at debug level; never bodies or headers.
  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    logger.debug('request', {
      method: c.req.method,
      path: c.req.path,
      harnessId: (c.var.claims as GatewayTokenClaims | undefined)?.harnessId,
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  });

  app.use(async (c, next) => {
    const port = deps.port();
    const host = c.req.header('host')?.toLowerCase();
    if (port === undefined || host === undefined || !allowedHosts(port).includes(host)) {
      return invalidHost();
    }
    await next();
    return undefined;
  });

  app.use(async (c, next) => {
    const token = BEARER.exec(c.req.header('authorization') ?? '')?.[1];
    const claims = token === undefined ? null : verifier.verify(token);
    if (token === undefined || claims === null) {
      return errorResponse('invalid_token', 'Missing, unknown or revoked Gateway Token.');
    }
    // Hono answers HEAD with the GET route; the protocol has no HEAD endpoints.
    if (c.req.method === 'HEAD') return notSupported(c);
    const flight = inFlight.start(claims.launchId, hashToken(token));
    c.set('claims', claims);
    c.set('signal', flight.signal);
    try {
      await next();
    } finally {
      flight.end();
    }
    return undefined;
  });

  app.get('/v1/harness/context', async (c) => {
    const claims = c.var.claims;
    const manifest = await unlessAborted(options.getManifest(claims.harnessId), c.var.signal);
    const slots: HarnessContext['slots'] = {};
    for (const [name, slot] of Object.entries(manifest?.models.slots ?? {})) {
      slots[name] = {
        ...(slot.description !== undefined && { description: slot.description }),
        requirements: slot.requirements ?? {},
      };
    }
    const body: HarnessContext = {
      harnessId: claims.harnessId,
      version: claims.harnessVersion,
      locale: claims.locale,
      ...(claims.workspace !== undefined && { workspace: claims.workspace }),
      slots,
    };
    return c.json(body);
  });

  app.notFound(notSupported);

  app.onError((error, c) => {
    if (error instanceof RequestAbortedError) {
      return errorResponse('invalid_token', 'The Gateway Token was revoked.');
    }
    logger.error('internal error', {
      method: c.req.method,
      path: c.req.path,
      harnessId: (c.var.claims as GatewayTokenClaims | undefined)?.harnessId,
      error,
    });
    return errorResponse('internal_error', 'The Model Gateway failed to handle the request.');
  });

  return app;
}
