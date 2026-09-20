---
spec_id: P1-02
title: Beta Channel
phase: P1
blocked_by: [P0-08, P0-10]
requirements: [R-P1-02]
---

## Problem Statement

Every published Harness Version is immediately offered to every installer. A Publisher who wants feedback on a risky change must either publish it to everyone or not at all, and Users who want early access have no way to volunteer for it. The Manifest already reserves the `channel` field for exactly this (`manifest-spec.md` §2), but P0 accepts only `stable`.

## Solution

Publishers can publish a Harness Version to the `beta` Channel. By default Users see and receive only `stable` versions. On a Harness's detail page or Library card, a User can opt into beta for that Harness; from then on the update check considers beta versions too, clearly labelled. Promoting a beta to stable is a new publish of the same package to `stable`, keeping versions immutable.

## User Stories

1. As a Publisher, I want to choose `beta` or `stable` when publishing a version, so that I can test changes with volunteers first.
2. As a Publisher, I want the Manifest `channel` field to be respected and overridable in the publish form, so that both CLI-minded and UI-minded workflows work.
3. As a Publisher, I want to promote a beta version to stable without re-uploading, so that promotion is quick and the bytes are identical.
4. As a Publisher, I want to see how many installers are on beta for my Harness, so that I know whether feedback is representative.
5. As a Publisher, I want beta versions to require a version greater than the latest stable (pre-release identifiers allowed), so that ordering stays unambiguous.
6. As a Publisher, I want to unpublish a beta without affecting stable, so that a bad beta can be pulled quickly.
7. As a User, I want to never receive a beta unless I opted in, so that the default experience stays reliable.
8. As a User, I want an "Include beta versions" toggle per Harness, so that I can be adventurous for one tool and conservative for the rest.
9. As a User, I want beta versions clearly labelled in the update prompt and in Library, so that I always know what I am running.
10. As a User, I want the same permission re-consent rules to apply to beta updates, so that opting into beta does not weaken my safety.
11. As a User, I want to roll back from a beta to the latest stable with one click, so that opting in is reversible.
12. As a User, I want the detail page version history to show which Channel each version was on, so that the history is honest.
13. As a Store administrator, I want beta versions excluded from search ranking and download counts shown publicly, so that betas do not distort discovery.
14. As a platform developer, I want the Channel to be a property of a Harness Version, not of the Harness, so that the data model stays simple.

## Implementation Decisions

- `channel` becomes a column on `harness_versions` with values `stable | beta`; existing rows are `stable`. `harnesses.latest_version` continues to mean latest **stable**; a new `latest_beta_version` column is maintained alongside.
- Manifest validation accepts `channel: "beta"`; the publish form pre-selects the Manifest's value and allows override, with the chosen value stored on the version (the stored Manifest is left as uploaded; the version row's `channel` is authoritative).
- Promotion: a new publish function action `promote` creates a new `harness_versions` row for the same package path and sha256 with `channel = stable` and a version the Publisher supplies (must be greater than latest stable). Immutability preserved; no bytes re-uploaded.
- Local `installs` gains `beta_opt_in` (boolean, default false) and the update check RPC accepts a per-Harness flag to include beta.
- Rollback: "Return to stable" installs the latest stable version through the ordinary update path (including re-consent if permissions differ) and clears the opt-in.
- Search RPC ignores beta-only Harnesses (no stable version) unless the query explicitly filters for them; public download counts count stable only (beta counts are visible to the Publisher).
- Update prompt and Library badge include the word "Beta" and use the warning colour defined in `design-principles.md`.

## Testing Decisions

- Behaviour under test: which version the update check offers under each opt-in state, promotion producing an identical-sha stable version, rollback, labelling.
- Primary seam: **Store seam** (architecture §8, item 4) for publish/promote/update-check RPC behaviour; **Desktop E2E** for one journey (opt in → beta update offered → rollback).
- Prior art: P0-08 publish tests and P0-10 update-check tests.

## Out of Scope

- More than two Channels, staged rollouts by percentage, or per-User allowlists.
- Beta feedback collection (use P1-04 reviews or external links).
- Beta for paid Harnesses having different prices; a purchase covers all Channels.

## Further Notes

Keep the wording "Beta" consistent in both languages (中文: "测试版"); the Channel id in data stays `beta`.

## Blocked by

- P0-08 Publish flow
- P0-10 Install, update and uninstall from the Store (Library)
