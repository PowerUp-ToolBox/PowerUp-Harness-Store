---
spec_id: P1-03
title: Anthropic Messages inbound compatibility
phase: P1
blocked_by: [P0-02]
requirements: [R-P1-03]
---

## Problem Statement

The Model Gateway accepts only the OpenAI Chat Completions protocol inbound (ADR-0004, `gateway-protocol.md`). A large share of agent code is written against the Anthropic Messages API and SDKs, with Anthropic-specific features such as system prompts as a top-level field, content blocks, tool use blocks, and prompt caching hints. Those authors must rewrite their model layer to list on the Store, which is friction the Gateway exists to remove.

## Solution

The Gateway adds a second inbound dialect: the Anthropic Messages API (`/v1/messages`), including streaming events and tool use, authenticated with the same Gateway Token presented as `x-api-key`. Requests are normalised into the Gateway's internal request model and routed exactly like OpenAI-dialect requests: Slot resolution, Provider adapters, Usage Records and errors are shared. The Runtime additionally injects `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` so unmodified Anthropic SDKs work with zero code changes.

## User Stories

1. As a Publisher using the Anthropic SDK, I want to point it at the Gateway by environment variable alone, so that my existing code runs as a Harness unchanged.
2. As a Publisher, I want `model` in a Messages request to accept a Slot name, so that my Anthropic-style Harness still runs on any Provider the User chooses.
3. As a Publisher, I want streaming to follow the Anthropic event sequence (`message_start`, `content_block_delta`, …), so that my SDK's stream helpers keep working.
4. As a Publisher, I want tool use to round-trip (`tool_use` and `tool_result` blocks), so that agentic loops written for Anthropic work through the Gateway.
5. As a Publisher, I want the top-level `system` field, multi-part content, and image blocks to be honoured, so that prompts behave the same.
6. As a Publisher, I want `cache_control` hints to be forwarded when the resolved Provider is Anthropic and silently dropped otherwise, so that I can optimise without breaking portability.
7. As a Publisher, I want Anthropic-shaped errors (`error.type`, `error.message`) so that my SDK's error handling paths work.
8. As a Publisher, I want the response `model` field to show the resolved `provider/model`, so that I can display what answered.
9. As a Publisher, I want the Node and Python SDKs to offer `createAnthropicClient()` helpers, so that setup stays two lines.
10. As a User, I want Anthropic-style Harnesses to appear in Usage Records identically to others, so that my accounting is complete.
11. As a User, I want a Harness written against Anthropic to work with my Ollama or DeepSeek Connection, so that "any model" holds for every Harness.
12. As a User, I want to be warned in the Models page when a Slot bound to a non-Anthropic model is used by a Harness that relies on Anthropic-only features (extended thinking, citations), so that surprising quality changes are explained.
13. As a platform developer, I want both dialects to converge on one internal request/response model before Provider adapters, so that adapters are written once.
14. As a platform developer, I want a conformance matrix (dialect × Provider × feature) in the test suite, so that regressions in translation are caught.

## Implementation Decisions

- New endpoint `POST /v1/messages`; `GET /v1/models` unchanged. Authentication accepts `x-api-key: <Gateway Token>` or `Authorization: Bearer`. `anthropic-version` header is accepted and ignored.
- Runtime injects `ANTHROPIC_BASE_URL` (same origin as the Gateway, without the `/v1` suffix as the Anthropic SDK appends it) and `ANTHROPIC_API_KEY` = Gateway Token, in addition to the existing OpenAI variables.
- Internal model: both dialects translate into the Gateway's canonical message/tool representation (the Vercel AI SDK core message types are the reference). Feature mapping decisions: `system` → system message; `tool_use`/`tool_result` ↔ tool calls/results; `stop_reason` ↔ finish reason with a documented table; `max_tokens` required by the Anthropic dialect, passed through; `thinking` parameters forwarded only when the resolved Provider is Anthropic, otherwise dropped with a response header `x-harness-store-dropped: thinking`.
- Streaming: the Gateway emits the Anthropic SSE event sequence generated from the canonical stream, including `usage` in `message_delta`.
- Errors: same codes as the protocol document, wrapped in Anthropic's `{ "type": "error", "error": { "type", "message" } }` shape; `slot_unbound` maps to `type: "invalid_request_error"` with the Gateway code preserved in `error.harness_store_code`.
- Usage Records unchanged; a `dialect` column (`openai | anthropic`) is added for diagnostics.
- Manifest: no changes. Slot declarations are dialect-agnostic.
- Feature-dependency warning in the Models page is driven by a per-Slot optional `requirements.features: ["thinking"]` (decide at implementation whether to add now or defer).

## Testing Decisions

- Tests assert equivalence: the same logical conversation sent in either dialect produces the same outbound request to the fake Provider and semantically equivalent responses.
- Primary seam: **Gateway HTTP seam** (architecture §8, item 1). Extend the fake Provider with an Anthropic-native mode so translation is tested in both directions (Anthropic inbound → OpenAI-compatible outbound, and Anthropic inbound → Anthropic outbound passthrough).
- Run the official Anthropic Node and Python SDKs against the Gateway in CI for a smoke conversation with tools and streaming.
- Prior art: P0-02 conformance suite.

## Out of Scope

- Anthropic Batches, Files, Admin or token-counting endpoints.
- Extended thinking translation to other Providers.
- OpenAI Responses API inbound (not planned).

## Further Notes

This is the first place the Gateway does inbound translation; keep the canonical model the single truth and resist adding dialect-specific branches in Provider adapters.

## Blocked by

- P0-02 Model Gateway core
