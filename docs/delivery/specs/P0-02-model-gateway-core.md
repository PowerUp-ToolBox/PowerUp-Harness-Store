---
spec_id: P0-02
title: Model Gateway core
phase: P0
blocked_by: [P0-01]
requirements: [R-0201, R-0202, R-0203, R-0204, R-0205, R-0206, R-0207, R-0208]
---

# P0-02 Model Gateway core

## Problem Statement

A Harness author today has to pick a model vendor, ship credential handling, and support each vendor's API separately; a User who prefers a local model or a Chinese Provider simply cannot run that Harness. The platform's promise is that any Harness runs on any model the User can reach, without the Harness ever seeing credentials. That requires one local service that every Harness talks to in one protocol, that resolves "which model" from the User's choices, and that accounts for every token.

## Solution

The Model Gateway: a loopback HTTP server, implemented as a standalone Node package with no Electron dependency, that accepts OpenAI Chat Completions requests authenticated by a per-launch Gateway Token, resolves Model Slots to the User's Slot Bindings, forwards through Vercel AI SDK Provider adapters (including data-only presets for OpenAI-compatible vendors), streams responses back, maps errors to documented codes and writes one Usage Record for every request it forwards to a Provider. `docs/tech/gateway-protocol.md` is normative for the wire behaviour; this spec covers what must be built around it.

## User Stories

1. As a Harness author, I want to point any OpenAI SDK at `OPENAI_BASE_URL` with `OPENAI_API_KEY` and have it just work, so that I do not learn a new API.
2. As a Harness author, I want to send `model: "default"` and get whatever the User bound, so that I never hard-code a vendor.
3. As a Harness author, I want the response's `model` field to say which real `provider/model` answered, so that I can show it in my UI.
4. As a Harness author, I want streaming with `stream: true` and usage in the final chunk when I ask for it, so that my UI feels live and I can show cost.
5. As a Harness author, I want tool calling (parallel tool calls, `tool_choice`) to behave like OpenAI's, so that my agent loop is portable.
6. As a Harness author, I want image content parts to reach vision-capable models and get a clear error otherwise, so that I can build multimodal Harnesses.
7. As a Harness author, I want `GET /v1/models` to list my Slots with their current bindings, so that I can render a model picker inside my Harness.
8. As a Harness author, I want `GET /v1/harness/context` to tell me my Harness ID, version, locale and Workspace, so that I do not parse environment variables by hand.
9. As a Harness author, I want a distinct `slot_unbound` error, so that I can tell the User to bind a model instead of showing a generic failure.
10. As a Harness author, I want unsupported request fields ignored rather than rejected, so that SDK upgrades do not break me.
11. As a Harness author, I want explicit `provider/model` ids accepted when the User has that Provider connected, so that advanced Harnesses can pin a model.
12. As a User, I want my API keys to never be visible to any Harness process, so that a bad Harness cannot steal them.
13. As a User, I want a Harness to be unable to call the Gateway after I close it, so that stale processes cannot keep spending my money.
14. As a User, I want one Harness unable to impersonate another, so that Usage Records are trustworthy.
15. As a User, I want changing a binding in the app to affect the very next request, so that I can switch models mid-session.
16. As a User, I want Provider errors (rate limits, invalid key, model not found) passed through with the Provider's own message, so that I can act on them.
17. As a User, I want no silent fallback to another model, so that I always know which model and account was used.
18. As a User, I want every request recorded with tokens, model, Harness and duration, so that I can see where usage goes.
19. As a User, I want the Gateway to only listen on my machine, so that other devices on my network cannot use my keys.
20. As a User with Ollama, I want the Gateway to talk to it with no API key, so that local models are zero-config.
21. As a User of DeepSeek/Qwen/Kimi/GLM/MiniMax/Doubao/Groq, I want presets with the right base URL, so that I only paste a key.
22. As a User with a custom vLLM or proxy endpoint, I want a generic OpenAI-compatible Provider with a name, base URL and optional key, and more than one of them, so that any endpoint works.
23. As a developer, I want the Gateway to start in-process with a config object and a binding-lookup callback, so that tests and the desktop app embed it the same way.
24. As a developer, I want a fake Provider server with scripted responses (text, streaming, tool calls, errors, missing usage), so that all tests run offline.
25. As a developer, I want a conformance suite that runs the same scenarios against every adapter, so that a new adapter cannot regress semantics.
26. As a developer, I want request metadata logged at debug level, never message content, with keys and tokens redacted, so that I can diagnose issues without leaking secrets.
27. As a developer, I want the Gateway reusable server-side later (P2), so that the same code handles cloud credits.
28. As an operator of the P2 cloud Gateway (future), I want the token verifier pluggable, so that JWTs can replace launch tokens without touching routing.

