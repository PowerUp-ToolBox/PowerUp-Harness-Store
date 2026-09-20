# Harness Store — System Architecture

Status: P0 baseline. Vocabulary follows [`CONTEXT.md`](../../CONTEXT.md); decisions follow [`docs/adr`](../adr). Read ADR-0004 first.

## 1. Shape in one paragraph

Harness Store is a desktop app (Electron + React + TypeScript) that installs **Harnesses** (self-contained agent programs) and launches each one as its own window. The app embeds the **Runtime**, whose two jobs are (a) supervising Harness processes and (b) hosting the **Model Gateway**, a local HTTP service speaking the OpenAI Chat Completions protocol. A Harness never holds model credentials; it calls the Gateway with a per-launch **Gateway Token** and asks for a **Model Slot**, and the Gateway forwards to whichever **Provider** the User bound to that Slot. The **Store** (Supabase: Auth, Postgres, Storage, Edge Functions) hosts Harness Packages, metadata, search and download counts.

## 2. Components

```
┌──────────────────────────── Desktop app (Electron) ─────────────────────────────┐
│  Renderer (React, i18n en/zh-CN)                                                │
│    Library · Store · Models · Publish · Settings · First-run wizard             │
│                          ▲ typed IPC (contextBridge)                            │
│  Main process = Runtime                                                         │
│    ┌─────────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌───────────────┐ │
│    │ Installer   │ │ Process          │ │ Model Gateway    │ │ Local store   │ │
│    │ download,   │ │ Supervisor       │ │ (packages/       │ │ SQLite +      │ │
│    │ verify,     │ │ spawn, env,      │ │  gateway)        │ │ safeStorage   │ │
│    │ unpack,     │ │ windows, single  │ │ OpenAI-compat in │ │ connections,  │ │
│    │ consent     │ │ instance, kill   │ │ Providers out    │ │ bindings,     │ │
│    └─────────────┘ └──────────────────┘ └──────────────────┘ │ usage, installs│ │
│                                                              └───────────────┘ │
└──────────────┬──────────────────────────────┬───────────────────────────────────┘
               │ HTTPS                        │ child processes on 127.0.0.1
        ┌──────▼──────────┐          ┌────────▼─────────┐   ┌──────────────────┐
        │ Store (Supabase)│          │ Harness A (web)  │   │ Harness B (term) │
        │ Auth (GitHub)   │          │ listens on       │   │ runs in embedded │
        │ Postgres + RLS  │          │ HARNESS_PORT,    │   │ xterm window     │
        │ Storage buckets │          │ opened in a      │   │                  │
        │ Edge Functions  │          │ BrowserWindow    │   │                  │
        └─────────────────┘          └──────────────────┘   └──────────────────┘
                                             │ HTTP + Gateway Token
                                             ▼
                               Model Gateway → Anthropic / OpenAI / Google /
                               OpenRouter / Ollama / LM Studio / DeepSeek /
                               Qwen / Kimi / GLM / MiniMax / Doubao / custom
```

### 2.1 Renderer
React single-page app. No business logic beyond view state; every action goes through typed IPC to the Runtime. i18n via message catalogs (en, zh-CN) selected from OS locale, overridable in Settings.

### 2.2 Runtime (Electron main process)
- **Installer**: downloads a Harness Package from the Store (signed URL), verifies sha256, unpacks into the install directory, records the install, and drives the permission-consent step. Also supports "install from local folder" for Publishers testing their own Harness.
- **Process Supervisor**: spawns the Harness Entry with the injected environment (§4), owns its window (web or terminal UI Kind), enforces single instance, kills the process when the window closes, and cleans up Gateway Tokens.
- **Model Gateway**: see [`gateway-protocol.md`](./gateway-protocol.md). Implemented in `packages/gateway` as a framework-independent Node HTTP server so it can be tested without Electron and later reused server-side (P2).
- **Local store**: SQLite database in the app data directory for installs, Slot Bindings, Usage Records, settings and Provider Connection metadata. Secrets (API keys) are encrypted with Electron `safeStorage` and stored as opaque blobs.

### 2.3 Store (Supabase)
- **Auth**: GitHub OAuth only. Only Publishers sign in; browsing and installing are anonymous.
- **Postgres**: tables in [`data-model.md`](./data-model.md), protected by RLS; public read of active Harnesses and published Harness Versions.
- **Storage**: private bucket `harness-packages` (downloads via short-lived signed URL), public bucket `harness-assets` (icons, screenshots).
- **Edge Functions**: `publish` (validate Manifest with the shared `packages/manifest` code, store package, create version), `download` (issue signed URL, increment counters), `report`.

