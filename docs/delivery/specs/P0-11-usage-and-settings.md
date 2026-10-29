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

A Usage page aggregating Usage Records by period, Harness, Provider/model and day, with filters by Harness and Provider, CSV export and Clear usage data, and a Settings page for language, the Harness update check interval with Check now, the data location and logs folder, the Store URL (advanced), re-running the first-run wizard, clearing usage data and a diagnostics block. Flow F7 in `docs/ux/flows.md` is normative for Usage; `docs/ux/screens.md` gives both screens' elements and copy, and `docs/tech/api.md` the IPC calls.

## User Stories

1. As a User, I want to see total requests, errors, prompt tokens and completion tokens for today, 7 days, 30 days and all time, so that I understand my overall consumption.
2. As a User, I want usage grouped by Harness, then by model, so that I can see which Harness costs the most on which model.
3. As a User, I want a daily breakdown for the selected period, so that I can spot spikes.
4. As a User, I want to filter by Harness and by Provider, so that I can answer specific questions.
5. As a User, I want rows where the Provider did not report token counts to show a dash with an explanation, so that I do not mistake missing data for zero usage.
6. As a User, I want failed requests counted separately, so that I can see a Harness that is erroring.
7. As a User, I want to see the last-used time per Harness and model, so that I can tell what is still in use.
8. As a User, I want to export the selected period and filters to CSV, so that I can do my own analysis or expense reports.
9. As a User, I want to clear usage data after a confirmation, so that I control what stays on my machine.
10. As a User, I want the Usage page to make clear that this data never leaves my machine, so that I trust it.
11. As a User, I want usage to update while a Harness is running, so that I can watch a long task consume tokens.
12. As a User, I want to change the app language between English and Simplified Chinese without restarting, so that switching is painless.
13. As a User, I want to set how often the app checks for Harness updates (including never) and to check now, so that I control background network activity.
14. As a User, I want to re-run the first-run wizard from Settings, so that I can redo setup after changing Providers.
15. As a User, I want to open the logs folder and the app data root from Settings, so that I can inspect or back up files.
16. As a User, I want to see the app version in Settings, so that I know what I am running.
17. As an advanced User, I want to point the app at a different Store URL, so that I can use a staging or self-hosted Store.
18. As an advanced User, I want a visible warning when a non-default Store URL is set, so that I do not forget I am not on the public Store.
19. As a Publisher testing locally, I want to see the Gateway port and confirm it is running and reachable from Settings, so that I can debug my Harness's connection.
20. As a User, I want settings to persist across restarts and be applied immediately, so that the app behaves predictably.
21. As a User asking for help, I want to copy the diagnostics in one click, without any key or token in them, so that I can paste them into a support request safely.

## Implementation Decisions

### Usage (#77)

