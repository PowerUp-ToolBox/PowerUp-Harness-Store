# Model Gateway Protocol

The **Model Gateway** is the only path from a Harness to a language model. It runs on `127.0.0.1` inside the Runtime, speaks the OpenAI Chat Completions protocol inbound, and forwards to the User's Providers outbound via Vercel AI SDK adapters. Implemented in `packages/gateway`, independent of Electron.

## 1. Discovery and authentication

- Base URL: `$HARNESS_GATEWAY_URL` (form `http://127.0.0.1:<port>/v1`). The port is chosen at app start; Harnesses must read the variable, never hard-code it.
- Every request carries `Authorization: Bearer $HARNESS_GATEWAY_TOKEN` (the scheme name is matched case-insensitively). Tokens are random 256-bit strings (base64url) issued per launch, bound to the claims `{ harnessId, harnessVersion, launchId, issuedAt, locale, workspace? }`, and revoked when the process exits. They have no time-based expiry: a token lives until it is revoked or the Gateway stops, and one launch may hold several. Requests without a valid token get `401 { "error": { "code": "invalid_token" } }`. Revocation is immediate: a request already in flight for a revoked token that has not sent its response headers yet gets the same 401, and a stream already under way ends with an `invalid_token` error event, then `data: [DONE]` (§3).
- The Gateway only listens on loopback (`127.0.0.1`, `::1` or `localhost`). It sets no CORS headers, so a browser page cannot call it directly; the Harness's own local server must proxy if its web UI needs model access (recommended pattern: the Harness backend calls the Gateway).
- The `Host` header must be exactly `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`, where `<port>` is the Gateway's port (the name is matched case-insensitively). Any other `Host`, a malformed one or none gets `403 { "error": { "code": "invalid_host" } }`, whatever the token, so a web page cannot reach the Gateway through DNS rebinding.
- Checks run in this order: `Host`, then the token, then routing. An unknown path without a valid token is therefore `401`, not `404`.

## 2. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/chat/completions` | Chat completion, streaming and non-streaming, with tool calling |
| `GET` | `/v1/models` | Lists the calling Harness's Slots and their current bindings |
| `GET` | `/v1/harness/context` | Non-OpenAI extension: returns `{ harnessId, version, locale, workspace?, slots: {...} }` |

Anything else, including another method on these paths (`HEAD` too), returns `404 { "error": { "code": "not_supported" } }`. Embeddings, images, audio and the Responses API are not part of P0.

`GET /v1/harness/context` answers from the Gateway Token's claims and the Harness's installed Manifest:

```json
{
  "harnessId": "alice/hello",
  "version": "1.2.3",
  "locale": "zh-CN",
  "workspace": "/Users/alice/project",
  "slots": {
    "default": { "description": "Main model", "requirements": { "tools": true } },
    "fast": { "requirements": {} }
  }
}
```

`version` is the Harness Version, `locale` the app's locale at launch, and `workspace` is present only when the launch has a Workspace. `slots` lists every Model Slot the Manifest declares, with its `description` when there is one and its Model Requirements (`{}` when none are declared). It never contains binding data; the current bindings are listed by `GET /v1/models`.

Request bodies are JSON whatever the `Content-Type` says, and at most 20 MB. A body that is larger, is not valid JSON or is not a JSON object gets `400 invalid_request`.

## 3. `POST /v1/chat/completions`

Request body follows OpenAI Chat Completions. Supported fields: `model`, `messages` (text and image-url content parts), `tools`, `tool_choice`, `temperature`, `top_p`, `max_tokens` / `max_completion_tokens`, `stop`, `stream`, `stream_options.include_usage`, `response_format` (`text`, `json_object`, `json_schema` best-effort), `seed` (best-effort), `user` (ignored), `metadata` (ignored). Unsupported fields are ignored, never rejected.

Exactly these fields reach the Provider; everything else is dropped, including `n` (always 1), `presence_penalty` / `frequency_penalty`, `logprobs`, `parallel_tool_calls` and vendor-specific extras. ADR-0005's best-effort forwarding of vendor extras is not built in P0. When both are sent, `max_completion_tokens` wins over `max_tokens`. No inbound header is ever forwarded upstream; the Provider sees only the Connection's credentials.

Validation (`400 invalid_request`, details in `message`):
- `model` (string) and `messages` (non-empty array) are required. A supported field of the wrong type is rejected; `null` counts as absent. `user` and `metadata` are not checked.
- Message roles are `system`, `developer` (sent upstream as `system`), `user`, `assistant` and `tool`; any other role is rejected. System messages stay where the Harness put them.
- Content parts are `text` everywhere, plus `image_url` in `user` messages with an `http(s)` URL (fetched by the Provider, never by the Gateway) or a base64 data URL of an image (`data:image/<type>[;...];base64,<data>`). Any other data URL (a PDF, audio, text, data that is not valid base64), any other part type, or an image outside a `user` message, is rejected.
- A `tool` message's `tool_call_id` must match a `tool_calls` entry of an earlier `assistant` message, and every `tool_calls` entry must get its `tool` message before the next `system`, `developer` or `user` message and before the end of `messages` (as OpenAI requires).
- A `tool_choice` naming a function must name one in `tools`, and `tool_choice: "required"` needs at least one tool.

