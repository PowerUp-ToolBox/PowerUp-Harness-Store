---
spec_id: P2-04
title: Private Harnesses
phase: P2
blocked_by: [P2-03]
requirements: [R-P2-04]
---

## Problem Statement

Every Harness in the Store is public. Teams that build internal Harnesses (a reviewer tuned to their codebase, an ops assistant with company runbooks) cannot use the Store at all: they fall back to "install from folder" on every machine and lose versioning, updates and consent flows. Publishers who sell to a specific customer have no way to limit distribution.

## Solution

Add **organisations** with members, and a `visibility: private` option on a Harness that ties it to an organisation. Private Harnesses never appear in search, Featured, Publisher pages or anonymous detail views; they are installable only by signed-in members of the owning organisation, and the download function enforces that on every download and update. Members see a "Private" section in the Store with their organisations' Harnesses. Everything else about a private Harness (Manifest, consent, Runtime, updates, Gateway) is identical to a public one. Private Harnesses are part of the platform subscription bundle (P2-02) for the organisation owner.

## User Stories

1. As a team lead, I want to create an organisation and invite teammates by email or GitHub login, so that we have a private audience.
2. As a Publisher, I want to publish a Harness as private to one of my organisations, so that only members can install it.
3. As a member, I want to see my organisations' private Harnesses in a dedicated Store section, so that I can find internal tools.
4. As a member, I want to install and update a private Harness exactly like a public one, so that there is nothing new to learn.
5. As a non-member, I want a private Harness to be invisible (not "forbidden"), so that its existence is not leaked.
6. As a team lead, I want to remove a member and have their access end immediately for new downloads and updates, so that offboarding is clean.
7. As a team lead, I want to see who in the organisation has installed which private Harness version, so that I can drive upgrades (opt-in reporting from the member's app).
8. As a Publisher, I want to switch a Harness from private to public deliberately (with a confirmation that this is irreversible for already-published versions), so that internal tools can graduate.
9. As a Publisher, I want to prevent accidentally publishing a private Harness as public by requiring the visibility to be set on the Harness, not per version, so that a tag push (P1-09) cannot leak it.
10. As a member, I want private Harness updates to follow the same re-consent rules, so that internal tools are held to the same trust standard.
11. As a member with two organisations, I want to see which organisation a private Harness belongs to, so that context is clear.
12. As an organisation owner, I want roles `owner`, `admin`, `member`, so that not everyone can invite or publish.
13. As an organisation owner, I want the organisation to require an active platform subscription (P2-02) on the owner's account, so that the pricing model is simple.
14. As an admin (platform), I want Takedown to work on private Harnesses too, so that moderation is universal.
15. As the maintainer, I want access checks to live in the `download` function and RLS, not in the client, so that a modified client cannot bypass them.
16. As the maintainer, I want private packages stored in the same private bucket with the same signed-URL flow, so that no second distribution path exists.
17. As a member, I want sync (P2-03) to restore private installs on a new machine only when I am still a member, so that access rules survive device changes.

## Implementation Decisions

- **Schema:** `organizations` (id, slug, name, owner user id, created at), `org_members` (org id, user id, role `owner` / `admin` / `member`, invited by, joined at), `org_invites` (org id, email or github login, token, expires at). `harnesses.visibility` enum `public` / `private` (default `public`) and `harnesses.org_id` nullable, required when private. Visibility is a Harness-level attribute, immutable from private to public except via an explicit "make public" action that is logged; public to private is not allowed once any version was public (the packages are already out).
- **Enforcement:** RLS on `harnesses` and `harness_versions` restricts private rows to members; the `download` Edge Function re-checks membership with the caller's JWT; anonymous calls for private Harnesses return the same "not found" as a non-existent Harness. `latest_versions` (update check) returns nothing for private Harnesses the caller can no longer access; the app then shows the install as "no longer available" but keeps it launchable.
- **Publishing:** the Publish flow gains an organisation picker when the Publisher is an `admin` or `owner` of at least one organisation; the Harness ID rule is unchanged (`publisher/slug`), so private Harnesses are still namespaced by the publishing User. Decide at implementation whether to also allow `org/slug` namespaces; default no, to keep one rule.
- **Membership management:** in the desktop app (Settings → Organisations) and, if a Store web UI exists, there too. Invites by email (magic link account creation from P2-03) or GitHub login.
- **Install reporting to the org (story 7):** opt-in per member, sends (User, Harness ID, version) on install/update only; off by default, consistent with the telemetry stance (P1-06).
- **Subscription linkage:** creating an organisation requires the creator's account to have an active subscription with the `private_harnesses` feature (P2-02); if it lapses, existing members keep installed versions, new downloads/updates are refused until reactivation.
- **Sync interaction:** private installs are synced as records; "install all" skips those the current membership does not allow and lists them.
- **Moderation:** Report and Takedown apply; Reports on private Harnesses are visible only to platform admins.
- **Gateway / Runtime:** no changes; a private Harness is just a Harness.

## Testing Decisions

- Good tests act as different principals (anonymous, member, ex-member, other org, admin) against the Store and assert visibility and download outcomes.
- **Store seam (architecture §8 seam 4):** matrix of principals × operations (search, detail, download, update check, publish private, make public, takedown); removal of a member is effective on the next call; anonymous access to a private Harness is indistinguishable from a missing one; RLS tested directly through PostgREST with each JWT.
- **Desktop E2E (seam 5):** member signs in → Private section shows the Harness → install → org removes member (seeded) → update check marks it unavailable while launch still works.
- **Sync tests (P2-03 seam):** "install all" excludes revoked private Harnesses.
- Prior art: P0-07 RLS tests, P0-12 Takedown tests.

## Out of Scope

- Organisation billing or seats (billing stays on the owner's personal subscription in P2-02).
- SSO / SCIM provisioning.
- Private Model Gateway configuration per organisation (shared org Provider keys).
- Org-level analytics beyond opt-in install reporting.

## Further Notes

- Keeping visibility at the Harness level rather than per version avoids the most damaging failure mode: a single mis-tagged version leaking an internal tool.

## Blocked by

- P2-03 Accounts for all Users and cloud sync
