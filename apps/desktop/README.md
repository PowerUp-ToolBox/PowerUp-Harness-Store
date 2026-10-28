# @harness-store/desktop

> Status: shell, i18n, the embedded Runtime, offline handling and the first-run wizard (P0-04.1 to P0-04.5): sidebar navigation, placeholder screens, typed IPC, window state, every UI string in `en` and `zh-CN`, the Model Gateway and local SQLite database starting with the app, an offline banner and Store offline panel when the Store is unreachable, and a skippable five-step setup wizard. Connections, detection and the Default Model behind the wizard follow in P0-03; the Runtime's installer and Process Supervisor in P0-05 and P0-10.

The Harness Store desktop app, built with Electron + React + TypeScript ([ADR-0003](../../docs/adr/0003-typescript-electron-stack.md)).

- **Main process = the Runtime.** It installs **Harness Packages** (from the Store or a local folder), drives the **Declared Permission** consent step, launches and supervises each **Harness** as its own process and window according to its **UI Kind** (`web` or `terminal`), and hosts the **Model Gateway** from [`packages/gateway`](../../packages/gateway). It keeps installs, **Slot Bindings**, **Connections** and **Usage Records** in a local store. The Runtime contains no agent loop.
- **Renderer.** A sandboxed React UI (Library, Store, Models, Publish, Usage, Settings, first-run wizard) with `en` and `zh-CN` catalogs, talking to the Runtime only over typed IPC.
- It validates every **Manifest** with [`packages/manifest`](../../packages/manifest).

References: [`docs/tech/architecture.md`](../../docs/tech/architecture.md) §2 and §4. Specs: [`P0-04`](../../docs/delivery/specs/P0-04-desktop-shell-i18n-first-run.md), [`P0-05`](../../docs/delivery/specs/P0-05-runtime-launch-and-supervise.md).

## Layout

| Path                | What it holds                                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/index.ts` | The Electron main process (the Runtime): app lifecycle, the main window, IPC registration. The only main file that imports Electron                                                                              |
| `src/main/runtime/` | Startup and shutdown (`bootstrap.ts`), SQLite and its migrations, services, IPC handlers and the dispatcher, window state. Never imports Electron (an ESLint rule enforces it), so it is tested under plain Node |
| `src/preload/`      | Exposes `window.api`, built from the IPC method list, through the context bridge. Bundled as CommonJS (`index.cjs`) for the sandbox                                                                              |
| `src/shared/ipc.ts` | The IPC contract: method names with input and output types, the `{ ok, data } \| { ok, error }` result, events                                                                                                   |
| `src/shared/i18n/`  | The `en.json` and `zh-CN.json` message catalogs (ICU), locale resolution, the translator with its fallbacks, and Intl formatting                                                                                 |
| `src/renderer/`     | The React UI: hash routes, the shell (sidebar, page header), one module per screen, and `I18nProvider` with the `useI18n()` hook                                                                                 |

The renderer runs with `contextIsolation`, `sandbox` and no Node integration under a strict Content Security Policy (`src/renderer/index.html`). It sees only `window.api`: `await window.api.app.ping()` returns `{ ok: true, data: { version } }`. Set `HARNESS_STORE_USER_DATA_DIR` to run with a fresh profile.

## Runtime startup and data

On launch, before the window opens, the Runtime opens `harness-store.sqlite` in the userData folder (creating it and applying the migrations on first run), then starts the Model Gateway on `127.0.0.1` with a port the OS picks. If either step fails, the window shows a blocking error screen naming the step, with the details and Quit, instead of the app (`app.status`). Settings shows the Gateway's port, the database path and the app version (`diagnostics.get`). Quitting stops the Gateway, which writes its last Usage Records, then closes the database.

SQLite is Node's built-in `node:sqlite`, so there is no native module to rebuild. Migrations are plain SQL files in `src/main/runtime/migrations/` (`0001_…sql`, never edited once released), bundled into the main process and tracked with `PRAGMA user_version`; each runs in its own transaction. The first creates `settings` (key/value, JSON values: the language override, whether the first-run wizard has run, and the main window's size and position) and `usage_records` (one row per Usage Record from the Gateway).

## Offline

The Runtime checks whether the Store answers with `HEAD <Store base URL>` through Electron's `net.fetch` (so system proxies apply): any status below 500 is online; a network error, no answer within 5 s, or a 5xx is offline. The Store being down counts as offline, since the User meets the same problem. It checks at startup, when the User presses Retry, and, while offline, again after 15 s, 30 s, 60 s, then every 5 minutes (at most 4 checks a minute); while online it does not poll. Overlapping checks share one request. Each change is pushed to the window as the `connectivity.changed` event (`connectivity.get` and `connectivity.check` over IPC).

While offline, every main screen shows a banner ("You're offline. Library and Models still work."), and only the Store routes (`/store`, `/store/h/…`, `/store/p/…`) swap their content for an offline panel with Retry. Library, Models, Publish, Usage and Settings keep working. When Retry finds the Store again, the Store screen mounts afresh and loads its data.

The Store base URL is the `store_base_url` setting (no UI until P0-11), else `http://127.0.0.1:54321`, the Supabase local stack. It is read at every check. To try it by hand, start the app without the local stack running (offline panel on Store), then serve anything on that port, for example `python3 -m http.server 54321`, and press Retry.