`tool_choice` is sent to the Provider, never enforced by the Gateway: a reply that ignores it (plain text for `required`, a tool call for `none`) is returned as the Provider sent it.

`response_format` `json_object` and `json_schema` are passed to the Provider as structured-output requests, but the reply is returned as raw text: output that is not valid JSON is never an error. Tools are only described to the Provider; the Gateway never runs one, so each request is a single model call.

`model` is one of:
- a **Slot name** declared in the Harness Manifest (`default`, `fast`, ...), the normal case;
- an explicit **`provider/model`** id (see §6), for advanced Harnesses; allowed only if the User has a Connection for that Provider.

A `model` containing `/` is an explicit id, split at the first `/` (`openrouter/anthropic/claude-sonnet-4-5` is the model `anthropic/claude-sonnet-4-5` at `openrouter`). The Provider part must be a Provider id of §6, or `openai-compatible:<name>` with `<name>` matching `^[a-z0-9][a-z0-9-]*$`, and the model part must be non-empty without whitespace; otherwise the request gets `404 unknown_slot`. A `model` without `/` is a Slot name (Slot names never contain `/`). An explicit id never consults the Slot Bindings; it needs a Connection for its Provider, else `403 provider_not_connected`.

A request is checked in this order: body validation (`400`), then model resolution (`404`, `409`, `403`), then the upstream call (`502`, `504`). Only a request that gets as far as the upstream call reaches a Provider.

Response shape and streaming (`text/event-stream`, `data: {...}` chunks, `data: [DONE]`) follow OpenAI. The `model` field in the response contains the **resolved** `provider/model` so a Harness can display what actually answered. Usage is reported in the final chunk when `stream_options.include_usage` is true and in non-streaming responses, in both cases only when the Provider reported it (see below).

With `stream: true` the Provider is called with streaming too, and the response is `200 text/event-stream`: one `data: <chat.completion.chunk>` event per chunk, then `data: [DONE]`. Every chunk is `{ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] }` with the same `id` (`chatcmpl_<uuid>`), `created` and resolved `model` throughout. In order:
1. A chunk with `delta: { role: "assistant" }`.
2. Content deltas (`delta.content`, as the Provider sent them) and tool-call deltas (`delta.tool_calls`), with `finish_reason: null`. A tool call's fragments share an `index`, 0-based in order of first appearance; its first fragment carries the Provider's tool call `id`, `type: "function"` and `function.name`, and every fragment appends to `function.arguments`, as OpenAI streams them. Concatenated, the fragments give exactly the `tool_calls` entry the non-streaming response would hold at that position.
3. A chunk with `delta: {}` and the `finish_reason`.
4. When `stream_options.include_usage` is true and the Provider reported usage, a usage chunk with `choices: []` and `usage`. When the Provider reported none, there is no usage chunk.
5. `data: [DONE]`.

The response headers are sent only once the Provider's answer has started (its first content, tool call or other output), so a failure before then (validation, resolution, a Provider error status, a first-byte timeout, a revoked token) is an ordinary HTTP error with a JSON body, exactly as without streaming. A failure after the headers went out (the Provider breaking off its response, an idle timeout, a revoked token, the Gateway stopping) ends the stream with one `data: {"error": {...}}` event, the same body as §5 with no `event:` line, then `data: [DONE]`. When the Harness closes the connection before `[DONE]`, the Gateway aborts the upstream request.

A non-streaming response is `{ id: "chatcmpl_<uuid>", object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason }], usage? }`, with `created` in epoch seconds and `message` = `{ role: "assistant", content: string | null, tool_calls? }` (`content` is `null` only when the reply is tool calls alone). `finish_reason` is `stop`, `length`, `tool_calls` or `content_filter`; any other Provider reason is reported as `stop`. Reasoning output is dropped. `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`, and `prompt_tokens_details.cached_tokens` when the Provider reported cached tokens) is present only when the Provider reported both input and output tokens; it is never estimated.

## 4. Slot resolution (normative)

For a request with `model = <slot>` from Harness H:

1. If the User set a **Model Override** for (H, slot) → use it.
2. Else, for each id in the Slot's **Recommended Models** in order: if the User has an enabled Connection for that Provider → use it. (Model existence is not verified at request time; Provider errors propagate.)
3. Else, if the User has a **Default Model** for a Slot with the same name → use it.
4. Else, if the User has a Default Model for `default` → use it.
5. Else → `409 { "error": { "code": "slot_unbound", "slot": "<slot>", "message": "..." } }`. The Runtime also raises a desktop notification linking to the Models page.

Resolution happens per request, so changing a binding in the app takes effect on the Harness's next call without restart. Model Requirements are advisory: the app warns when a binding does not satisfy them, the Gateway never blocks on them.

