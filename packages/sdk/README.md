# @harness-store/sdk

> Status: placeholder (P0-01.1). The SDK arrives in P0-06.

The SDK for authors of Node **Harnesses**. A Harness never holds model credentials; the **Runtime** launches it with a **Gateway Token** and the address of the **Model Gateway** in its environment. This package turns that launch environment into a few small, typed helpers.

## What it will contain

- `getContext()`: the launch environment (`HARNESS_ID`, `HARNESS_VERSION`, `HARNESS_DATA_DIR`, `HARNESS_WORKSPACE`, `HARNESS_PORT`, `HARNESS_LOCALE`, ...) as typed values: Harness ID, Harness Version, Data Directory, Workspace, locale, platform and port.
- `createOpenAIClient()` and `gatewayFetch()`: an OpenAI client, or plain `fetch`, pre-configured to call the Model Gateway with the Gateway Token.
- `listSlots()`, Model Slot constants, a typed `SlotUnboundError` for when the User has not bound a model to a Slot, and a `createServer()` helper that listens on `HARNESS_PORT` for UI Kind `web`.
- No dependency on Electron or on `@harness-store/gateway`: a small, pure-Node library, published to npm later.

The reference Harnesses in [`examples/`](../../examples) are built with it, and the Harness authoring guide (`docs/guides/`) documents it. Spec: [`P0-06`](../../docs/delivery/specs/P0-06-sdk-and-reference-harnesses.md).

## Scripts

| Command          | What it does                                               |
| ---------------- | ---------------------------------------------------------- |
| `pnpm test`      | Vitest (`--passWithNoTests` until the first test lands)    |
| `pnpm lint`      | ESLint with the shared root config                         |
| `pnpm typecheck` | `tsc --noEmit` against `tsconfig.json` (sources and tests) |
| `pnpm build`     | Emits `dist/` from `tsconfig.build.json`                   |
