import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createOpenAIClient,
  createServer,
  getContext,
  Slots,
  SlotUnboundError,
} from '@harness-store/sdk';

const { locale, port } = getContext();
const openai = createOpenAIClient();

// The whole page as one string: no file to find at runtime (the working directory is the
// Workspace or the Data Directory, not the Harness folder).
const page = `<!doctype html>
<html lang="${locale}">
<meta charset="utf-8">
<title>Ask</title>
<input id="question" size="60"> <button id="ask">Ask</button>
<p id="answer"></p>
<script>
  document.getElementById('ask').onclick = async () => {
    const answer = document.getElementById('answer');
    answer.textContent = '';
    const response = await fetch('/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: document.getElementById('question').value }),
    });
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      answer.textContent += part.value;
    }
  };
</script>
</html>`;

// Of the pages in a browser, only this Harness's own page may call /ask: a page on another site
// cannot send JSON here without a CORS preflight, which this server never answers, and a rebound
// DNS name arrives with another Host. This is not authentication: a local program can still call
// /ask.
function fromOwnPage(request: IncomingMessage): boolean {
  const host = request.headers.host;
  return (
    (host === `127.0.0.1:${String(port)}` || host === `localhost:${String(port)}`) &&
    request.headers['content-type'] === 'application/json'
  );
}

// The page's backend: asks the default Model Slot and streams the answer back as plain text.
async function ask(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const controller = new AbortController();
  response.on('close', () => {
    controller.abort(); // the page went away: stop the model call too
  });
  response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  try {
    // Read the body inside the try: a page that goes away mid-upload makes this throw.
    let body = '';
    request.setEncoding('utf8'); // decodes a character split across two chunks correctly
    for await (const chunk of request) body += chunk as string;
    const { question } = JSON.parse(body) as { question: string };
    const stream = await openai.chat.completions.create(
      { model: Slots.default, messages: [{ role: 'user', content: question }], stream: true },
      { signal: controller.signal },
    );
    for await (const chunk of stream) response.write(chunk.choices[0]?.delta.content ?? '');
  } catch (error) {
    if (!controller.signal.aborted) {
      response.write(
        SlotUnboundError.from(error) === undefined
          ? `The model call failed: ${error instanceof Error ? error.message : String(error)}`
          : 'No model is bound to this Harness. Bind one on the Models page of Harness Store.',
      );
    }
  } finally {
    response.end();
  }
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "connect-src 'self'",
    });
    response.end(page);
  } else if (request.method === 'POST' && request.url === '/ask' && fromOwnPage(request)) {
    void ask(request, response);
  } else {
    response.writeHead(404).end();
  }
});
server.on('error', (error) => {
  console.error(`Cannot listen on 127.0.0.1:${String(port)}: ${error.message}`);
  process.exit(1);
});