## 5. Errors

All errors use `{ "error": { "code", "message", "type": "harness_store" | "provider", ... } }`.

| HTTP | code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Body fails validation (details in `message`), is not a JSON object or is larger than 20 MB |
| 401 | `invalid_token` | Missing, unknown or revoked Gateway Token |
| 403 | `invalid_host` | `Host` header is not the Gateway on loopback (§1) |
| 403 | `provider_not_connected` | Explicit `provider/model` for a Provider with no Connection |
| 404 | `not_supported` | Unknown path, or a method the path does not serve (§2) |
| 404 | `unknown_slot` | `model` is neither a declared Slot nor a valid `provider/model` |
| 409 | `slot_unbound` | Resolution found nothing (see §4) |
| 500 | `internal_error` | A Gateway bug or a failing host callback; logged, never retried |
| 502 | `provider_error` | Upstream error; `provider_status` and `provider_message` included verbatim |
| 504 | `provider_timeout` | No response headers within 120 s, or a 120 s gap in the response body |

`type` is `provider` for `provider_error` and `provider_timeout` and `harness_store` for every other code.

`provider_error` carries what the Provider said:
- `provider_status`: the upstream HTTP status, when the Provider answered with an error status. A Provider that could not be reached, or that broke off a response, gives a `provider_error` without it.
- `provider_message`: the upstream `error.message`; else the raw upstream body, cut to 1000 characters; else the network error's message.
- `provider_code`: the upstream `error.code`, when it is a string.

Any occurrence of the Connection's API key in these fields is replaced with `[redacted]`, before the raw body is cut to 1000 characters. The Gateway never retries a failed upstream call.

`provider_timeout` covers two timeouts, both 120 s by default and configurable by the Gateway's host: the Provider's response headers must arrive within the first-byte timeout, and once they have, no gap between two chunks of the response body (streamed or not) may exceed the idle timeout. A timeout aborts the upstream request. On a stream that has already started, a `provider_timeout` or `provider_error` arrives as the stream's final error event (§3) instead of an HTTP status.

Reserved for the cloud Gateway (P2-01), never emitted locally in P0: `402 insufficient_credits`, `429 rate_limited`.

There is no automatic fallback between Providers in P0.

## 6. Provider ids and Connections

A **Provider id** is a fixed string; a **Connection** is the User's credential/endpoint for one Provider. Users may have at most one Connection per Provider in P0, except `openai-compatible` which allows many named endpoints (`openai-compatible:<name>`).

| Provider id | Adapter | Credential | Notes |
|---|---|---|---|
| `anthropic` | @ai-sdk/anthropic | API key | |
| `openai` | @ai-sdk/openai | API key | |
| `google` | @ai-sdk/google | API key | Gemini API |
| `openrouter` | @openrouter/ai-sdk-provider | API key | model ids are OpenRouter's, e.g. `openrouter/anthropic/claude-sonnet-4-5` |
| `ollama` | openai-compatible | none; base URL default `http://127.0.0.1:11434/v1` | auto-detected |
| `lmstudio` | openai-compatible | none; default `http://127.0.0.1:1234/v1` | auto-detected |
| `deepseek` | openai-compatible preset | API key | `https://api.deepseek.com/v1` |
| `qwen` | openai-compatible preset | API key | DashScope compatible endpoint |
| `moonshot` | openai-compatible preset | API key | Kimi |
| `zhipu` | openai-compatible preset | API key | GLM |
| `minimax` | openai-compatible preset | API key | |
| `doubao` | openai-compatible preset | API key | Volcengine Ark |
| `groq` | openai-compatible preset | API key | |
| `openai-compatible` | @ai-sdk/openai-compatible | optional key + base URL | vLLM, custom proxies, anything else |

Presets are data (id, display name, base URL, docs link, key placeholder, whether `/models` listing works). Adding a preset must never require code changes outside the preset table.

Model listing: for each Connection the app calls the Provider's model list where available (`/v1/models` for OpenAI-compatible endpoints and OpenAI; Anthropic and Google use a static list shipped with the app, refreshed with app updates) and lets the User type a model name manually when listing is unavailable.

## 7. Usage Records

On every completed or failed-after-first-byte request the Gateway writes one Usage Record: `{ timestamp, harnessId, harnessVersion, slot, provider, model, promptTokens, completionTokens, cachedPromptTokens?, durationMs, status }`. Token counts come from the Provider response; when absent they are recorded as `null`, never estimated. Records stay local (SQLite) and feed the Usage page. No cost calculation in P0.

## 8. Conformance fixtures

`packages/gateway` ships a **fake Provider** (an OpenAI-compatible HTTP server with scripted responses, including streaming and tool calls) used by its own tests, the Supervisor tests and the desktop E2E suite. Any Provider adapter change must keep the conformance suite green: identical inbound request → equivalent outbound semantics for text, tool calls, images, stop sequences and usage reporting.
