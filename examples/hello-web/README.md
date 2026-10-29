# Hello Web

A small chat page in its own window. Type a message, press Enter, and the answer streams in from the model you bound to this Harness's `default` **Model Slot** in Harness Store; under the conversation, the page shows which model answered (`ollama/qwen3:8b`). It is the reference Harness with **UI Kind** `web`: the smallest complete example of a Harness that serves its own page.

## Using it

- Type a message and press Enter or Send. The conversation is kept while the window is open, so you can ask follow-up questions; reloading the window starts a new one.
- "Answered by" names the model that wrote the last answer. Change it on the Models page of Harness Store; the next message uses the new model.
- If no model is bound, the page says so and where to bind one; send the message again afterwards.
- The Language menu switches the page between English and 简体中文. It starts in the app's language.

Hello Web has no access to your files, runs no commands and reaches no network service: every model call goes through the Model Gateway of Harness Store, which holds your keys.

## For Publishers

The source is on [GitHub](https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store/tree/main/examples/hello-web). It is built with [`@harness-store/sdk`](https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store/tree/main/packages/sdk) and shows the pattern every web Harness that needs a model follows: **the page never calls the Model Gateway**. The Gateway sends no CORS headers, so a page cannot reach it, and the Gateway Token must stay out of the page. The page calls its own server, which calls the Gateway and relays the answer.

- [`src/index.ts`](https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store/blob/main/examples/hello-web/src/index.ts): `getContext()` for the launch environment (and a clear message when started outside Harness Store), `createServer()` to listen on `127.0.0.1:$HARNESS_PORT`, where the Runtime opens the window. `GET /` serves the page with a Content Security Policy that lets it connect to its own origin only.
- [`src/chat.ts`](https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store/blob/main/examples/hello-web/src/chat.ts): `POST /chat` takes `{ messages: [{ role, content }] }`, streams the answer from `Slots.default` through `createOpenAIClient()`, and relays it as Server-Sent Events: `token` `{ text }`, then `done` `{ model }` with the `provider/model` that answered, or `error` `{ code, message }` (`slot_unbound` comes from `SlotUnboundError.from()`). It answers only JSON requests whose `Host` is `127.0.0.1` or `localhost` on its port (403 or 415 otherwise), so other sites and rebound DNS names cannot use it, and it aborts the Gateway call when the page goes away.
- [`src/page.ts`](https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store/blob/main/examples/hello-web/src/page.ts): the page as one HTML string with inline CSS and script, so there are no files to find at runtime. It keeps the conversation, reads the stream with `fetch` (`EventSource` cannot POST), and holds the `en` and `zh-CN` strings; `HARNESS_LOCALE` sets the first language. The ids `#message`, `#send`, `#reply` and `#model` are stable for tests.
- `manifest.json`: one `default` Slot with `requirements: { tools: false }`, `workspace: none`, and every Declared Permission at its most restrictive value.

The source folder is not itself a Harness Package. `pnpm build` writes one to `out/`: `manifest.json`, `README.md`, `assets/` and the Entry `dist/index.mjs`, a single file that bundles the SDK and the `openai` client, so no `node_modules` is shipped. Install `out/` with "Install this folder locally" on the Publish screen of Harness Store to try it.

| Command                               | What it does                                                                                                                                                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`                          | Type-checks `src/` (`tsc --build tsconfig.build.json`), bundles the Entry with rolldown, and writes `out/`                                                                                                                                   |
| `pnpm --filter hello-web run pack`    | Zips `out/` to `dist/hello-web-<version>.zip` (deterministic; not `pnpm pack`, which is pnpm's own command)                                                                                                                                  |
| `pnpm exec harness-manifest validate` | Checks `out/` or the zip exactly as the Publish flow will                                                                                                                                                                                    |
| `pnpm test`                           | Vitest: `out/` and its zip pass `validatePackage` and the CLI with no problems and no warnings, and hold no stray files; the bundled Entry, run outside the repository, exits 1 without the launch environment and otherwise serves its page |
| `pnpm lint`                           | ESLint with the shared root config                                                                                                                                                                                                           |
| `pnpm typecheck`                      | `tsc --noEmit` against `tsconfig.json` (sources and tests)                                                                                                                                                                                   |

The end-to-end proof (install `out/`, launch it through the Runtime, chat from the page, the model it names, `/chat` and its guards, one Usage Record) is in [`apps/desktop/test/launch/reference-harnesses.test.ts`](https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store/blob/main/apps/desktop/test/launch/reference-harnesses.test.ts). To build a Harness of your own, follow the [authoring guide](https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store/blob/main/docs/guides/authoring-harnesses.md). Spec: [`P0-06`](https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store/blob/main/docs/delivery/specs/P0-06-sdk-and-reference-harnesses.md).
