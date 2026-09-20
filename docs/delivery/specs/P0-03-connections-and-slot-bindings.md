---
spec_id: P0-03
title: Provider Connections and Slot Bindings
phase: P0
blocked_by: [P0-02, P0-04]
requirements: [R-0301, R-0302, R-0303, R-0304, R-0305, R-0306, R-0307]
---

# P0-03 Provider Connections and Slot Bindings

## Problem Statement

The Gateway can route, but only if the User has told the app which Providers they can reach and which real model should fill each Model Slot. Users have keys for several vendors, a local Ollama, and different preferences per Harness ("use Claude for the reviewer, Qwen locally for the summariser"). Without a clear place to manage Connections and Slot Bindings, every launch ends in `slot_unbound` and the "any model" promise is invisible.

## Solution

A Models page and the services behind it: Connections (one per Provider, many for generic OpenAI-compatible endpoints) with encrypted secrets, test-connection and model listing; automatic detection of local Providers; global Slot Bindings (Default Models) and per-Harness Model Overrides; a resolver implementing the normative order that the Gateway calls on every request; and requirement warnings when a binding does not satisfy a Slot's Model Requirements.

## User Stories

1. As a User, I want to add a Provider from a list of presets with its logo, name and docs link, so that I know what I am connecting.
2. As a User, I want to paste an API key and have it masked after saving, so that it is never displayed again.
3. As a User, I want a "Test connection" button that makes a tiny real request and reports success or the Provider's error, so that I know the key works before launching anything.
4. As a User, I want the app to detect Ollama and LM Studio on their default ports and offer one-click Connections, so that local models need no configuration.
5. As a User, I want to change the base URL of a local Provider (e.g. Ollama on another port or host), so that non-default setups work.
6. As a User, I want to add several named generic OpenAI-compatible endpoints (vLLM at work, a proxy at home), so that any endpoint can be a Provider.
7. As a User, I want to disable a Connection without deleting it, so that I can pause a Provider temporarily.
8. As a User, I want deleting a Connection to warn me which Slot Bindings depend on it and clear them, so that I am not surprised by `slot_unbound` later.
9. As a User, I want to see the models each Connection offers, fetched live where the Provider supports it, so that I pick from real names.
10. As a User, I want to type a model name manually when listing is unavailable or incomplete, so that new models work on day one.
11. As a User, I want a static, app-shipped model list for Anthropic and Google with context sizes and capabilities, so that requirement checks work for them.
12. As a User, I want to set my Default Model for the `default` Slot during first run and change it any time, so that most Harnesses work with one choice.
13. As a User, I want to set Default Models for other common Slot names (e.g. `fast`) globally, so that I do not repeat myself per Harness.
14. As a User, I want, for each installed Harness, to see its Slots, the Publisher's description and requirements, the resolved model and why it was chosen, so that I understand what will run.
15. As a User, I want to override any Slot for one Harness, so that a specific Harness uses a specific model.
16. As a User, I want to clear an override and fall back to the automatic choice, so that I can undo experiments.
17. As a User, I want a warning when the model I bind lacks tool calling, vision or enough context for that Slot, so that I make an informed choice, and I still want to proceed if I insist.
18. As a User, I want a launch attempt with an unbound `default` Slot to send me to the Models page with that Harness preselected, so that fixing it takes one step.
19. As a User, I want changes to take effect on the next Gateway request with no restart, so that I can tune live.
20. As a User, I want the Models page to work offline for local Providers and show which cloud Providers are unreachable, so that I am not blocked by network state.
21. As a User, I want my Connections stored only on my machine, so that no server ever sees my keys.
22. As a Publisher, I want my Recommended Models to become the initial binding when the User has that Provider, so that first launch behaves as I designed.
23. As a Publisher, I want Users to be able to override my recommendation, so that my Harness still works for Users on other Providers.
24. As a developer, I want the resolver to be a pure function over (override, recommended, defaults, connections), so that the normative order is unit-testable.
25. As a developer, I want the preset table to be data so that adding a vendor is a one-line change.

## Implementation Decisions

