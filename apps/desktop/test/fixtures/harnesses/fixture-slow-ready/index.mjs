// fixture-slow-ready: a web Harness for the Runtime's tests. It starts listening on
// 127.0.0.1:$HARNESS_PORT 2 seconds after it started, then prints `FIXTURE listening <epoch ms>`
// with the time its port began accepting connections.
import { createServer } from 'node:http';

process.stdout.write('fixture-slow-ready: started, listening in 2 s\n');
setTimeout(() => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ready');
  });
  server.listen(Number(process.env.HARNESS_PORT), '127.0.0.1', () => {
    process.stdout.write(`FIXTURE listening ${String(Date.now())}\n`);
  });
}, 2000);
