---
status: accepted
date: 2026-09-20
---

# The Model Gateway's inbound protocol is OpenAI Chat Completions, addressed by Model Slots

Every Harness must talk to models through the Model Gateway. We decided the Gateway accepts exactly one inbound protocol in P0, OpenAI Chat Completions (streaming, tool calling, image parts), and that the `model` field normally names a **Model Slot** declared in the Manifest rather than a concrete model. Outbound conversion to each Provider is done by Vercel AI SDK adapters.

## Considered Options

- Custom protocol: cleanest semantics, but every author would need our SDK; rejected.
- OpenAI Responses API or Anthropic Messages as the canonical inbound: smaller ecosystems of client code; Anthropic Messages inbound is added as a compatibility layer in P1 instead.
- Real model names instead of Slots: would tie a Harness to a vendor and defeat "any Harness on any model".

## Consequences

- Any existing OpenAI-SDK code works with only a base URL and key change, in any language.
- Provider-specific features (extended thinking controls, prompt caching flags) are exposed only as far as they map onto Chat Completions; a Harness that needs more can pass an explicit `provider/model` and vendor-specific extra fields, which are forwarded best-effort.
- Every token crosses the Gateway, which is what makes local Usage Records (P0) and cloud credits (P2) possible.
