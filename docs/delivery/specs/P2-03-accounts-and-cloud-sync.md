---
spec_id: P2-03
title: Accounts for all Users and cloud sync
phase: P2
blocked_by: [P0-07, P0-10]
requirements: [R-P2-03]
---

## Problem Statement

In P0 only Publishers sign in; everyone else is anonymous, which was the right call for growth. By P2 it becomes a limitation: a User with two machines sets up Connections, Slot Bindings and installs twice; a reinstall loses everything; credits and subscriptions (P2-01, P2-02) need an identity; private Harnesses (P2-04) need to know who is asking. The round-one decision was "start anonymous, move to accounts later". This is later.

## Solution

Introduce optional **accounts for all Users** (GitHub OAuth as in P0, plus email magic link so non-developers can join). Installing and browsing stay anonymous. Signing in unlocks **cloud sync** of the installed Harness list, Slot Bindings, Model Overrides and app settings across devices, and optionally Provider Connection secrets under end-to-end encryption with a User-held passphrase. Sync is last-writer-wins per record with a visible "last synced" state and a conflict list where needed. Local data remains the source when offline; the app works exactly as before without an account.

## User Stories

1. As a User, I want to keep using the app fully without an account, so that P0's anonymity promise is honoured.
2. As a User, I want to sign in with GitHub or an email link, so that I can use an account without being a developer.
3. As a User, I want my installed Harness list to appear on a second machine with one-click "install all", so that setup is fast.
4. As a User, I want my Slot Bindings and Model Overrides to sync, so that my model choices follow me.
5. As a User, I want app settings (language, update interval) to sync, so that machines behave the same.
6. As a User, I want the choice to sync my Provider API keys, protected by a passphrase only I know, so that convenience does not mean the platform can read my keys.
7. As a User, I want to be told clearly that losing the passphrase means losing synced keys (not the account), so that I understand the trade-off.
8. As a User, I want to see when each machine last synced and to remove a lost device from my account, so that I stay in control.
9. As a User, I want conflicting edits (two machines changed the same binding offline) resolved predictably and shown to me, so that nothing silently disappears.
10. As a User, I want sync to never upload Harness Data Directories, Usage Records or logs, so that private work stays local.
11. As a User, I want to sign out on one device and have its local copy kept, so that signing out is not data loss.
12. As a User, I want to delete my account and all synced data, so that I can leave cleanly.
13. As a User, I want Publisher identity and User identity to be the same account, so that I do not manage two logins.
14. As a User whose email account is compromised, I want sessions revocable from another device, so that I can lock the attacker out.
15. As the maintainer, I want the sync protocol to be simple record-level upserts with versions, so that it is debuggable and cheap.
16. As the maintainer, I want secrets to reach the server only as ciphertext the server cannot decrypt, so that a database breach cannot leak keys.
17. As the maintainer, I want anonymous download counting and Store behaviour unchanged for signed-out Users, so that accounts add no friction.

## Implementation Decisions

- **Auth:** Supabase Auth with GitHub OAuth (existing) plus email magic link. One `profiles` row per User; `github_login` becomes nullable and is required only to publish (the Harness ID rule is unchanged: publishing needs a linked GitHub login).
- **Synced records:** `installs` (Harness ID, version pinned or "latest", consented permissions), `slot_bindings` (global and per-Harness), `settings` (allow-listed keys). Each synced record carries `(device_id, updated_at, version)`; server stores per-User records in `sync_records` (User id, kind, key, payload jsonb or ciphertext, version, updated_at, device_id). Last-writer-wins by `updated_at` with server tie-break; conflicts (both sides changed since last sync) are applied LWW and listed in a "Recent sync changes" view for transparency.
- **Not synced:** Data Directories, Usage Records, launch logs, Workspace paths, local install paths.
- **Secrets (opt-in):** end-to-end encryption with a key derived from a User passphrase (a modern password KDF, parameters decided at implementation) plus a per-User random salt stored server-side; ciphertext only in `sync_records`. The server never receives the passphrase or derived key. Passphrase loss = secrets unrecoverable; the app says so before enabling. Local storage still uses `safeStorage` after decryption.
- **Devices:** `devices` table (User id, device id, name, platform, last_sync_at); revocation deletes the device's refresh tokens and marks it removed; the client on that device drops to signed-out state on next request.
- **Sync engine:** pull-then-push on app start, on change (debounced), and every 15 minutes; offline queue; the local SQLite remains authoritative for operation.
- **Account deletion:** deletes `sync_records`, `devices`, subscription linkage handled by P2-02 (cancel first), Publisher data retained only where a published Harness exists (Publisher must Unpublish or transfer first; decide transfer at implementation).
- **Anonymity preserved:** all Store read paths and the `download` function keep working with the anon key; no feature outside sync/credits/private requires sign-in.

## Testing Decisions

- Good tests drive two simulated devices against the Store and assert converged local state and server contents; encryption tests assert the server-side payload is not plaintext.
- **Store seam (architecture §8 seam 4):** sync upsert/pull semantics, LWW with tie-break, device revocation, account deletion cascade, magic-link sign-in creating a profile without `github_login`, publish refused without linked GitHub.
- **Local store / sync engine seam (new seam, kept at the sync-engine boundary):** two in-memory clients with fixture SQLite databases converge after offline edits; conflicts appear in the changes list; nothing from the not-synced list is ever sent (assert on captured payloads).
- **Crypto tests:** round-trip with correct passphrase, failure with wrong passphrase, server payload has no recognisable key prefixes (`sk-`, `AIza`).
- **Desktop E2E (seam 5):** sign in on a fresh profile with a seeded account → "install all" restores the Library.
- Prior art: P0-10 install tests; P0-07 RLS tests.

## Out of Scope

- Syncing conversation history (Harnesses own it).
- Team or organisation membership: P2-04.
- Credits and subscription UI: P2-01 / P2-02 (they consume the identity this spec provides).
- Passkeys or SSO.

## Further Notes

- ADR-0002 is unaffected: accounts here are Harness Store accounts, not vendor accounts, and never proxy consumer subscriptions.
- The round-one plan to "later require sign-in to download" is intentionally not adopted; downloads stay anonymous.

## Blocked by

- P0-07 Store backend (Supabase schema, auth, storage, edge functions)
- P0-10 Install, update and uninstall from the Store (Library)
