English | [简体中文](authoring-harnesses.zh-CN.md)

# Authoring Harnesses

This guide takes a Publisher from an empty folder to a **Harness** that is ready for the Store. It builds a small one along the way, **First Harness**, and explains each step with the two reference Harnesses that ship in this repository: [`hello-web`](../../examples/hello-web) (UI Kind `web`) and [`hello-term`](../../examples/hello-term) (UI Kind `terminal`). Follow it section by section and you end with a Harness you have installed, launched and checked exactly as the Store will check it.

Terms follow [`CONTEXT.md`](../../CONTEXT.md). The normative documents are the [Manifest specification](../tech/manifest-spec.md), the [launch contract](../tech/architecture.md#4-harness-launch-contract) and the [Model Gateway protocol](../tech/gateway-protocol.md); where this guide and they disagree, they win.

**Contents**

1. [What a Harness is](#1-what-a-harness-is)
2. [Folder layout](#2-folder-layout)
3. [The Manifest, field by field](#3-the-manifest-field-by-field)
4. [The launch contract](#4-the-launch-contract)
5. [Using the SDK](#5-using-the-sdk)
6. [Model Slots and Recommended Models](#6-model-slots-and-recommended-models)
7. [What the platform does not do](#7-what-the-platform-does-not-do)
8. [Testing locally](#8-testing-locally)
9. [Publishing](#9-publishing)

**Before you start** you need:

- Harness Store, with at least one Connection and a Default Model for the `default` Slot (the first-run setup or the Models page). Any Provider works, a local Ollama or LM Studio included.
- Node.js 22.13 or later (22 or 24 LTS) and npm, to build your Harness. Users need neither: the Runtime runs your Entry with its own Node.
- Until `@harness-store/sdk` and `@harness-store/manifest` are published to npm, a checkout of this repository to build them from, which also needs git and pnpm 10.

## 1. What a Harness is

A **Harness** is a self-contained program, packaged with a **Manifest**, that does one concrete agent-powered job (a code reviewer, a writing assistant, a chat page) and owns its own agent loop and UI. The **Runtime** in the Harness Store desktop app installs it, launches it as its own app, in its own window, and supervises the process; the Harness reaches language models only through the **Model Gateway**, a local service that speaks the OpenAI Chat Completions protocol and forwards each request to whichever Provider and model the **User** has bound to the Harness's **Model Slot**. What a Publisher uploads is a **Harness Package**: the Manifest plus every file needed to run the Harness on the platforms it declares. Each upload is one **Harness Version**, immutable once published.

## 2. Folder layout

A Harness Package has this layout ([manifest-spec.md §1](../tech/manifest-spec.md#1-package-layout)):

```
<archive root>/
  manifest.json          required (≤ 1 MB)
  README.md              required (Store description, Markdown, ≤ 50 KB)
  assets/icon.png        required, 512×512 PNG
  assets/<screenshots>   optional, PNG/JPEG, ≤ 5 files, ≤ 2 MB each
  <anything else>        the Harness itself
```

- `manifest.json` is the Manifest (section 3). It is the only file the Store and the Runtime interpret.
- `README.md` is the description on the Store's detail page. Write it for Users: what the Harness does, how to use it, what it touches.
- `assets/icon.png` is exactly 512×512 pixels. Every other file directly in `assets/` is a screenshot, so keep sources (an `.svg`, a `.psd`) somewhere else.
- Everything else is yours: for runtime kind `node`, the Entry and whatever it imports. There is no install step, so nothing is downloaded at install time: either ship `node_modules` inside the package or, simpler and much smaller, bundle the Entry and its dependencies into one file.

The limits (500 MB, 20 000 files, no symlinks, no absolute or `..` paths, and so on) are in [manifest-spec.md §1](../tech/manifest-spec.md#1-package-layout); the validator in section 8 checks every one of them.

### Source folder and Harness folder

Keep the folder you work in apart from the folder you install and publish. The reference Harnesses do this: `examples/hello-web` holds `src/`, `package.json` and `node_modules`, and `pnpm build` writes the Harness folder `examples/hello-web/out/`, which holds only `manifest.json`, `README.md`, `assets/` and the bundled Entry `dist/index.mjs`. Only `out/` is validated, installed and published. Installing or publishing the source folder would carry `src/` and `node_modules` along, and a pnpm `node_modules` is made of symlinks, which a Harness Package may not contain.

### Start First Harness

Make a working folder with three things side by side: the repository checkout, the SDK and Manifest packages built from it, and your Harness.

```sh
mkdir work
cd work
git clone https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store.git
cd PowerUp-Harness-Store
pnpm install
pnpm --filter @harness-store/manifest --filter @harness-store/sdk build
pnpm --filter @harness-store/manifest --filter @harness-store/sdk pack --pack-destination ../harness-store-packages
cd ..
```

Here `pnpm pack` is pnpm's own command: it writes `harness-store-sdk-0.1.0.tgz` and `harness-store-manifest-0.0.0.tgz` to `work/harness-store-packages/`. Now create the source folder of First Harness and install the SDK, the Manifest validator and a bundler ([rolldown](https://rolldown.rs); esbuild or any other single-file bundler works the same way):

```sh
mkdir first-harness
cd first-harness
npm init -y
npm pkg set type=module "scripts.build=node scripts/build.mjs"
npm install ../harness-store-packages/harness-store-sdk-0.1.0.tgz
npm install --save-dev rolldown@1.2.11 ../harness-store-packages/harness-store-manifest-0.0.0.tgz
mkdir src
mkdir scripts
mkdir assets
```

Save this build script as `scripts/build.mjs`. It bundles `src/index.ts` and everything it imports (the SDK and the `openai` client) into one ES module, then copies the files of the package layout next to it, so `out/` is a complete Harness folder that needs no `node_modules`:

```js
// Writes the Harness folder, out/: the Entry src/index.ts bundled into one file with everything it
// imports, next to manifest.json, README.md and assets/. Nothing else of this folder goes in.
import { cpSync, rmSync } from 'node:fs';
import { build } from 'rolldown';

rmSync('out', { recursive: true, force: true });
await build({
  input: 'src/index.ts',
  platform: 'node',
  transform: { target: 'node22' },
  output: { file: 'out/dist/index.mjs', format: 'esm', codeSplitting: false },
});
for (const file of ['manifest.json', 'README.md', 'assets']) {
  cpSync(file, `out/${file}`, { recursive: true });
}
```

Then add the package files:

- `assets/icon.png`: your icon, a 512×512 PNG. The reference Harnesses use a rounded square with two initials.
- `README.md`: a few paragraphs for Users, for example:

  ```markdown
  # First Harness

  Ask a question in the terminal window and the answer streams in from the model you bound to this Harness in Harness Store. Press Ctrl-D to quit.

  First Harness reads no files, runs no commands and reaches no network service: every model call goes through the Model Gateway of Harness Store.
  ```

- `manifest.json`: written in section 3.
- `src/index.ts`: written in section 5.

`npm run build` will then produce:

```
first-harness/out/
  manifest.json
  README.md
  assets/icon.png
  dist/index.mjs        the Entry
```

## 3. The Manifest, field by field

The Manifest is `manifest.json` at the root of the Harness Package. This is the whole Manifest of [`hello-web`](../../examples/hello-web/manifest.json):

```json
{
  "manifestVersion": 1,
  "id": "harness-store/hello-web",
  "version": "0.1.0",
  "name": "Hello Web",
  "summary": "Reference Harness: a small chat page that runs on any model.",
  "tags": ["education"],
  "license": "MIT",
  "sourceRepo": "https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store/tree/main/examples/hello-web",
  "platforms": [
    "darwin-arm64",
    "darwin-x64",
    "win32-x64",
    "win32-arm64",
    "linux-x64",
    "linux-arm64"
  ],
  "runtime": { "kind": "node", "node": "22" },
  "entry": "dist/index.mjs",
  "ui": { "kind": "web" },
  "workspace": "none",
  "models": {
    "slots": {
      "default": {
        "description": "Writes chat replies",
        "requirements": { "tools": false }
      }
    }
  },
  "permissions": {
    "filesystem": { "scope": "none" },
    "shell": false,
    "network": { "domains": [] }
  }
}
```

| Field | In `hello-web` | What it means |
|---|---|---|
| `manifestVersion` | `1` | The format version. Always `1` for now. |
| `id` | `harness-store/hello-web` | The **Harness ID**, `publisher/slug`. The publisher segment must be the GitHub login you publish with, in lower case (1–39 lower-case letters, digits and hyphens, starting with a letter or digit); the slug is 3–40 lower-case letters, digits and hyphens, starting and ending with a letter or digit. It never changes for the life of the Harness. |
| `version` | `0.1.0` | The **Harness Version**, strict semver without a `v`. Every published version must be greater than the last. |
| `name` | `Hello Web` | The display name, 2–40 characters. |
| `summary` | one sentence | Shown in lists, at most 120 characters. |
| `tags` | `["education"]` | Optional, up to 5 from `coding`, `writing`, `research`, `data`, `productivity`, `devops`, `design`, `education`, `fun`, `other`. |
| `license` | `MIT` | One SPDX identifier, or `proprietary`. |
| `sourceRepo` | a GitHub URL | Optional, shown as "Source" on the detail page. `homepage` works the same way. |
| `platforms` | all six | Where the Harness runs: any of `darwin-arm64`, `darwin-x64`, `win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64`. The Runtime launches it only on a listed platform. A bundled Node Harness runs everywhere, so list all six unless you know better. |
| `runtime` | `{ "kind": "node", "node": "22" }` | Run the Entry with the Runtime's Node. `node` must be `"22"`. The other kind is `binary`: you ship an executable per platform. |
| `entry` | `dist/index.mjs` | The **Entry**: a path relative to the package root, with `/` separators and no `./`. For `binary`, an object from platform to executable path. |
| `ui` | `{ "kind": "web" }` | The **UI Kind**. `web`: serve a page on `127.0.0.1:$HARNESS_PORT`; the Runtime opens it in the Harness window. Optional `path` (default `/`), `readyTimeoutSeconds` (5–120, default 30) and `window` (`width`, `height`). |
| `workspace` | `none` | Whether the User picks a **Workspace** folder at launch: `required`, `optional` or `none` (the default). |
| `models` | one `default` Slot | The **Model Slots** the Harness asks the Gateway for, each with a `description`, its **Model Requirements** and optional **Recommended Models** (section 6). A `default` Slot is mandatory. |
| `permissions` | all at their minimum | The **Declared Permissions**: `filesystem.scope` (`none`, `workspace`, `home` or `paths` with a list), `shell` (runs commands or not) and `network` (`domains`, or `any: true`). All three keys are required. Model calls through the Gateway are never declared. |

Apart from its identity fields (`id`, `name`, `summary` and `sourceRepo`), [`hello-term`](../../examples/hello-term/manifest.json) differs in three fields: its UI Kind is `terminal` (the Runtime runs it in a pty inside an embedded terminal, and stdin and stdout are its whole UI; there is no port), its Workspace is `optional` (the User may pick a folder or continue without one), and its Slot description says what the model does there:

```json
{
  "manifestVersion": 1,
  "id": "harness-store/hello-term",
  "version": "0.1.0",
  "name": "Hello Term",
  "summary": "Reference Harness: a chat loop in an embedded terminal.",
  "tags": ["education"],
  "license": "MIT",
  "sourceRepo": "https://github.com/PowerUp-ToolBox/PowerUp-Harness-Store/tree/main/examples/hello-term",
  "platforms": [
    "darwin-arm64",
    "darwin-x64",
    "win32-x64",
    "win32-arm64",
    "linux-x64",
    "linux-arm64"
  ],
  "runtime": { "kind": "node", "node": "22" },
  "entry": "dist/index.mjs",
  "ui": { "kind": "terminal" },
  "workspace": "optional",
  "models": {
    "slots": {
      "default": {
        "description": "Answers in the terminal",
        "requirements": { "tools": false }
      }
    }
  },
  "permissions": {
    "filesystem": { "scope": "none" },
    "shell": false,
    "network": { "domains": [] }
  }
}
```

Other keys you may use: `changelog` (Markdown for this version, up to 5 KB), `channel` (only `"stable"` in P0), `$schema` (lets an editor check the file against the [Manifest JSON Schema](../../packages/manifest/src/manifest-v1.schema.json)) and top-level `x-` keys for your own data, which the Store and the Runtime ignore. Any other unknown key, at any level, is a problem. Keys that have no effect, such as `ui.path` on a `terminal` Harness, give a warning.

Declare permissions honestly, as what your Harness actually does: Users see them in the install dialog, and an update that widens them asks the User to consent again.

### First Harness's Manifest

First Harness is a terminal Harness that may get a Workspace and asks one Slot for answers. Use your own GitHub login instead of `alice`, and save this as `manifest.json`:

```json
{
  "manifestVersion": 1,
  "id": "alice/first-harness",
  "version": "0.1.0",
  "name": "First Harness",
  "summary": "Answers your questions in a terminal window, on any model.",
  "tags": ["education"],
  "license": "MIT",
  "platforms": [
    "darwin-arm64",
    "darwin-x64",
    "win32-x64",
    "win32-arm64",
    "linux-x64",
    "linux-arm64"
  ],
  "runtime": { "kind": "node", "node": "22" },
  "entry": "dist/index.mjs",
  "ui": { "kind": "terminal" },
  "workspace": "optional",
  "models": {
    "slots": {
      "default": {
        "description": "Answers questions",
        "requirements": { "tools": false }
      }
    }
  },
  "permissions": {
    "filesystem": { "scope": "none" },
    "shell": false,
    "network": { "domains": [] }
  }
}
```

## 4. The launch contract

When the Runtime launches a Harness it sets these environment variables. They are reproduced from [architecture.md §4](../tech/architecture.md#4-harness-launch-contract), which is the normative source:

| Variable | Value |
|---|---|
| `HARNESS_GATEWAY_URL` | `http://127.0.0.1:<gateway-port>/v1` |
| `HARNESS_GATEWAY_TOKEN` | per-launch token |
| `OPENAI_BASE_URL` | same as `HARNESS_GATEWAY_URL` (so unmodified OpenAI SDKs work) |
| `OPENAI_API_KEY` | same as `HARNESS_GATEWAY_TOKEN` |
| `HARNESS_ID` | `publisher/slug` |
| `HARNESS_VERSION` | installed semver |
| `HARNESS_DATA_DIR` | absolute path, private to this Harness |
| `HARNESS_WORKSPACE` | absolute path, only when a Workspace was chosen |
| `HARNESS_PORT` | port to listen on, only for `ui.kind = web` |
| `HARNESS_LOCALE` | `en` or `zh-CN` |
| `HARNESS_PLATFORM` | e.g. `darwin-arm64` |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` | added in P1-03 once the Gateway accepts Anthropic Messages inbound; not set in P0 |

What else a Harness can rely on at launch:

- **Before the start.** The launch is refused, and the User is sent to the Models page, when no model can fill the `default` Slot. No other Slot is checked, so a call on another Slot can still fail with `slot_unbound` (section 5).
- **Working directory.** The process starts in the Workspace when there is one, else in the **Data Directory**, never in the installed Harness folder. Find your own files relative to the Entry (`import.meta.dirname`), or, like the reference Harnesses, bundle everything into the Entry.
- **Data Directory.** `HARNESS_DATA_DIR` is yours for state, created before the launch and deleted when the User uninstalls the Harness. Keep settings, caches and history there, not in the Workspace.
- **Environment.** Inherited variables whose names start with `OPENAI_`, `ANTHROPIC_`, `GOOGLE_API_`, `GEMINI_`, `OPENROUTER_` or `HARNESS_` are removed before the table's are set, so a Harness never picks up the User's own keys by accident.
- **Node.** A `node` Harness runs as `<node> <entry>` with the Runtime's Node: in P0 that is Electron's Node 24, although Manifests declare `"22"`. Write code that runs on both. On macOS and Linux it is Electron's executable acting as Node (BoringSSL, Electron's native-module ABI); on Windows it is the stock `node.exe` of the same Node version, which the app ships (OpenSSL, Node's own ABI). A native addon must use N-API to load on both, and TLS or crypto edge cases may differ between them. No system Node, Python or shell is guaranteed.
- **UI Kind `web`.** The window opens at once on a Starting state and shows `http://127.0.0.1:$HARNESS_PORT/` (plus `ui.path`) as soon as the port accepts a connection; listen within `ui.readyTimeoutSeconds` or the launch fails. Listen on `127.0.0.1`, not `localhost`, which may resolve to `::1`. The page runs in a sandboxed view locked to that origin; links to other sites open in the User's browser.
- **UI Kind `terminal`.** The process runs in a pty the size of the embedded terminal.
- **Stopping.** Closing the window (or quitting the app) sends SIGTERM to the Harness's process group (on Windows `taskkill /T`), then SIGKILL after 5 seconds. When the process exits by itself, the window stays open with its exit code and offers Relaunch. Either way the Gateway Token is revoked.
- **Logs.** stdout and stderr (or the pty output) go to a log file per launch, which the User opens with "Show logs". The environment and the Gateway Token are never logged.

## 5. Using the SDK

`@harness-store/sdk` turns the launch contract into a few typed helpers and gives you the official [`openai`](https://www.npmjs.com/package/openai) client, pointed at the Model Gateway. It has no other dependency. Install it in your source folder (section 2 already did):

```sh
npm install ../harness-store-packages/harness-store-sdk-0.1.0.tgz
```

The full API is in the [SDK README](../../packages/sdk/README.md). Every snippet below is a complete ES module you can paste into a `.ts` file and bundle as in section 2.

### Read the launch environment: `getContext()`

`getContext()` returns the launch environment as typed values: `harnessId`, `harnessVersion`, `dataDir`, `workspace`, `locale` (`en` or `zh-CN`), `platform` and `port`. Outside Harness Store (for example `node out/dist/index.mjs` from a shell) it throws `NotInHarnessStoreError`, whose message names the missing variables and tells the reader to install the folder with "Install this folder locally". Catch it and exit with that message instead of failing later with a connection error:

```ts
import { getContext, NotInHarnessStoreError } from '@harness-store/sdk';

try {
  const context = getContext();
  console.log(`${context.harnessId} ${context.harnessVersion} on ${context.platform}`);
  console.log(`Language: ${context.locale}`);
  console.log(`Data Directory: ${context.dataDir}`);
  console.log(`Workspace: ${context.workspace ?? 'none'}`);
} catch (error) {
  // Started from a shell rather than by Harness Store: the message says what to do instead.
  if (!(error instanceof NotInHarnessStoreError)) throw error;
  console.error(error.message);
  process.exit(1);
}
```

Use `locale` to pick your UI strings. The reference Harnesses ship `en` and `zh-CN` strings and fall back to English.

### Call a model: `createOpenAIClient()`

`createOpenAIClient()` returns the official `openai` client with the Gateway's URL and your Gateway Token. Send a Model Slot name as `model`: the Gateway resolves it to the model the User bound, and reports that model, as `provider/model`, in the response's `model` field so you can show what answered. Catch `slot_unbound` and tell the User where to fix it:

```ts
import { createOpenAIClient, Slots, SlotUnboundError } from '@harness-store/sdk';

const openai = createOpenAIClient();

try {
  const completion = await openai.chat.completions.create({
    model: Slots.default,
    messages: [{ role: 'user', content: 'Say hello in five words' }],
  });
  console.log(completion.choices[0]?.message.content);
  // The provider/model the User bound to the Slot, e.g. ollama/qwen3:8b.
  console.log(`Answered by ${completion.model}`);
} catch (error) {
  const unbound = SlotUnboundError.from(error);
  if (unbound === undefined) throw error;
  console.log(
    `No model is bound to the "${unbound.slot}" Model Slot. Bind one on the Models page of Harness Store.`,
  );
}
```

The client has retries off (`maxRetries: 0`): the Gateway never needs them, and retrying a `409` or a `502` only repeats the failure and the User's cost. Pass `createOpenAIClient({ maxRetries: 2 })` if you want them anyway. Everything else is the `openai` client as documented: tools, `response_format`, images, `AbortSignal`. The fields the Gateway passes on are listed in [gateway-protocol.md §3](../tech/gateway-protocol.md#3-post-v1chatcompletions).

### Stream an answer: First Harness's Entry

With `stream: true` the Gateway streams the Provider's answer chunk by chunk, and every chunk carries the resolved model. This is the whole of First Harness: a terminal loop that streams each answer as it arrives. Save it as `src/index.ts`:

```ts
import { createInterface } from 'node:readline';
import { createOpenAIClient, getContext, Slots, SlotUnboundError } from '@harness-store/sdk';

const { harnessVersion, workspace } = getContext();
const openai = createOpenAIClient();

console.log(`First Harness ${harnessVersion}. Ask a question; Ctrl-D quits.`);
if (workspace !== undefined) console.log(`Workspace: ${workspace}`);

for await (const question of createInterface({ input: process.stdin, output: process.stdout })) {
  if (question.trim() === '') continue;
  try {
    const stream = await openai.chat.completions.create({
      model: Slots.default,
      messages: [{ role: 'user', content: question }],
      stream: true,
    });
    let model = '';
    for await (const chunk of stream) {
      model = chunk.model;
      process.stdout.write(chunk.choices[0]?.delta.content ?? '');
    }
    process.stdout.write(`\n(${model})\n`);
  } catch (error) {
    const unbound = SlotUnboundError.from(error);
    console.log(
      unbound === undefined
        ? `The model call failed: ${error instanceof Error ? error.message : String(error)}`
        : `No model is bound to the "${unbound.slot}" Model Slot. Bind one on the Models page of Harness Store.`,
    );
  }
}
```

On Ctrl-D (end of input) the loop ends and the process exits with code 0; the Harness window stays open on "First Harness has exited" until the User closes or relaunches it. The process is running in a real terminal, so ANSI colours and cursor movement work. For a fuller terminal Harness with conversation history, `/model` and `/quit`, Ctrl-C and localized strings, read [`hello-term`](../../examples/hello-term/src/index.ts).

### Serve a page: `createServer()`

A Harness with UI Kind `web` serves its UI over HTTP. `createServer(handler)` creates an `http.Server` and starts it listening on `127.0.0.1:$HARNESS_PORT`, the address the Runtime waits for and then shows in the window. It returns at once; a listen failure arrives as the server's `'error'` event.

The page itself must never call the Model Gateway: the Gateway sends no CORS headers, so a browser page cannot reach it, and the Gateway Token must not leave your process. The page calls your own server, and your server calls the Gateway and relays the answer:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createOpenAIClient,
  createServer,
  getContext,
  Slots,
  SlotUnboundError,
} from '@harness-store/sdk';

const { locale, port } = getContext();
const openai = createOpenAIClient();

// The whole page as one string: no file to find at runtime (the working directory is the
// Workspace or the Data Directory, not the Harness folder).
const page = `<!doctype html>
<html lang="${locale}">
<meta charset="utf-8">
<title>Ask</title>
<input id="question" size="60"> <button id="ask">Ask</button>
<p id="answer"></p>
<script>
  const ask = document.getElementById('ask');
  const answer = document.getElementById('answer');
  ask.onclick = async () => {
    ask.disabled = true; // one question at a time, or two answers would mix in #answer
    answer.textContent = '';
    try {
      const response = await fetch('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: document.getElementById('question').value }),
      });
      if (!response.ok) throw new Error('the server answered ' + response.status);
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      for (let part = await reader.read(); !part.done; part = await reader.read()) {
        answer.textContent += part.value;
      }
    } catch (error) {
      answer.textContent = 'No answer: ' + error.message;
    } finally {
      ask.disabled = false;
    }
  };
</script>
</html>`;

// Every request must name this server as 127.0.0.1 or localhost on its port. A page on a rebound
// DNS name (another site's name pointed at 127.0.0.1) arrives with another Host; without this
// check it could read every route here as its own origin. This is not authentication: a local
// program can still send any Host.
function toOwnHost(request: IncomingMessage): boolean {
  const host = request.headers.host;
  return host === `127.0.0.1:${String(port)}` || host === `localhost:${String(port)}`;
}

// The page's backend: asks the default Model Slot and streams the answer back as plain text.
async function ask(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const controller = new AbortController();
  response.on('close', () => {
    controller.abort(); // the page went away: stop the model call too
  });
  response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  try {
    // Read the body inside the try: a page that goes away mid-upload makes this throw.
    let body = '';
    request.setEncoding('utf8'); // decodes a character split across two chunks correctly
    for await (const chunk of request) body += chunk as string;
    const { question } = JSON.parse(body) as { question: string };
    const stream = await openai.chat.completions.create(
      { model: Slots.default, messages: [{ role: 'user', content: question }], stream: true },
      { signal: controller.signal },
    );
    for await (const chunk of stream) response.write(chunk.choices[0]?.delta.content ?? '');
  } catch (error) {
    if (!controller.signal.aborted) {
      response.write(
        SlotUnboundError.from(error) === undefined
          ? `The model call failed: ${error instanceof Error ? error.message : String(error)}`
          : 'No model is bound to this Harness. Bind one on the Models page of Harness Store.',
      );
    }
  } finally {
    response.end();
  }
}

const server = createServer((request, response) => {
  if (!toOwnHost(request)) {
    response.writeHead(403).end();
  } else if (request.method === 'GET' && request.url === '/') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "connect-src 'self'",
    });
    response.end(page);
  } else if (
    request.method === 'POST' &&
    request.url === '/ask' &&
    // Pages on other sites cannot send JSON here: it needs a CORS preflight, never answered.
    request.headers['content-type'] === 'application/json'
  ) {
    void ask(request, response);
  } else {
    response.writeHead(404).end();
  }
});
server.on('error', (error) => {
  console.error(`Cannot listen on 127.0.0.1:${String(port)}: ${error.message}`);
  process.exit(1);
});
```

Guard your server. Any web page the User opens in a browser can send requests to `127.0.0.1:<port>`, and each answered model request spends the User's tokens. Two checks keep other web pages out, so that in the browser your own page is the only caller:

- **Require `Host` to be `127.0.0.1:<port>` or `localhost:<port>`, on every route.** This stops DNS rebinding, where another site's name is pointed at `127.0.0.1` and its pages talk to your server as their own origin. Such a page can read the response of any route that skips this check, so check it first, for every request, as the snippet does. Only a route that returns nothing private and changes nothing, like a static page, can do without it.
- **Require `Content-Type: application/json` on every route that does something** (a model call, a write to the Data Directory). A page on another site can send such a request only after a CORS preflight, which your server never answers, so the browser never sends it.

These checks are not authentication. A program running on the User's machine sets any `Host` and `Content-Type` it likes and passes both; such a program already runs with the User's permissions (section 7), so do not put anything behind your server that you would not let it reach.

On the page, let one request run at a time (the snippet disables the button until the answer ends), or two answers stream into the same place and both spend tokens, and show a failed request to the User instead of dropping it.

Also send a `Content-Security-Policy` with `connect-src 'self'` and load nothing from other origins (no CDN, no web fonts), so the page works offline and talks to no one but your server. [`hello-web`](../../examples/hello-web/src) does all of this with a full chat UI: Server-Sent Events, history kept in the page, a size limit on request bodies, en/zh-CN strings and the model that answered.

### List the Slots and their models: `listSlots()`

`listSlots()` returns every Model Slot your Manifest declares, in Manifest order, with the `provider/model` it is bound to right now, or `null` when it is unbound (`GET /v1/models`). Bindings can change while your Harness runs, so ask again rather than caching the answer:

```ts
import { listSlots } from '@harness-store/sdk';

for (const slot of await listSlots()) {
  console.log(`${slot.name} → ${slot.resolvedModel ?? 'no model bound'}`);
}
```

Two more helpers: `getGatewayContext()` returns the Gateway's own view of the launch (`GET /v1/harness/context`: Harness ID, version, locale, Workspace, and each Slot's description and Model Requirements), and like `listSlots()` throws a `GatewayError` (with `status` and `code`) on an error answer. `gatewayFetch(path, init?)` is `fetch` against the Gateway with the Gateway Token added, for anything the other helpers do not cover: `gatewayFetch('/models')` calls `$HARNESS_GATEWAY_URL/models`, and the `Response` comes back as it is, whatever its status.

### Errors to handle

Every Gateway error has the body `{ "error": { "code", "message", "type" } }` ([gateway-protocol.md §5](../tech/gateway-protocol.md#5-errors)). The `openai` client throws them as errors that carry the HTTP `status` and the Gateway's `error` body. The ones a Harness should expect:

| Status | `code` | What to do |
|---|---|---|
| 409 | `slot_unbound` | No model can fill the Slot. Tell the User to bind one on the Models page of Harness Store, then let them try again: the next call resolves afresh. `isSlotUnbound(error)` recognises it, `SlotUnboundError.from(error)` gives you the typed error with `slot`. |
| 502 | `provider_error` | The Provider failed; `provider_status` and `provider_message` say how. Show the message. |
| 504 | `provider_timeout` | The Provider sent nothing for 120 s. Show it; the User decides whether to retry. |
| 403 | `provider_not_connected` | The bound model's Provider has no Connection any more. Same advice as `slot_unbound`. |
| 404 | `unknown_slot` | `model` names a Slot your Manifest does not declare: a bug in your Harness. |
| 400 | `invalid_request` | The request is malformed, or the Provider cannot express it; `message` says why. |

### Without the SDK

The SDK is a convenience, not a requirement. `OPENAI_BASE_URL` and `OPENAI_API_KEY` are set to the Gateway's URL and your Gateway Token, so an unmodified OpenAI client in any language talks to the Gateway: send a Slot name as `model`. With runtime kind `binary` you can ship a Harness written in any language, as long as every model call goes through the Gateway.

## 6. Model Slots and Recommended Models

A **Model Slot** is a named role for a model inside your Harness. You choose the names (`default` is mandatory, up to 8 Slots, `^[a-z][a-z0-9-]{0,31}$`), send a name as `model`, and the User decides which real model fills each one. For each Slot you declare:

- **Model Requirements**, what the Slot needs: `tools` (tool calling), `vision`, `json` (structured output) and `minContext` (context window in tokens). Leave out what you do not need.
- **Recommended Models**, up to 5 `provider/model` ids in order of preference, using the Provider ids of [gateway-protocol.md §6](../tech/gateway-protocol.md#6-provider-ids-and-connections) (`anthropic`, `openai`, `ollama`, `deepseek`, ...).

### How a Slot is resolved

On every request the Gateway resolves the Slot afresh, in this order ([gateway-protocol.md §4](../tech/gateway-protocol.md#4-slot-resolution-normative)):

1. A **Model Override** the User set for this Harness and Slot.
2. The first of your **Recommended Models** whose Provider has an enabled Connection. The model's existence is not checked: if the User's Ollama does not have it, the call fails with `provider_error`.
3. The User's **Default Model** for a Slot with the same name.
4. The User's Default Model for `default`.
5. Nothing: `409 slot_unbound`.

Model Requirements never block anything. The Models page warns the User when the model they pick for a Slot is known not to meet its requirements ("This model may not meet the requirements of Code Reviewer's `default` Slot (tool calling)."), and shows "Capabilities unknown" when it cannot tell. The Gateway sends the request either way. Requirements steer the User's choice; Recommended Models make the first choice for them.

### A worked example

A code reviewer needs a strong model with tool calling for the review itself, and a cheap one to summarise each file first. Its `models`:

```json
{
  "models": {
    "slots": {
      "default": {
        "description": "Reviews the change, reading files with tools",
        "requirements": { "tools": true, "minContext": 64000 },
        "recommended": ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "ollama/qwen3-coder:30b"]
      },
      "fast": {
        "description": "Summarises each changed file before the review",
        "requirements": { "minContext": 16000 },
        "recommended": ["ollama/qwen3:8b", "openai/gpt-5-mini"]
      }
    }
  }
}
```

What each Slot resolves to, for three Users who have set no Model Override:

| The User has | `default` resolves to | `fast` resolves to |
|---|---|---|
| An Anthropic Connection and Ollama; Default Model `ollama/llama3.2` | `anthropic/claude-sonnet-4-5` (first Recommended Model with a Connection) | `ollama/qwen3:8b` (first Recommended Model with a Connection) |
| Only Ollama; Default Model `ollama/llama3.2` | `ollama/qwen3-coder:30b` (third Recommended Model); fails with `provider_error` until the User pulls it | `ollama/qwen3:8b` |
| Only DeepSeek; Default Model `deepseek/deepseek-chat` | `deepseek/deepseek-chat` (no Recommended Model has a Connection, so the Default Model) | `deepseek/deepseek-chat` (no Default Model for `fast`, so the one for `default`) |

In every row the User can set a Model Override on the Models page, and it wins. If a User binds a model the app knows has no tool calling, the Models page warns that it may not meet the `default` Slot's requirements, and the reviewer still gets that model. So check what comes back (a reply without the tool calls the review needs) and tell the User which Slot needs a better model.

Guidelines:

- Start with one Slot, `default`. Add another only when the Harness really has two jobs of different cost or capability.
- Declare only the requirements you depend on. Every one you add can raise a warning for a model that would have worked.
- Recommend models you have tested, best first, and include a local one if your Harness works with it.
- `Slots.default`, `Slots.fast` and `Slots.smart` in the SDK are only common names. Any Slot your Manifest declares is valid; one it does not declare gets `404 unknown_slot`.
- `model` can also be an explicit `provider/model` id, which bypasses the User's choice and needs a Connection for that Provider. Use Slots.

## 7. What the platform does not do

Design your Harness around these facts. They are the trust model of [ADR-0004](../adr/0004-harness-is-a-standalone-process-behind-a-model-gateway.md) and [security.md](../tech/security.md), and the app tells Users at install that Harnesses are not sandboxed and that Declared Permissions are not enforced.

- **No sandboxing.** Harness Store does not sandbox your Harness: it runs as an ordinary process with all of the User's operating-system permissions, and its Declared Permissions are shown to the User but not enforced.
- **No access to real credentials.** Your Harness never receives the User's Provider credentials: it gets only a Gateway Token, which works on nothing but the local Model Gateway and is revoked when your process exits.
- **No automatic Provider fallback.** When the Provider or model bound to a Slot fails, the Model Gateway returns the error to your Harness and never retries the call or switches to another Provider or model.

And, following from those:

- **Gateway-only model access is a rule, not a wall.** Nothing technically stops a Harness from calling a Provider directly with keys of its own; the Store's listing terms forbid it, and Users can Report a Harness that does it.
- **Model Requirements are advisory.** The Gateway sends a request to the bound model even when that model lacks a capability the Slot declared (section 6).
- **No install step.** The Runtime copies the Harness Package and runs it: it runs no `npm install`, no build and no post-install script, and provides no system Node, Python or shell. Ship everything the Entry needs.
- **No restart.** If your process crashes or exits, it stays exited until the User relaunches it. Its window shows the exit code.
- **No CORS on the Gateway.** A web page cannot call the Gateway; your server must (section 5).
- **No secret storage.** The Data Directory is an ordinary folder that the User and every other program running as the User can read; it is deleted on uninstall.

## 8. Testing locally

Test the Harness exactly as Users will run it: installed by the Runtime, launched from the Library, with the launch contract set. Nothing in this section needs an account or a network connection.

1. **Build** the Harness folder:

   ```sh
   npm run build
   ```

2. **Validate** it with the same checks the Store and the Runtime run (the Manifest schema, the files it refers to, the icon's size, the screenshots, the package limits):

   ```sh
   npx harness-manifest validate out
   ```

   It prints every problem at once and exits 0 when the folder is valid, for example `The Harness Package alice/first-harness 0.1.0 is valid: no problems, no warnings.` Add `--publisher <your GitHub login>` to check the Harness ID's publisher segment too.

3. **Check the message outside Harness Store.** `node out/dist/index.mjs` from a shell must fail clearly, not with a connection error:

   ```sh
   node out/dist/index.mjs
   ```

   ```
   Not running inside Harness Store: HARNESS_GATEWAY_URL, HARNESS_GATEWAY_TOKEN, HARNESS_ID, HARNESS_VERSION, HARNESS_DATA_DIR, HARNESS_LOCALE, HARNESS_PLATFORM are not set. Install this folder with "Install this folder locally" on the Publish screen of Harness Store, then launch it from the Library.
   ```

   (First Harness calls `getContext()` without a `try`, so Node prints this message with a stack trace; the `getContext()` snippet in section 5 shows how to print only the message.)

4. **Install the folder.** In Harness Store, open **Publish** and choose **Install this folder locally** (no sign-in needed). Pick the `out` folder. The app validates it and lists any problems and warnings; fix them, rebuild and press **Re-check**. Then the install dialog shows your Declared Permissions, UI Kind and Workspace setting, as Users will see them; choose **Install**. The app confirms "Installed First Harness 0.1.0 from the folder. It is marked Local in the Library."

5. **Launch** it from the **Library**. If the card says "Set up a model first", bind a model to the `default` Slot on the Models page. First Harness has `workspace: optional`, so the app asks for a folder and offers "Continue without a folder". Ask a question: the answer streams in, followed by the model that wrote it.

6. **Iterate.** Close the Harness window, change the code, run `npm run build` and install the folder again: the new install replaces the old one, whatever its version, and keeps the Data Directory. When something goes wrong, **Show logs** opens the launch's output.

Also try what Users will try: launch with no model bound to a Slot your Harness uses, set a Model Override to another Provider while the Harness runs, switch the app's language, and, for `workspace: optional`, launch with and without a folder.

To check an archive too, zip the contents of `out` (the files at the archive root, not the folder itself) and validate the zip, for example on macOS or Linux `cd out`, `zip -r ../first-harness-0.1.0.zip .`, `cd ..`, then `npx harness-manifest validate first-harness-0.1.0.zip`. The reference Harnesses have a script for it: `pnpm --filter hello-web run pack` writes a deterministic `dist/hello-web-0.1.0.zip` from `out/`, leaving out what the Publish flow leaves out (`.git/`, `node_modules/.cache/`, `.DS_Store`, `Thumbs.db`, `*.swp`).

## 9. Publishing

Publishing happens on the same **Publish** screen, from the same `out` folder: sign in with GitHub (only Publishers need an account), choose the folder, fix any problems the validation lists, review how the listing will look, and upload. The app builds the zip for you. The flow is described in [flows.md F5](../ux/flows.md#f5-publish) and specified in [P0-08](../delivery/specs/P0-08-publish-flow.md); this guide does not repeat it.

Before you publish, remember that:

- the publisher segment of the Harness ID must be the GitHub login you sign in with;
- a published Harness Version is immutable: every change, even a typo in the README, is a new version with a greater `version`;
- an update that widens Declared Permissions, or changes the Entry or the runtime kind, asks every User to consent again.
