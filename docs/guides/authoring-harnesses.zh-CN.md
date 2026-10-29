[English](authoring-harnesses.md) | 简体中文

# 编写 Harness

本指南带领发布者从一个空文件夹开始，做出一个可以上架商店的 **Harness**。过程中会构建一个小 Harness——**First Harness**，并结合本仓库自带的两个参考 Harness 讲解每一步：[`hello-web`](../../examples/hello-web)（UI 类型 `web`）和 [`hello-term`](../../examples/hello-term)（UI 类型 `terminal`）。按章节逐步操作，最后你会得到一个已经安装、启动，并且完全按商店的方式检查过的 Harness。

术语以 [`CONTEXT.md`](../../CONTEXT.md) 为准。规范性文档是 [Manifest 规范](../tech/manifest-spec.md)、[启动契约](../tech/architecture.md#4-harness-launch-contract)和 [Model Gateway 协议](../tech/gateway-protocol.md)；本指南与它们不一致时，以它们为准。

**目录**

1. [什么是 Harness](#1-什么是-harness)
2. [文件夹结构](#2-文件夹结构)
3. [逐字段讲解 Manifest](#3-逐字段讲解-manifest)
4. [启动契约](#4-启动契约)
5. [使用 SDK](#5-使用-sdk)
6. [模型槽位与推荐模型](#6-模型槽位与推荐模型)
7. [平台不做的事](#7-平台不做的事)
8. [本地测试](#8-本地测试)
9. [发布](#9-发布)

**开始之前**，你需要：

- Harness Store，并且至少有一个模型连接，以及 `default` 槽位的默认模型（在首次运行设置或模型页中配置）。任何 Provider 都可以，包括本地的 Ollama 或 LM Studio。
- Node.js 22.13 或更高版本（22 或 24 LTS）以及 npm，用来构建你的 Harness。用户两者都不需要：Runtime 用它自带的 Node 运行你的入口。
- 在 `@harness-store/sdk` 和 `@harness-store/manifest` 发布到 npm 之前，需要本仓库的一份检出用来构建它们，为此还需要 git 和 pnpm 10。

## 1. 什么是 Harness

**Harness** 是一个自包含的程序，与一份 **Manifest** 一起打包，完成一项具体的、由 Agent 驱动的工作（代码审查、写作助手、聊天页面），并自带 Agent 循环和 UI。Harness Store 桌面应用中的 **Runtime** 负责安装它，把它作为独立应用在单独的窗口中启动，并监管它的进程；Harness 只能通过 **Model Gateway** 访问语言模型。Model Gateway 是一个本地服务，使用 OpenAI Chat Completions 协议，把每个请求转发给 **用户** 为该 Harness 的 **模型槽位** 绑定的 Provider 和模型。发布者上传的是 **Harness 包**：Manifest，加上在其声明的平台上运行该 Harness 所需的全部文件。每次上传就是一个 **Harness 版本**，发布后不可更改。

## 2. 文件夹结构

Harness 包的结构如下（[manifest-spec.md §1](../tech/manifest-spec.md#1-package-layout)）：

```
<archive root>/
  manifest.json          required (≤ 1 MB)
  README.md              required (Store description, Markdown, ≤ 50 KB)
  assets/icon.png        required, 512×512 PNG
  assets/<screenshots>   optional, PNG/JPEG, ≤ 5 files, ≤ 2 MB each
  <anything else>        the Harness itself
```

- `manifest.json` 就是 Manifest（第 3 节）。它是商店和 Runtime 唯一会解析的文件。
- `README.md` 是商店详情页上的介绍。为用户而写：这个 Harness 做什么、怎么用、会接触哪些东西。
- `assets/icon.png` 必须正好是 512×512 像素。直接放在 `assets/` 下的其他文件都会被当作截图，所以源文件（`.svg`、`.psd`）请放在别处。
- 其余内容由你决定：对于 runtime kind `node`，就是入口及其导入的一切。没有安装步骤，所以安装时不会下载任何东西：要么把 `node_modules` 放进包里，要么（更简单，也小得多）把入口和它的依赖打包成一个文件。

各项限制（500 MB、20 000 个文件、不允许符号链接、不允许绝对路径或 `..` 路径等）见 [manifest-spec.md §1](../tech/manifest-spec.md#1-package-layout)；第 8 节中的校验器会逐一检查。

### 源文件夹与 Harness 文件夹

把你日常工作的文件夹和要安装、发布的文件夹分开。参考 Harness 就是这样做的：`examples/hello-web` 中有 `src/`、`package.json` 和 `node_modules`，`pnpm build` 生成 Harness 文件夹 `examples/hello-web/out/`，其中只有 `manifest.json`、`README.md`、`assets/` 和打包后的入口 `dist/index.mjs`。只有 `out/` 会被校验、安装和发布。如果安装或发布源文件夹，`src/` 和 `node_modules` 会被一并带上，而 pnpm 的 `node_modules` 由符号链接组成，Harness 包中不允许出现符号链接。

### 开始编写 First Harness

新建一个工作文件夹，并排放三样东西：仓库检出、由它构建出的 SDK 和 Manifest 包，以及你的 Harness。

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

这里的 `pnpm pack` 是 pnpm 自带的命令：它把 `harness-store-sdk-0.1.0.tgz` 和 `harness-store-manifest-0.0.0.tgz` 写到 `work/harness-store-packages/`。接着创建 First Harness 的源文件夹，安装 SDK、Manifest 校验器和一个打包工具（[rolldown](https://rolldown.rs)；esbuild 或其他任何单文件打包工具用法相同）：

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

把下面的构建脚本保存为 `scripts/build.mjs`。它把 `src/index.ts` 及其导入的一切（SDK 和 `openai` 客户端）打包成一个 ES 模块，再把包结构中的文件复制到它旁边，这样 `out/` 就是一个完整的、不需要 `node_modules` 的 Harness 文件夹：

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

然后添加包文件：

- `assets/icon.png`：你的图标，一张 512×512 的 PNG。参考 Harness 使用带两个首字母的圆角方块。
- `README.md`：写给用户的几段话，例如：

  ```markdown
  # First Harness

  Ask a question in the terminal window and the answer streams in from the model you bound to this Harness in Harness Store. Press Ctrl-D to quit.

  First Harness reads no files, runs no commands and reaches no network service: every model call goes through the Model Gateway of Harness Store.
  ```

- `manifest.json`：在第 3 节编写。
- `src/index.ts`：在第 5 节编写。

之后 `npm run build` 会生成：

```
first-harness/out/
  manifest.json
  README.md
  assets/icon.png
  dist/index.mjs        the Entry
```

## 3. 逐字段讲解 Manifest

Manifest 是 Harness 包根目录下的 `manifest.json`。下面是 [`hello-web`](../../examples/hello-web/manifest.json) 的完整 Manifest：

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

| 字段 | 在 `hello-web` 中 | 含义 |
|---|---|---|
| `manifestVersion` | `1` | 格式版本。目前始终为 `1`。 |
| `id` | `harness-store/hello-web` | **Harness ID**，形如 `publisher/slug`。publisher 部分必须是你发布时使用的 GitHub 登录名，小写（1–39 个小写字母、数字和连字符，以字母或数字开头）；slug 为 3–40 个小写字母、数字和连字符，以字母或数字开头和结尾。它在 Harness 的整个生命周期内都不会改变。 |
| `version` | `0.1.0` | **Harness 版本**，严格的 semver，不带 `v`。每个发布的版本都必须大于上一个。 |
| `name` | `Hello Web` | 显示名称，2–40 个字符。 |
| `summary` | 一句话 | 显示在列表中，最多 120 个字符。 |
| `tags` | `["education"]` | 可选，最多 5 个，取自 `coding`、`writing`、`research`、`data`、`productivity`、`devops`、`design`、`education`、`fun`、`other`。 |
| `license` | `MIT` | 一个 SPDX 标识符，或 `proprietary`。 |
| `sourceRepo` | 一个 GitHub URL | 可选，在详情页显示为“Source”。`homepage` 用法相同。 |
| `platforms` | 全部六个 | Harness 能运行的平台：`darwin-arm64`、`darwin-x64`、`win32-x64`、`win32-arm64`、`linux-x64`、`linux-arm64` 中的任意几个。Runtime 只在列出的平台上启动它。打包好的 Node Harness 在所有平台上都能运行，所以除非确有原因，请列出全部六个。 |
| `runtime` | `{ "kind": "node", "node": "22" }` | 用 Runtime 的 Node 运行入口。`node` 必须为 `"22"`。另一种 kind 是 `binary`：你为每个平台提供一个可执行文件。 |
| `entry` | `dist/index.mjs` | **入口**（Entry）：相对于包根目录的路径，使用 `/` 分隔，不带 `./`。对于 `binary`，是一个从平台到可执行文件路径的对象。 |
| `ui` | `{ "kind": "web" }` | **UI 类型**（UI Kind）。`web`：在 `127.0.0.1:$HARNESS_PORT` 上提供页面，Runtime 在 Harness 窗口中打开它。可选 `path`（默认 `/`）、`readyTimeoutSeconds`（5–120，默认 30）和 `window`（`width`、`height`）。 |
| `workspace` | `none` | 用户在启动时是否选择一个 **工作目录**（Workspace）文件夹：`required`、`optional` 或 `none`（默认）。 |
| `models` | 一个 `default` 槽位 | Harness 向 Gateway 请求的 **模型槽位**，每个都有 `description`、**模型要求**（Model Requirements）和可选的 **推荐模型**（Recommended Models）（第 6 节）。必须有 `default` 槽位。 |
| `permissions` | 全部为最小值 | **声明权限**：`filesystem.scope`（`none`、`workspace`、`home`，或带列表的 `paths`）、`shell`（是否运行命令）和 `network`（`domains`，或 `any: true`）。三个键都必须有。经由 Gateway 的模型调用无需声明。 |

除身份字段（`id`、`name`、`summary` 和 `sourceRepo`）外，[`hello-term`](../../examples/hello-term/manifest.json) 有三个字段不同：UI 类型为 `terminal`（Runtime 在内嵌终端的 pty 中运行它，stdin 和 stdout 就是它的全部 UI，没有端口）；工作目录为 `optional`（用户可以选择一个文件夹，也可以不选直接继续）；槽位描述说明了模型在这里做什么：

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

其他可用的键：`changelog`（本版本的 Markdown 说明，最多 5 KB）、`channel`（P0 中只能是 `"stable"`）、`$schema`（让编辑器根据 [Manifest JSON Schema](../../packages/manifest/src/manifest-v1.schema.json) 检查文件），以及存放你自有数据的顶层 `x-` 键，商店和 Runtime 会忽略它们。其他任何未知键，无论在哪一层，都算作问题。不起作用的键（例如 `terminal` Harness 上的 `ui.path`）会产生警告。

如实声明权限，写明你的 Harness 实际会做什么：用户会在安装对话框中看到它们，而扩大权限的更新会要求用户重新同意。

### First Harness 的 Manifest

First Harness 是一个终端 Harness，可以获得工作目录，并向一个槽位请求回答。把 `alice` 换成你自己的 GitHub 登录名，然后保存为 `manifest.json`：

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

## 4. 启动契约

Runtime 启动 Harness 时会设置以下环境变量。它们摘自规范性来源 [architecture.md §4](../tech/architecture.md#4-harness-launch-contract)：

| 变量 | 值 |
|---|---|
| `HARNESS_GATEWAY_URL` | `http://127.0.0.1:<gateway-port>/v1` |
| `HARNESS_GATEWAY_TOKEN` | 每次启动单独生成的 token |
| `OPENAI_BASE_URL` | 与 `HARNESS_GATEWAY_URL` 相同（这样未经修改的 OpenAI SDK 也能直接使用） |
| `OPENAI_API_KEY` | 与 `HARNESS_GATEWAY_TOKEN` 相同 |
| `HARNESS_ID` | `publisher/slug` |
| `HARNESS_VERSION` | 已安装版本的 semver |
| `HARNESS_DATA_DIR` | 绝对路径，此 Harness 私有 |
| `HARNESS_WORKSPACE` | 绝对路径，仅在选择了工作目录时设置 |
| `HARNESS_PORT` | 要监听的端口，仅用于 `ui.kind = web` |
| `HARNESS_LOCALE` | `en` 或 `zh-CN` |
| `HARNESS_PLATFORM` | 例如 `darwin-arm64` |
| `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` | 在 P1-03 中加入，届时 Gateway 将接受 Anthropic Messages 入站请求；P0 中不设置 |

启动时 Harness 还可以依赖以下几点：

- **启动之前。** 如果没有任何模型能填充 `default` 槽位，启动会被拒绝，用户会被引导到模型页。其他槽位不做检查，因此对其他槽位的调用仍可能以 `slot_unbound` 失败（第 5 节）。
- **当前目录。** 进程启动时，当前目录在有工作目录时就是工作目录，否则是 **数据目录**，绝不会是已安装的 Harness 文件夹。请相对于入口（`import.meta.dirname`）查找你自己的文件，或者像参考 Harness 那样，把所有内容打包进入口。
- **数据目录。** `HARNESS_DATA_DIR` 归你存放状态，启动前创建，用户卸载该 Harness 时删除。把设置、缓存和历史记录放在这里，不要放在工作目录中。
- **环境变量。** 名称以 `OPENAI_`、`ANTHROPIC_`、`GOOGLE_API_`、`GEMINI_`、`OPENROUTER_` 或 `HARNESS_` 开头的继承变量，会在设置上表中的变量之前被移除，因此 Harness 绝不会意外拿到用户自己的 key。
- **Node。** `node` Harness 以 `<node> <entry>` 的方式、用 Runtime 的 Node 运行：在 P0 中是 Electron 的 Node 24，尽管 Manifest 声明的是 `"22"`。请编写在两者上都能运行的代码。不保证有系统 Node、Python 或 shell。
- **UI 类型 `web`。** 窗口会立即以“正在启动”状态打开，一旦端口接受连接，就显示 `http://127.0.0.1:$HARNESS_PORT/`（加上 `ui.path`）；必须在 `ui.readyTimeoutSeconds` 内开始监听，否则启动失败。请监听 `127.0.0.1`，不要用 `localhost`，后者可能解析为 `::1`。页面运行在锁定到该源（origin）的沙盒视图中；指向其他网站的链接会在用户的浏览器中打开。
- **UI 类型 `terminal`。** 进程运行在一个与内嵌终端大小相同的 pty 中。
- **停止。** 关闭窗口（或退出应用）会向 Harness 的进程组发送 SIGTERM（Windows 上为 `taskkill /T`），5 秒后再发送 SIGKILL。如果进程自行退出，窗口会保持打开，显示退出码并提供“重新启动”。无论哪种情况，Gateway Token 都会被吊销。
- **日志。** stdout 和 stderr（或 pty 输出）会写入每次启动单独的日志文件，用户通过“查看日志”打开。环境变量和 Gateway Token 永远不会写入日志。

## 5. 使用 SDK

`@harness-store/sdk` 把启动契约封装成几个带类型的辅助函数，并提供指向 Model Gateway 的官方 [`openai`](https://www.npmjs.com/package/openai) 客户端。除此之外它没有其他依赖。在源文件夹中安装它（第 2 节已经装过）：

```sh
npm install ../harness-store-packages/harness-store-sdk-0.1.0.tgz
```

完整 API 见 [SDK README](../../packages/sdk/README.md)。下面每个代码片段都是一个完整的 ES 模块，可以粘贴到 `.ts` 文件中，并按第 2 节的方式打包。

### 读取启动环境：`getContext()`

`getContext()` 以带类型的值返回启动环境：`harnessId`、`harnessVersion`、`dataDir`、`workspace`、`locale`（`en` 或 `zh-CN`）、`platform` 和 `port`。在 Harness Store 之外（例如在 shell 中执行 `node out/dist/index.mjs`），它会抛出 `NotInHarnessStoreError`，其消息会列出缺失的变量，并告诉读者用“Install this folder locally”（中文界面为“本地安装此文件夹”）安装该文件夹。捕获它并带着这条消息退出，而不是之后因连接错误而失败：

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

用 `locale` 选择 UI 文案。参考 Harness 提供 `en` 和 `zh-CN` 两套文案，并回退到英文。

### 调用模型：`createOpenAIClient()`

`createOpenAIClient()` 返回官方 `openai` 客户端，已配置好 Gateway 的 URL 和你的 Gateway Token。把模型槽位名称作为 `model` 发送：Gateway 会把它解析为用户绑定的模型，并在响应的 `model` 字段中以 `provider/model` 的形式报告该模型，方便你显示是哪个模型回答的。捕获 `slot_unbound`，并告诉用户去哪里修复：

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

该客户端关闭了重试（`maxRetries: 0`）：Gateway 从不需要重试，而重试 `409` 或 `502` 只会重复失败，并让用户重复付费。如果你仍然需要重试，传入 `createOpenAIClient({ maxRetries: 2 })`。其余一切都与 `openai` 客户端的文档一致：tools、`response_format`、图片、`AbortSignal`。Gateway 透传的字段列在 [gateway-protocol.md §3](../tech/gateway-protocol.md#3-post-v1chatcompletions) 中。

### 流式输出回答：First Harness 的入口

设置 `stream: true` 后，Gateway 会把 Provider 的回答逐块流式转发，每个数据块都带有解析后的模型。下面就是 First Harness 的全部代码：一个终端循环，回答一到就流式输出。保存为 `src/index.ts`：

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

按下 Ctrl-D（输入结束）时循环结束，进程以退出码 0 退出；Harness 窗口会停留在“First Harness 已退出”，直到用户关闭或重新启动它。进程运行在真正的终端中，所以 ANSI 颜色和光标移动都能正常工作。如果想看一个更完整的终端 Harness（带对话历史、`/model` 和 `/quit`、Ctrl-C 以及本地化文案），请阅读 [`hello-term`](../../examples/hello-term/src/index.ts)。

### 提供页面：`createServer()`

UI 类型为 `web` 的 Harness 通过 HTTP 提供 UI。`createServer(handler)` 创建一个 `http.Server`，并开始监听 `127.0.0.1:$HARNESS_PORT`，Runtime 会等待这个地址就绪，然后在窗口中显示它。该函数立即返回；监听失败会以服务器的 `'error'` 事件出现。

页面本身绝不能调用 Model Gateway：Gateway 不发送 CORS 头，浏览器页面无法访问它，而且 Gateway Token 不能离开你的进程。页面调用你自己的服务器，由服务器调用 Gateway 并转发回答：

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

保护好你的服务器。用户在浏览器中打开的任何网页都可以向 `127.0.0.1:<port>` 发送请求，而每个得到响应的模型请求都会消耗用户的 token。下面两项检查可以把其他网页挡在外面，使浏览器中只有你自己的页面能调用它：

- **在每个路由上要求 `Host` 为 `127.0.0.1:<port>` 或 `localhost:<port>`。** 这可以阻止 DNS 重绑定：其他网站的域名被指向 `127.0.0.1` 后，它的页面就能以同源身份与你的服务器通信。这样的页面可以读取任何跳过此检查的路由的响应，所以要像代码片段那样，对每个请求首先做这项检查。只有不返回私密内容、也不改变任何东西的路由（比如静态页面）才可以不检查。
- **在每个会执行操作的路由上要求 `Content-Type: application/json`**（模型调用、写入数据目录）。其他网站的页面只有经过 CORS 预检才能发送这样的请求，而你的服务器从不响应预检，所以浏览器永远不会发出该请求。

这些检查不是身份验证。用户电脑上运行的程序可以随意设置 `Host` 和 `Content-Type`，从而通过这两项检查；这样的程序本来就以用户的权限运行（第 7 节），所以不要在服务器后面放任何你不愿让它访问的东西。

在页面上，一次只允许一个请求（代码片段在回答结束前禁用按钮），否则两个回答会流入同一个位置，而且都会消耗 token；请求失败时要显示给用户，而不是悄悄丢弃。

还要发送带 `connect-src 'self'` 的 `Content-Security-Policy`，并且不从其他源加载任何内容（不用 CDN，不用网络字体），这样页面可以离线工作，并且只与你的服务器通信。[`hello-web`](../../examples/hello-web/src) 以完整的聊天 UI 实现了以上全部内容：Server-Sent Events、保存在页面中的历史、请求体大小限制、en/zh-CN 文案，以及回答所用的模型。

### 列出槽位及其模型：`listSlots()`

`listSlots()` 按 Manifest 中的顺序返回 Manifest 声明的每个模型槽位，以及它当前绑定的 `provider/model`，未绑定时为 `null`（`GET /v1/models`）。绑定在 Harness 运行期间可能改变，所以需要时请重新查询，不要缓存结果：

```ts
import { listSlots } from '@harness-store/sdk';

for (const slot of await listSlots()) {
  console.log(`${slot.name} → ${slot.resolvedModel ?? 'no model bound'}`);
}
```

另外还有两个辅助函数：`getGatewayContext()` 返回 Gateway 自己对本次启动的视图（`GET /v1/harness/context`：Harness ID、版本、语言、工作目录，以及每个槽位的描述和模型要求），遇到错误响应时与 `listSlots()` 一样抛出 `GatewayError`（带 `status` 和 `code`）。`gatewayFetch(path, init?)` 是自动附加 Gateway Token、请求 Gateway 的 `fetch`，用于其他辅助函数没有覆盖的场景：`gatewayFetch('/models')` 调用 `$HARNESS_GATEWAY_URL/models`，返回的 `Response` 原样交给你，不论状态码是什么。

### 需要处理的错误

每个 Gateway 错误的响应体都是 `{ "error": { "code", "message", "type" } }`（[gateway-protocol.md §5](../tech/gateway-protocol.md#5-errors)）。`openai` 客户端把它们作为错误抛出，错误中带有 HTTP `status` 和 Gateway 的 `error` 响应体。Harness 应当预料到的错误有：

| 状态码 | `code` | 处理方式 |
|---|---|---|
| 409 | `slot_unbound` | 没有模型能填充该槽位。告诉用户在 Harness Store 的模型页绑定一个，然后让他们重试：下一次调用会重新解析。`isSlotUnbound(error)` 可以识别它，`SlotUnboundError.from(error)` 返回带 `slot` 的类型化错误。 |
| 502 | `provider_error` | Provider 出错；`provider_status` 和 `provider_message` 说明了原因。显示这条消息。 |
| 504 | `provider_timeout` | Provider 在 120 秒内没有发送任何内容。显示出来，由用户决定是否重试。 |
| 403 | `provider_not_connected` | 所绑定模型的 Provider 已经没有模型连接。处理方式同 `slot_unbound`。 |
| 404 | `unknown_slot` | `model` 指定了 Manifest 未声明的槽位：这是你 Harness 中的 bug。 |
| 400 | `invalid_request` | 请求格式错误，或者 Provider 无法表达该请求；`message` 会说明原因。 |

### 不使用 SDK

SDK 只是为了方便，并非必需。`OPENAI_BASE_URL` 和 `OPENAI_API_KEY` 已设置为 Gateway 的 URL 和你的 Gateway Token，所以任何语言中未经修改的 OpenAI 客户端都能与 Gateway 通信：把槽位名称作为 `model` 发送即可。使用 runtime kind `binary`，你可以发布用任何语言编写的 Harness，只要每次模型调用都经过 Gateway。

## 6. 模型槽位与推荐模型

**模型槽位** 是模型在你的 Harness 中扮演的一个具名角色。名称由你决定（`default` 必须有，最多 8 个槽位，`^[a-z][a-z0-9-]{0,31}$`），你把名称作为 `model` 发送，由用户决定每个槽位使用哪个真实模型。对每个槽位，你可以声明：

- **模型要求**（Model Requirements），即该槽位需要什么：`tools`（工具调用）、`vision`、`json`（结构化输出）和 `minContext`（以 token 计的上下文窗口）。不需要的就省略。
- **推荐模型**（Recommended Models），最多 5 个 `provider/model` ID，按优先顺序排列，使用 [gateway-protocol.md §6](../tech/gateway-protocol.md#6-provider-ids-and-connections) 中的 Provider ID（`anthropic`、`openai`、`ollama`、`deepseek` 等）。

### 槽位如何解析

每次请求时，Gateway 都会按以下顺序重新解析槽位（[gateway-protocol.md §4](../tech/gateway-protocol.md#4-slot-resolution-normative)）：

1. 用户为该 Harness 和槽位设置的 **手动覆盖**（Model Override）。
2. 你的 **推荐模型** 中，第一个其 Provider 有已启用模型连接的模型。不检查该模型是否存在：如果用户的 Ollama 中没有它，调用会以 `provider_error` 失败。
3. 用户为同名槽位设置的 **默认模型**。
4. 用户为 `default` 设置的默认模型。
5. 都没有：`409 slot_unbound`。

模型要求从不阻止任何操作。当用户为某个槽位选择的模型已知不满足其要求时，模型页会发出警告（“此模型可能不满足 Code Reviewer 的 `default` 槽位要求（工具调用）。”），无法判断时则显示“能力未知”。无论哪种情况，Gateway 都会发送请求。模型要求引导用户做选择；推荐模型替用户做出第一个选择。

### 完整示例

一个代码审查 Harness 在审查本身时需要一个支持工具调用的强模型，另外需要一个便宜的模型先总结每个文件。它的 `models`：

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

对于三位没有设置手动覆盖的用户，每个槽位的解析结果如下：

| 用户拥有 | `default` 解析为 | `fast` 解析为 |
|---|---|---|
| 一个 Anthropic 模型连接和 Ollama；默认模型为 `ollama/llama3.2` | `anthropic/claude-sonnet-4-5`（第一个有模型连接的推荐模型） | `ollama/qwen3:8b`（第一个有模型连接的推荐模型） |
| 只有 Ollama；默认模型为 `ollama/llama3.2` | `ollama/qwen3-coder:30b`（第三个推荐模型）；在用户拉取该模型之前会以 `provider_error` 失败 | `ollama/qwen3:8b` |
| 只有 DeepSeek；默认模型为 `deepseek/deepseek-chat` | `deepseek/deepseek-chat`（没有推荐模型有模型连接，因此使用默认模型） | `deepseek/deepseek-chat`（`fast` 没有默认模型，因此使用 `default` 的默认模型） |

在每种情况下，用户都可以在模型页设置手动覆盖，且手动覆盖优先。如果用户绑定了一个应用已知不支持工具调用的模型，模型页会警告它可能不满足 `default` 槽位的要求，而审查 Harness 仍会拿到这个模型。所以要检查返回的结果（一个缺少审查所需工具调用的回复），并告诉用户哪个槽位需要更好的模型。

建议：

- 从一个槽位 `default` 开始。只有当 Harness 确实有两项成本或能力不同的工作时，才添加另一个。
- 只声明你真正依赖的要求。每多加一项，都可能让一个本来能用的模型触发警告。
- 推荐你测试过的模型，最好的放在前面；如果你的 Harness 能用本地模型，也推荐一个本地模型。
- SDK 中的 `Slots.default`、`Slots.fast` 和 `Slots.smart` 只是常用名称。Manifest 声明的任何槽位都有效；未声明的槽位会得到 `404 unknown_slot`。
- `model` 也可以是显式的 `provider/model` ID，这会绕过用户的选择，并且需要该 Provider 的模型连接。请使用槽位。

## 7. 平台不做的事

请围绕以下事实设计你的 Harness。它们是 [ADR-0004](../adr/0004-harness-is-a-standalone-process-behind-a-model-gateway.md) 和 [security.md](../tech/security.md) 中的信任模型，应用也会在安装时告诉用户：Harness 不在沙盒中运行，声明权限也不会被强制执行。

- **没有沙盒。** Harness Store 不会把你的 Harness 放进沙盒：它作为普通进程运行，拥有用户在操作系统中的全部权限；它的声明权限会展示给用户，但不会被强制执行。
- **无法接触真实凭据。** 你的 Harness 永远拿不到用户的 Provider 凭据：它只拿到一个 Gateway Token，这个 token 只能用于本地 Model Gateway，并在你的进程退出时被吊销。
- **没有自动切换 Provider。** 当绑定到槽位的 Provider 或模型失败时，Model Gateway 把错误返回给你的 Harness，绝不会重试该调用，也不会切换到其他 Provider 或模型。

由此还可以推出：

- **只经由 Gateway 访问模型是规则，而不是技术屏障。** 技术上没有什么能阻止 Harness 用自己的 key 直接调用 Provider；商店的上架条款禁止这样做，用户可以举报（Report）这样做的 Harness。
- **模型要求只是建议。** 即使绑定的模型缺少槽位声明的某项能力，Gateway 也会把请求发给它（第 6 节）。
- **没有安装步骤。** Runtime 复制 Harness 包后直接运行：不执行 `npm install`、不构建、不运行安装后脚本，也不提供系统 Node、Python 或 shell。入口需要的一切都要随包提供。
- **不会自动重启。** 如果进程崩溃或退出，它会保持退出状态，直到用户重新启动。它的窗口会显示退出码。
- **Gateway 不支持 CORS。** 网页无法调用 Gateway，必须由你的服务器调用（第 5 节）。
- **没有密钥存储。** 数据目录是一个普通文件夹，用户以及以该用户身份运行的其他所有程序都能读取它；卸载时它会被删除。

## 8. 本地测试

像用户实际运行那样测试 Harness：由 Runtime 安装，从资源库启动，并设置好启动契约。本节的所有步骤都不需要账号，也不需要网络连接。

1. **构建** Harness 文件夹：

   ```sh
   npm run build
   ```

2. **校验**它，使用与商店和 Runtime 相同的检查（Manifest schema、它引用的文件、图标尺寸、截图、包的各项限制）：

   ```sh
   npx harness-manifest validate out
   ```

   它会一次列出所有问题，文件夹有效时以 0 退出，例如 `The Harness Package alice/first-harness 0.1.0 is valid: no problems, no warnings.`。加上 `--publisher <your GitHub login>` 还会检查 Harness ID 的 publisher 部分。

3. **检查在 Harness Store 之外运行时的提示。** 在 shell 中执行 `node out/dist/index.mjs` 必须清楚地报错，而不是报连接错误：

   ```sh
   node out/dist/index.mjs
   ```

   ```
   Not running inside Harness Store: HARNESS_GATEWAY_URL, HARNESS_GATEWAY_TOKEN, HARNESS_ID, HARNESS_VERSION, HARNESS_DATA_DIR, HARNESS_LOCALE, HARNESS_PLATFORM are not set. Install this folder with "Install this folder locally" on the Publish screen of Harness Store, then launch it from the Library.
   ```

   （First Harness 调用 `getContext()` 时没有使用 `try`，所以 Node 会把这条消息连同调用栈一起打印出来；第 5 节中的 `getContext()` 片段演示了如何只打印消息。）

4. **安装文件夹。** 在 Harness Store 中打开 **发布**（Publish），选择 **本地安装此文件夹**（Install this folder locally），无需登录。选择 `out` 文件夹。应用会校验它，并列出所有问题和警告；修复它们，重新构建，然后点击 **重新检查**（Re-check）。接着安装对话框会显示你的声明权限、UI 类型和工作目录设置，与用户看到的一样；选择 **安装**（Install）。应用会确认：“已从文件夹安装 First Harness 0.1.0，在资源库中标记为「本地」。”

5. **启动**：从 **资源库**（Library）启动它。如果卡片显示“先设置模型”，请在模型页为 `default` 槽位绑定一个模型。First Harness 设置了 `workspace: optional`，所以应用会让你选择一个文件夹，并提供“不选择目录继续”。提一个问题：回答会流式输出，后面跟着写出它的模型。

6. **迭代。** 关闭 Harness 窗口，修改代码，运行 `npm run build`，然后再次安装该文件夹：新安装会替换旧安装，不论版本号如何，并保留数据目录。出问题时，**查看日志**（Show logs）会打开本次启动的输出。

也试试用户会做的事：在 Harness 用到的某个槽位没有绑定模型时启动，在 Harness 运行时把手动覆盖设为另一个 Provider，切换应用语言；对于 `workspace: optional`，分别在选择和不选择文件夹的情况下启动。

如果还想检查压缩包，把 `out` 的内容（位于压缩包根目录的文件，而不是文件夹本身）打成 zip 并校验，例如在 macOS 或 Linux 上依次执行 `cd out`、`zip -r ../first-harness-0.1.0.zip .`、`cd ..`，然后执行 `npx harness-manifest validate first-harness-0.1.0.zip`。参考 Harness 为此提供了脚本：`pnpm --filter hello-web run pack` 从 `out/` 生成确定性的 `dist/hello-web-0.1.0.zip`，并排除发布流程会排除的内容（`.git/`、`node_modules/.cache/`、`.DS_Store`、`Thumbs.db`、`*.swp`）。

## 9. 发布

发布在同一个 **发布** 页面上进行，使用同一个 `out` 文件夹：用 GitHub 登录（只有发布者需要账号），选择文件夹，修复校验列出的问题，预览上架后的样子，然后上传。应用会替你生成 zip。该流程见 [flows.md F5](../ux/flows.md#f5-publish)，规格见 [P0-08](../delivery/specs/P0-08-publish-flow.md)；本指南不再重复。

发布之前请记住：

- Harness ID 的 publisher 部分必须是你登录所用的 GitHub 登录名；
- 已发布的 Harness 版本不可更改：任何改动，哪怕只是 README 中的一个错别字，都要发布一个 `version` 更大的新版本；
- 扩大声明权限、更改入口或 runtime kind 的更新，会要求每个用户重新同意。
