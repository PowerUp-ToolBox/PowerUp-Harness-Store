# @harness-store/gateway

> Status: P0-02.2 (the [fake Provider](#fake-provider-harness-storegatewaytestingfake-provider)) is in. The Model Gateway server and its Provider adapters arrive in the rest of P0-02.

The **Model Gateway**: the local service, hosted by the **Runtime**, that is the only path from a running **Harness** to any model. It is a loopback HTTP server that speaks the OpenAI Chat Completions protocol, authenticates each request with the Harness's per-launch **Gateway Token**, resolves the requested **Model Slot** to the User's **Slot Binding** (Model Override, then Recommended Models, then Default Model), forwards the call to the chosen **Provider** through a **Connection** the Harness never sees, streams the answer back and writes a **Usage Record**.

## What it will contain

- A framework-independent Node HTTP server with no Electron dependency, so it is tested in-process against a fake Provider (the Gateway HTTP seam, [`architecture.md`](../../docs/tech/architecture.md) §8) and can be reused server-side later. The HTTP layer is [Hono](https://hono.dev) on `@hono/node-server`.
- Provider adapters built on the Vercel AI SDK, plus data-only presets for OpenAI-compatible Providers.
- Documented error codes such as `slot_unbound`.

Normative reference: [`docs/tech/gateway-protocol.md`](../../docs/tech/gateway-protocol.md). Spec: [`P0-02`](../../docs/delivery/specs/P0-02-model-gateway-core.md).

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

| Command          | What it does                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `pnpm test`      | Vitest over `test/` (offline: a connection beyond loopback throws); run `pnpm build` first |
| `pnpm lint`      | ESLint with the shared root config                                                         |
| `pnpm typecheck` | `tsc --noEmit` against `tsconfig.json` (sources and tests)                                 |
| `pnpm build`     | Emits `dist/` from `tsconfig.build.json`                                                   |
