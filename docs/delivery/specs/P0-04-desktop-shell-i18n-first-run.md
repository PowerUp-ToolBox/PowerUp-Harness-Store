---
spec_id: P0-04
title: Desktop app shell, i18n and first-run wizard
phase: P0
blocked_by: [P0-01]
requirements: [R-0401, R-0402, R-0403, R-0404, R-0405]
---

# P0-04 Desktop app shell, i18n and first-run wizard

## Problem Statement

Every P0 feature needs a window to live in, a way for the React UI to ask the Runtime to do things, and a language the User can read. A new User who opens the app for the first time needs to end up with at least one working Connection and a Default Model in a few minutes, or the very first Harness launch fails with `slot_unbound` and they leave.

## Solution

The Electron + React application shell: main process hosting the Runtime services, a sandboxed renderer with a typed IPC bridge, six-section navigation (Library, Store, Models, Publish, Usage, Settings, per `docs/ux/screens.md`), complete `en` and `zh-CN` message catalogs switchable at runtime, an offline-aware layout, and a skippable first-run wizard that detects local Providers, optionally takes one API key and sets the Default Model before dropping the User into the Store's Featured page.

## User Stories

1. As a User, I want the app to open to a familiar sidebar layout (Library, Store, Models, Publish, Usage, Settings), so that I always know where I am.
2. As a User, I want the app in my OS language when it is English or Chinese, so that I do not have to configure it.
3. As a User, I want to switch language in Settings and see the whole UI change immediately, so that I can pick what I prefer.
4. As a User, I want every string, including error messages from validation and the Gateway, to appear in my language, so that nothing looks half-translated.
5. As a User, I want dates, numbers and file sizes formatted for my locale, so that information reads naturally.
6. As a User, I want the app to remember window size and position, so that it opens where I left it.
7. As a User on first run, I want a short welcome that says what Harness Store is and what it does not do (no sandbox), so that I set expectations correctly.
8. As a User on first run, I want the app to find my running Ollama or LM Studio and add it with one click, so that local models work instantly.
9. As a User on first run, I want to optionally paste one API key for a cloud Provider from a short list, so that I can use my paid account.
10. As a User on first run, I want to pick my Default Model from what I just connected, so that Harnesses work immediately.
11. As a User on first run, I want to skip any or all steps, so that I can explore before committing.
12. As a User, I want to re-run the wizard from Settings, so that I can redo setup later.
13. As a User, I want a clear banner when the Store is unreachable while Library, Models, Usage and Settings still work, so that offline use is not scary.
14. As a User, I want the app to not lock up during downloads or launches, so that I can keep browsing.
15. As a User, I want keyboard navigation and screen-reader labels on primary controls, so that the app is usable without a mouse.
16. As a User, I want a light/dark theme following the OS, so that the app fits my desktop.
17. As a User, I want the app to quit cleanly, terminating running Harnesses after a confirmation, so that nothing is left orphaned. *(Deferred to P0-05: there are no Harness processes before the Supervisor exists.)*
18. As a User, I want a tray/dock indicator of how many Harnesses are running, so that I know what is active. *(Deferred to P0-05, for the same reason.)*
19. As a User, I want an "About" view with the app version, so that I can report problems accurately. *(In P0-04 this is the app version line in the Settings diagnostics block, not a separate view.)*
20. As a developer, I want the renderer to have no Node or Electron APIs, only a typed `window.api`, so that a rendering bug cannot become a privilege escalation.
21. As a developer, I want every IPC method typed end-to-end with a shared schema, so that mismatches fail at compile time.
22. As a developer, I want progress events (download, upload, launch readiness) streamed to the renderer, so that UI progress is real.
23. As a developer, I want a lint rule that fails on hard-coded UI strings, so that i18n coverage cannot regress.
24. As a developer, I want a check that `zh-CN` has every key `en` has, so that missing translations are caught in CI.
25. As a developer, I want feature areas (Library, Store, Models, Publish, Usage, Settings) as separate route modules with placeholder screens, so that later specs fill them independently.
26. As a developer, I want the app runnable in dev with hot reload for the renderer and restart for main, so that iteration is fast.

## Implementation Decisions

