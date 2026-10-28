// fixture-web: a web Harness for the Runtime's tests. It listens on 127.0.0.1:$HARNESS_PORT and
// answers every request with the environment it was started with, as JSON.
import { createServer } from 'node:http';

const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(process.env));
});
server.listen(Number(process.env.HARNESS_PORT), '127.0.0.1');
