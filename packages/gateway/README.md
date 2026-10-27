# @harness-store/gateway

> Status: P0-02.1 (the [Gateway server](#the-gateway-server) with Gateway Token auth and `GET /v1/harness/context`), P0-02.2 (the [fake Provider](#fake-provider-harness-storegatewaytestingfake-provider)) and P0-02.3 ([non-streaming chat completions](#post-v1chatcompletions) for explicit `provider/model` ids through the `openai-compatible` adapter) are in. Streaming, Slot resolution, `GET /v1/models`, the other Provider adapters and Usage Records arrive in the rest of P0-02.

The **Model Gateway**: the local service, hosted by the **Runtime**, that is the only path from a running **Harness** to any model. It is a loopback HTTP server that speaks the OpenAI Chat Completions protocol, authenticates each request with the Harness's per-launch **Gateway Token**, resolves the requested **Model Slot** to the User's **Slot Binding** (Model Override, then Recommended Models, then Default Model), forwards the call to the chosen **Provider** through a **Connection** the Harness never sees, streams the answer back and writes a **Usage Record**.

The HTTP layer is [Hono](https://hono.dev) on `@hono/node-server`, with no Electron dependency, so the Gateway is tested in-process against the fake Provider (the Gateway HTTP seam, [`architecture.md`](../../docs/tech/architecture.md) §8) and can be reused server-side later. Provider adapters are built on the Vercel AI SDK (`ai`), with data-only presets for OpenAI-compatible Providers to come.

Normative reference: [`docs/tech/gateway-protocol.md`](../../docs/tech/gateway-protocol.md). Spec: [`P0-02`](../../docs/delivery/specs/P0-02-model-gateway-core.md).

## The Gateway server

```ts
import { createGateway } from '@harness-store/gateway';

const gateway = createGateway({
  getManifest: (harnessId) => installed.manifestOf(harnessId), // Manifest | null
  resolveBinding: ({ harnessId, slot }) => bindings.resolve(harnessId, slot), // Binding | null
  getConnection: (providerId) => connections.decrypt(providerId), // ConnectionSecret | null
  onUsage: (record) => usage.insert(record),
  // tokenVerifier: optional, defaults to in-memory per-launch tokens
  // logger: optional, defaults to no debug logs and errors on console.error
  // firstByteTimeoutMs, streamIdleTimeoutMs: optional, default 120 000 each
});

const { port, url } = await gateway.listen(); // 127.0.0.1, OS-assigned port; url is HARNESS_GATEWAY_URL
const token = gateway.issueToken({
  harnessId: 'alice/hello',
  harnessVersion: '1.2.3',
  launchId,
  locale: 'en',
  workspace: '/Users/alice/project', // only when the launch has a Workspace
}); // HARNESS_GATEWAY_TOKEN; the Gateway stamps issuedAt
gateway.revokeLaunch(launchId); // when the Harness process exits
await gateway.close();
```

- `listen(host = '127.0.0.1', port = 0)` accepts only `127.0.0.1`, `::1` and `localhost` and resolves to `{ port, url }` with `url` = `http://<host>:<port>/v1` (IPv6 in brackets). It rejects when called a second time or after `close()`.
- `close()` revokes every token, fails every request in flight, destroys open connections and stops listening. It is idempotent.
- `issueToken(claims)` returns 32 random bytes, base64url. Tokens live until `revokeToken(token)`, `revokeLaunch(launchId)` (every token of that launch) or `close()`. Revoking fails the matching requests in flight with 401 `invalid_token`.
- The Gateway is an `EventEmitter`; it emits `usage` with each Usage Record once Usage Records land (P0-02.7).
- Every request is checked in this order: the `Host` header (`127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`, else 403 `invalid_host`), the Gateway Token (else 401 `invalid_token`), then routing (else 404 `not_supported`). No response carries a CORS header.
- `GET /v1/harness/context` answers `{ harnessId, version, locale, workspace?, slots }` from the token's claims and the Manifest from `getManifest` (called on every request, never cached; `null` gives `slots: {}`).
- `firstByteTimeoutMs` bounds the wait for a Provider's response headers, `streamIdleTimeoutMs` the gap between two chunks of its response body; either one running out fails the request with 504 `provider_timeout` and aborts the upstream call.

### `POST /v1/chat/completions`

One pipeline per request, in the order the protocol fixes:

1. **Validate** the body ([`src/openai/request.ts`](src/openai/request.ts), zod with loose objects): unknown fields are ignored, a supported field of the wrong type is 400 `invalid_request`.
2. **Resolve** `model`: an explicit `provider/model` id needs `getConnection(providerId)` to return a Connection (else 403 `provider_not_connected`); a malformed id is 404 `unknown_slot`. Slot names are 404 `unknown_slot` until Slot resolution lands (P0-02.5).
3. **Translate and call** ([`src/openai/translate.ts`](src/openai/translate.ts)): exactly the protocol's fields go to `generateText` with `maxRetries: 0` and tools without `execute`, through the Provider's adapter ([`src/adapters.ts`](src/adapters.ts)) and the Gateway's timed `fetch` ([`src/upstream-fetch.ts`](src/upstream-fetch.ts)). No inbound header reaches the Provider.
4. **Answer** an OpenAI `chat.completion` whose `model` is the resolved `provider/model`, or map the failure ([`src/provider-errors.ts`](src/provider-errors.ts)) to 502 `provider_error` (`provider_status`, `provider_message`, `provider_code`, the Connection's key redacted) or 504 `provider_timeout`.

Only the `openai-compatible` adapter exists so far (`openai-compatible` and `openai-compatible:<name>`, with the Connection's `baseUrl`); another Provider id with a Connection gets 500 `internal_error` until P0-02.6. `stream: true` is 400 `invalid_request` until P0-02.4. The 14 Provider ids are exported as `PROVIDER_IDS`.

Types the host implements or receives (all exported):

| Type                 | Shape                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GatewayTokenClaims` | `{ harnessId, harnessVersion, launchId, issuedAt, locale, workspace? }`; `issuedAt` is epoch ms                                                                           |
| `TokenVerifier`      | `{ issue(claims): string; verify(token): claims \| null; revoke(token): void; revokeLaunch(launchId): void }`; the default keeps tokens keyed by their SHA-256, never raw |
| `Binding`            | `{ providerId, model, source: 'override' \| 'recommended' \| 'default_same_name' \| 'default' }`                                                                          |
| `ConnectionSecret`   | `{ apiKey?, baseUrl? }`: the decrypted credential, and a base URL that overrides the Provider's default                                                                   |
| `UsageRecord`        | `{ timestamp, harnessId, harnessVersion, slot, provider, model, promptTokens, completionTokens, cachedPromptTokens?, durationMs, status }`                                |
| `Logger`             | `{ debug(message, fields?): void; error(message, fields?): void }`; every message and field is redacted (keys, Bearer tokens) before it reaches the logger                |

A callback that throws or rejects gets the request 500 `internal_error` and is logged through `logger.error`.

## Fake Provider (`@harness-store/gateway/testing/fake-provider`)

A scriptable OpenAI-compatible HTTP server for tests: every Gateway, Runtime and end-to-end test runs against it instead of a real model vendor. It speaks the Chat Completions wire format closely enough that the OpenAI SDK and the Vercel AI SDK `openai-compatible` adapter treat it like a real Provider. It only binds loopback and never calls out.

```ts
import { startFakeProvider } from '@harness-store/gateway/testing/fake-provider';

const fake = await startFakeProvider(); // OS-assigned port on 127.0.0.1
fake.url; // 'http://127.0.0.1:<port>/v1', an OpenAI base URL
fake.requests; // every request received: { method, path, headers, body, aborted }
fake.reset(); // forget the recorded requests
await fake.close(); // cancels pending delays, destroys open connections, stops listening
```

Options (all optional):

| Option    | Default       | Meaning                                                                                                  |
| --------- | ------------- | -------------------------------------------------------------------------------------------------------- |
| `host`    | `'127.0.0.1'` | `127.0.0.1`, `::1` or `localhost`; anything else throws                                                  |
| `port`    | `0`           | `0` lets the OS choose; a fixed port lets the fake stand in for a local Provider (Ollama on 11434)       |
| `slowMs`  | `1000`        | How long `fake/slow` holds back its response headers                                                     |
| `aliases` | `{}`          | Extra model names served by a scenario, e.g. `{ 'qwen3:8b': 'fake/echo' }`                               |
| `apiKey`  | none          | When set, a wrong or missing `Authorization: Bearer` gets 401 `invalid_api_key`; otherwise anything goes |

The request's `model` picks a scenario by exact name (an unknown name gets 404 `model_not_found`). Every scenario honours `stream`, and a streamed reply ends with a usage chunk (`choices: []`) when `stream_options.include_usage` is true, like OpenAI. Token counts are whitespace-separated words.

| Model                                       | Behaviour                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fake/echo`, `fake/echo-stream`             | Replies with the text of the last user message, word for word; one SSE chunk per word                                                                                                                                                                         |
| `fake/tool-call`, `fake/tool-call-parallel` | Calls `tools[0]` (parallel: the first two tools, or `tools[0]` twice) with `{"input":"<last user text>"}` and ids `call_0`, `call_1`; streamed arguments come in 2 fragments. 400 without `tools`; answers a trailing `tool` message with its content as text |
| `fake/stream-no-usage`                      | Like `fake/echo`, but never reports usage                                                                                                                                                                                                                     |
| `fake/vision`                               | Needs an `image_url` part (http(s) or data URL) in a user message, else 400                                                                                                                                                                                   |
| `fake/500`                                  | HTTP 500 `{ error: { message, type: 'server_error', code: null } }`                                                                                                                                                                                           |
| `fake/rate-limited`                         | HTTP 429 `{ error: { message, type: 'requests', code: 'rate_limit_exceeded' } }`                                                                                                                                                                              |
| `fake/slow`                                 | Like `fake/echo`, after holding back the response headers for `slowMs`                                                                                                                                                                                        |
| `fake/stall`                                | Sends the first content chunk (half the body when not streaming), then nothing until the client leaves or `close()`                                                                                                                                           |
| `fake/stream-error`                         | Sends the first content chunk (half the body when not streaming), then drops the connection                                                                                                                                                                   |

`GET /v1/models` lists the scenarios and aliases in the OpenAI list shape. A body that is not JSON, or has no `model` or no `messages`, gets 400 `invalid_request_error`. A recorded request's `aborted` turns true when the client disconnects before the response finishes, which is how a test proves that an upstream call was cancelled.

## Scripts

| Command          | What it does                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm test`      | Vitest over `test/` (offline: a connection beyond loopback throws); run `pnpm build` first                        |
| `pnpm lint`      | ESLint with the shared root config (type-aware; run `pnpm build` first)                                           |
| `pnpm typecheck` | `tsc --noEmit` against `tsconfig.json` (sources and tests); run `pnpm build` first                                |
| `pnpm build`     | Emits `dist/` from `tsconfig.build.json`; the tests import the package by its own name, which resolves to `dist/` |
