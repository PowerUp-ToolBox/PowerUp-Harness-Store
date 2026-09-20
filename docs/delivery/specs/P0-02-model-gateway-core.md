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

The Model Gateway: a loopback HTTP server, implemented as a standalone Node package with no Electron dependency, that accepts OpenAI Chat Completions requests authenticated by a per-launch Gateway Token, resolves Model Slots to the User's Slot Bindings, forwards through Vercel AI SDK Provider adapters (including data-only presets for OpenAI-compatible vendors), streams responses back, maps errors to documented codes and writes one Usage Record per request. `docs/tech/gateway-protocol.md` is normative for the wire behaviour; this spec covers what must be built around it.

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
26. As a developer, I want request/response logging at debug level with keys redacted, so that I can diagnose issues without leaking secrets.
27. As a developer, I want the Gateway reusable server-side later (P2), so that the same code handles cloud credits.
28. As an operator of the P2 cloud Gateway (future), I want the token verifier pluggable, so that JWTs can replace launch tokens without touching routing.

## Implementation Decisions

- **Package**: `packages/gateway` exports `createGateway(options): Gateway` where `Gateway` has `listen(host = '127.0.0.1', port = 0)`, `close()`, `issueToken(claims)`, `revokeToken(token)`, `revokeLaunch(launchId)`, and emits `usage` events. HTTP layer is a minimal framework (Hono on Node) so the same app can later run on Deno/Workers.
- **Options** (decision-encoding snippet):
  ```ts
  type GatewayOptions = {
    resolveBinding(ctx: { harnessId: string; slot: string }): Promise<Binding | null>  // implements normative order
    getConnection(providerId: string): Promise<ConnectionSecret | null>                // decrypted just-in-time
    getManifest(harnessId: string): Promise<Manifest | null>
    onUsage(record: UsageRecord): Promise<void>
    tokenVerifier?: TokenVerifier                                                       // default: in-memory launch tokens
    logger?: Logger
  }
  type Binding = { providerId: string; model: string; source: 'override' | 'recommended' | 'default_same_name' | 'default' }
  ```
  The Gateway itself is stateless apart from the token table; all User data comes through callbacks, which keeps it testable and reusable.
- **Token claims**: `{ harnessId, harnessVersion, launchId, issuedAt }`. Tokens are 32 random bytes, base64url. Verification is constant-time. Revocation is immediate; in-flight streams are aborted on revoke.
- **Slot resolution** lives in the desktop app's binding service (P0-03) behind `resolveBinding`, but the Gateway validates the outcome: unknown Slot names (not in Manifest) → `unknown_slot`; `null` → `slot_unbound`. Explicit `provider/model` ids bypass resolution and require `getConnection(providerId)` non-null, else `provider_not_connected`.
- **Adapters**: one module per Provider id mapping a `ConnectionSecret` to a Vercel AI SDK language model. `openai-compatible` presets are rows in a table `{ id, displayName, baseUrl, requiresKey, supportsModelList, docsUrl, keyPlaceholder }`; the adapter code reads the table. Provider ids from the protocol doc are an enum exported for the desktop app.
- **Translation**: inbound OpenAI request → AI SDK `streamText`/`generateText` call (messages, tools as JSON schema, tool_choice, temperature, top_p, max tokens, stop, response_format json → `Output.object` best effort). Outbound AI SDK stream → OpenAI SSE chunks (`chat.completion.chunk`) with deltas for content and tool calls, `finish_reason` mapping (`stop`, `length`, `tool_calls`, `content_filter`), final usage chunk, `[DONE]`. Non-streaming assembles the full object. Response `id` is `chatcmpl_<uuid>`, `created` epoch seconds, `model` the resolved id.
- **Images**: `image_url` parts pass through as AI SDK image parts (URL or data URL). If the Provider rejects, the error is a `provider_error`.
- **Timeouts**: 120 s to first byte → `provider_timeout`; idle stream gap 120 s → abort with `provider_timeout`. Client disconnect aborts the upstream request.
- **Errors**: single mapper from AI SDK/HTTP errors to the documented table; `provider_error` includes `provider_status`, `provider_message` and `provider_code` when available. Errors during a stream after first byte are sent as a final SSE `error` event then `[DONE]`.
- **Usage Record**: written in `finally` for every request that reached a Provider; `status` ∈ `ok | provider_error | timeout | aborted`. Tokens `null` when absent, never estimated. `durationMs` measured from request receipt to stream end.
- **Security**: bind loopback only; reject non-loopback `Host`; no CORS headers; max body 20 MB; JSON only.
- **Performance**: target < 20 ms median overhead against the fake Provider; measured by a benchmark script, not a unit test.
- **Debug logging**: structured, redacts `Authorization` and any key-like string; off by default.

## Testing Decisions

- Seam: **Gateway HTTP seam** (architecture §8, item 1). Start `createGateway` with in-memory callbacks and the fake Provider; drive it with plain `fetch` and an OpenAI SDK client; assert on HTTP status, JSON/SSE bodies, `usage` events and token behaviour.
- Fake Provider: an OpenAI-compatible HTTP server in the package (`testing/fake-provider`) with scenario scripts selected by model name (e.g. `fake/echo`, `fake/tool-call`, `fake/stream-no-usage`, `fake/500`, `fake/slow`). It is exported for use by P0-05 and P0-13.
- Conformance suite: a table of scenarios × adapters; runs against the fake Provider always, and against real Anthropic/OpenAI/one OpenAI-compatible endpoint when keys are present in the environment (skipped otherwise, never failing CI for missing keys).
- Good tests assert only wire behaviour: "given override binding X, response.model is X", "after revokeLaunch, next request is 401 and the open stream ends", "Provider 429 → 502 provider_error with provider_status 429".
- Prior art: fixture convention from P0-01.

## Out of Scope

- Storing Connections, Slot Bindings and the Models page UI (P0-03).
- Issuing tokens at launch and injecting environment (P0-05); this spec only provides `issueToken`.
- Usage page (P0-11); this spec only emits records.
- Anthropic Messages inbound (P1-03), embeddings/images/audio, Responses API, cost calculation, fallback.

## Further Notes

- Keep the OpenAI translation layer isolated from the HTTP layer so P1-03 can add a second inbound protocol beside it.
- The protocol document is normative; when tests reveal a gap, update the document in the same change.

## Blocked by

- P0-01 Monorepo scaffold and Manifest package