- **Query** (`usage.query`, api.md): input `{ from, to, harnessId?, providerId?, groupBy }`. `from` and `to` are ISO-8601 UTC instants bounding the half-open `[from, to)`, null meaning unbounded. `groupBy` is an ordered array of distinct dimensions from `harness`, `provider`, `model` and `day`; `model` always also groups by Provider, and `[]` answers one total row (zeros over no records). Input is checked with the existing `invalid_input` pattern and only whitelisted column expressions reach the SQL text.
- **Output**: one row per group, `{ harnessId?, provider?, model?, day?, requests, errors, promptTokens, completionTokens, unknownCount, lastUsedAt }`, all summed in SQL over the local `usage_records`; the renderer only formats and never sums. `requests` counts every record; `errors` counts every status other than `ok` (`provider_error`, `timeout`, `aborted`), a subset of `requests`. Token sums cover only `ok` records with both `prompt_tokens` and `completion_tokens` present (0 when there are none); `unknownCount` counts the `ok` records missing either. Non-`ok` records never add to token sums or to `unknownCount`. `cached_prompt_tokens` is neither shown nor exported. `lastUsedAt` is `MAX(timestamp)` over all statuses, as ISO UTC.
- **Periods and days**: the renderer computes period starts from the local `Date`: Today starts at this morning's local midnight, 7 days and 30 days at the local midnight 6 and 29 calendar days before today, All has no start; no period has an end, so records written later still count. Starts are recomputed on every query, so live refresh and a page left open past midnight stay correct. Main buckets days with SQLite `date(timestamp, 'localtime')`. The default period is 7 days and is not persisted.
- **Page queries**: totals `[]`, Harness subtotal rows `['harness']`, model rows `['harness', 'model']`, the daily breakdown `['day']`, each with the period and filters. The filter options come from all-time, unfiltered `['harness']` and `['provider']` queries, so uninstalled Harnesses and removed Connections still appear.
- **Layout** (design demo): a note that the records are counted by the Model Gateway and never leave the machine; the period selector; filters by Harness and Provider; totals tiles Requests, Errors, Prompt tokens, Completion tokens; a "Usage by Harness and model" table with columns Requests, Errors, Prompt tokens, Completion tokens and Last used, Harness groups and their model rows ordered by `lastUsedAt` descending; a "Daily breakdown" plain table of the days that have records, newest first, with no chart; Export CSV and Clear usage data. Tokens only, no cost.
- **Labels**: a Harness shows its installed name from `installs.list`, else its raw Harness ID. A Provider shows its Connection's name, else the raw provider ID. A model row shows the model name with "via {Provider}" beneath its Harness.
- **Dash rule**: a token cell shows a bare "—" with the tooltip "This Provider did not report usage" only when every `ok` request of its row is unknown (`requests - errors - unknownCount == 0` with `unknownCount > 0`); when some are known it shows the known sum plus a "—" marker with that tooltip. A row with only failed requests shows 0, not a dash. The renderer derives this without summing.
- **Empty and zero states**: with no Usage Record at all the page shows the empty state "Launch a Harness to see usage here", which is also where Clear leads; a period or filter that matches nothing shows zero totals and empty tables.
- **Live refresh**: main's `onUsage` emits the `usage.recorded` event (`{ harnessId }`, dotted like `installs.changed`) after each insert; the Gateway package is unchanged. The page re-queries leading and trailing, at most once every 2 s, only while it is mounted and `document.visibilityState` is `visible`; records that arrive while the window is hidden make it re-query once when it shows again.
- **CSV export** (`usage.export`, the same `{ from, to, harnessId?, providerId? }`): main re-runs the query grouped by `['harness', 'model', 'day']`, the finest grain the page shows, ordered by `harness_id`, `provider`, `model`, `day` ascending, and writes it to the file chosen in `dialog.showSaveDialog` (default name `harness-store-usage-<YYYY-MM-DD>.csv`). It answers `{ path }`, null when cancelled, `internal_error` when the file cannot be written (no new error code). Format: UTF-8 without BOM, CRLF line ends, a header row, RFC 4180 quoting, and a leading `'` on any cell starting with `=`, `+`, `-` or `@` (formula injection). Columns: `harness_id, provider, model, day, requests, errors, prompt_tokens, completion_tokens, unknown_usage_count, last_used_at`, with raw IDs (the full provider ID), `day` as local `YYYY-MM-DD` and `last_used_at` as ISO UTC. A failed export keeps its own error until the next export attempt, through live refreshes.
- **Clear usage data** (`usage.clear`, no input, answers null): deletes every row, no VACUUM, no partial clear in P0. One shared confirmation dialog ("Clear usage data?", "This deletes every Usage Record on this machine.", Cancel / Clear usage data) serves the Usage and Settings pages.
- **Index**: migration `0008` adds an index on `usage_records(timestamp)`, because a period over every Harness cannot use the existing (`harness_id`, `timestamp`) index, which stays (data-model.md).
- **No cost calculation** in P0; the page shows tokens only, per `docs/tech/gateway-protocol.md` §7.

### Settings (#78)

