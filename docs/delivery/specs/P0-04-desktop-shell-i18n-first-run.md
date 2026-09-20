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

The Electron + React application shell: main process hosting the Runtime services, a sandboxed renderer with a typed IPC bridge, five-section navigation (Library, Store, Models, Publish, Settings), complete `en` and `zh-CN` message catalogs switchable at runtime, an offline-aware layout, and a skippable first-run wizard that detects local Providers, optionally takes one API key and sets the Default Model before dropping the User into the Store's Featured page.

## User Stories

1. As a User, I want the app to open to a familiar sidebar layout (Library, Store, Models, Publish, Settings), so that I always know where I am.
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
17. As a User, I want the app to quit cleanly, terminating running Harnesses after a confirmation, so that nothing is left orphaned.
18. As a User, I want a tray/dock indicator of how many Harnesses are running, so that I know what is active.
19. As a User, I want an "About" view with the app version and links, so that I can report problems accurately.
20. As a developer, I want the renderer to have no Node or Electron APIs, only a typed `window.api`, so that a rendering bug cannot become a privilege escalation.
21. As a developer, I want every IPC method typed end-to-end with a shared schema, so that mismatches fail at compile time.
22. As a developer, I want progress events (download, upload, launch readiness) streamed to the renderer, so that UI progress is real.
23. As a developer, I want a lint rule that fails on hard-coded UI strings, so that i18n coverage cannot regress.
24. As a developer, I want a check that `zh-CN` has every key `en` has, so that missing translations are caught in CI.
25. As a developer, I want feature areas (Library, Store, Models, Publish, Settings) as separate route modules with placeholder screens, so that later specs fill them independently.
26. As a developer, I want the app runnable in dev with hot reload for the renderer and restart for main, so that iteration is fast.

## Implementation Decisions

- **Stack**: Electron (current stable), React, TypeScript, Vite for renderer, a bundler for main/preload. Context isolation on, node integration off, sandbox on for the renderer; a single preload exposing `window.api`.
- **IPC contract**: request/response methods and event channels defined once as a typed schema (method name → input/output types), used by both main handlers and the renderer client. Responses are `{ ok: true, data } | { ok: false, error: { code, messageKey, params?, message } }`. Progress is an event channel `progress:<jobId>`.
- **Runtime services in main**: this spec creates the service container and lifecycle (start Gateway on app ready with port 0, open SQLite, run migrations, load settings); services themselves come from P0-02/03/05/10.
- **Routing**: hash-based client routing with routes `/library`, `/store`, `/store/h/:harnessId`, `/store/p/:login`, `/models`, `/publish`, `/usage`, `/settings`, `/onboarding`. Deep links from notifications use the same routes.
- **i18n**: ICU message format catalogs `en.json` and `zh-CN.json`; a `t(key, params)` hook; locale = settings override → OS locale (`zh*` → `zh-CN`, else `en`). Runtime error codes and Manifest problem `messageKey`s map to catalog keys with a fallback to the English `message`. Intl APIs for dates/numbers/bytes.
- **Offline state**: a connectivity service pings the Store base URL on start and on failure; Store routes render an offline panel with retry; other routes unaffected.
- **Onboarding state machine** (decision-encoding snippet):
  ```
  welcome → detect-local → cloud-key → default-model → done
  every state: [Skip] → next state; [Back] allowed; `done` sets settings.onboarding_done = true and navigates to /store
  detect-local: probes; shows found Providers with [Add]; none found → explanatory text + link to Ollama/LM Studio
  cloud-key: preset dropdown (Anthropic, OpenAI, Google, OpenRouter, DeepSeek, Qwen, Moonshot, Zhipu, MiniMax, Doubao, Groq, custom); key field; [Test & add]
  default-model: list models from Connections added so far; if none, show "You can set this later in Models"
  ```
  The wizard uses P0-03's services through IPC; before P0-03 lands, the wizard's detect/key/default steps are stubbed and the UI is complete.
- **Window state**: persisted in settings; main window min size 960×640.
- **Quit**: if Harnesses are running, confirm; on confirm, Supervisor stops all (P0-05) then quits.
- **Theme**: CSS variables; follows `nativeTheme`; no manual toggle in P0.
- **Accessibility**: semantic landmarks, focus outlines, `aria-label` on icon buttons, all dialogs focus-trapped.
- **Tooling**: ESLint rule banning JSX text literals outside the i18n hook; a script comparing catalog keys; both run in CI.

## Testing Decisions

- Seams: IPC contract tested by invoking main handlers directly with a fake service container (no Electron window). i18n tested by catalog-parity script and by rendering a few components with React Testing Library under both locales.
- Onboarding state machine tested as a pure reducer with a table of (state, event) → state.
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