- **Stack**: Electron (current stable), React, TypeScript; electron-vite builds main, preload and renderer. The preload is emitted as CommonJS because a sandboxed preload cannot be ESM. Main and preload bundle every JS dependency, workspace packages included, so only `electron` and Node built-ins stay external and a packaged app needs no `node_modules`. The desktop build only compiles; packaging with electron-builder is a separate manual script, never part of the repo build or CI. Context isolation on, node integration off, sandbox on for the renderer; a single preload exposing `window.api`. A strict Content-Security-Policy ships with the renderer (scripts, styles and connections from the app itself, images also as data URLs; no objects, base URI or form actions) and is relaxed only by the dev server for hot reload; system fonts and inline SVG icons, no web fonts. Main blocks in-window navigation, denies every new window and permission request, and opens `https:` links in the default browser.
- **IPC contract**: request/response methods and event channels defined once as a TypeScript-only typed map (method name → input/output types; no runtime schema library), used by both main handlers and the renderer client. One invoke channel carries `{ method, input }`; the preload builds `window.api.<domain>.<verb>` from the shared method list, plus `window.api.on(event, listener)`, which returns an unsubscribe function. Responses are `{ ok: true, data } | { ok: false, error: { code, messageKey, params?, message } }`, where `messageKey` is the full catalog key `error.<code>` and `message` is the English text from the `en` catalog. Each handler checks its own input and answers `invalid_input`; a handler that throws becomes `internal_error`, so the app's call never rejects; calls from any sender other than the main window are refused. Codes are every Gateway error code plus `internal_error`, `invalid_input` and `not_implemented`. P0-04 ships `app.ping`, `app.status` (startup result), `app.quit`, `settings.get` / `settings.set` (the renderer may write only `locale` and `onboardingDone`), `diagnostics.get`, `connectivity.get` / `connectivity.check`, `providers.list`, and the stubs `connections.detectLocal` (empty list) and `connections.add` (`not_implemented`) that P0-03 replaces. Events: `connectivity.changed`; progress is the reserved event channel `progress:<jobId>`, with no producer until P0-05, P0-08 and P0-10.
- **Runtime services in main**: this spec creates the service container and lifecycle (start Gateway on app ready with port 0, open SQLite, run migrations, load settings); services themselves come from P0-02/03/05/10. IPC handlers and services sit behind a seam that never imports `electron`. SQLite uses the built-in `node:sqlite`; migrations are plain ordered SQL files tracked with `PRAGMA user_version`. The first migration creates only `settings` (JSON-encoded values under snake_case keys: `locale`, `onboarding_done`, `store_base_url` and the main-only `window_state`) and `usage_records`, which the Gateway's `onUsage` fills with one row per Usage Record (moved here from P0-02); later specs add their own tables in their own migrations. The Gateway's `resolveBinding` and `getConnection` return null until P0-03 and `getManifest` until P0-10; the default token verifier and logger are kept. An ESLint rule keeps the seam free of `electron`. The app data root is the OS user-data folder of the product name "Harness Store", overridable for fresh profiles and E2E through `HARNESS_STORE_USER_DATA_DIR`. On quit, the Gateway closes first (flushing Usage Records), then the database. If SQLite or the Gateway fails to start, the window still opens on a localized full-window startup error with Quit. A single-instance lock focuses the existing window on a second launch.
- **Routing**: hash-based client routing with routes `/library`, `/store`, `/store/h/*` (a splat: the Harness ID `publisher/slug` contains a slash, so a `:harnessId` param cannot match it), `/store/p/:login`, `/models`, `/publish`, `/usage`, `/settings`, `/onboarding`. `/` and unknown routes go to `/library`, or to `/onboarding` while `onboarding_done` is false; the last route is not persisted. `/onboarding` fills the window with no sidebar and no offline banner. Deep links from notifications use the same routes.
- **i18n**: two flat ICU message format catalogs, `en` and `zh-CN`, shared by main and renderer, with literal (never nested) keys; a small in-house provider and `t(key, params)` hook on top of `intl-messageformat` (not i18next, whose `{{x}}` placeholders and nested dot keys clash with the Manifest's `{x}` templates and dotted `messageKey`s). Manifest problems are looked up as `manifest.<messageKey>` with their `params` (never by `code`), and the `en` values are verbatim copies of the Manifest package's English messages; IPC and Runtime errors use `error.<code>`. Fallback: UI locale's catalog → `en` catalog → the error's English `message`. Locale = settings override → OS locale (`zh*` in any case, with `-` or `_` → `zh-CN`, else `en`), resolved in main and handed to the renderer over IPC with the settings (never read from the browser); the renderer renders nothing until it arrives. Settings offers System, English and 简体中文; System clears the override. Intl APIs with the resolved locale for dates and numbers; bytes use base 1000 (B, kB, MB, GB, at most one fraction digit).
- **Offline state**: a connectivity service in main checks the Store base URL (`HEAD`, 5 s timeout, any status below 500 is online) on start and on Retry, and while offline re-checks with backoff (15 s, 30 s, 60 s, then every 5 min); overlapping checks share one request, checks go through Electron's network stack so system proxies apply, there are no periodic checks while online, and every change is pushed as `connectivity.changed`. The Store base URL is the `store_base_url` setting, else a default pointing at the local Supabase stack until P0-07/P0-11 set the public URL. The service exposes a failure report for the Store client (P0-09). Following `docs/ux/screens.md`, the shell shows a persistent offline banner on every main route while offline, and only `/store*` swaps its content for an offline panel with Retry; Library, Models, Publish, Usage and Settings content is never blocked. Until P0-09 caches Store lists there is no last-fetched content to show, so the panel stands in for screens.md's "last fetched content with banner"; Publish's own offline state belongs to P0-08.
- **Onboarding state machine** (decision-encoding snippet):
  ```
  welcome → detect-local → cloud-key → default-model → done
  every state: [Skip] → next state, except welcome's [Skip setup] → done; [Back] on every state but welcome, done included
  reaching `done` sets settings.onboarding_done = true; done's [Open Store] and [Skip] navigate to /store
  detect-local: probes; one checkbox per found Provider, on by default, [Continue] adds the checked ones; none found → explanatory text + link to Ollama/LM Studio
  cloud-key: preset dropdown (Anthropic, OpenAI, Google, OpenRouter, DeepSeek, Qwen, Moonshot, Zhipu, MiniMax, Doubao, Groq, custom); key field; [Test connection] adds the Connection on success
  cloud-key: presets are the Gateway's Provider table minus ollama and lmstudio; custom (openai-compatible) also asks a name and base URL; failure → inline error with [Retry] [Edit] [Skip]; [Continue] on an empty form = [Skip]
  default-model: one picker over models of Connections added in this run, grouped by Connection; preselect first local, else first remote; if none, show "You can set this later in Models"
  done: summary of only what this run added or set
  ```
  Welcome shows the screens.md tagline, a paragraph on what Harness Store is, the no-sandbox sentence from `docs/ux/design-principles.md` §4 and an `en` / `zh-CN` selector prefilled from the resolved locale that writes the override at once. Wizard progress is not persisted: quitting before `done` restarts at welcome. "Re-run setup" in Settings only opens the wizard at welcome; it clears no setting, Connection or Slot Binding. The wizard uses P0-03's services through IPC; before P0-03 lands, the wizard's detect/key/default steps are stubbed and the UI is complete, so the chosen Default Model is kept only for the summary until P0-03 writes the global `default` Slot Binding.
- **Settings screen in P0-04**: Language, Re-run setup, and a read-only Diagnostics block (Model Gateway running and port, database path, app version). Everything else on that screen belongs to P0-11.
- **Window state**: `{ x, y, width, height, isMaximized }`, saved on close in the SQLite `window_state` setting; default 1280×800, min size 960×640; saved bounds whose centre is on no current display fall back to a centred default-size window, and restored bounds are clamped to the work area they reopen on. The window is created hidden and shown when ready.
- **Quit**: closing the last window quits on every platform. The confirmation when Harnesses are running (Supervisor stops all, then quit) and the tray/dock running count are deferred to P0-05.
- **Theme**: CSS variables; follows the OS through CSS `prefers-color-scheme` (no `nativeTheme` IPC); no manual toggle in P0.
- **Accessibility**: semantic landmarks, focus outlines, `aria-label` on icon buttons, all dialogs focus-trapped.
- **Tooling**: ESLint rule (core `no-restricted-syntax` on renderer `.tsx` files) banning JSX text literals and literal `aria-label`, `title`, `placeholder` and `alt` values, itself covered by a Vitest test; the catalog check is a Vitest test, not a separate script, that compares `en` and `zh-CN` keys and ICU arguments and checks that every Manifest `messageKey` and Gateway error code has an entry; both run in CI through `pnpm test`.

## Testing Decisions

- Seams: IPC contract tested by invoking main handlers directly with a fake service container (no Electron window). i18n tested by the catalog-parity test and by rendering a few components with React Testing Library under both locales.
- Onboarding state machine tested as a pure reducer with a table of (state, event) → state.
- Main and seam tests run under plain Node, component tests under jsdom; no display is needed in CI. Besides `test`, the desktop package has per-area scripts `test:i18n`, `test:runtime-bootstrap`, `test:connectivity` and `test:onboarding`.
- E2E smoke (P0-13, **Desktop E2E seam**) walks the wizard with the fake Provider acting as Ollama.
- Good test: "given OS locale zh-TW and no override, app locale is zh-CN"; "given IPC error `slot_unbound`, renderer shows the zh-CN message when locale is zh-CN".

## Out of Scope

- Actual content of Library/Store/Models/Publish/Usage screens (P0-03, P0-08, P0-09, P0-10, P0-11).
- Auto-update of the app itself, code signing (deferred), telemetry (P1-06), manual theme toggle.

## Further Notes

- UX detail for the wizard and navigation is specified in `docs/ux/flows.md` and `docs/ux/screens.md`; follow their copy for the no-sandbox notice.
- Keep the renderer free of business logic; if a rule is needed in two screens, it belongs in the Runtime and is exposed via IPC.

## Blocked by

- P0-01 Monorepo scaffold and Manifest package
