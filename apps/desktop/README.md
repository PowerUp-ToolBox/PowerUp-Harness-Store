# @harness-store/desktop

> Status: shell (P0-04.1): sidebar navigation, placeholder screens, typed IPC and window state. i18n, the embedded Gateway and SQLite, offline handling and the first-run wizard follow in P0-04; the Runtime's installer and Process Supervisor in P0-05 and P0-10.

The Harness Store desktop app, built with Electron + React + TypeScript ([ADR-0003](../../docs/adr/0003-typescript-electron-stack.md)).

- **Main process = the Runtime.** It installs **Harness Packages** (from the Store or a local folder), drives the **Declared Permission** consent step, launches and supervises each **Harness** as its own process and window according to its **UI Kind** (`web` or `terminal`), and hosts the **Model Gateway** from [`packages/gateway`](../../packages/gateway). It keeps installs, **Slot Bindings**, **Connections** and **Usage Records** in a local store. The Runtime contains no agent loop.
- **Renderer.** A sandboxed React UI (Library, Store, Models, Publish, Usage, Settings, first-run wizard) with `en` and `zh-CN` catalogs, talking to the Runtime only over typed IPC.
- It validates every **Manifest** with [`packages/manifest`](../../packages/manifest).

References: [`docs/tech/architecture.md`](../../docs/tech/architecture.md) §2 and §4. Specs: [`P0-04`](../../docs/delivery/specs/P0-04-desktop-shell-i18n-first-run.md), [`P0-05`](../../docs/delivery/specs/P0-05-runtime-launch-and-supervise.md).

## Layout

| Path                | What it holds                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/index.ts` | The Electron main process (the Runtime): app lifecycle, the main window, IPC registration. The only main file that imports Electron            |
| `src/main/runtime/` | Services, IPC handlers and the dispatcher, window state. Never imports Electron (an ESLint rule enforces it), so it is tested under plain Node |
| `src/preload/`      | Exposes `window.api`, built from the IPC method list, through the context bridge. Bundled as CommonJS (`index.cjs`) for the sandbox            |
| `src/shared/ipc.ts` | The IPC contract: method names with input and output types, the `{ ok, data } \| { ok, error }` result, events                                 |
| `src/renderer/`     | The React UI: hash routes, the shell (sidebar, page header) and one module per screen                                                          |

The renderer runs with `contextIsolation`, `sandbox` and no Node integration under a strict Content Security Policy (`src/renderer/index.html`). It sees only `window.api`: `await window.api.app.ping()` returns `{ ok: true, data: { version } }`. The main window's size and position are saved in `app-state.json` in the userData folder; set `HARNESS_STORE_USER_DATA_DIR` to run with a fresh profile.

## Scripts

Run them with `pnpm --filter @harness-store/desktop <script>` from the repo root.

| Command          | What it does                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm dev`       | `electron-vite dev`: the app with renderer hot reload; main and preload rebuild and restart       |
| `pnpm build`     | `electron-vite build`: compiles main, preload and renderer into `out/` (what the root build runs) |
| `pnpm package`   | Builds, then packages the app for the current OS into `release/` with electron-builder (manual)   |
| `pnpm test`      | Vitest: seam tests under Node, renderer component tests under jsdom                               |
| `pnpm lint`      | ESLint with the shared root config                                                                |
| `pnpm typecheck` | `tsc --build` over `tsconfig.json` (main, preload, shared) and `tsconfig.web.json` (renderer)     |
