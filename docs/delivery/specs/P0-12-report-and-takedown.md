---
spec_id: P0-12
title: Report and Takedown
phase: P0
blocked_by: [P0-07, P0-09]
requirements: [R-1201, R-1202]
---

# P0-12 Report and Takedown

## Problem Statement

Harness Store runs third-party code without a sandbox and publishes listings without pre-review. The only enforcement in P0 is reactive: Users must be able to flag a harmful or misleading Harness, an administrator must be able to remove it, and Users who already installed it must be warned. Without this loop the listing policy in `docs/tech/security.md` is unenforceable.

## Solution

A Report dialog reachable from the detail page and the Library card menu (flow F8 in `docs/ux/flows.md`), submitted anonymously to the Store's `report` function; a minimal administrator path to take down a version or a Harness using the `admin/takedown` function (invoked through a small admin CLI in the Store app, no admin UI in P0); and client behaviour that makes taken-down Harnesses disappear from the Store and show a warning in the Library while remaining launchable.

## User Stories

1. As a User, I want a Report link on every detail page, so that I can flag a Harness where I found it.
2. As a User, I want to report from the Library card menu too, so that I can flag a Harness that misbehaved after install.
3. As a User, I want to choose a reason (malicious behaviour, bypasses the Model Gateway, misleading listing, broken, inappropriate, spam, other), so that reviewers can prioritise.
4. As a User, I want a free-text details field with a sensible limit, so that I can describe what happened.
5. As a User, I want to submit without an account, so that reporting has no barrier.
6. As a User, I want the report to include the Harness version and my platform and app version automatically, so that I do not have to look them up.
7. As a User, I want assurance that no personal data is sent beyond what I typed, so that reporting feels safe.
8. As a User, I want a confirmation after submitting, so that I know it went through.
9. As a User, I want repeated reports of the same Harness from my install to be gently rate-limited, so that the system is not abusable while I am not punished for a double click.
10. As a User, I want an offline or server error to be shown with Retry and my text preserved, so that I do not have to retype.
11. As a User who installed a Harness that was later taken down, I want a clear red warning on its Library card and detail view, so that I can decide whether to keep using it.
12. As a User, I want a taken-down Harness to remain launchable, so that the platform does not delete my tools remotely.
13. As a User, I want a taken-down Harness to have Update hidden and to never reappear in Store lists or search, so that removal is complete on the discovery side.
14. As a Store administrator, I want to list open Reports with reason, counts per Harness and the latest details, so that I can triage.
15. As a Store administrator, I want to take down a single version or a whole Harness with a note, so that I can respond proportionately.
16. As a Store administrator, I want takedown to resolve the related open Reports, so that the queue stays clean.
17. As a Store administrator, I want to dismiss a Report as unfounded with a note, so that the queue reflects decisions.
18. As a Store administrator, I want takedowns to be logged with who did it and when, so that actions are auditable.
19. As a Publisher, I want a taken-down status visible on my own Harness list with the administrator's note, so that I know what happened and can appeal by email.
20. As a security reviewer, I want reports and takedowns to be impossible to perform through direct table writes with the anon key, so that the only path is the validated function.

## Implementation Decisions

- **Report dialog** fields: reason (enum from `docs/tech/data-model.md`), details (≤ 2000 chars), optional contact email (stored in `details` prefix in P0, no separate column). Client info sent: Harness ID, version (installed or viewed), platform, app version, a random per-install `install_id` (generated once, stored in settings) used only for rate limiting. No IP is stored server-side.
- **Rate limit** client-side: at most 3 reports per Harness per install per 24 h, enforced locally with a friendly message; server-side per `docs/tech/api.md`.
- **Submission** goes through IPC `store.report` to the `report` function; on failure the dialog keeps its content and offers Retry.
- **Admin tooling**: a CLI in the Store app (run by an administrator with a service-role key from their machine) with commands `reports list [--open]`, `reports dismiss <id> --note`, `takedown <harness_id> [--version] --note`. The `takedown` command calls the `admin/takedown` function with an admin JWT; `reports list` and `dismiss` use service-role queries. No web admin UI in P0 (P1-05).
- **Audit**: `admin/takedown` writes `resolution_note` and `resolved_at` on affected Reports and appends a row to an `admin_actions` table (added by this spec: id, admin_id, action, target_harness_id, target_version_id, note, created_at).
- **Publisher visibility**: the Publisher-only RLS read policy from P0-08 also exposes taken-down versions of their own Harnesses with the takedown note (copied to `harness_versions.takedown_note`, added by this spec).
- **Client behaviour**: the update check (P0-10) already surfaces `store_status = taken_down`; this spec defines the UI: red banner on the Library card, warning on the detail view (which the client can still render from its locally stored Manifest), Update hidden, Launch allowed with a one-time confirmation "This Harness was removed from the Store. Launch anyway?".
- **Copy** in `en` and `zh-CN`; reasons are translated, stored as enum values.

## Testing Decisions

- **Seams**: Store seam for `report` (rate limit, anonymous insert, RLS denial of direct writes) and `admin/takedown` (version vs whole Harness, report resolution, audit row); renderer component tests for the Report dialog validation and local rate limit; Installer seam test that a taken-down status from `latest_versions` marks the install and hides Update.
- **Good tests**: an anon PostgREST insert into `reports` is rejected while the function succeeds; six reports within an hour from one client info return a rate-limit error on the sixth; taking down a Harness makes its detail read return nothing and its versions unavailable for download while an existing install still launches in an E2E check.
- **Fixtures**: seeded Store with open Reports; admin user created with the service role.
- **Prior art**: P0-07 store tests.

## Out of Scope

- Web admin dashboard and Publisher analytics (P1-05).
- Automated scanning (P1-07).
- Appeals workflow beyond an email address in the takedown note.
- Ratings and reviews (P1-04).

## Further Notes

- Even though enforcement is reactive, response time matters: the admin CLI must be usable in under a minute from a fresh checkout; document it in the Store app README.

## Blocked by

- P0-07 Store backend (Supabase schema, auth, storage, edge functions)
- P0-09 Store browsing and discovery
