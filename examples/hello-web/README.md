# hello-web (reference Harness)

> Status: placeholder (P0-01.1). The Harness itself arrives in P0-06.

A reference **Harness** with **UI Kind** `web` and runtime kind `node`. When launched, the **Runtime** starts its **Entry** with the bundled Node, the Harness serves a single chat page on `HARNESS_PORT`, and the Runtime opens that page in its own window. The page talks only to its own backend, which calls the **Model Gateway** using the `default` **Model Slot**, so it runs on whatever model the User has bound.

It will ship as a complete, publishable **Harness Package**: a **Manifest** (`manifest.json`), `README.md`, `assets/icon.png`, localized `en` / `zh-CN` text, and a single-file JavaScript bundle as its Entry (no `node_modules` shipped). It is built with [`@harness-store/sdk`](../../packages/sdk), serves as one of the first Store listings, and is the Harness the end-to-end acceptance journey publishes, installs and launches (P0-13).

Spec: [`P0-06`](../../docs/delivery/specs/P0-06-sdk-and-reference-harnesses.md).

## Scripts

| Command          | What it does                                               |
| ---------------- | ---------------------------------------------------------- |
| `pnpm test`      | Vitest (`--passWithNoTests` until the first test lands)    |
| `pnpm lint`      | ESLint with the shared root config                         |
| `pnpm typecheck` | `tsc --noEmit` against `tsconfig.json` (sources and tests) |
| `pnpm build`     | Emits `dist/` from `tsconfig.build.json`                   |
