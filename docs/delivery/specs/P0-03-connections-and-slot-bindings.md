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

- **Local storage**: tables `connections`, `secrets`, `slot_bindings` per `docs/tech/data-model.md`, created by their own ordered migrations (`0002`, plus `0003` and `0004` for `last_test_failure` and `test_model`). Beyond the original columns, `connections` keeps `key_hint` (the key's last 4 characters, empty for a key under 12 characters, so the masked key is listed without decrypting), `last_test_error`, `last_test_failure` and `test_model`; `secrets.id` and `connections.secret_ref` are the Connection id (NULL without a key); `slot_bindings.provider_id` holds the Connection id, with no foreign key. Secrets are encrypted with Electron `safeStorage` behind the Electron-free `SecretCipher` (`isAvailable`/`encrypt`/`decrypt`; tests use a reversible fake). If it is unavailable (on Linux also when the backend is `basic_text`), storing a key is refused with the `encryption_unavailable` error and keyring guidance, never stored in plaintext; keyless Connections (Ollama, LM Studio, a keyless custom endpoint) can still be added. The renderer only ever sees the masked key. Base URLs are trimmed of a trailing `/`, must be `http` or `https`, and are stored as NULL when empty or the preset default.
- **Connection identity**: `id = providerId` for single-instance Providers, where adding a Provider that already has its Connection edits that Connection in place; `openai-compatible:<slug-of-name>` for generic endpoints, many allowed, base URL required, key optional (name 1–64 characters, unique ignoring case, editable; slug lower-case `[a-z0-9-]`, `endpoint` when empty, `-2`, `-3` … on collision, set only on create).
- **Adding and editing**: `connections.add` checks the input, tests the Connection and saves it only when the test passes (a failure answers `provider_error` with the Provider's text, `provider_timeout` or `unexpected_response`). `connections.update({ id, displayName?, apiKey?, baseUrl?, enabled? })` tests first only when the key or base URL changes; a left-out key is kept, and an optional key cannot be cleared (remove and add again). `connections.testDraft` tests what the Add/Edit dialog holds without saving, and the dialog enables Save once it passed. Removing deletes the Connection, its secret, its model-list cache entry and every Slot Binding of any scope that uses it, in one transaction; the UI first names the affected Default Models.
- **Detection**: when the wizard's Local Providers step or the Models page opens, and on "Detect again": probe `GET {baseUrl}/models` at the Ollama and LM Studio preset base URLs (`http://127.0.0.1:11434/v1`, `http://127.0.0.1:1234/v1`) in parallel over Node's `fetch`, 1.5 s timeout each; a Provider counts as running only on HTTP 200 with a JSON `data` array (or `data: null`, Ollama with no model pulled). The Models page shows found Providers with an "Add" button ("Added" when its Connection exists, so a custom base URL is never replaced); the wizard keeps P0-04's per-Provider "Add" checkbox, on by default, and adds the checked ones on Continue, which counts as the explicit action. Nothing is ever added silently. Probe targets are injectable, so tests use fake Providers on OS-picked ports.
- **Test connection**: `testConnection` in `packages/gateway`, over the Gateway's adapters, upstream `fetch` wrapper and error mapper (keys redacted, a 15 s timeout, the error's cause chain appended to the text) and Node's `fetch`, not Electron's `net.fetch`. Providers that list models: `GET {baseUrl}/models`; OpenRouter: the authenticated `GET {baseUrl}/key` (its `/models` answers without a key), then the listing; Anthropic and Google: a 1-token completion with the catalogue's smallest model or one the User names; Zhipu, MiniMax and Doubao (no listing, no catalogue): a 1-token completion with a "Model to test with" the User must give. `connections.test({ id, model? })` re-tests a saved Connection and records `last_tested_at` (ISO-8601 UTC), `last_test_ok` and the Provider's text verbatim in `last_test_error` (or the reason in `last_test_failure` when there is no Provider text); a failed test is still IPC `ok: true`, with the failure in the returned `ConnectionSummary`. A model the User named for a passed test is kept in `test_model` and reused. Row status, in order: Disabled, Connection failed (with its text), Local, Connected, Not tested; cloud Providers are never probed automatically.
- **Model listing**: `listModels` in `packages/gateway`: a live `GET {baseUrl}/models` (`data[].id`, Bearer key when there is one) for every Provider marked `supportsModelList` (OpenAI, OpenRouter, Ollama, LM Studio and the OpenAI-compatible rows); the static `MODEL_CATALOGUE` for Anthropic and Google (`{ id, contextWindow, tools, vision }`, one entry per Provider marked as the test model), refreshed with app updates; an empty list for the rest. Live listings are cached in main for 10 min per Connection (injectable clock); failures are not cached, and a new key or base URL or removal drops the entry. `ConnectionSummary.models` comes from the cache or catalogue only, with no network call. Pickers offer the enabled Connections' models grouped by Connection, plus "Type a model name" (one `<connectionId>/<model>` input split at the first `/`). Typed and live-listed models have unknown capabilities (warnings say "unknown", not "fails").
- **Resolver** (decision-encoding snippet, mirrors gateway-protocol §4):
  ```ts
  resolve(harnessId, slot):
    override = bindings[`harness:${harnessId}`][slot]        → if exists && connectionEnabled → { …, source: 'override' }
    for id of manifest.models.slots[slot].recommended:      → if connectionEnabled(provider(id)) → { …, source: 'recommended' }
    g = bindings.global[slot]                                → if exists && connectionEnabled → { …, source: 'default_same_name' }
    d = bindings.global['default']                           → if exists && connectionEnabled → { …, source: 'default' }
    null
  ```
  A binding whose Connection is disabled or deleted is treated as absent; on the Models page a Default Model whose Connection is disabled is kept and marked "Connection disabled" (removing a Connection deletes its bindings, so none is left pointing at a deleted one). Recommended model ids with unknown Provider ids are skipped. Built as the pure `resolveSlotBinding({ slot, override, recommended, defaults, enabledConnections })` in `apps/desktop/src/main/runtime/slot-resolver.ts`; reachability is the Connection's `enabled` flag, never its last test. For the `default` Slot a global match reports source `default`, not `default_same_name`. Until P0-03.5, `override` and `recommended` are passed in empty.
- **Gateway wiring**: `createGatewayHost` replaces P0-04's stubs. `resolveBinding` and `getConnection` read SQLite on every request (no startup snapshot), decrypting a key only for that call, so adds, disables, removals and binding changes apply to the next request with no restart. `getConnection` returns null for a disabled Connection (explicit `provider/model` → 403 `provider_not_connected`); a decryption failure becomes 500 `internal_error`. `getManifest` stays null until P0-05/P0-10, so in the app every Slot name answers 404 `unknown_slot` until then; tests inject a fixture Manifest.
- **Requirement check**: `checkRequirements(requirements, modelInfo) → { ok: boolean; unknown: boolean; failures: ('tools'|'vision'|'json'|'minContext')[] }`, pure, in `apps/desktop/src/shared/requirements.ts` over the Manifest's `ModelRequirements`; a capability missing from the model info (every typed or live-listed model, and `json` even for catalogue entries) makes the result `unknown`, never a failure. Shown as inline warning chips on binding controls and on the Harness detail page's Slots section (P0-03.5).
- **UI**: Models page has two panes: Connections (list with status, Edit, Test, Enable/Disable and Remove; Add/Edit in a modal dialog rather than a drawer, with a preset picker showing letter monograms and docs links instead of logos, local Providers labelled "Local"; a Local Providers detection panel with "Detect again" and install guidance when nothing is found) and Bindings (Global defaults: `default` first and always, then every other globally bound Slot by name, each with a picker and "Not set"; no control adds an arbitrary Slot name; then one card per installed Harness with a row per Slot: description, requirements, resolved model + source badge, override dropdown, clear). Deep link `models?harness=<id>` preselects a card. The per-Harness cards and the deep link arrive with P0-03.5. Provider names come from `provider.<id>` catalog keys in `en` and `zh-CN`, falling back to `displayName`. The renderer never imports `@harness-store/gateway`; presets reach it through `providers.list` (every Provider, now with `local`, `baseUrl`, `docsUrl`, `supportsModelList`, `keyPlaceholder`, `needsTestModel` and `testModel`) and catalogue entries through `connections.models`.
- **Wizard**: P0-04's stubs are replaced: the Local Providers step uses real detection and adds through `connections.add`; the Remote Provider step (local Providers filtered out) adds and tests a real Connection; the Default model step picks from the Connections added in this run and saves the global `default` binding with `bindings.setGlobal` on Continue, so a working `default` exists when the wizard finishes.
- **IPC**: `connections.list/add/update/remove/test/testDraft/detectLocal/models`, `bindings.getGlobal/setGlobal` (shipped), then `bindings.getForHarness/setOverride/clearOverride/resolveAll(harnessId)` with P0-03.5. Detection keeps P0-04's shipped name `connections.detectLocal` rather than `connections.detect`. `bindings.getGlobal()` returns the raw rows `{ slot, connectionId, model }[]`; `bindings.setGlobal({ slot, target: { connectionId, model } | null })` deletes the row for `null`, checks the Slot name (`^[a-z][a-z0-9-]{0,31}$`) and the model with the Gateway's `isModelName`/`isProviderId`, and needs an existing enabled Connection (`provider_not_connected` otherwise). One new error code, `encryption_unavailable`, plus `unexpected_response` for a test or listing that reached something that is not the Provider's API; unknown Connection ids and bad input answer `invalid_input`. `error.provider_error` takes a `{detail}` argument carrying the Provider's redacted text verbatim.
- **Events**: no Runtime event is emitted yet: the single window refreshes after its own calls, and `connections.changed`/`bindings.changed` arrive with P0-05, when the Harness window's model indicator needs them. The Gateway's `resolveBinding` callback reads current state on each request, so no cache invalidation is needed beyond the model-list cache.

## Testing Decisions

- Seam: the resolver and requirement checker are pure functions tested exhaustively with tables (Manifest validation seam style). Connection storage tested at the IPC boundary with `safeStorage` stubbed to a reversible fake.
- Gateway integration: through the **Gateway HTTP seam**, start the Runtime with its real SQLite stores, the reversible fake `SecretCipher`, the real resolver and a fixture Manifest, with the fake Provider upstream; assert that adding, disabling, enabling and removing a Connection, replacing its key or base URL, and setting or clearing a Default Model (`default` and `fast`) change the very next request's outcome and `response.model`. The same assertion for a Model Override arrives with P0-03.5.
- E2E (P0-13) covers the visual flow. The Models page and the wizard steps also have jsdom component tests with a mocked `window.api`, as P0-04 has, rather than this spec rendering no React.
- Detection, test and listing tests use the fake Provider (`@harness-store/gateway/testing/fake-provider`, including its 401 "Incorrect API key provided." for the verbatim-error case) on OS-picked ports, and an injected `fetch` stub for Anthropic and Google, whose wire formats the fake Provider does not speak; no test uses a real key. Per-area scripts: `test:connections` and `test:bindings` in the desktop package, `test:catalogues` and `test:connection-check` in the gateway package.
- Good test: "given recommended [anthropic/x, ollama/y] and only an Ollama Connection, resolve returns ollama/y with source recommended"; "given disabled Connection for override, resolution falls through".

## Out of Scope

- The Gateway itself (P0-02); first-run wizard screens (P0-04) although they call these services; Usage page (P0-11); consumer-subscription OAuth (never, ADR-0002); cost estimation; automatic fallback.

## Further Notes

- Keep the preset table in `packages/gateway` (shared with adapters) and render it in the UI from there. The shipped table (from P0-02.6) has exactly the ids of P0-03.1's table; it also carries `docsUrl`, `supportsModelList` and `keyPlaceholder` per row. `supportsModelList` is false for Anthropic and Google (served by the catalogue) and for Zhipu, MiniMax and Doubao (manual entry and a "Model to test with").
- Delivered in this branch: P0-03.1 to P0-03.4. P0-03.5 (Model Overrides, Recommended Models, requirement warnings in the UI, the per-Harness cards and deep link) waits on P0-05.1 (install from folder).
- zh-CN strings for every Provider preset name and every warning are required (P0-04 owns the i18n mechanism).

## Blocked by

- P0-02 Model Gateway core
- P0-04 Desktop app shell, i18n and first-run wizard