- **Storage**: the local `settings` table through P0-04's `settings.get/set`; every value persists and applies at once. `update_check_interval` is a new key, `'1h' | '6h' | '24h' | 'never'`, absent meaning `'6h'`; `store_base_url` is P0-04.4's key. `Settings` gains `updateCheckInterval`, `storeBaseUrl?` (the override; absent means the default) and `defaultStoreBaseUrl`; `SettingsPatch` gains `updateCheckInterval` and `storeBaseUrl: string | null` (null clears), both validated by `parseSettingsPatch`.
- **Layout**, in order, with the existing `settings-row` components: Language; Check for Harness updates (interval and Check now); Data location (path, Open folder, Open logs folder); Store URL under a collapsed "Advanced" section; Re-run setup; Clear usage data; Diagnostics with Copy diagnostics.
- **Language**: P0-04's System / English / 简体中文 select and its note are kept. The catalog swaps in place; `HARNESS_LOCALE` already comes from `settings.get().resolvedLocale` at each launch, so running Harnesses keep their launch locale and nothing new is needed in main.
- **Update interval**: Every hour, Every 6 hours (default), Every 24 hours, Never. P0-10.2's checker takes `intervalMs: () => number | null` (null meaning Never) instead of the constant and reads it whenever a check is due. With Never, neither the 10 s startup check nor any periodic check is scheduled. A changed interval reschedules: the next check runs a whole new interval from now, with none at once.
- **Check now** (`installs.checkUpdates`, no input): runs `updates.check()` whatever the interval, Never included; `check()` now reports whether the Store answered. It answers null when done, or `store_unreachable` when offline or when the Store did not answer. The button is disabled while offline or while a check runs; afterwards a toast says how many installs have `availableUpdate` ("Checked the Store. No updates available." or "Checked the Store. {n} updates available."), counted by the renderer from `installs.list`.
- **Data location**: the app data root (`options.dataDir`, where `harnesses/`, `data/` and `logs/` live) is shown as the Data location row. `app.openFolder('logs' | 'dataRoot')` opens it or `<dataRoot>/logs` (created when missing) with the injected `openPath`, answering `open_failed` with the path on failure.
- **Store URL** (Advanced): "the public Store" is the existing, unchanged `DEFAULT_STORE_BASE_URL`, shown as the default. Main accepts only an absolute `http:` or `https:` URL with no username or password, query or fragment, at most 2048 characters in its stored, percent-encoded form, and stores it without a trailing slash; anything else is `invalid_input`, which the renderer explains beside the field. Setting the default itself, or null, removes the key. The build's anon key is used with any URL; there is no anon-key setting. The field commits with an explicit Apply button and a "Use default" button.
- **Store URL side effects**, in this order, only when the URL really changes: if signed in, `auth.signOut()` first, so the revoke goes to the old Store and the session never reaches the new URL (it also cancels a sign-in under way); then the write; then `store.home`'s new `clearCache()` and a connectivity check of the new Store, which aborts a check of the old Store still in flight and resets the offline backoff. A sign-in pins the Store URL it started with and stops with `sign_in_cancelled` when the URL changed before its profile read or before storing the session. The renderer's Store search state resets to the Store home when the effective URL changes. No update check runs at once; stored `store_status` values stay until the next scheduled check.
- **Custom Store banner**: while an override is stored, the Shell shows on every main route (not `/onboarding`), beside the offline banner, a banner that cannot be dismissed, naming the URL ("You're using a custom Store: {url}") with a link to Settings.
- **Re-run setup**: P0-04's existing behaviour; the wizard opens at Welcome with nothing cleared or pre-populated, and existing Connections and the Default Model stay.
- **Clear usage data**: the same shared dialog and `usage.clear` as the Usage page.
- **Diagnostics** (`diagnostics.get`, now async): app version; the Model Gateway as `{ running: true, port, reachable }` or `{ running: false }`, `reachable` read live by a GET of `http://127.0.0.1:<port>/v1/models` without a token, any HTTP answer within 1 s counting (the probe is injectable); `nodeVersion` (`process.versions.node`, the Runtime Harnesses run on); `dataRoot`; `databasePath`. The UI distinguishes running on port N, not reachable on port N, and not running. It is read when Settings opens and again after Copy.
- **Copy diagnostics** (`diagnostics.copy`, no input): main builds an English plain-text block from a fresh `diagnostics.get` (version, Gateway status and port, Node version, data root, database path, Store URL with "(custom)" when not the default) and writes it with Electron's `clipboard`. The renderer never supplies the text. No API key, Store session or token, or Gateway Token is in it.
- **Copy** in `en` and `zh-CN` for every new string (screens.md), with the catalog parity test; new copy includes "Errors" / "失败".
- **api.md** records `usage.query/export/clear`, `installs.checkUpdates`, `app.openFolder`, `diagnostics.get/copy` and the `usage.recorded` event; **data-model.md** the `update_check_interval` values, the `store_base_url` rule and the new index.

## Testing Decisions

