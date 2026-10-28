/**
 * hello-web: the reference Harness with UI Kind `web`. The Runtime starts it with `HARNESS_PORT`
 * and opens `http://127.0.0.1:<port>/` in the Harness window once the port accepts connections.
 * It serves two things there: the chat page (`GET /`), and that page's own backend (`POST /chat`),
 * which sends the conversation to the Model Gateway on the `default` Model Slot and relays the
 * answer to the page as it streams in, over Server-Sent Events.
 *
 * The page never calls the Gateway itself: the Gateway sets no CORS headers, so a browser page
 * cannot reach it (docs/tech/gateway-protocol.md §1), and the Gateway Token stays in this process.
 * This server-side relay is the pattern for any web Harness whose page needs a model.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createOpenAIClient,
  createServer,
  getContext,
  NotInHarnessStoreError,
} from '@harness-store/sdk';
import type { HarnessContext } from '@harness-store/sdk';
import { relayChat } from './chat.js';
import { page } from './page.js';

/**
 * What the page may load and connect to: only this origin. Nothing on the page comes from
 * anywhere else (no CDN, no web fonts), and its script can reach no server but this one.
 */
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function main(): void {
  let context: HarnessContext;
  try {
    context = getContext();
  } catch (error) {
    // Started by hand rather than by Harness Store: say how to run it instead of failing later.
    if (!(error instanceof NotInHarnessStoreError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const { port, locale } = context;
  if (port === undefined) {
    process.stderr.write('HARNESS_PORT is not set: hello-web has UI Kind "web" in manifest.json\n');
    process.exitCode = 1;
    return;
  }
  const client = createOpenAIClient();
  const html = page(locale);

  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && pathname === '/') {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': CONTENT_SECURITY_POLICY,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(html);
    } else if (request.method === 'POST' && pathname === '/chat') {
      void relayChat(request, response, { client, port });
    } else {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found\n');
    }
  };

  // Listens on 127.0.0.1:HARNESS_PORT, the address the Runtime waits for and then shows.
  const server = createServer(handler);
  server.on('listening', () => {
    process.stdout.write(
      `Hello Web ${context.harnessVersion} serving http://127.0.0.1:${String(port)}/\n`,
    );
  });
  server.on('error', (error) => {
    process.stderr.write(`Could not serve on 127.0.0.1:${String(port)}: ${error.message}\n`);
    process.exit(1);
  });
}

main();
