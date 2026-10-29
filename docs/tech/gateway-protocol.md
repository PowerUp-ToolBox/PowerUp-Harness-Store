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

`GET /v1/models` lists every Model Slot the Harness's installed Manifest declares, in Manifest order, in the OpenAI list shape so OpenAI SDKs can read it:

```json
{
  "object": "list",
  "data": [
    { "id": "default", "object": "model", "created": 0, "owned_by": "harness-store", "resolved_model": "anthropic/claude-sonnet-5-5" },
    { "id": "fast", "object": "model", "created": 0, "owned_by": "harness-store", "resolved_model": null }
  ]
}
```

`id` is the Slot name, what the Harness sends as `model`. `resolved_model` is the Slot's current Slot Binding as `provider/model` (§4), resolved afresh on every call, or `null` when the Slot is unbound. Which rule of §4 chose the binding is never reported, and the listing does not check that the bound Provider has a Connection (a completion does). A Harness whose Manifest declares no Slots gets `data: []`.

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
- A request the Provider's adapter cannot express for that Provider is rejected too, with the adapter's own message, before anything is sent upstream. Google, for one, takes system messages only before the first `user` or `assistant` message, so a `system` or `developer` message later in the conversation is rejected for a `google` model and accepted for the others.

`tool_choice` is sent to the Provider, never enforced by the Gateway: a reply that ignores it (plain text for `required`, a tool call for `none`) is returned as the Provider sent it.

`response_format` `json_object` and `json_schema` are passed to the Provider as structured-output requests, but the reply is returned as raw text: output that is not valid JSON is never an error. A `json_schema`'s `strict` (a boolean) reaches Providers that take it (`openai`, `openrouter` and the OpenAI-compatible rows) as sent, and as `false` when absent, OpenAI's own default. Tools are only described to the Provider; the Gateway never runs one, so each request is a single model call.

`model` is one of:
- a **Slot name** declared in the Harness Manifest (`default`, `fast`, ...), the normal case;
- an explicit **`provider/model`** id (see §6), for advanced Harnesses; allowed only if the User has an enabled Connection for that Provider.

