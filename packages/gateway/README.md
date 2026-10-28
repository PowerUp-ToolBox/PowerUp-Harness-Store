# @harness-store/gateway

> Status: P0-02.1 (the [Gateway server](#the-gateway-server) with Gateway Token auth and `GET /v1/harness/context`), P0-02.2 (the [fake Provider](#fake-provider-harness-storegatewaytestingfake-provider)), P0-02.3 ([non-streaming chat completions](#post-v1chatcompletions) for explicit `provider/model` ids through the `openai-compatible` adapter), P0-02.4 ([streaming](#streaming), tool calls, image parts and usage), P0-02.5 ([Model Slot resolution](#model-slots-and-get-v1models) and `GET /v1/models`) and P0-02.6 ([every Provider adapter](#providers-and-adapters) and the conformance suite) are in. Usage Records arrive with P0-02.7.

The **Model Gateway**: the local service, hosted by the **Runtime**, that is the only path from a running **Harness** to any model. It is a loopback HTTP server that speaks the OpenAI Chat Completions protocol, authenticates each request with the Harness's per-launch **Gateway Token**, resolves the requested **Model Slot** to the User's **Slot Binding** (Model Override, then Recommended Models, then Default Model), forwards the call to the chosen **Provider** through a **Connection** the Harness never sees, streams the answer back and writes a **Usage Record**.

The HTTP layer is [Hono](https://hono.dev) on `@hono/node-server`, with no Electron dependency, so the Gateway is tested in-process against the fake Provider (the Gateway HTTP seam, [`architecture.md`](../../docs/tech/architecture.md) §8) and can be reused server-side later. Provider adapters are built on the Vercel AI SDK (`ai`), with data-only presets for OpenAI-compatible Providers.

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
- `issueToken(claims)` returns 32 random bytes, base64url. Tokens live until `revokeToken(token)`, `revokeLaunch(launchId)` (every token of that launch) or `close()`. Revoking fails the matching requests in flight with 401 `invalid_token`, or ends their open streams with an `invalid_token` error event and `[DONE]`.
- The Gateway is an `EventEmitter`. It emits `slot_unbound` with `{ harnessId, slot }` for every request that gets 409 `slot_unbound` (the Runtime's cue for the "needs a model" notification; a throwing listener is logged and does not change the response), and `usage` with each Usage Record once Usage Records land (P0-02.7).
- Every request is checked in this order: the `Host` header (`127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`, else 403 `invalid_host`), the Gateway Token (else 401 `invalid_token`), then routing (else 404 `not_supported`). No response carries a CORS header.
- `GET /v1/harness/context` answers `{ harnessId, version, locale, workspace?, slots }` from the token's claims and the Manifest from `getManifest` (called on every request, never cached; `null` gives `slots: {}`).
- `firstByteTimeoutMs` bounds the wait for a Provider's response headers, `streamIdleTimeoutMs` the gap between two chunks of its response body; either one running out fails the request with 504 `provider_timeout` and aborts the upstream call.

### `POST /v1/chat/completions`

One pipeline per request, in the order the protocol fixes:

1. **Validate** the body ([`src/openai/request.ts`](src/openai/request.ts), zod with loose objects): unknown fields are ignored, a supported field of the wrong type is 400 `invalid_request`.
2. **Resolve** `model` ([`src/slots.ts`](src/slots.ts)): a Slot name resolves to its current Slot Binding ([below](#model-slots-and-get-v1models)); an explicit `provider/model` id is used as is, and a malformed one is 404 `unknown_slot`. Either way `getConnection(providerId)` must return a Connection, else 403 `provider_not_connected`.
3. **Translate and call** ([`src/openai/translate.ts`](src/openai/translate.ts)): exactly the protocol's fields go to `generateText` (or `streamText` for `stream: true`) with `maxRetries: 0` and tools without `execute`, through the Provider's adapter ([`src/adapters.ts`](src/adapters.ts)) and the Gateway's timed `fetch` ([`src/upstream-fetch.ts`](src/upstream-fetch.ts)). No inbound header reaches the Provider.
4. **Answer** an OpenAI `chat.completion` (or [a stream](#streaming)) whose `model` is the resolved `provider/model`, or map the failure ([`src/provider-errors.ts`](src/provider-errors.ts)) to 502 `provider_error` (`provider_status`, `provider_message`, `provider_code`, the Connection's key redacted) or 504 `provider_timeout`.

Every Provider id of the protocol has an adapter ([below](#providers-and-adapters)).

Tool calls (parallel ones included) come back as `tool_calls`, in the order the Provider made them; `image_url` parts (http(s) URLs, which the Provider fetches, or base64 data URLs) reach the Provider as AI SDK file parts, and a Provider that refuses an image answers an ordinary `provider_error`. `usage` is present only when the Provider reported both input and output tokens, never estimated.

#### Streaming

`stream: true` streams from the Provider and answers `text/event-stream` ([`src/openai/stream.ts`](src/openai/stream.ts)): a `delta.role` chunk, content and index-addressed tool-call fragments as OpenAI sends them, a `delta: {}` chunk with the `finish_reason`, a usage chunk (`choices: []`) when `stream_options.include_usage` is true and the Provider reported usage, then `data: [DONE]`. Every chunk carries the same `chatcmpl_<uuid>`.

The 200 headers wait for the Provider's first output, so every failure before it is an ordinary HTTP error. A failure after it (the Provider breaking off or sending an in-stream `{"error":{...}}`, the idle timeout, a revoked token) ends the stream with `data: {"error":{...}}` and `data: [DONE]`; `close()` drops open streams with no final event. A Harness that disconnects mid-stream aborts the upstream request; the request stays in flight (revocable) until its stream ends, and is logged then, with its whole duration and the code of the error event it ended with (`streamError`).

Tool-call argument fragments are the Provider's text as streamed: concatenated, they equal the non-streaming `arguments` as JSON, not necessarily byte for byte. A call the Provider streamed no argument text for gets its parsed arguments (`{}`) in one fragment.

#### Model Slots and `GET /v1/models`

The Gateway does not implement the resolution order (Model Override, Recommended Models, Default Model); the host's `resolveBinding` does. The Gateway asks it, and `getManifest`, on every request and caches nothing, so a binding changed in the app applies to the Harness's very next call. For a Slot name in `model`:

| The host says                                       | The Harness gets                                                                                                             |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| The Manifest does not declare the Slot (or is null) | 404 `unknown_slot`; `resolveBinding` is not called                                                                           |
| `resolveBinding` returns `null`                     | 409 `slot_unbound` with `slot`, and the Gateway emits `slot_unbound`                                                         |
| `resolveBinding` returns a `Binding`                | The completion from `binding.providerId`/`binding.model`, as an explicit id would get it; `source` never reaches the Harness |
| A `Binding` with an invalid Provider id or model    | 500 `internal_error`, logged                                                                                                 |

`GET /v1/models` answers `{ object: 'list', data: [{ id: <slot>, object: 'model', created: 0, owned_by: 'harness-store', resolved_model: 'provider/model' | null }] }` (type `ModelList`), one entry per declared Slot in Manifest order, calling `resolveBinding` for each Slot on every call. It never checks Connections and never reaches a Provider.

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

## Providers and adapters

One table, `PROVIDERS` ([`src/providers.ts`](src/providers.ts), exported for the desktop app), describes every Provider of protocol §6, one row each: `{ id, displayName, adapter, baseUrl?, requiresKey, supportsModelList, docsUrl, keyPlaceholder }`. `PROVIDER_IDS` (and the `ProviderId` type) is derived from it, and a test fails when it drifts from the protocol's table. [`src/adapters.ts`](src/adapters.ts) picks the row by the part of the Provider id before any `:` (`openai-compatible:vllm` uses the `openai-compatible` row) and builds the row's adapter:

| `adapter`           | Package                       | Providers                                                                                                          |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `anthropic`         | `@ai-sdk/anthropic`           | `anthropic`                                                                                                        |
| `openai`            | `@ai-sdk/openai` (Chat API)   | `openai`                                                                                                           |
| `google`            | `@ai-sdk/google`              | `google`                                                                                                           |
| `openrouter`        | `@openrouter/ai-sdk-provider` | `openrouter`; model names are OpenRouter's (`anthropic/claude-sonnet-4-5`), passed through unchanged               |
| `openai-compatible` | `@ai-sdk/openai-compatible`   | `ollama`, `lmstudio`, `deepseek`, `qwen`, `moonshot`, `zhipu`, `minimax`, `doubao`, `groq` and `openai-compatible` |

- A Connection's `baseUrl` overrides the row's default (an international account, Ollama on another port). The generic `openai-compatible` row has no default, so its Connections must carry one.
- A row with `requiresKey` needs the Connection's `apiKey`; Ollama, LM Studio and `openai-compatible` work without one (`{}` is a valid Ollama Connection). Keys and base URLs are always passed explicitly, so no SDK ever reads `OPENAI_API_KEY`, `ANTHROPIC_BASE_URL` or the like from the environment.
- A Connection that lacks what its row needs, or a Provider id no row serves, fails the request with 500 `internal_error`.
- http(s) image URLs are always handed to the Provider as URLs, whichever adapter; the Gateway never downloads them.

A new OpenAI-compatible preset is one new row with `adapter: 'openai-compatible'` (and a new line in protocol §6): nothing else changes.

### Conformance suite

[`test/conformance.test.ts`](test/conformance.test.ts) runs one scenario set (echo, streamed echo, tool call streamed and not, parallel tool calls, stream without usage, images, Provider 500, rate limit, timeout) through the Gateway against every row whose adapter speaks the OpenAI wire format (`openai`, `openrouter`, `openai-compatible`), each with its Connection pointed at the fake Provider. [`test/providers.test.ts`](test/providers.test.ts) checks every row's endpoint and credentials, a throwaway preset row, and Anthropic and Google against canned answers in their own wire formats.

[`test/conformance-live.test.ts`](test/conformance-live.test.ts) runs the text, streaming and tool-call scenarios against real Providers, each only when its variables are set (otherwise its tests are reported as skipped). It reads nothing but these, so a developer's own keys never spend money during `pnpm test`:

| Variables                                                                                                     | Provider                        | Default model      |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------ |
| `CONFORMANCE_ANTHROPIC_API_KEY`, `CONFORMANCE_ANTHROPIC_MODEL`                                                | `anthropic`                     | `claude-haiku-4-5` |
| `CONFORMANCE_OPENAI_API_KEY`, `CONFORMANCE_OPENAI_MODEL`                                                      | `openai`                        | `gpt-4.1-mini`     |
| `CONFORMANCE_OPENAI_COMPATIBLE_BASE_URL`, `CONFORMANCE_OPENAI_COMPATIBLE_MODEL` (and `..._API_KEY` if needed) | an `openai-compatible` endpoint | none               |

```sh
CONFORMANCE_ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @harness-store/gateway test conformance-live
```

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
