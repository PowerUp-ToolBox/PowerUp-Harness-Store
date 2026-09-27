# hello-term (reference Harness)

> Status: placeholder (P0-01.1). The Harness itself arrives in P0-06.

A reference **Harness** with **UI Kind** `terminal` and runtime kind `node`. When launched, the **Runtime** opens a window with an embedded terminal attached to the Harness process, which runs a short interactive chat loop (`/model` lists its Model Slots, `/quit` exits). Every model call goes through the **Model Gateway** using the `default` **Model Slot**, so it runs on whatever model the User has bound.

It will ship as a complete, publishable **Harness Package**: a **Manifest** (`manifest.json`), `README.md`, `assets/icon.png`, localized `en` / `zh-CN` text, and a single-file JavaScript bundle as its Entry (no `node_modules` shipped). It is built with [`@harness-store/sdk`](../../packages/sdk) and is also used by the post-build smoke test that proves the bundled Node runs Node Harnesses on every platform (P0-13).

Spec: [`P0-06`](../../docs/delivery/specs/P0-06-sdk-and-reference-harnesses.md).

## Scripts

| Command          | What it does                                               |
| ---------------- | ---------------------------------------------------------- |
| `pnpm test`      | Vitest (`--passWithNoTests` until the first test lands)    |
| `pnpm lint`      | ESLint with the shared root config                         |
| `pnpm typecheck` | `tsc --noEmit` against `tsconfig.json` (sources and tests) |
| `pnpm build`     | Emits `dist/` from `tsconfig.build.json`                   |
