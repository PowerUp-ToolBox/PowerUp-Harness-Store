// A stand-in for the parts of GitHub that Supabase Auth's GitHub provider calls server to server:
// the OAuth token exchange and the user API (GitHub Enterprise paths, which config.toml's `url`
// selects). It runs inside a container on the local stack's Docker network (fake-github.ts), so
// Auth reaches it as http://fake-github:8080 on every OS. Plain JavaScript with no dependencies:
// the container runs it with `node --input-type=module -e`.
//
// It keeps no state. The fake browser of the tests plays the consent screen: it sends Auth back
// an authorization code that is the identity itself, base64url-encoded JSON
// `{ id, login, name, email }`; the access token is that same string.
import { createServer } from 'node:http';

const PORT = 8080;

function identityOf(token) {
  try {
    const identity = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (typeof identity.id === 'number' && typeof identity.login === 'string') return identity;
  } catch {
    // Not an identity: answered as an unknown token below.
  }
  return null;
}

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

const server = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    const url = new URL(request.url ?? '/', 'http://fake-github');
    if (request.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      const code = new URLSearchParams(body).get('code') ?? '';
      if (identityOf(code) === null) return send(response, 400, { error: 'bad_verification_code' });
      return send(response, 200, { access_token: code, token_type: 'bearer', scope: 'user:email' });
    }
    const token = /^(?:Bearer|token) (.+)$/i.exec(request.headers.authorization ?? '')?.[1] ?? '';
    const identity = identityOf(token);
    if (request.method === 'GET' && url.pathname.startsWith('/api/v3/') && identity === null) {
      return send(response, 401, { message: 'Bad credentials' });
    }
    if (request.method === 'GET' && url.pathname === '/api/v3/user') {
      return send(response, 200, {
        id: identity.id,
        login: identity.login,
        name: identity.name,
        avatar_url: `https://avatars.fake-github.invalid/u/${String(identity.id)}`,
        email: identity.email,
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/v3/user/emails') {
      return send(response, 200, [{ email: identity.email, primary: true, verified: true }]);
    }
    send(response, 404, { message: 'Not Found' });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`fake GitHub listening on ${String(PORT)}`);
});
