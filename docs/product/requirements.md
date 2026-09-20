# Requirements

Traceable requirement list. IDs are stable; specs (GitHub issues) cite them. Priority = phase. Each line is one testable statement. Acceptance detail lives in the owning spec.

## P0-01 Monorepo scaffold and Manifest package
- **R-0101** pnpm monorepo with `apps/desktop`, `apps/store`, `packages/manifest`, `packages/gateway`, `packages/sdk`, `examples/*`; one command runs all tests.
- **R-0102** `packages/manifest` exports the JSON Schema, TS types, `validateManifest(json)` and `validatePackage(archive)` implementing every rule in `docs/tech/manifest-spec.md`.
- **R-0103** Validation returns structured problems `{ path, code, message }`; codes are stable strings.
- **R-0104** Fixture packages (valid and each failure class) live in the package and are used by tests.
- **R-0105** A CLI `harness-manifest validate <dir|zip>` prints problems and exits non-zero on failure.

## P0-02 Model Gateway core
- **R-0201** Gateway serves `POST /v1/chat/completions`, `GET /v1/models`, `GET /v1/harness/context` on loopback per `docs/tech/gateway-protocol.md`.
- **R-0202** Requests require a valid Gateway Token; tokens are issued/revoked through an in-process API used by the Supervisor.
- **R-0203** Slot resolution follows the normative order (override → recommended reachable → same-name default → `default` → `slot_unbound`).
- **R-0204** Streaming and non-streaming responses, tool calling, image content parts and usage reporting work against the fake Provider and against at least Anthropic, OpenAI and one OpenAI-compatible endpoint.
- **R-0205** Provider adapters exist for every Provider id in the protocol table; presets are data-only.
- **R-0206** Every completed request writes a Usage Record; token counts are `null` when the Provider omits them.
- **R-0207** Errors use the documented codes and HTTP statuses; provider errors pass through status and message.
- **R-0208** The Gateway starts in < 300 ms and adds < 20 ms median overhead to a non-streaming call against the fake Provider.

## P0-03 Provider Connections and Slot Bindings
- **R-0301** Users can add, test, edit, disable and remove a Connection for each Provider; secrets are stored via `safeStorage` and never shown again after entry (masked).
- **R-0302** On first run and on demand, the app detects Ollama (11434) and LM Studio (1234) and offers one-click Connections.
- **R-0303** For each Connection the app lists models where the Provider supports it and always allows manual model entry.
- **R-0304** Users set global Slot Bindings (Default Models) per Slot name and Model Overrides per installed Harness.
- **R-0305** The Models page shows, per installed Harness and Slot, the currently resolved model and why (override / recommended / default).
- **R-0306** Binding a model that fails a Slot's Model Requirements shows a warning but is allowed.
- **R-0307** Changing a binding affects the next Gateway request without restarting the Harness.

## P0-04 Desktop app shell, i18n and first-run wizard
- **R-0401** Electron + React app with navigation: Library, Store, Models, Publish, Settings.
- **R-0402** All UI strings come from message catalogs; `en` and `zh-CN` are complete; locale follows the OS and can be changed in Settings without restart.
- **R-0403** First-run wizard: welcome → local Provider detection → optional API key → Default Model → Store; every step skippable; can be re-run from Settings.
- **R-0404** Typed IPC layer between renderer and Runtime; renderer has no Node access.
- **R-0405** App works offline for Library, Models, Usage, Settings and launching installed Harnesses; Store views show an offline state.

## P0-05 Runtime: install from folder, launch and supervise Harnesses
- **R-0501** "Install from folder" validates a local Harness directory and installs it like a Store package (marked as local).
- **R-0502** Launch implements the launch contract (architecture §4): environment, cwd, Data Directory, Workspace picker, Gateway Token.
- **R-0503** `ui.kind = web`: window opens when the port is ready; readiness timeout shows an error with the last 50 lines of process output.
- **R-0504** `ui.kind = terminal`: embedded terminal window with pty, resize, copy/paste.
- **R-0505** One running instance per Harness; launching again focuses the window.
- **R-0506** Closing the window terminates the process (SIGTERM → SIGKILL after 5 s); process exit closes the window and surfaces non-zero exit codes.
- **R-0507** Node Harnesses run on the Runtime's bundled Node LTS; binary Harnesses run directly with the executable bit set.
- **R-0508** Process stdout/stderr are captured to a per-launch log file viewable from Library.

## P0-06 Harness SDK and reference Harnesses
- **R-0601** `@harness-store/sdk` (Node) exposes `getContext()`, `createOpenAIClient()`, slot constants, and a typed error for `slot_unbound`.
- **R-0602** `examples/hello-web` (web UI Kind) and `examples/hello-term` (terminal) are complete, publishable Harnesses using the SDK and the `default` Slot.
- **R-0603** A "harness authoring" guide documents the launch contract, Manifest and SDK with copy-paste examples.

