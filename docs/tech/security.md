# Security and Trust Model

## Trust boundaries
1. **Harness process** — third-party code with the User's OS privileges. P0 does **not** sandbox it (ADR-0004). The product says so plainly at install ("Installing runs this Harness with your user permissions. Harness Store does not isolate it. Install only Harnesses you trust.").
2. **Runtime / Gateway** — first-party, holds decrypted credentials only in memory while forwarding a request.
3. **Store** — first-party service; never sees credentials, Usage Records or conversation content.

## What the platform guarantees in P0
- **Credential isolation**: Provider credentials are stored encrypted (Electron `safeStorage`, OS keychain-backed) and are never written to a Harness's environment, files or Data Directory. `OPENAI_*` / `ANTHROPIC_*` variables inherited from the User's shell are stripped before spawning.
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
- Publisher JWT required for publish/unpublish; `is_admin` claim for takedown.
- Rate limits on `publish` (20/day/publisher) and `report` (5/h/IP).

## Desktop-side controls
- Gateway binds `127.0.0.1` only, validates `Host`, no CORS.
- Context isolation and no Node integration in renderer and Harness web windows. The Harness web window is a plain BrowserWindow loading `http://127.0.0.1:<port>`; it gets no preload and no IPC.
- Installs are unpacked under the app data root; the Runtime never executes files from a Workspace.

## Later phases
P1: automated scanning, beta Channel, purchase entitlements. P2: server-side Gateway with per-user quotas; private Harness access control.
