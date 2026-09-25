# @harness-store/desktop

> Status: placeholder (P0-01.1). The Electron shell arrives in P0-04; the Runtime's installer and Process Supervisor in P0-05 and P0-10.

The Harness Store desktop app, built with Electron + React + TypeScript ([ADR-0003](../../docs/adr/0003-typescript-electron-stack.md)).

- **Main process = the Runtime.** It installs **Harness Packages** (from the Store or a local folder), drives the **Declared Permission** consent step, launches and supervises each **Harness** as its own process and window according to its **UI Kind** (`web` or `terminal`), and hosts the **Model Gateway** from [`packages/gateway`](../../packages/gateway). It keeps installs, **Slot Bindings**, **Connections** and **Usage Records** in a local store. The Runtime contains no agent loop.
- **Renderer.** A sandboxed React UI (Library, Store, Models, Publish, Settings, first-run wizard) with `en` and `zh-CN` catalogs, talking to the Runtime only over typed IPC.
- It validates every **Manifest** with [`packages/manifest`](../../packages/manifest).

References: [`docs/tech/architecture.md`](../../docs/tech/architecture.md) §2 and §4. Specs: [`P0-04`](../../docs/delivery/specs/P0-04-desktop-shell-i18n-first-run.md), [`P0-05`](../../docs/delivery/specs/P0-05-runtime-launch-and-supervise.md).

## Scripts

| Command          | What it does                                               |
| ---------------- | ---------------------------------------------------------- |
| `pnpm test`      | Vitest (`--passWithNoTests` until the first test lands)    |
| `pnpm lint`      | ESLint with the shared root config                         |
| `pnpm typecheck` | `tsc --noEmit` against `tsconfig.json` (sources and tests) |
| `pnpm build`     | Emits `dist/` from `tsconfig.build.json`                   |
