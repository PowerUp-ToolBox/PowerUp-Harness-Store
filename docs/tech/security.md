# Security and Trust Model

## Trust boundaries
1. **Harness process** — third-party code with the User's OS privileges. P0 does **not** sandbox it (ADR-0004). The product says so plainly at install ("Installing runs this Harness with your user permissions. Harness Store does not isolate it. Install only Harnesses you trust.").
2. **Runtime / Gateway** — first-party, holds decrypted credentials only in memory while forwarding a request.
3. **Store** — first-party service; never sees credentials, Usage Records or conversation content.

## What the platform guarantees in P0
- **Credential isolation**: Provider credentials are stored encrypted (Electron `safeStorage`, OS keychain-backed) and are never written to a Harness's environment, files or Data Directory. They are never stored in plaintext: when OS encryption is unavailable (on Linux also the `basic_text` backend, which uses a hard-coded password), adding a key is refused with guidance to enable an OS keyring. Decrypted keys stay in the Runtime's main process; the app's own UI sees only the last 4 characters. Variables inherited from the User's shell whose names start with `OPENAI_`, `ANTHROPIC_`, `GOOGLE_API_`, `GEMINI_`, `OPENROUTER_` or `HARNESS_` are stripped (case-insensitively) before spawning; the environment and the Gateway Token are never written to launch logs.
- **Attribution**: every model call carries a per-launch Gateway Token; tokens are unguessable, loopback-only, and revoked at process exit. A Harness cannot impersonate another Harness.
- **Package integrity**: the Store records sha256 at publish; the Runtime verifies before unpacking; zip-slip, symlinks and absolute paths are rejected.
- **Immutability**: a published Harness Version cannot change. Updates are explicit, and re-consent is required when Declared Permissions widen or Entry/runtime kind changes.
- **Publisher identity**: `publisher` in a Harness ID is the GitHub login of the account that published it; no one else can publish under it.
- **No silent data exfiltration by the platform**: no telemetry in P0; the only network calls the app makes are to the Store and to Providers the User configured.

## What it does not guarantee
- That a Harness respects its Declared Permissions.
- That a Harness only uses the Gateway (policy + Report + Takedown, see below).
- Protection against a malicious Harness once launched.

## Store policy (P0)
- Listing terms require: Gateway-only model access, accurate Declared Permissions, no credential harvesting, no obfuscated payloads, license compliance.
- Enforcement in P0 is reactive: Report → admin review → Takedown. Automated scanning is P1-07.

## Store-side controls
- RLS on all tables; writes only through Edge Functions with server-side validation using the same `packages/manifest` code as the client.
- Packages in a private bucket; downloads via 60-second signed URLs.
- Publisher JWT required for publish/unpublish; takedown requires a caller whose `profiles.is_admin` is set, looked up by the function (not a JWT claim; Publishers cannot write that column). `download` and `report` need no account, and neither stores an IP address or user.
- Rate limits on `publish` (20 per rolling 24 h per Publisher) and `report` (5/h per IP, best effort in function memory, and 5/h per install id, checked against the stored Reports).

## Desktop-side controls
- Gateway binds `127.0.0.1` only, validates `Host`, no CORS.
- Context isolation and no Node integration in renderer and Harness web windows. A Harness window's top bar is an app page with its own preload, which exposes only calls about that window's own launch (main checks the sender), never the main window's API. The Harness's own page loads `http://127.0.0.1:<port>` in a separate sandboxed view of that window with no preload and no IPC, in a session per Harness (`persist:harness:<publisher>/<slug>`) that denies every permission request. Navigation, redirects and `window.open` stay in the view only for that exact origin; other http(s) URLs (`localhost:<port>` included) open in the User's browser, and other schemes are blocked.
- Store content in the main window (P0-09): the renderer reads the Store only through the Runtime's IPC, never directly. A README or changelog is Publisher Markdown rendered with raw HTML dropped and then sanitised against an allow-list (no scripts, iframes, styles or event attributes); its links keep only absolute http(s) targets and its images load only from the Store's asset bucket or as raster `data:` images. Store images reach the renderer through a `store-asset:` scheme that main serves from the public `harness-assets` bucket of the configured Store and nowhere else, so the renderer's Content Security Policy never names a remote origin except GitHub's avatar host. The main window opens no new windows: an http(s) link (README, homepage, source) goes to the User's browser through `shell.openExternal`, any other scheme is refused.
- Paths the app opens in the OS (logs, Data Directory) are computed in main from the Harness ID, never taken from a renderer.
- Installs are unpacked under the app data root; the Runtime never executes files from a Workspace.

## Later phases
P1: automated scanning, beta Channel, purchase entitlements. P2: server-side Gateway with per-user quotas; private Harness access control.