## P0-07 Store backend
- **R-0701** Supabase project with migrations for all P0 tables, enums, triggers, RLS policies and buckets per `docs/tech/data-model.md`.
- **R-0702** GitHub OAuth sign-in creates a profile with the GitHub login.
- **R-0703** Edge Functions `publish`, `download`, `unpublish`, `report`, `admin/takedown` per `docs/tech/api.md`, using `packages/manifest` for validation.
- **R-0704** `search_harnesses` and `latest_versions` RPCs.
- **R-0705** Local development runs on the Supabase CLI with seed data (≥ 3 Harnesses).

## P0-08 Publish flow
- **R-0801** Publish page: sign in with GitHub → pick folder → validation results → metadata preview (from Manifest) + changelog → upload with progress → success with Store link.
- **R-0802** Validation problems are shown verbatim with path and code; publishing is blocked until zero problems.
- **R-0803** Publisher can see their Harnesses and versions and Unpublish a version.
- **R-0804** Publishing a new version of an existing Harness requires a greater semver; the error is shown before upload.

## P0-09 Store browsing and discovery
- **R-0901** Store home shows Featured, then most downloaded, then newest.
- **R-0902** Search with text, tag filter and automatic platform filter (current OS) with a toggle to show all.
- **R-0903** Detail page shows all Manifest-derived fields listed in `docs/ux/screens.md`, README rendered as Markdown (sanitised), permissions with the trust notice, Slots with requirements and recommended models, version history with changelogs.
- **R-0904** Publisher page lists a Publisher's active Harnesses.
- **R-0905** Detail page install button reflects state: Install / Installed / Update available / Not available for this platform / Taken down.

## P0-10 Install, update and uninstall from the Store (Library)
- **R-1001** Install: download with progress, sha256 verification, unpack, consent dialog, record.
- **R-1002** Consent dialog shows Declared Permissions (red/yellow/green), runtime kind and Entry, Workspace need, and the no-sandbox notice; requires explicit confirmation.
- **R-1003** Update check on start and every 6 h; Library badges Harnesses with updates; update prompt shows changelog and a permission diff; re-consent required when permissions widen or Entry/runtime kind changes.
- **R-1004** Uninstall removes the install directory and, after confirmation, the Data Directory.
- **R-1005** Library lists installed Harnesses with Launch, Update, Uninstall, Open data folder, View logs, and Model Overrides shortcut.

## P0-11 Usage page and Settings
- **R-1101** Usage page aggregates Usage Records by Harness, Provider/model and day; date range filter; CSV export.
- **R-1102** Settings: language, Store URL (advanced), update check interval, re-run first-run wizard, open logs folder, clear usage data.

## P0-12 Report and Takedown
- **R-1201** Report button on detail page with reason and details; confirmation shown.
- **R-1202** Admin takedown via Edge Function; taken-down Harnesses disappear from Store and show "removed" in Library with launch still allowed but a warning.

## P0-13 End-to-end acceptance, CI and unsigned builds
- **R-1301** CI runs unit, Gateway conformance, Supervisor, Store (Supabase local) and Playwright smoke tests on push.
- **R-1302** Smoke journey: fresh profile → wizard with fake Ollama → install `hello-web` from local Store → launch → Harness completes a chat via Gateway → usage visible; must complete in < 10 min wall-clock in CI.
- **R-1303** Unsigned builds produced for macOS (dmg), Windows (nsis) and Linux (AppImage) as CI artifacts.

## P0.5
- **R-P5-01** `runtime.kind = python`: Runtime bundles `uv`, creates a per-install virtualenv, installs from `pyproject.toml`/`requirements.txt` with progress and clear failure UX.
- **R-P5-02** `harness-store` Python SDK mirrors the Node SDK.
- **R-P5-03** Publish page accepts `owner/repo@tag`; the client downloads the tag archive, validates and uploads it like a folder; `sourceRepo` is set.

## P1
- **R-P1-01** Paid Harnesses: price set by Publisher, one-time purchase via Stripe Checkout, Stripe Connect Express payouts, 10% platform commission (placeholder), entitlement checked at install; Manifest gains an `encrypted` reserved flag.
- **R-P1-02** Beta Channel: versions can be published to `beta`; Users opt in per Harness.
- **R-P1-03** Gateway accepts Anthropic Messages API inbound.
- **R-P1-04** Ratings (1–5) and reviews, one per verified installer, Publisher reply.
- **R-P1-05** Publisher analytics (downloads, versions, platforms) and admin dashboard (totals, reports queue, takedowns).
- **R-P1-06** Opt-in telemetry: app opened, launch started/ended, provider type, crashes; never content.
- **R-P1-07** Publish-time automated scanning flags direct vendor credentials/domains for review.
- **R-P1-08** Background Harnesses: `background: true` keeps the process alive without a window, with tray controls.
- **R-P1-09** Connect a GitHub repo; a tag push publishes automatically via webhook.

## P2
- **R-P2-01** Cloud Model Gateway with per-User credits, same protocol as the local Gateway; local Gateway can route to it as a Provider.
- **R-P2-02** Platform subscription (Stripe Billing) including credits, cloud sync and private Harnesses.
- **R-P2-03** Accounts for all Users; sync of installed list, Slot Bindings and settings (secrets synced only with end-to-end encryption).
- **R-P2-04** Private Harnesses: organisations, members, visibility `private`, access enforced on download.