A `model` containing `/` is an explicit id, split at the first `/` (`openrouter/anthropic/claude-sonnet-4-5` is the model `anthropic/claude-sonnet-4-5` at `openrouter`). The Provider part must be a Provider id of §6, or `openai-compatible:<name>` with `<name>` matching `^[a-z0-9][a-z0-9-]*$`, and the model part must be a valid model name for it; otherwise the request gets `404 unknown_slot`. A model name is non-empty, has no whitespace, `?`, `#`, `%` or `\`, and no empty, `.` or `..` segment between its `/`s, so no adapter can turn it into another request URL. A `google` model name, which the adapter puts into the request path, must also be a Gemini model name: `^(?:(?:models|tunedModels)/)?[A-Za-z0-9][A-Za-z0-9._-]*$`. A `model` without `/` is a Slot name (Slot names never contain `/`). An explicit id never consults the Slot Bindings; it needs an enabled Connection for its Provider (a disabled Connection counts as none), else `403 provider_not_connected`.

A request is checked in this order: body validation (`400`), then model resolution (`404`, `409`, `403`), then the upstream call (`502`, `504`). Only a request that gets as far as the upstream call reaches a Provider.

Response shape and streaming (`text/event-stream`, `data: {...}` chunks, `data: [DONE]`) follow OpenAI. The `model` field in the response contains the **resolved** `provider/model` so a Harness can display what actually answered. Usage is reported in the final chunk when `stream_options.include_usage` is true and in non-streaming responses, in both cases only when the Provider reported it (see below).

With `stream: true` the Provider is called with streaming too, and the response is `200 text/event-stream`: one `data: <chat.completion.chunk>` event per chunk, then `data: [DONE]`. Every chunk is `{ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }] }` with the same `id` (`chatcmpl_<uuid>`), `created` and resolved `model` throughout. In order:
1. A chunk with `delta: { role: "assistant" }`.
2. Content deltas (`delta.content`, as the Provider sent them) and tool-call deltas (`delta.tool_calls`), with `finish_reason: null`. A tool call's fragments share an `index`, 0-based in order of first appearance; its first fragment carries the Provider's tool call `id`, `type: "function"` and `function.name`, and every fragment appends to `function.arguments`, as OpenAI streams them. The argument fragments are the Provider's argument text as it streamed it; argument text that is so far only whitespace is held back until non-whitespace text follows it, and a tool call for which the Provider streamed no argument text, or only whitespace, gets the arguments the non-streaming response would hold (`{}` for a call without arguments) in one fragment, so concatenated arguments are never empty. Concatenated, the fragments give the same tool call as the non-streaming response at that position: the same `id` and `function.name`, and `function.arguments` equal as JSON, though not necessarily byte for byte (the non-streaming response re-serializes the arguments compactly).
3. A chunk with `delta: {}` and the `finish_reason`.
4. When `stream_options.include_usage` is true and the Provider reported usage, a usage chunk with `choices: []` and `usage`. When the Provider reported none, there is no usage chunk.
5. `data: [DONE]`.

The response headers are sent only once the Provider's answer has started (its first content, tool call or other output), so a failure before then (validation, resolution, a Provider error status or in-stream error, a first-byte timeout, a revoked token) is an ordinary HTTP error with a JSON body, exactly as without streaming. A failure after the headers went out (the Provider breaking off its response or sending an in-stream error, an idle timeout, a revoked token) ends the stream with one `data: {"error": {...}}` event, the same body as §5 with no `event:` line, then `data: [DONE]`. When the Gateway stops, it drops open connections with no final event. When the Harness closes the connection before `[DONE]`, the Gateway aborts the upstream request.

A non-streaming response is `{ id: "chatcmpl_<uuid>", object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason }], usage? }`, with `created` in epoch seconds and `message` = `{ role: "assistant", content: string | null, tool_calls? }` (`content` is `null` only when the reply is tool calls alone). `finish_reason` is `stop`, `length`, `tool_calls` or `content_filter`; any other Provider reason is reported as `stop`. Reasoning output is dropped. `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`, and `prompt_tokens_details.cached_tokens` when the Provider reported cached tokens) is present only when the Provider reported both input and output tokens; it is never estimated.

## 4. Slot resolution (normative)

For a request with `model = <slot>` from Harness H:

1. If the User set a **Model Override** for (H, slot) → use it.
2. Else, for each id in the Slot's **Recommended Models** in order: if the User has an enabled Connection for that Provider → use it. (Model existence is not verified at request time; Provider errors propagate.)
3. Else, if the User has a **Default Model** for a Slot with the same name → use it.
4. Else, if the User has a Default Model for `default` → use it.
5. Else → `409 { "error": { "code": "slot_unbound", "slot": "<slot>", "message": "..." } }`. The Runtime also raises a desktop notification linking to the Models page.

At every step, a binding or Recommended Model whose Connection is disabled or has been removed counts as absent, so resolution falls through to the next step; reachability is the Connection's enabled flag, never the result of its last test. Removing a Connection also deletes every Slot Binding that uses it.

Resolution happens per request, so changing a binding in the app takes effect on the Harness's next call without restart. Model Requirements are advisory: the app warns when a binding does not satisfy them, the Gateway never blocks on them.

The order above is implemented by the Gateway's host (the desktop app's binding service), which the Gateway asks for the Slot Binding on every request; the Gateway caches neither the Manifest nor any binding. For a request whose `model` is a Slot name, the Gateway:
- answers `404 unknown_slot` when the Harness's installed Manifest does not declare that Slot, without resolving anything;
- answers `409 slot_unbound` (with the `slot` field) when the host finds no binding, and tells the Runtime so it can raise the notification of step 5;
- otherwise uses the binding's `provider/model` exactly like an explicit id (§3): the Provider needs a Connection, else `403 provider_not_connected`, and the response's `model` is the bound `provider/model`.

A binding whose Provider id is not one of §6 or whose model name is not a valid model name for that Provider (§3) is a host bug and gets `500 internal_error`.

## 5. Errors

All errors use `{ "error": { "code", "message", "type": "harness_store" | "provider", ... } }`.

| HTTP | code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Body fails validation (details in `message`), is not a JSON object or is larger than 20 MB, or asks for something the Provider's adapter cannot express (§3) |
| 401 | `invalid_token` | Missing, unknown or revoked Gateway Token |
| 403 | `invalid_host` | `Host` header is not the Gateway on loopback (§1) |
| 403 | `provider_not_connected` | The Provider of an explicit `provider/model`, or of a Slot's binding, has no Connection |
| 404 | `not_supported` | Unknown path, or a method the path does not serve (§2) |
| 404 | `unknown_slot` | `model` is neither a declared Slot nor a valid `provider/model` |
| 409 | `slot_unbound` | Resolution found nothing (see §4); `slot` names the Slot |
| 500 | `internal_error` | A Gateway bug or a failing host callback; logged, never retried |
| 502 | `provider_error` | Upstream error; `provider_status` and `provider_message` included verbatim |
| 504 | `provider_timeout` | No response headers within 120 s, or a 120 s gap in the response body |

`type` is `provider` for `provider_error` and `provider_timeout` and `harness_store` for every other code.

`provider_error` carries what the Provider said:
- `provider_status`: the upstream HTTP status, when the Provider answered with an error status. A Provider that could not be reached, that broke off a response, or that reported the error inside a `200` stream (`data: {"error": {...}}`, as OpenRouter, vLLM and Ollama do) gives a `provider_error` without it.
- `provider_message`: the upstream `error.message` (of the error body, or of the in-stream error); else the raw upstream body, cut to 1000 characters; else the network error's message.
- `provider_code`: the upstream `error.code`, when it is a string.

Any occurrence of the Connection's API key in these fields is replaced with `[redacted]`, before the raw body is cut to 1000 characters. The Gateway never retries a failed upstream call.

`provider_timeout` covers two timeouts, both 120 s by default and configurable by the Gateway's host: the Provider's response headers must arrive within the first-byte timeout, and once they have, no gap between two chunks of the response body (streamed or not) may exceed the idle timeout. A timeout aborts the upstream request. On a stream that has already started, a `provider_timeout` or `provider_error` arrives as the stream's final error event (§3) instead of an HTTP status.

Reserved for the cloud Gateway (P2-01), never emitted locally in P0: `402 insufficient_credits`, `429 rate_limited`.

There is no automatic fallback between Providers in P0.

## 6. Provider ids and Connections

A **Provider id** is a fixed string; a **Connection** is the User's credential/endpoint for one Provider. Users may have at most one Connection per Provider in P0, except `openai-compatible` which allows many named endpoints (`openai-compatible:<name>`, where `<name>` is a slug made from the endpoint's display name when it is added and never changes on rename).

| Provider id | Adapter | Credential | Notes |
|---|---|---|---|
| `anthropic` | @ai-sdk/anthropic | API key | `https://api.anthropic.com/v1` |
| `openai` | @ai-sdk/openai | API key | `https://api.openai.com/v1`, Chat Completions |
| `google` | @ai-sdk/google | API key | Gemini API, `https://generativelanguage.googleapis.com/v1beta` |
| `openrouter` | @openrouter/ai-sdk-provider | API key | `https://openrouter.ai/api/v1`; model ids are OpenRouter's, e.g. `openrouter/anthropic/claude-sonnet-4-5` |
| `ollama` | openai-compatible | none; base URL default `http://127.0.0.1:11434/v1` | auto-detected |
| `lmstudio` | openai-compatible | none; default `http://127.0.0.1:1234/v1` | auto-detected |
| `deepseek` | openai-compatible preset | API key | `https://api.deepseek.com/v1` |
| `qwen` | openai-compatible preset | API key | DashScope compatible mode, `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `moonshot` | openai-compatible preset | API key | Kimi, `https://api.moonshot.cn/v1` |
| `zhipu` | openai-compatible preset | API key | GLM, `https://open.bigmodel.cn/api/paas/v4` |
| `minimax` | openai-compatible preset | API key | `https://api.minimax.cn/v1` |
| `doubao` | openai-compatible preset | API key | Volcengine Ark, `https://ark.cn-beijing.volces.com/api/v3` |
| `groq` | openai-compatible preset | API key | `https://api.groq.com/openai/v1` |
| `openai-compatible` | @ai-sdk/openai-compatible | optional key + base URL | vLLM, custom proxies, anything else |