## First run

On a fresh profile (`settings.onboardingDone` false) the app opens on the first-run wizard (`/onboarding`), which fills the window without the sidebar: Welcome and language → Local Providers → Remote Provider (optional) → Default model → Done, with a step list on top and Skip on every step ("Skip setup" on Welcome jumps to the summary). Back works on every step but Welcome. Reaching Done sets `onboarding_done`, so later launches open on the Library; Open Store lands on Store home. The steps are a pure reducer (`src/renderer/src/onboarding/wizard-reducer.ts`); progress is not kept, so quitting midway starts again at Welcome. Settings has "Re-run setup", which opens the wizard at Welcome and clears nothing.

Until P0-03, the Runtime's `connections.detectLocal` finds nothing and `connections.add` answers `not_implemented`, so the wizard shows its "not found" (with links to install Ollama and LM Studio), failed-test and "set this later in Models" states. The wizard keeps the chosen Default Model in its own state for the summary; P0-03 saves it as the `default` Slot Binding.

## Languages

Every string the User sees comes from `src/shared/i18n/en.json` and `zh-CN.json`: flat keys, ICU messages, rendered with `const { t } = useI18n(); t('section.library')`. A new string needs an entry in both catalogs. The UI follows the Settings override, else the OS locale (`zh*` → `zh-CN`, anything else → `en`), which main resolves and sends over IPC; switching applies at once. Runtime and Gateway errors are looked up as `error.<code>` and Manifest problems as `manifest.<messageKey>`, falling back to the English `message`. Two checks run in `pnpm test` and `pnpm lint`: catalog parity (same keys, valid ICU, same arguments; every Manifest messageKey and Gateway code covered) and an ESLint rule that rejects hard-coded JSX text. To see Chinese, start the app with `--lang=zh-CN` or set the OS language (`LANG` only matters on Linux).

## Scripts

Run them with `pnpm --filter @harness-store/desktop <script>` from the repo root.

| Command                       | What it does                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                    | `electron-vite dev`: the app with renderer hot reload; main and preload rebuild and restart                       |
| `pnpm build`                  | `electron-vite build`: compiles main, preload and renderer into `out/` (what the root build runs)                 |
| `pnpm package`                | Builds, then packages the app for the current OS into `release/` with electron-builder (manual)                   |
| `pnpm test`                   | Vitest: seam tests under Node, renderer component tests under jsdom                                               |
| `pnpm test:i18n`              | Only the i18n tests: catalog parity, locale resolution, translation, formatting, the lint rule                    |
| `pnpm test:runtime-bootstrap` | Only the startup tests: SQLite and migrations against a temp data dir, Gateway start and stop, the error screen   |
| `pnpm test:connectivity`      | Only the offline tests: the connectivity check, its backoff and debounce, the banner and the Store offline panel  |
| `pnpm test:onboarding`        | Only the first-run wizard tests: the step table, `onboarding_done` in SQLite, the wizard screens and Re-run setup |
| `pnpm lint`                   | ESLint with the shared root config                                                                                |
| `pnpm typecheck`              | `tsc --build` over `tsconfig.json` (main, preload, shared) and `tsconfig.web.json` (renderer)                     |