- **Local storage**: tables `connections`, `secrets`, `slot_bindings` per `docs/tech/data-model.md`. Secrets encrypted with Electron `safeStorage`; if `safeStorage` is unavailable (some Linux setups), the app refuses to store keys and explains how to enable a keyring rather than falling back to plaintext.
- **Connection identity**: `id = providerId` for single-instance Providers; `openai-compatible:<slug-of-name>` for generic endpoints (name unique, editable, slug regenerated only on create).
- **Detection**: on first run, on Models page open, and on demand: probe `http://127.0.0.1:11434/v1/models` and `http://127.0.0.1:1234/v1/models` with a 1.5 s timeout; show detected Providers with an "Add" button; never add silently.
- **Test connection**: for OpenAI-compatible Providers, `GET /models` (if supported) else a 1-token completion with the first listed or user-typed model; for Anthropic/Google, a minimal completion. Result stored as `last_tested_at`, `last_test_ok`, plus the error message for display.
- **Model listing**: live via each adapter's list capability; cached for 10 min; Anthropic/Google use a static catalogue shipped with the app (`{ id, contextWindow, tools, vision }`), refreshed with app updates. Manual entry always available; manually entered models have unknown capabilities (warnings say "unknown", not "fails").
- **Resolver** (decision-encoding snippet, mirrors gateway-protocol §4):
  ```ts
  resolve(harnessId, slot):
    override = bindings[`harness:${harnessId}`][slot]        → if exists && connectionEnabled → { …, source: 'override' }
    for id of manifest.models.slots[slot].recommended:      → if connectionEnabled(provider(id)) → { …, source: 'recommended' }
    g = bindings.global[slot]                                → if exists && connectionEnabled → { …, source: 'default_same_name' }
    d = bindings.global['default']                           → if exists && connectionEnabled → { …, source: 'default' }
    null
  ```
  A binding whose Connection is disabled or deleted is treated as absent (and shown as "broken" in the UI). Recommended model ids with unknown Provider ids are skipped.
- **Requirement check**: `checkRequirements(requirements, modelInfo) → { ok: boolean; unknown: boolean; failures: ('tools'|'vision'|'json'|'minContext')[] }`; shown as inline warning chips on binding controls and on the Harness detail page's Slots section.
- **UI**: Models page has two panes: Connections (list + add drawer) and Bindings (Global defaults; then one card per installed Harness with a row per Slot: description, requirements, resolved model + source badge, override dropdown, clear). Deep link `models?harness=<id>` preselects a card.
- **IPC**: `connections.list/add/update/remove/test/detect/models`, `bindings.getGlobal/setGlobal/getForHarness/setOverride/clearOverride/resolveAll(harnessId)`.
- **Events**: binding and connection changes emit a Runtime event; the Gateway's `resolveBinding` callback reads current state on each request, so no cache invalidation is needed beyond the model-list cache.

## Testing Decisions

- Seam: the resolver and requirement checker are pure functions tested exhaustively with tables (Manifest validation seam style). Connection storage tested at the IPC boundary with `safeStorage` stubbed to a reversible fake.
- Gateway integration: through the **Gateway HTTP seam**, start the Gateway with the real resolver and a fake connections store; assert that changing an override between two requests changes `response.model`.
- Detection/test-connection tested against the fake Provider from P0-02 bound to configurable ports.
- E2E (P0-13) covers the visual flow; this spec's tests do not render React.
- Good test: "given recommended [anthropic/x, ollama/y] and only an Ollama Connection, resolve returns ollama/y with source recommended"; "given disabled Connection for override, resolution falls through".

## Out of Scope

- The Gateway itself (P0-02); first-run wizard screens (P0-04) although they call these services; Usage page (P0-11); consumer-subscription OAuth (never, ADR-0002); cost estimation; automatic fallback.

## Further Notes

- Keep the preset table in `packages/gateway` (shared with adapters) and render it in the UI from there.
- zh-CN strings for every Provider preset name and every warning are required (P0-04 owns the i18n mechanism).

## Blocked by

- P0-02 Model Gateway core
- P0-04 Desktop app shell, i18n and first-run wizard
