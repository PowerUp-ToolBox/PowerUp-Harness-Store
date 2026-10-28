# @harness-store/sdk

The SDK for Node **Harnesses**. A Harness never holds model credentials: the **Runtime** launches it with the address of the **Model Gateway** and a per-launch **Gateway Token** in its environment ([launch contract](../../docs/tech/architecture.md#4-harness-launch-contract)). This package turns that environment into a few small, typed helpers. It talks to the Gateway over HTTP only, exactly as any third-party Harness would, and depends on nothing but the official [`openai`](https://www.npmjs.com/package/openai) client: no Electron, no `@harness-store/gateway`.

```ts
import { createOpenAIClient, getContext, isSlotUnbound, Slots } from '@harness-store/sdk';

const { locale, workspace } = getContext();
const openai = createOpenAIClient();
try {
  const reply = await openai.chat.completions.create({
    model: Slots.default,
    messages: [{ role: 'user', content: 'Hello' }],
  });
  console.log(reply.model, reply.choices[0]?.message.content);
} catch (err) {
  if (isSlotUnbound(err)) console.error('Bind a model to this Harness in Harness Store.');
  else throw err;
}
```

## API

| Export                      | What it does                                                                                                                                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getContext()`              | The launch environment as typed values: `harnessId`, `harnessVersion`, `dataDir` (the Data Directory), `workspace`, `locale` (`en` or `zh-CN`), `platform`, `port`. Read at call time, no network. Throws `NotInHarnessStoreError` (naming the missing variables) outside Harness Store. |
| `createOpenAIClient(opts?)` | The official `openai` client with `baseURL` = `HARNESS_GATEWAY_URL` and `apiKey` = `HARNESS_GATEWAY_TOKEN`. Retries are off (`maxRetries: 0`) unless `opts` says otherwise. Chat completions, streaming or not, go through it.                                                           |
| `gatewayFetch(path, init?)` | `fetch` against the Gateway: `path` is relative to `HARNESS_GATEWAY_URL` (`'/models'`), `Authorization: Bearer <Gateway Token>` is set. The `Response` comes back untouched.                                                                                                             |
| `listSlots()`               | `GET /v1/models`: every Model Slot the Manifest declares, in order, as `{ name, resolvedModel }` (`provider/model`, or `null` when unbound).                                                                                                                                             |
| `getGatewayContext()`       | `GET /v1/harness/context`: the Gateway's view of the launch and the Manifest's Model Slots with their Model Requirements.                                                                                                                                                                |
| `createServer(handler)`     | An `http.Server` listening on `127.0.0.1:HARNESS_PORT`, for UI Kind `web`. Throws when `HARNESS_PORT` is unset.                                                                                                                                                                          |
| `Slots`                     | `{ default, fast, smart }`: convenience constants; any Slot name the Manifest declares is valid.                                                                                                                                                                                         |
| `isSlotUnbound(err)`        | True for the Gateway's 409 `slot_unbound` answer as the `openai` client surfaces it (checked by shape, not class), false for everything else.                                                                                                                                            |
| `SlotUnboundError`          | Typed `slot_unbound` error with `slot`; `SlotUnboundError.from(err)` converts a recognised `openai` error.                                                                                                                                                                               |
| `GatewayError`              | Any other non-2xx Gateway answer from `listSlots()` or `getGatewayContext()`, with `status`, `code` and `slot`.                                                                                                                                                                          |

The SDK is deliberately small: no agent loop and no prompt helpers ([ADR-0001](../../docs/adr/0001-harness-is-a-declarative-package.md), [ADR-0004](../../docs/adr/0004-harness-is-a-standalone-process-behind-a-model-gateway.md)). The reference Harnesses in [`examples/`](../../examples) are built with it, and the [authoring guide](../../docs/guides/authoring-harnesses.md) shows how to use it, from an empty folder to a published Harness. Spec: [`P0-06`](../../docs/delivery/specs/P0-06-sdk-and-reference-harnesses.md); wire protocol: [`gateway-protocol.md`](../../docs/tech/gateway-protocol.md).

ESM only. Version `0.1.0`, private until the npm publishing pipeline exists.

## Scripts

| Command          | What it does                                                                                                                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`      | Vitest: unit tests, and integration tests against a real Model Gateway and the fake Provider. `test/guide.test.ts` checks that every TypeScript snippet of the authoring guide is a file of `test/guide/` (type-checked and linted with the tests) and runs each one; they import the SDK by its name, so run `pnpm build` first |
| `pnpm lint`      | ESLint with the shared root config                                                                                                                                                                                                                                                                                               |
| `pnpm typecheck` | `tsc --noEmit` against `tsconfig.json` (sources and tests)                                                                                                                                                                                                                                                                       |
| `pnpm build`     | Emits `dist/` from `tsconfig.build.json`                                                                                                                                                                                                                                                                                         |
