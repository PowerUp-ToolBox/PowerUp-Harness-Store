# Hello Term

A small chat in a terminal window. Type a message, press Enter, and the answer streams in from the model you bound to this Harness's `default` **Model Slot** in Harness Store. It is the reference Harness with **UI Kind** `terminal`: the smallest complete example of a Harness whose whole UI is stdin and stdout.

## Using it

- Type a message and press Enter. The conversation is kept until you quit, so you can ask follow-up questions.
- `/model` shows which model each Model Slot is bound to right now (`default → ollama/qwen3:8b`). Change it on the Models page of Harness Store; the next message uses the new model.
- `/quit`, Ctrl-C or Ctrl-D ends the session. The window stays open so you can read the conversation; close it or relaunch.
- You may choose a **Workspace** folder when you launch it. Hello Term only prints its path: it never reads or writes your files.

Hello Term follows the app's language (English or 简体中文). It has no access to your files, runs no commands and reaches no network service: every model call goes through the Model Gateway of Harness Store, which holds your keys.

## For Publishers

The source is on [GitHub](https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store/tree/main/examples/hello-term). It is built with [`@harness-store/sdk`](https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store/tree/main/packages/sdk):

- [`src/index.ts`](https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store/blob/main/examples/hello-term/src/index.ts): `getContext()` for the launch environment (and a clear message when started outside Harness Store), `createOpenAIClient()` for streaming chat on `Slots.default`, `listSlots()` for `/model`, and `SlotUnboundError.from()` to tell the User to bind a model. It shows `workspace: optional` handling: print the folder when there is one, carry on without it.
- [`src/strings.ts`](https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store/blob/main/examples/hello-term/src/strings.ts): the `en` and `zh-CN` strings, picked by `HARNESS_LOCALE`.
- `manifest.json`: one `default` Slot with `requirements: { tools: false }`, and every Declared Permission at its most restrictive value.

The source folder is not itself a Harness Package. `pnpm build` writes one to `out/`: `manifest.json`, `README.md`, `assets/` and the Entry `dist/index.mjs`, a single file that bundles the SDK and the `openai` client, so no `node_modules` is shipped. Install `out/` with "Install this folder locally" on the Publish screen of Harness Store to try it.

| Command                               | What it does                                                                                                                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                          | Type-checks `src/` (`tsc --build tsconfig.build.json`), bundles the Entry with rolldown, and writes `out/`                                                                                                                                                          |
| `pnpm --filter hello-term run pack`   | Zips `out/` to `dist/hello-term-<version>.zip` (deterministic; not `pnpm pack`, which is pnpm's own command)                                                                                                                                                        |
| `pnpm exec harness-manifest validate` | Checks `out/` or the zip exactly as the Publish flow will                                                                                                                                                                                                           |
| `pnpm test`                           | Vitest: `out/` and its zip pass `validatePackage` and the CLI with no problems and no warnings, and hold no stray files; the bundled Entry, run outside the repository, exits 1 without the launch environment and answers piped stdin against a stub Model Gateway |
| `pnpm lint`                           | ESLint with the shared root config                                                                                                                                                                                                                                  |
| `pnpm typecheck`                      | `tsc --noEmit` against `tsconfig.json` (sources and tests)                                                                                                                                                                                                          |

The end-to-end proof (install `out/`, launch it in a pty through the Runtime, chat, `/model`, `/quit`, one Usage Record) is in [`apps/desktop/test/launch/reference-harnesses.test.ts`](https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store/blob/main/apps/desktop/test/launch/reference-harnesses.test.ts). Spec: [`P0-06`](https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store/blob/main/docs/delivery/specs/P0-06-sdk-and-reference-harnesses.md).
