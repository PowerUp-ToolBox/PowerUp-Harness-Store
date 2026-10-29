/** The local server of a Harness with UI Kind `web`. */
import { createServer as createHttpServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import { harnessPort } from './context.js';

/**
 * Creates an `http.Server` for `handler` and starts it listening on `127.0.0.1:HARNESS_PORT`, the
 * address the Runtime loads in the Harness window. It returns at once: listen failures arrive as
 * the server's `'error'` event. Throws when `HARNESS_PORT` is not set, i.e. when this Harness is
 * not UI Kind `web`.
 */
export function createServer(handler: RequestListener): Server {
  const port = harnessPort();
  if (port === undefined) {
    throw new Error(
      'HARNESS_PORT is not set: createServer() is only for Harnesses with UI Kind "web" (ui.kind in manifest.json)',
    );
  }
  const server = createHttpServer(handler);
  server.listen(port, '127.0.0.1');
  return server;
}
