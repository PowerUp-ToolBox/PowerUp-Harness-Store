# Model Gateway Protocol

The **Model Gateway** is the only path from a Harness to a language model. It runs on `127.0.0.1` inside the Runtime, speaks the OpenAI Chat Completions protocol inbound, and forwards to the User's Providers outbound via Vercel AI SDK adapters. Implemented in `packages/gateway`, independent of Electron.

## 1. Discovery and authentication

- Base URL: `$HARNESS_GATEWAY_URL` (form `http://127.0.0.1:<port>/v1`). The port is chosen at app start; Harnesses must read the variable, never hard-code it.
- Every request carries `Authorization: Bearer $HARNESS_GATEWAY_TOKEN`. Tokens are random 256-bit strings issued per launch, bound to (Harness ID, version, launch id), and revoked when the process exits. Requests without a valid token get `401 { "error": { "code": "invalid_token" } }`.
- The Gateway only listens on loopback. It rejects requests whose `Host` is not loopback and sets no CORS headers, so a browser page cannot call it directly; the Harness's own local server must proxy if its web UI needs model access (recommended pattern: the Harness backend calls the Gateway).

## 2. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/chat/completions` | Chat completion, streaming and non-streaming, with tool calling |
| `GET` | `/v1/models` | Lists the calling Harness's Slots and their current bindings |
| `GET` | `/v1/harness/context` | Non-OpenAI extension: returns `{ harnessId, version, locale, workspace?, slots: {...} }` |

Anything else returns `404 { "error": { "code": "not_supported" } }`. Embeddings, images, audio and the Responses API are not part of P0.

## 3. `POST /v1/chat/completions`

Request body follows OpenAI Chat Completions. Supported fields: `model`, `messages` (text and image-url content parts), `tools`, `tool_choice`, `temperature`, `top_p`, `max_tokens` / `max_completion_tokens`, `stop`, `stream`, `stream_options.include_usage`, `response_format` (`text`, `json_object`, `json_schema` best-effort), `seed` (best-effort), `user` (ignored), `metadata` (ignored). Unsupported fields are ignored, never rejected.

`model` is one of:
- a **Slot name** declared in the Harness Manifest (`default`, `fast`, ...), the normal case;
- an explicit **`provider/model`** id (see §6), for advanced Harnesses; allowed only if the User has a Connection for that Provider.

Response shape and streaming (`text/event-stream`, `data: {...}` chunks, `data: [DONE]`) follow OpenAI. The `model` field in the response contains the **resolved** `provider/model` so a Harness can display what actually answered. Usage is reported in the final chunk when `stream_options.include_usage` is true and always in non-streaming responses.

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
| 400 | `invalid_request` | Body fails validation (details in `message`) |
| 401 | `invalid_token` | Missing/expired Gateway Token |
| 403 | `provider_not_connected` | Explicit `provider/model` for a Provider with no Connection |
| 404 | `unknown_slot` | `model` is neither a declared Slot nor a valid `provider/model` |
| 409 | `slot_unbound` | Resolution found nothing (see §4) |
| 502 | `provider_error` | Upstream error; `provider_status` and `provider_message` included verbatim |
| 504 | `provider_timeout` | No first byte within 120 s |

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
