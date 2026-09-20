# Harness Store — Product Requirements Document

Owner: PowerUp (org). Status: P0 baseline, 2026-09-20. Vocabulary follows `CONTEXT.md`; architectural decisions live in `docs/adr`. This document says **what** and **why**; the technical docs say **how**.

## 中文摘要

Harness Store 是一个桌面应用（macOS / Windows / Linux，同一套界面，中英双语），定位是 **AI Agent 领域的 Steam / App Store**。每一个 **Harness** 是一个自带 agent 架构和界面的独立程序，用户从 Store 里安装后像独立 app 一样点开使用；开发者（**Publisher**）把自己做好的 Harness 打包上传，立刻上架。

平台的灵魂是 **Model Gateway**：所有 Harness 只能通过本地 Gateway 调用语言模型，入站协议统一为 OpenAI Chat Completions 兼容格式。Harness 请求的是一个 **Model Slot**（如 `default`、`fast`），用户决定每个 Slot 绑定到哪个真实模型：Anthropic、OpenAI、Google、OpenRouter、Ollama、LM Studio、DeepSeek、通义、Kimi、智谱、MiniMax、豆包，或任何 OpenAI 兼容端点。真实凭证永远不进入 Harness 进程；每一枚 token 都经过 Gateway，因此本地用量统计（P0）和后续付费（P1/P2）自然成立。

**P0** 交付最小闭环：安装、启动、模型绑定、发布、浏览、更新、卸载、用量页、举报。目标用户是自带模型账号的技术用户；完成标准是新用户从安装到用自己的 key 或本地 Ollama 跑通任意一个 Store 里的 Harness 不超过 10 分钟，并且上传、下载、运行端到端跑通，Store 内至少有 10 个 Harness。**P0.5** 增加 Python Harness、Python SDK 与 GitHub 仓库导入。**P1** 引入一次性买断的付费 Harness（Stripe Connect，抽成暂定 10%，不做防复制）、beta Channel、Anthropic 格式入站、评分评论、Publisher 数据页与管理后台、可选遥测、发布时自动扫描、后台常驻 Harness、GitHub webhook 自动发版。**P2** 提供平台订阅：云端 Gateway 与模型额度、云同步、私有 Harness。

明确不做：进程沙箱（P0 只做权限告知）、平台自带 agent loop、借用消费级订阅（ADR-0002）、P0 阶段的代码签名与遥测。

## 1. Vision

Any agent, on any model, one click away. Harness Store lets a User install an AI agent the way they install a game on Steam, run it on whatever language model they already pay for or host locally, and lets a Publisher ship an agent without caring which model their audience uses.

## 2. Problem

- Agent programs are scattered across GitHub repos, each with its own install steps, its own provider support and its own way of asking for API keys. A User who wants to try five agents repeats the same setup five times and hands their credentials to five codebases.
- A Publisher who builds a useful agent must support every model vendor themselves or lose the Users who only have Ollama, DeepSeek or an OpenRouter account.
- There is no trusted, discoverable place where an agent's permissions, platform support and model needs are stated up front.

## 3. Target users

**P0: technical Users who already hold their own model accounts.** They can obtain an API key, have installed Ollama or LM Studio, and are comfortable being told "this Harness will run shell commands". They do not need a wizard to explain what a model is.

**Publishers** are developers who have already built an agent program (Node in P0, Python in P0.5) and want distribution without building provider integrations.

Later phases widen the User base only after payments (P1) and the platform subscription with bundled model credits (P2) remove the "bring your own key" barrier.

## 4. Product principles

1. **Steam / App Store model.** A Harness is an app: it has a listing, an install button, its own window, its own updates. The main window is a launcher and a store, never a chat surface.
2. **Gateway-only model access.** A Harness never sees a credential. It asks the Model Gateway for a Model Slot; the User decides which Provider fills it. This is the platform's single non-negotiable technical rule.
3. **Honesty about trust.** In P0 nothing sandboxes a Harness. Declared Permissions are shown clearly and consent is required, and the copy says in plain words that installing means trusting the Publisher.
4. **The User decides the model, always.** Recommended Models are suggestions. A Slot Binding can be changed at any time and takes effect on the next request.
5. **Local first.** Installs, Connections, Slot Bindings and Usage Records live on the User's machine. The Store is needed to discover and download, not to run.
6. **Simple over clever.** One inbound protocol, one package format, one auth provider for Publishers, no automatic fallback, no hidden behaviour.

## 5. Scope by phase

### P0 — Core

Definition of done is in §7. In scope:

- Desktop app for macOS, Windows and Linux with one UI, localised in English and Simplified Chinese.
- Runtime that installs Harness Packages, launches a Harness as its own window (web or terminal UI Kind), supervises the process, injects the launch environment, provides a Data Directory and an optional Workspace, and enforces single instance per Harness.
- Node Harnesses run on a bundled Node LTS; binary Harnesses run directly. Universal package per Harness Version with per-platform Entry.
- Model Gateway: OpenAI Chat Completions inbound, streaming and tool calling, Slot resolution (Model Override → Recommended Models → Default Model → error), per-launch Gateway Token, Usage Records, no fallback.
- Connections for Anthropic, OpenAI, Google, OpenRouter, Ollama, LM Studio, DeepSeek, Qwen, Moonshot, Zhipu, MiniMax, Doubao, Groq and any OpenAI-compatible endpoint; auto-detection of local Providers; model listing where available.
- Slot Bindings: global Default Model per Slot name and per-Harness Model Override, with advisory Model Requirements warnings.
- Store on Supabase: anonymous browse and install; GitHub OAuth for Publishers only; search, tags, download counts, Publisher pages, Featured; immutable Harness Versions; Unpublish.
- Publish flow inside the app: pick a folder, local Manifest validation, metadata form, upload, live immediately.
- Install with a consent screen, update notifications with re-consent when Declared Permissions or Entry change, uninstall that removes the Data Directory.
- Usage page (tokens per Harness per model, local only) and Settings (language, Provider detection, data location).
- Report button; administrator Takedown.
- Automated tests at the seams listed in the architecture document, CI, and unsigned builds for all three platforms.

### P0.5 — Python and GitHub import

- Python Harness runtime (bundled `uv`, declared Python version, dependency install with clear failure UX).
- Python SDK equivalent to the Node SDK.
- GitHub import for publishing: the User pastes `owner/repo@tag`, the app fetches the archive, validates it and uploads it through the normal publish path; the listing shows the source.

### P1 — Paid Harnesses and store maturity

- Paid Harnesses: one-time purchase only, Stripe Connect Express for Publishers, platform commission **10% (placeholder, to be confirmed)**. No copy protection; the package format carries a reserved `encrypted` flag for a possible later scheme.
- Beta Channel per Harness with per-User opt-in.
- Anthropic Messages inbound compatibility on the Model Gateway.
- Ratings and reviews.
- Publisher analytics (downloads, installs over time) and an administrator dashboard (Harness count, Publisher count, downloads, Reports queue).
- Opt-in, anonymous telemetry (app opens, Harness launches, crashes; never content).
- Publish-time automated scanning (direct-vendor credential patterns, known vendor domains) that flags for review.
- Background Harnesses that keep running without a window.
- GitHub webhook auto-publish on tag push for connected repositories.

### P2 — Platform subscription

- Cloud Model Gateway with model credits, reusing the local Gateway code server-side.
- Platform subscription (monthly) that bundles model credits, cloud features and premium support.
- Accounts for all Users and cloud sync of Library, Slot Bindings and settings (never raw credentials without end-to-end encryption).
- Private Harnesses for teams: unlisted, access-controlled.

## 6. Non-goals

- **No sandbox in P0.** Declared Permissions inform; they do not restrain.
- **No agent loop in the platform.** The Runtime launches processes; it never runs an agent itself (ADR-0004).
- **No consumer-subscription OAuth** (Claude Pro/Max, ChatGPT Plus). Deferred indefinitely pending an officially sanctioned channel (ADR-0002).
- **No code signing or notarisation in P0.** Builds are unsigned; distribution polish is handled before public launch.
- **No telemetry in P0.** Download counts are server-side business metrics, not client telemetry.
- No automatic Provider fallback, no cost estimation, no chat history kept by the platform, no multi-version side-by-side installs.

## 7. Success metrics

**P0 definition of done**

| Metric | Target |
|---|---|
| Time from first app launch to a running Store Harness, using the User's own API key or local Ollama | ≤ 10 minutes, measured with a stopwatch on a clean machine |
| End-to-end path: publish a Harness → find it in the Store → install → launch → get a model response → update → uninstall | Passes on macOS, Windows and Linux |
| Harnesses listed in the Store at P0 launch | ≥ 10 (first-party reference Harnesses count) |
| Providers proven end-to-end | At least one remote (Anthropic or OpenAI) and one local (Ollama) |

**Leading indicators after launch** (from server-side counts only): weekly downloads, number of active Publishers, Harnesses with more than one published version, Reports per 100 installs.

## 8. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Third-party code runs unsandboxed on the User's machine | A malicious Harness can read files or exfiltrate data | Declared Permissions with explicit consent; plain-language warning; Report and Takedown; automated scanning in P1; sandboxing revisited once usage justifies it |
| Protocol long tail: OpenAI-compatible semantics differ across Providers (tool calls, images, stop sequences, usage) | Harnesses work on one Provider and break on another | Single inbound protocol; conformance suite against a fake Provider; adapters via a maintained SDK; Anthropic inbound added only in P1 |
| Thin supply side at launch | Empty Store, no reason to install | First-party reference Harnesses; Node SDK; publish in minutes from a folder; Python in P0.5 to open a second ecosystem |
| Provider terms of service | Account bans if consumer subscriptions are borrowed | API keys and local endpoints only (ADR-0002) |
| A Harness bypasses the Model Gateway | Breaks "any model" promise and future metering | No credentials ever injected; listing policy; Report; automated scanning in P1 |
| Local Providers behave inconsistently (model listing, context windows) | Confusing Slot Binding warnings | Manual model entry always available; Model Requirements are advisory |

## 9. Open questions (deferred, none blocking P0)

- Final P1 commission percentage and refund policy.
- Whether Publishers may set regional pricing.
- Exact contents and price of the P2 platform subscription.
- Whether a declarative "chat runtime" Harness should be shipped first-party (ADR-0004 keeps the door open).
- Code signing and notarisation timeline before public distribution.