- **Seams**: main seam tests with real SQLite. The usage seam test sets `process.env.TZ` to America/New_York at the top of its file and restores it afterwards (the global Vitest config is unchanged), so local-day and period tests cross a daylight-saving change and pass in CI's UTC. The Gateway produces Usage Records from the P0-02 fake Provider (with and without usage fields, and a failure after the first byte); aggregation is then tested through IPC `usage.query` as external behaviour.
- **Usage cases**: two answers with usage, one without and one failing: the 7-day total sums the two, with one unknown and one error; a group with an unknown record and an error sums the known ones only; zero totals over no records; local-time day bucketing and periods across the end of daylight saving time; Harness and Provider filters narrow every grouping alike and the days sum to the period; most recently used first; export writes the grouped rows of the period and filters to the picked file, writes nothing on cancel and answers `internal_error` when the write fails; clear leaves every total zero and no group.
- **Settings cases**: every setting reads back the same after a restart; a fresh profile checks every 6 hours on the default Store; Never makes no `latest_versions` call over 30 simulated hours, not even 10 s after start, while 1 hour makes the startup check and one each hour; choosing Never cancels scheduled checks; a new interval schedules the next check a whole interval from now; Check now answers `store_unreachable` while offline; Store URL validation, sign-out before the write, the next Store read on the new URL, the home cache drop, the new Store checked while a check of the old one hangs, and a sign-in started during the sign-out's revoke cancelled; both folders open (the logs folder created), `open_failed` with the path; a Gateway that stops answering shows as not reachable; Copy diagnostics puts every listed field on the clipboard, read fresh, with the anon key and session tokens absent.
- **Renderer**: component tests in jsdom in `en` and `zh-CN`: the period selector and its starts (a pure function tested with an injected clock, including crossing local midnight), filters, the dash rule, live refresh throttling and the hidden-window case, export and its sticky error, Clear to the empty state, no cost shown; Settings sections in both languages, the language switch changing a nav label in place, interval and Check now with its toast and offline state, folders, the Store URL Apply, refusal and banner on every main screen but not the wizard, the Store search reset on a URL change, Re-run setup writing nothing, Clear usage data and diagnostics.
- **Not built here**: Desktop E2E (including the language switch in the real app) is left to P0-13.
- **Fixtures**: fake Provider scripts from P0-02; no real credentials.
- **Prior art**: P0-02 Gateway tests; P0-04 renderer tests; P0-10's update-check tests with fake timers.

## Out of Scope

- Cost estimation and pricing tables.
- Telemetry or any upload of usage data (P1-06 is opt-in telemetry and still never includes token data).
- Connection and Slot Binding management (P0-03).
- Per-Harness budget limits.
- A usage chart.
- From screens.md's Settings: Appearance, the local-Provider detection toggle, Move data location, Licenses, Sign out (it exists on Publish) and Reset app.
- The terminal font size P0-05 deferred here; it stays fixed at 13 px.
- Checking for and installing updates of the app itself (story 16 as first written); P0-13 defers app updates, so Settings shows only the version.
- Desktop E2E (P0-13).

## Further Notes

- Aggregation queries use the (`harness_id`, `timestamp`) index for a Harness filter and the `timestamp` index added by migration `0008` for periods over every Harness; the table can grow to millions of rows for heavy users.
- Deviations from the tickets (#77, #78) as built:
  - The live event is `usage.recorded` (dotted like `installs.changed`), not `usage:recorded`, and is emitted by main after the insert; the Gateway package is unchanged.
  - The CSV is not "exactly the displayed view": it is the page's period and filters at the finest grain the page shows (Harness, Provider and model, day), ordered by those columns.
  - A token cell shows the dash only when its row has unknown records; a row of failed requests only shows 0.
  - There is no `status` dimension in `groupBy`; `errors` is a column of every row instead.
  - The daily breakdown is a table, not a chart.
  - The Store URL commits with Apply (and Use default), the one exception to "no Save button", because applying per keystroke would sign the User out; the build's anon key is used for any Store URL.
  - Check now and its toast follow screens.md and the design demo, though the Settings ticket does not list them.
  - "Open Harness data root" is the app data root, also shown as Data location.
  - The Settings items listed under Out of Scope are not built.

## Blocked by

- P0-02 Model Gateway core
- P0-04 Desktop app shell, i18n and first-run wizard
