---
spec_id: P0-11
title: Usage page and Settings
phase: P0
blocked_by: [P0-02, P0-04]
requirements: [R-1101, R-1102]
---

# P0-11 Usage page and Settings

## Problem Statement

The Model Gateway records every model call as a Usage Record, but the User cannot see any of it: which Harness consumed how many tokens, on which model, when. Separately, the app has settings (language, update interval, Store URL, wizard re-run, log and data locations) with no place to change them. Users running paid API keys need to see where tokens go; everyone needs a Settings screen.

## Solution

A Usage page aggregating Usage Records by period, Harness, Provider/model and day with filters and CSV export, and a Settings page for language, Store URL (advanced), update check interval, re-running the first-run wizard, opening the logs folder, and clearing usage data. Flow F7 in `docs/ux/flows.md` is normative for Usage.

## User Stories

1. As a User, I want to see total prompt and completion tokens and request count for today, 7 days, 30 days and all time, so that I understand my overall consumption.
2. As a User, I want usage grouped by Harness, then by model, so that I can see which Harness costs the most on which model.
3. As a User, I want a daily breakdown for the selected period, so that I can spot spikes.
4. As a User, I want to filter by Harness and by Provider, so that I can answer specific questions.
5. As a User, I want rows where the Provider did not report token counts to show a dash with an explanation, so that I do not mistake missing data for zero usage.
6. As a User, I want failed requests counted separately, so that I can see a Harness that is erroring.
7. As a User, I want to see the last-used time per Harness and model, so that I can tell what is still in use.
8. As a User, I want to export the current view to CSV, so that I can do my own analysis or expense reports.
9. As a User, I want to clear usage data after a confirmation, so that I control what stays on my machine.
10. As a User, I want the Usage page to make clear that this data never leaves my machine, so that I trust it.
11. As a User, I want usage to update while a Harness is running, so that I can watch a long task consume tokens.
12. As a User, I want to change the app language between English and Simplified Chinese without restarting, so that switching is painless.
13. As a User, I want to set how often the app checks for Harness updates (including never), so that I control background network activity.
14. As a User, I want to re-run the first-run wizard from Settings, so that I can redo setup after changing Providers.
15. As a User, I want to open the logs folder and the Harness data root from Settings, so that I can inspect or back up files.
16. As a User, I want to see the app version and check for app updates from Settings, so that I know what I am running.
17. As an advanced User, I want to point the app at a different Store URL, so that I can use a staging or self-hosted Store.
18. As an advanced User, I want a visible warning when a non-default Store URL is set, so that I do not forget I am not on the public Store.
19. As a Publisher testing locally, I want to see the Gateway port and confirm it is running from Settings, so that I can debug my Harness's connection.
20. As a User, I want settings to persist across restarts and be applied immediately, so that the app behaves predictably.

## Implementation Decisions

- **Usage queries** run against the local `usage_records` table via IPC `usage.query({ from, to, harnessId?, providerId?, groupBy })`. Aggregation happens in SQL; the renderer only formats. Periods are computed in the User's local timezone. A `status` dimension separates `ok` from `error` records.
- **Null token counts** are excluded from sums and reported through a separate `unknownCount` per group so the UI can show the dash and tooltip.
- **Live updates**: the Gateway emits a `usage:recorded` event over IPC; the Usage page refreshes its current query with a 2-second throttle while visible.
- **CSV export** writes the current grouped view with columns: harness_id, provider, model, day, requests, errors, prompt_tokens, completion_tokens, unknown_usage_count, last_used_at. Save dialog via the OS.
- **Clear usage data** deletes all rows after a confirmation dialog; there is no partial clear in P0.
- **No cost calculation** in P0; the page shows tokens only, per `docs/tech/gateway-protocol.md` §7.
- **Settings storage**: the local `settings` table; IPC `settings.get/set`. Language change triggers a catalog swap in the renderer and sets `HARNESS_LOCALE` for future launches (running Harnesses keep their locale). Update interval options: 1 h, 6 h (default), 24 h, never. Store URL defaults to the public Store; changing it clears the Store cache and shows a persistent banner.
- **Wizard re-run** reopens the first-run flow from P0-04 without deleting existing Connections.
- **Diagnostics block** in Settings shows app version, Gateway port and status, bundled Node version, data root path, and a "Copy diagnostics" button.
- **Copy** in `en` and `zh-CN`.

## Testing Decisions

- **Seams**: Gateway seam produces Usage Records from scripted fake-Provider responses (with and without usage fields); the aggregation is then tested through the IPC query as external behaviour; renderer component tests for period selection, filters and the dash-for-unknown rule; a small E2E check that changing language updates visible copy without restart.
- **Good tests**: after three requests (two with usage, one without) the 7-day total shows the sum of two and an unknown count of one; a request that failed with a provider error appears under errors and not in token sums; export produces a CSV whose rows equal the grouped view; setting update interval to never results in no `latest_versions` call over a simulated 24 h clock.
- **Fixtures**: fake Provider scripts from P0-02.
- **Prior art**: P0-02 Gateway tests; P0-04 renderer tests.

## Out of Scope

- Cost estimation and pricing tables.
- Telemetry or any upload of usage data (P1-06 is opt-in telemetry and still never includes token data).
- Connection and Slot Binding management (P0-03).
- Per-Harness budget limits.

## Further Notes

- Keep the aggregation queries indexed on (`harness_id`, `timestamp`); the table can grow to millions of rows for heavy users.

## Blocked by

- P0-02 Model Gateway core
- P0-04 Desktop app shell, i18n and first-run wizard