Presets are data (id, display name, base URL, docs link, key placeholder, whether `/models` listing works). Adding a preset must never require code changes outside the preset table.

The base URL in the table is the Provider's default; a Connection's own base URL replaces it (an international account of a Chinese vendor, such as `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, or Ollama on another port). Where a vendor has a mainland-China and an international endpoint, the default is the mainland-China one. `openai-compatible` has no default: its Connections must name a base URL. Every Provider except `ollama`, `lmstudio` and `openai-compatible` needs an API key; the Gateway never falls back to an SDK's environment variables (`OPENAI_API_KEY` and the like). Model names are passed to the Provider exactly as written after the Provider id, once they pass the model name check of §3.

Model listing: for each Connection the app calls the Provider's model list where available (`/v1/models` for OpenAI-compatible endpoints and OpenAI; Anthropic and Google use a static list shipped with the app, refreshed with app updates) and lets the User type a model name manually when listing is unavailable.

## 7. Usage Records

For every request it attempted an upstream call for, whatever the outcome, the Gateway writes exactly one Usage Record: `{ timestamp, harnessId, harnessVersion, slot, provider, model, promptTokens, completionTokens, cachedPromptTokens?, durationMs, status }`. A request answered before any upstream call (`invalid_token`, `invalid_request`, `unknown_slot`, `slot_unbound`, `provider_not_connected`) writes none: no Provider was contacted. Stopping the Gateway completes only once the Usage Records of the requests it stopped have been written.

- `status`: `ok`; `provider_error` for any upstream failure, before or after the first byte (a refused connection included); `timeout` for the first-byte or idle timeout; `aborted` when the Harness disconnected, its Gateway Token was revoked or the Gateway closed.
- `timestamp`: when the request arrived, ISO-8601 UTC. `durationMs`: from then until the response ended (for a stream, its last event), whole milliseconds, at least 1.
- `slot`: the Model Slot asked for, `null` for an explicit `provider/model` id. `provider`: the full Provider id (`openai-compatible:vllm`). `model`: the model name without the Provider prefix.
- Token counts come only from the Provider response: each one it did not report is `null`, never estimated. `cachedPromptTokens` is present only when the Provider reported cached prompt tokens.

Records are handed to the host after the response ended, off the request's critical path. They stay local (SQLite) and feed the Usage page. No cost calculation in P0.

## 8. Conformance fixtures

`packages/gateway` ships a **fake Provider** (an OpenAI-compatible HTTP server with scripted responses, including streaming and tool calls) used by its own tests, the Supervisor tests and the desktop E2E suite. Any Provider adapter change must keep the conformance suite green: identical inbound request → equivalent outbound semantics for text, tool calls, images, stop sequences and usage reporting. The suite runs one scenario set (text, streaming, structured output, stop sequences, tool calls, parallel tool calls, a stream without usage, images, Provider errors, rate limits, timeouts) through the Gateway against every Provider whose adapter speaks the OpenAI wire format (`openai`, `openrouter` and every OpenAI-compatible row of §6), with the fake standing in for the Provider; it reads the Provider list from the Provider table, so a new preset is covered automatically. Anthropic and Google are checked against canned answers in their own wire formats (for Anthropic, streamed text and tool calls with usage too). The text, streaming and tool-call scenarios also run against real Anthropic, OpenAI and one OpenAI-compatible endpoint when a developer sets `CONFORMANCE_*` API keys; without them those tests are skipped, never failed.
