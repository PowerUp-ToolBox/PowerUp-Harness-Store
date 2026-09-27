# @harness-store/gateway

> Status: placeholder (P0-01.1). The Model Gateway itself arrives in P0-02.

The **Model Gateway**: the local service, hosted by the **Runtime**, that is the only path from a running **Harness** to any model. It is a loopback HTTP server that speaks the OpenAI Chat Completions protocol, authenticates each request with the Harness's per-launch **Gateway Token**, resolves the requested **Model Slot** to the User's **Slot Binding** (Model Override, then Recommended Models, then Default Model), forwards the call to the chosen **Provider** through a **Connection** the Harness never sees, streams the answer back and writes a **Usage Record**.

## What it will contain

- A framework-independent Node HTTP server with no Electron dependency, so it is tested in-process against a fake Provider (the Gateway HTTP seam, [`architecture.md`](../../docs/tech/architecture.md) §8) and can be reused server-side later.
- Provider adapters built on the Vercel AI SDK, plus data-only presets for OpenAI-compatible Providers.
- Documented error codes such as `slot_unbound`.

Normative reference: [`docs/tech/gateway-protocol.md`](../../docs/tech/gateway-protocol.md). Spec: [`P0-02`](../../docs/delivery/specs/P0-02-model-gateway-core.md).

## Scripts

| Command          | What it does                                               |
| ---------------- | ---------------------------------------------------------- |
| `pnpm test`      | Vitest (`--passWithNoTests` until the first test lands)    |
| `pnpm lint`      | ESLint with the shared root config                         |
| `pnpm typecheck` | `tsc --noEmit` against `tsconfig.json` (sources and tests) |
| `pnpm build`     | Emits `dist/` from `tsconfig.build.json`                   |