### 2.4 Shared packages
- `packages/manifest`: Manifest JSON Schema, TypeScript types, `validateManifest()` and `validatePackage()` (structure + file presence). Used by the desktop app, the Publish flow and the `publish` Edge Function. Single source of truth.
- `packages/gateway`: the Model Gateway server and Provider adapters (Vercel AI SDK).
- `packages/sdk`: `@harness-store/sdk` for Node Harness authors.
- `examples/`: reference Harnesses used in tests and as the first Store listings.

## 3. Repository layout (pnpm monorepo)

```
apps/desktop        Electron app (main = Runtime, renderer = React)
apps/store          Supabase project: migrations, RLS policies, edge functions, seed
packages/manifest   schema + validators (no runtime deps beyond a JSON Schema lib)
packages/gateway    Model Gateway + Provider adapters
packages/sdk        @harness-store/sdk (Node)
examples/hello-web  reference Harness, UI Kind web, Node
examples/hello-term reference Harness, UI Kind terminal, Node
docs/               this documentation
```

## 4. Harness launch contract

When the Runtime starts a Harness it:

1. Resolves Entry for the current platform from the Manifest.
2. Creates (if absent) the Harness's **Data Directory** under the app data root.
3. If `workspace` is `required`, asks the User to pick a folder (remembering the last one); if `optional`, offers the picker but allows skipping.
4. Issues a **Gateway Token** bound to (Harness ID, Harness Version, launch id).
5. Picks a free TCP port for web UI Kind.
6. Spawns the process with `cwd` = Workspace if present, else the Data Directory, and the environment in the table below (inherited environment is passed through, with `OPENAI_*` and `ANTHROPIC_*` variables removed first so a Harness cannot accidentally use the User's own shell credentials).
7. For `ui.kind = web`: polls `127.0.0.1:<port>` until it accepts a TCP connection (timeout 30 s, configurable in Manifest up to 120 s), then opens a BrowserWindow at `http://127.0.0.1:<port><ui.path ?? "/">`. For `ui.kind = terminal`: opens a window with an embedded terminal attached to the process's pty.
8. On window close: sends SIGTERM, waits 5 s, then SIGKILL. On process exit: closes the window and shows the exit code if non-zero. Either way the Gateway Token is revoked.

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

Node Harnesses are executed with the Runtime's bundled Node LTS (`<bundled node> <entry>`). Binary Harnesses are executed directly; the Runtime sets the executable bit on macOS/Linux after unpacking.

## 5. Model resolution (summary; normative text in gateway-protocol.md)

`model` in a request is either a Slot name declared in the Manifest or an explicit `provider/model` id. For a Slot, the Gateway resolves, in order: the User's Model Override for (Harness, Slot) → the first Recommended Model whose Provider has a Connection → the User's Default Model for that Slot name → the User's Default Model for `default` → error `slot_unbound`. Model Requirements are checked in the UI when binding and surfaced as warnings; the Gateway does not refuse a request on requirement mismatch.

## 6. Data flows

- **Install**: Renderer → Runtime.install(harnessId, version) → Store `download` function → signed URL → download to temp → sha256 check → unpack → consent screen (permissions, MCP-like commands are not a concept here; only Declared Permissions and Entry) → record install.
- **Update**: Runtime polls Store for newer published versions of installed Harnesses on app start and every 6 h. If the new Manifest adds a Declared Permission or changes Entry/runtime kind, the update requires re-consent; otherwise one click.
- **Publish**: Renderer picks a folder → `packages/manifest` validation locally → metadata form prefilled from Manifest → zip → `publish` Edge Function (re-validates, stores, creates immutable Harness Version) → listing visible immediately.
- **Model call**: Harness → Gateway `/v1/chat/completions` (Slot) → resolve binding → Provider adapter → stream back → Usage Record written on completion.

## 7. Non-goals in P0 (see ADRs and PRD)
No sandboxing of Harness processes. No agent loop in the platform. No consumer-subscription OAuth. No payments. No cloud sync. No telemetry. No code signing pipeline.

## 8. Test seams (highest first)

1. **Gateway HTTP seam**: run `packages/gateway` in-process against a fake OpenAI-compatible Provider server; assert on HTTP responses, streaming, errors and Usage Records. This is the primary seam for all model-routing behaviour.
2. **Manifest validation seam**: pure functions in `packages/manifest` with fixture packages.
3. **Supervisor seam**: spawn fixture Harnesses (tiny Node scripts) and assert injected environment, window readiness, lifecycle and token revocation. Runs without a display where possible (window creation mocked).
4. **Store seam**: Supabase local stack; call Edge Functions and PostgREST over HTTP.
5. **Desktop E2E seam**: Playwright for Electron, a handful of smoke journeys (first run, install, launch, publish) with Providers faked.
