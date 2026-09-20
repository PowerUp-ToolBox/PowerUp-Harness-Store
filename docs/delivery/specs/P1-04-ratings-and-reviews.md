---
spec_id: P1-04
title: Ratings and reviews
phase: P1
blocked_by: [P0-09, P0-10]
requirements: [R-P1-04]
---

## Problem Statement

Users choose Harnesses by name, summary, download count and Featured placement alone. There is no signal of quality from people who actually ran a Harness, and Publishers get no structured feedback. Ratings were deliberately deferred from P0 because unverified ratings are easy to game; the mechanism must tie a review to a real install.

## Solution

Signed-in Users who have installed a Harness (verified through the desktop app) can leave one star rating (1–5) and an optional short review per Harness, edit it later, and see it attached to the version they were running. The detail page shows the average, the distribution and recent reviews; Publishers can post one reply per review; Users can report abusive reviews. Ratings feed a modest ranking boost in search.

## User Stories

1. As a User, I want to rate a Harness from 1 to 5 stars from the Library after I have launched it at least once, so that my rating reflects real use.
2. As a User, I want to write a short review with my rating, so that I can explain my score.
3. As a User, I want to edit or delete my review, so that I can update it after an update fixes my complaint.
4. As a User, I want my review to show which version I was running, so that readers can judge relevance.
5. As a User, I want to see the average rating and the star distribution on the detail page, so that I can judge consensus at a glance.
6. As a User, I want to sort reviews by most recent or most helpful, so that I can find the relevant ones.
7. As a User, I want to mark a review as helpful, so that good reviews rise.
8. As a User, I want to report a review that is abusive or spam, so that the community stays useful.
9. As a User, I want to see ratings in search results and lists, so that I can compare before opening details.
10. As a User, I want to be prompted (once, dismissible) to rate a Harness after several launches, so that I remember to contribute.
11. As a Publisher, I want to reply once to each review, so that I can respond to feedback publicly.
12. As a Publisher, I want a notification when a new review arrives, so that I can respond promptly.
13. As a Publisher, I want to see ratings broken down by version, so that I can tell whether a release helped.
14. As a Publisher, I want to be unable to rate my own Harness, so that scores stay credible.
15. As a Store administrator, I want to hide a review after a report, so that abuse can be handled.
16. As a Store administrator, I want a rate limit and a minimum install age before reviewing, so that fresh accounts cannot flood ratings.
17. As a platform developer, I want the "verified installer" proof to be issued by the Store when the install was downloaded by a signed-in User, so that the check does not rely on client honesty alone.

## Implementation Decisions

- Requires accounts for reviewers: sign-in with GitHub (already used for Publishers) extended to any User who wants to review. Anonymous installing remains unchanged.
- **Verification**: when a signed-in User downloads a Harness, the `download` function records an `install_claims` row (user_id, harness_id, version, created_at). A review is accepted only if a claim exists and is at least 24 hours old (decide the exact age at implementation), and the local app reports at least one launch (client-asserted, informational).
- **Tables** (reserved name `reviews` in `data-model.md`): `reviews` (id, harness_id, user_id, version, rating 1–5, body ≤ 2000 chars null, helpful_count, status: visible | hidden, created_at, updated_at; unique user+harness), `review_replies` (review_id unique, publisher_id, body, created_at), `review_votes` (review_id, user_id, unique), `install_claims`. `harnesses` gains denormalised `rating_avg`, `rating_count`, `rating_histogram` (int[5]) maintained by trigger.
- Publisher cannot review their own Harness (checked server-side).
- Search RPC ranking adds a bounded term for Bayesian-adjusted average (prior weight decided at implementation) so a few 5-star ratings do not outrank established Harnesses.
- Reports on reviews reuse the `reports` table with a new `review_id` nullable column and reason set.
- In-app prompt to rate after the 5th launch, once per Harness, dismissible forever.
- Reviews are shown in the reviewer's language with no translation in P1; a language tag is stored for later filtering.

## Testing Decisions

- Behaviour under test: who may review (claims, age, ownership), one-per-User, aggregate correctness, hide on report, ranking influence bounded.
- Primary seam: **Store seam** (architecture §8, item 4): RPC/function tests for review creation rules and aggregates under Supabase local.
- **Desktop E2E**: launch fixture Harness five times → prompt appears → submit rating → detail page reflects it.
- Prior art: P0-12 report tests; P0-09 search tests.

## Out of Scope

- Review moderation tooling beyond hide/unhide (an admin dashboard arrives with P1-05).
- Translated reviews, images in reviews, threaded discussion.
- Purchase-verified badges (could be added after P1-01; note only).

## Further Notes

Verified-installer is a soft guarantee; a determined actor can still create accounts and download. The 24-hour claim age and rate limits keep the cost above the benefit for casual manipulation, which is the P1 bar.

## Blocked by

- P0-09 Store browsing and discovery
- P0-10 Install, update and uninstall from the Store (Library)
