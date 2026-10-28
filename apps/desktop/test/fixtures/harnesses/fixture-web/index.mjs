// fixture-web: a web Harness for the Runtime's tests. It listens on 127.0.0.1:$HARNESS_PORT at
// once and serves:
// - `/`: a page with a link to an external site, and what its script can reach (for the manual
//   check that the page gets neither Node nor Electron IPC);
// - `/env`: the environment it was started with, as JSON;
// - `/complete`: one chat completion from the Model Gateway for its `default` Model Slot, made
//   with its Gateway Token, as the Gateway answered it;
// - `/exit/<code>`: answers, then exits with that code (a crash once it was ready).
// On SIGTERM it writes `SIGTERM` to $FIXTURE_SIGNAL_FILE and exits 0.
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Fixture Web</title></head>
  <body>
    <h1>Fixture Web</h1>
    <p><a id="external" href="https://example.com">example.com (opens in the browser)</a></p>
    <p><a id="blank" href="https://example.com" target="_blank">example.com in a new window</a></p>
    <p><a id="env" href="/env">The environment (stays in the window)</a></p>
    <pre id="reach"></pre>
    <script>
      document.getElementById('reach').textContent = JSON.stringify({
        require: typeof window.require,
        process: typeof window.process,
        electron: typeof window.electron,
        api: typeof window.api,
        harness: typeof window.harness,
        ipcRenderer: typeof window.ipcRenderer,
      });
    </script>
  </body>
</html>
`;

process.on('SIGTERM', () => {
  if (process.env.FIXTURE_SIGNAL_FILE) appendFileSync(process.env.FIXTURE_SIGNAL_FILE, 'SIGTERM\n');
  process.exit(0);
});

const complete = async () => {
  const response = await fetch(`${process.env.HARNESS_GATEWAY_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.HARNESS_GATEWAY_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'default', messages: [{ role: 'user', content: 'ping' }] }),
  });
  return { status: response.status, body: await response.json() };
};

const server = createServer((request, response) => {
  if (request.url === '/env') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ env: process.env, cwd: process.cwd() }));
  } else if (request.url?.startsWith('/exit/')) {
    response.end('exiting');
    setTimeout(() => {
      process.exit(Number(request.url.slice('/exit/'.length)));
    }, 50);
  } else if (request.url === '/complete') {
    complete().then(
      (result) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
      },
      (error) => {
        response.writeHead(502, { 'content-type': 'text/plain' });
        response.end(String(error));
      },
    );
  } else {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  }
});
server.listen(Number(process.env.HARNESS_PORT), '127.0.0.1', () => {
  process.stdout.write(`fixture-web: listening on 127.0.0.1:${process.env.HARNESS_PORT}\n`);
});
