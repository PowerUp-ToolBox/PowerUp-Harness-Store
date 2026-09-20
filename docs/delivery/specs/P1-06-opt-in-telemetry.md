---
spec_id: P1-06
title: Opt-in telemetry
phase: P1
blocked_by: [P0-04]
requirements: [R-P1-06]
---

## Problem Statement

After P0 ships, the team cannot tell whether installed Harnesses are actually launched, which Provider types Users rely on (local vs cloud), or where the app crashes. Store download counts (P0) only show acquisition, not use. Without this signal, roadmap decisions about Provider presets, platform support and Runtime stability are guesses. At the same time, P0 Users were promised that the app makes no network calls except to the Store and to their configured Providers, and that promise must survive.

## Solution

Add an anonymous, **default-off** telemetry channel. A User can turn it on from Settings (and is asked once, after the first-run wizard, with a plain explanation of exactly what is sent). When on, the app sends a small, fixed set of events about app and Harness lifecycle and crash reports. It never sends conversation content, prompts, model outputs, file paths, Workspace names, hostnames, API keys or Harness Data Directory contents. The event catalogue is public in the docs and visible in the app ("What we send"), and the User can view the last events queued locally before they leave the machine.

## User Stories

1. As a User, I want telemetry to be off by default, so that installing the app does not start reporting on me without my consent.
2. As a User, I want to be asked once, in plain language, whether to enable telemetry, so that I can decide with full information rather than discovering a hidden toggle.
3. As a User, I want to see the exact list of event types and fields the app sends, so that I can judge the privacy impact myself.
4. As a User, I want to view the events currently queued on my machine before they are sent, so that I can verify the list matches the promise.
5. As a User, I want to turn telemetry off at any time and have the local queue discarded, so that changing my mind takes immediate effect.
6. As a User, I want telemetry to never include prompts, model outputs, file paths, Workspace names or Harness data, so that my work stays private even when I opt in.
7. As a User, I want the telemetry identifier to be a random installation id I can reset, so that events cannot be linked to my GitHub account or Store activity.
8. As a User, I want telemetry to fail silently when offline and never block launching a Harness, so that the feature has no cost to me.
9. As a User in `zh-CN`, I want the consent screen and event catalogue in my language, so that consent is informed.
10. As the maintainer, I want to know how many launches per installed Harness happen per week, so that I can distinguish "installed and abandoned" from "used daily".
11. As the maintainer, I want to know the Provider id (not the credential or model list) used per launch, so that I can prioritise Provider presets and adapter fixes.
12. As the maintainer, I want crash reports with app version, platform and a sanitised stack trace, so that I can fix Runtime bugs I cannot reproduce locally.
13. As the maintainer, I want to know how often `slot_unbound` and `provider_error` occur (counts only), so that I can improve the Models page and error UX.
14. As the maintainer, I want to know how long the first-run wizard takes and where Users skip, so that the ≤ 10 minute promise can be measured in the field.
15. As the maintainer, I want the event schema versioned, so that old app versions do not break ingestion.
16. As a Publisher, I want aggregate launch counts for my Harness to appear later in my analytics (P1-05) only when derived from opted-in Users and labelled as a sample, so that the number is not misread as total usage.
17. As a privacy-conscious User, I want the telemetry endpoint to be the Store domain only, so that no third-party analytics vendor receives my events.
18. As a User, I want a Harness to have no access to the telemetry channel, so that a Harness cannot smuggle data through it.

## Implementation Decisions

- **Default off.** The `telemetry_enabled` setting defaults to `false`. Nothing is queued or sent until the User enables it. The one-time prompt appears after the first-run wizard completes (or is skipped) and is never shown again; Settings has the toggle and the "What we send" view. (R-P1-06)
- **Event catalogue (initial, fixed):** `app_opened`, `app_closed`, `wizard_step` (step id, skipped: bool, duration bucket), `harness_launched` (Harness ID, version, ui kind, workspace: bool, runtime kind), `harness_exited` (Harness ID, duration bucket, exit class: ok/nonzero/killed), `gateway_error` (error code only, Provider id), `gateway_request_summary` (per launch: Provider id, request count bucket, streaming: bool), `crash` (component, sanitised stack, app version), `install_completed`, `uninstall_completed`. Harness ID is included because Harnesses are public listings, not User data. Any new event requires a docs update and a schema version bump.
- **Never included:** message content, prompts, completions, tool arguments, file or directory paths, Workspace names, hostnames, usernames, IP-derived geolocation, model names bound by the User (Provider id only), Connection details, Usage Record token counts per request (buckets only).
- **Identity:** a random `installation_id` generated on enable, resettable from Settings; no link to the Supabase user id. No IP addresses stored server-side beyond transient request handling.
- **Transport:** batched JSON, at most once per 15 minutes or on app close, to a Store Edge Function `telemetry/ingest` over HTTPS. Queue capped (1000 events, oldest dropped). Retries are best-effort; failures never surface to the User.
- **Storage server-side:** `telemetry_events` table (reserved in the data model), append-only, retention 180 days, admin-only read. Aggregations feed the admin dashboard (P1-05) as "opted-in sample" metrics.
- **Isolation from Harnesses:** the telemetry client lives in the Runtime; nothing about it is exposed through the Gateway or the launch environment.
- **Sanitisation of crash stacks:** strip everything after the app install root prefix, remove home directory segments, drop any string longer than 200 chars. Decide at implementation: whether to use source maps server-side or client-side.
- Localisation: consent copy and catalogue in `en` and `zh-CN` via the existing message catalogs.

## Testing Decisions

- Good tests observe external behaviour: the bytes that would leave the machine and the state of the queue, not internal method calls.
- **Runtime-level seam (architecture §8 seam 3 plus a captured HTTP sink):** run the Runtime's telemetry client against a local fake ingest endpoint; assert that with the setting off nothing is ever sent, that enabling then launching a fixture Harness yields exactly the catalogued events with only allowed fields, and that disabling discards the queue.
- **Sanitisation unit tests:** feed crash stacks containing home paths, Workspace paths and long strings; assert the output contains none of them.
- **Store seam (seam 4):** the ingest function rejects unknown event types and oversized batches, stores accepted ones, and never persists request IPs.
- **Desktop E2E (seam 5):** one smoke test that the consent prompt appears once after the wizard and that the "What we send" view lists the catalogue.
- Prior art: the fake Provider pattern from `packages/gateway` (scripted HTTP sink).

## Out of Scope

- Publisher-facing or admin analytics UI: P1-05.
- Store-side download metrics: already in P0-07/P0-09.
- Any per-request token or cost reporting: Usage Records remain local (P0-11).
- A/B testing, remote config, feature flags.

## Further Notes

- The P0 promise in `docs/tech/security.md` ("no telemetry in P0; the only network calls are to the Store and configured Providers") remains true in letter: the ingest endpoint is on the Store domain, and the security doc is updated to describe the opt-in channel.
- If the maintainer later wants to make telemetry default-on for pre-release builds, that is a separate decision and needs an ADR.

## Blocked by

- P0-04 Desktop app shell, i18n and first-run wizard