## Implementation Decisions

- **Package**: `packages/gateway` exports `createGateway(options): Gateway`. The `Gateway` is a typed `EventEmitter` with `listen(host = '127.0.0.1', port = 0)`, `close()`, `issueToken(claims)`, `revokeToken(token)` and `revokeLaunch(launchId)`, and emits `usage` (each Usage Record) and `slot_unbound` (`{ harnessId, slot }`, the Runtime's cue for the "needs a model" notification of `docs/ux/flows.md`). The HTTP layer is Hono on `@hono/node-server`, served by one small loopback helper (serve on loopback, report the port, close cleanly) shared with the fake Provider; code stays runtime-portable where cheap (Web Crypto for random bytes) so the same app can later run server-side.
- **Lifecycle**: `listen()` accepts only `127.0.0.1`, `::1` and `localhost`, and resolves to `{ port, url }` where `url` is exactly `HARNESS_GATEWAY_URL` (`http://<host>:<port>/v1`, IPv6 in brackets). A second `listen()`, or one after `close()`, rejects. `close()` is idempotent: it revokes every token, aborts every request in flight, force-closes sockets (open streams are dropped with no final event), stops listening, and resolves only once the Usage Records of the requests it stopped have been delivered.
- **Options and host-facing types** (decision-encoding snippet):
  ```ts
  type GatewayOptions = {
    resolveBinding(ctx: { harnessId: string; slot: string }): Promise<Binding | null>  // implements normative order
    getConnection(providerId: string): Promise<ConnectionSecret | null>                // decrypted just-in-time; null = none or disabled
    getManifest(harnessId: string): Promise<Manifest | null>                           // every request, never cached; null = no Slots
    onUsage(record: UsageRecord): Promise<void>                                        // after the response ended; rejection logged
    tokenVerifier?: TokenVerifier                                                       // default: in-memory launch tokens
    logger?: Logger                                                                     // default: debug dropped, errors to console.error
    firstByteTimeoutMs?: number                                                         // default 120 000
    streamIdleTimeoutMs?: number                                                        // default 120 000
  }
  type Binding = { providerId: string; model: string; source: 'override' | 'recommended' | 'default_same_name' | 'default' }
  type ConnectionSecret = { apiKey?: string; baseUrl?: string }                         // baseUrl overrides the Provider's default
  type TokenVerifier = { issue(claims): string; verify(token): GatewayTokenClaims | null; revoke(token): void; revokeLaunch(launchId): void }
  type Logger = { debug(message, fields?): void; error(message, fields?): void }
  ```
  The Gateway itself is stateless apart from its Gateway Tokens and the registry of requests in flight; all User data comes through callbacks, which keeps it testable and reusable. A callback that throws, rejects or breaks its contract (for example a Binding whose Provider id or model name is invalid), and anything else unexpected, gives `500 internal_error` and is logged.
- **Gateway Tokens**: claims `{ harnessId, harnessVersion, launchId, issuedAt, locale, workspace? }`. `issueToken` takes the claims without `issuedAt`; the Gateway stamps it (epoch ms). `locale` and the optional Workspace come from the Runtime at launch (P0-05), and `GET /v1/harness/context` answers from them. Tokens are 32 random bytes, base64url, with no time-based expiry: a token lives until it is revoked or the Gateway closes, and one launch may hold several. The default verifier keys its table by SHA-256(token), never by the raw token. The Bearer scheme is matched case-insensitively. The Gateway (not the verifier) registers each request in flight by launch and token hash, so `revokeToken`/`revokeLaunch` take effect immediately: a request that has not sent its headers gets `401 invalid_token`, a stream already under way ends with an `invalid_token` error event and `[DONE]`.
- **Request checks**: `Host` first (only `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`, else `403 invalid_host`, whatever the token), then the token (`401`), then routing (`404 not_supported`, including other methods and `HEAD`), so an unknown path is `401` without a valid token. No CORS headers. Request bodies are parsed as JSON whatever the `Content-Type`; a body over 20 MB, not valid JSON or not a JSON object is `400 invalid_request`. All of this is recorded in `docs/tech/gateway-protocol.md` §1–§2.
- **`GET /v1/harness/context`** answers `{ harnessId, version, locale, workspace?, slots }`, with `slots` taken straight from the Manifest (`description` when present, Model Requirements, `{}` when none). It never carries binding data; bindings are listed only by `GET /v1/models`.
- **Model resolution**: a `model` containing `/` is an explicit id, split at the first `/`; the Provider part must be a Provider id or `openai-compatible:<name>`, and the model part must pass the model-name check of protocol §3 (which also stops a name from rewriting an adapter's request URL), else `404 unknown_slot`. Explicit ids never call `getManifest` or `resolveBinding`. A `model` without `/` is a Slot name: undeclared in the Manifest → `404 unknown_slot` without resolving; `resolveBinding` returning `null` → `409 slot_unbound` plus the `slot_unbound` event. In both paths `getConnection(providerId)` returning `null` (no Connection, a deleted one behind an override, or a disabled one) is `403 provider_not_connected`; the Gateway has no notion of "enabled". The response's `model` is always `<providerId>/<model>`.
- **`GET /v1/models`** keeps the OpenAI list shape so OpenAI SDKs can read it: one `{ id: <slot>, object: 'model', created: 0, owned_by: 'harness-store', resolved_model: 'provider/model' | null }` per declared Slot, in Manifest order, resolved afresh on every call. Binding `source` never reaches a Harness, and the listing does not check Connections. (This replaces an object keyed by Slot name with `unbound: true`.)
- **Adapters**: one data table keyed by Provider id covers all 14 ids: `{ id, displayName, adapter: 'anthropic' | 'openai' | 'google' | 'openrouter' | 'openai-compatible', baseUrl?, requiresKey, supportsModelList, docsUrl, keyPlaceholder }`. The exported Provider id list is derived from it, and the adapter is picked by the Provider id's part before `:`. A Connection's base URL overrides the row's default (international accounts, Ollama on another port, the fake standing in for any preset). Keys and base URLs are always passed explicitly, so no SDK reads `OPENAI_API_KEY` or similar from the environment; a row that needs a key and a Connection without one is `500 internal_error`. `openai` uses Chat Completions (not Responses), so it also runs against the fake; OpenRouter runs in strict mode so streams report usage. Preset base URLs default to the mainland-China endpoints (protocol §6); MiniMax uses `api.minimax.cn/v1`, the base URL in MiniMax's current docs. Adding an OpenAI-compatible preset is one table row.
- **Translation**: inbound bodies are validated with zod on loose objects (rules in protocol §3: required fields, roles with `developer` sent as `system`, content parts, tool-call/tool-result pairing, `tool_choice` naming a known tool). Exactly the protocol §3 field list is forwarded; `max_completion_tokens` wins over `max_tokens`; `n`, penalties, `logprobs`, `parallel_tool_calls` and vendor extras are dropped, and no inbound header ever goes upstream. Every AI SDK call uses `maxRetries: 0`, and tools never get `execute`, so each request is a single model call and the Gateway never runs a tool. `tool_choice` is passed to the Provider but not enforced: a reply that ignores it is returned as sent. `response_format` `json_object`/`json_schema` become a structured-output request (with the request's `strict`, `false` when absent), but the reply is returned as raw text and invalid JSON is never an error. A request an adapter cannot express for its Provider (Google with a mid-conversation system message) is `400 invalid_request`. Non-streaming `message` is `{ role: 'assistant', content: string | null, tool_calls? }`; finish reasons map to `stop`, `length`, `tool_calls`, `content_filter`, anything else to `stop`; reasoning output is dropped. Response `id` is `chatcmpl_<uuid>`, `created` epoch seconds.
- **Streaming**: the upstream call streams only when the client asked for `stream: true`. The `200 text/event-stream` headers are sent only when the first stream part other than `start`/`start-step` arrives, so any failure before then is an ordinary HTTP error. The chunk sequence (role chunk, content and 0-indexed tool-call deltas with Provider ids passed through, a `delta: {}` chunk with `finish_reason`, the usage chunk when asked for and reported, `[DONE]`) and the mid-stream error event (`data: {"error": {...}}` with no `event:` line, then `[DONE]`) are normative in protocol §3. A client disconnect aborts the upstream request.
- **Usage on the wire**: `usage` (response body or usage chunk) appears only when the Provider reported both input and output tokens; `prompt_tokens_details.cached_tokens` only when the Provider reported cached tokens. Adapters are always created with upstream usage on; the Gateway decides what reaches the client.
- **Images**: `image_url` parts in `user` messages pass to the adapter as file parts. http(s) URLs are handed over as URLs and never downloaded by the Gateway; data URLs must be base64 images, anything else is `400 invalid_request`. A Provider that rejects an image answers a `provider_error`.
- **Timeouts**: implemented in a custom `fetch` handed to every adapter. First byte means the upstream response headers arrived; idle means a gap between upstream body chunks, streamed or not. Both default to 120 s, are configurable, abort the upstream call and give `504 provider_timeout` (an error event once a stream has started).
- **Errors**: every error body is `{ error: { code, message, type: 'harness_store' | 'provider', ... } }`; `type` is `provider` for `provider_error` and `provider_timeout`, `harness_store` otherwise. Completions are checked in the order body validation (`400`), model resolution (`404`, `409`, `403`), upstream call. `provider_error` carries `provider_status` (only when the Provider answered with an error status; a refused connection, a broken-off response or an in-stream error has none), `provider_message` and `provider_code` per protocol §5, with the Connection's API key replaced by `[redacted]` before any truncation. The Gateway never retries.
- **Usage Record**: one per request for which the adapter actually called the Gateway's upstream `fetch`, whatever the outcome; requests answered before that write none. `status` is `ok`, `provider_error` (any upstream failure, before or after the first byte), `timeout` (first-byte or idle) or `aborted` (client disconnect, revoke or `close()`). `timestamp` is the ISO-8601 UTC arrival time, `durationMs` an integer ≥ 1 to the end of the response, `provider` the full Provider id, `model` the name without the Provider prefix, `slot` `null` for an explicit id. Token counts are the Provider's own, each `null` when not reported, never estimated; `cachedPromptTokens` only when reported. Records are delivered after the response ended, off the critical path: `onUsage` first (a rejection is logged and changes nothing), then the `usage` event. The Gateway only produces records; storing them is P0-04/P0-11 (see Out of Scope).
- **Security**: bind loopback only; reject a non-loopback `Host` (DNS rebinding); no CORS headers; body at most 20 MB; Connection secrets never leave the Gateway except to their Provider.
- **Performance**: startup < 300 ms and < 20 ms median overhead over 200 sequential non-streaming calls (Gateway against the fake versus the fake directly, Usage Records on), measured by a benchmark script against the built package that exits non-zero over budget; not part of `pnpm test`.
- **Debug logging**: off by default. Log lines carry metadata only (method, path, Harness ID, resolved model, status, upstream status, duration; a stream is logged when it ends, with its whole duration and the code of any final error event), never message content, Connection secrets or tokens. Every logged string passes through a redactor for `Authorization`/`x-api-key` values and `sk-`/Bearer-style key strings.
- **Build order**: packages depend on each other through `workspace:*` with exports pointing at `dist/`, so CI runs Build right after Install, before Lint, Typecheck and Test, and a fresh clone needs `pnpm build` before those commands (root README).

## Testing Decisions

- Seam: **Gateway HTTP seam** (architecture §8, item 1). Start `createGateway` with in-memory callbacks and the fake Provider; drive it with plain `fetch`, an OpenAI SDK client, and `node:http` where a forged `Host` header is needed (fetch drops it); assert on HTTP status, JSON/SSE bodies, `usage`/`slot_unbound` events and token behaviour. Tests bind the fake under the Provider id `openai-compatible:fake`. The suite runs offline: a test setup makes any connection beyond loopback throw.
- Fake Provider: an OpenAI-compatible HTTP server in the package, exported as `@harness-store/gateway/testing/fake-provider` for P0-03, P0-05 and P0-13:
  ```ts
  startFakeProvider(opts?: { host?: '127.0.0.1' | '::1' | 'localhost'; port?: number; slowMs?: number;
                             aliases?: Record<string, Scenario>; apiKey?: string })
    : Promise<{ url /* .../v1 */; port; requests: { method; path; headers; body; aborted }[]; reset(); close() }>
  ```
  A fixed port is accepted (the fake stands in for Ollama on 11434). Scenarios are picked by exact model name: `fake/echo` and `fake/echo-stream` (the same scenario), `fake/tool-call`, `fake/tool-call-parallel`, `fake/stream-no-usage`, `fake/vision`, `fake/500`, `fake/rate-limited`, `fake/slow`, `fake/stall` (first chunk, then silence) and `fake/stream-error` (first chunk, then the socket is destroyed); any other name not in `aliases` is `404 model_not_found`. Every scenario honours `stream` and sends a usage chunk when `stream_options.include_usage` is set; token counts are whitespace-separated words. `GET /v1/models` lists scenarios and aliases. Any `Authorization` is accepted unless `apiKey` is set. Every request is recorded (lower-cased headers, body, and `aborted` when the client left early), which is how tests prove upstream aborts and that the Provider sees the Connection key and never the Gateway Token. `close()` cancels pending timers and force-closes sockets. An export smoke test imports the package by its own name.
- Conformance suite: one scenario set (text, streaming, structured output, stop sequences, tool calls streamed and not, parallel tool calls, a stream without usage, images, Provider errors, rate limits, timeouts) runs through the Gateway against every OpenAI-wire row of the Provider table (`openai`, `openrouter`, every OpenAI-compatible row) with the fake standing in, reading the rows from the table so a new preset is covered automatically. Anthropic and Google get a construction check of every row plus canned answers in their own wire formats (Anthropic streamed text and tool calls with usage included). A drift test compares the exported Provider ids with the first column of protocol §6. A throwaway preset row is shown working at the adapter factory with an injected table (the running Gateway's model parser checks ids against the built-in table). Live runs of the text, streaming and tool-call scenarios against real Anthropic, OpenAI and one OpenAI-compatible endpoint read only `CONFORMANCE_*` variables, so a developer's own shell keys never spend money; without them those tests are skipped, never failed.
- Good tests assert only wire behaviour: "given override binding X, response.model is X", "after revokeLaunch, next request is 401 and the open stream ends", "Provider 429 → 502 provider_error with provider_status 429", "after close(), the aborted Usage Record has reached onUsage".
- Prior art: fixture and test layout convention from P0-01.

## Out of Scope

- Storing Connections, Slot Bindings and the Models page UI (P0-03).
- Issuing tokens at launch and injecting environment (P0-05); this spec only provides `issueToken`.
- Storing and aggregating Usage Records: the `usage_records` table and its migrations (P0-04) and the aggregated usage query behind the Usage page (P0-11). This spec only emits records through `onUsage` and the `usage` event.
- Best-effort forwarding of vendor-specific request fields (ADR-0005); P0 forwards exactly the protocol §3 field list.
- Time-based token expiry, upstream retries, automatic fallback between Providers.
- Anthropic Messages inbound (P1-03), embeddings/images/audio, Responses API, cost calculation.

## Further Notes

- Keep the OpenAI translation layer isolated from the HTTP layer so P1-03 can add a second inbound protocol beside it.
- The protocol document is normative; when tests reveal a gap, update the document in the same change. Details settled while building this spec (Host rule and `invalid_host`, order of checks, token lifetime, context and `/v1/models` shapes, forwarding and validation rules, the SSE sequence and mid-stream error format, `internal_error`, `provider_error` fields, Usage Record rules) are recorded there.
- Open: the live conformance tests have run only against the fake, not against real Anthropic and OpenAI, because no `CONFORMANCE_*` keys were available while building. A maintainer needs to run them once with the variables set to close R-0204.

## Blocked by

- P0-01 Monorepo scaffold and Manifest package
