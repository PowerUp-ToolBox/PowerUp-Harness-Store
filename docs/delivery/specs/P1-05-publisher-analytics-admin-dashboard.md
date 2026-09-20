---
spec_id: P1-05
title: Publisher analytics and admin dashboard
phase: P1
blocked_by: [P0-07, P0-08]
requirements: [R-P1-05]
---

## Problem Statement

P0 records download events and counts but exposes them only as a single number on the detail page. Publishers cannot see whether a release is being adopted, on which platforms, or whether interest is growing, which weakens the case for investing in a Harness. Store administrators have no working surface at all: Reports and Takedowns are handled through raw database access, which does not scale past a handful of listings.

## Solution

Two read-mostly surfaces built on the data P0 already collects. **Publisher analytics** in the desktop app's Publish area: downloads over time, by version and by platform, for each of the Publisher's Harnesses. **Admin dashboard**, a small web app served from the Store project for accounts with the admin flag: platform totals, the Reports queue with one-click Takedown and resolution notes, Featured management, and a Publisher lookup. No client telemetry is involved; everything derives from Store-side events.

## User Stories

1. As a Publisher, I want a per-Harness chart of downloads per day for the last 7, 30 and 90 days, so that I can see trends.
2. As a Publisher, I want downloads split by version, so that I can see adoption of my latest release.
3. As a Publisher, I want downloads split by platform, so that I know where to focus testing.
4. As a Publisher, I want a summary across all my Harnesses on one page, so that I can see my portfolio at a glance.
5. As a Publisher, I want update downloads distinguished from first installs, so that I can tell growth from churn.
6. As a Publisher, I want to export the numbers as CSV, so that I can analyse them elsewhere.
7. As a Publisher, I want analytics to load quickly even with millions of events, so that the page is usable.
8. As a Publisher, I want to see my Harness's current Featured status and search impressions if available, so that I understand discovery (impressions: decide at implementation whether to record).
9. As a Store administrator, I want totals (Harnesses, Publishers, versions, downloads today/7d/30d) on one page, so that I can gauge platform health.
10. As a Store administrator, I want the open Reports queue sorted by age and severity, so that I handle the worst first.
11. As a Store administrator, I want to open a Report, see the Harness, version, Manifest, permissions and reporter details, and resolve it (dismiss, or Takedown version or Harness) with a note, so that moderation is fast and recorded.
12. As a Store administrator, I want to set and reorder Featured Harnesses, so that curation does not require SQL.
13. As a Store administrator, I want to look up a Publisher and see their Harnesses, versions, reports and (after P1-01) purchases, so that support requests can be answered.
14. As a Store administrator, I want an audit log of admin actions, so that moderation is accountable.
15. As a Store administrator, I want to restore a taken-down Harness if a Report was mistaken, so that errors are reversible.
16. As a platform developer, I want aggregates precomputed daily rather than scanning raw events on each request, so that dashboards stay cheap.

## Implementation Decisions

- **Aggregation**: a nightly (and on-demand) job materialises `download_daily` (version_id, day, platform, kind: install | update, count) from `download_events`. The `download` function gains a `kind` field supplied by the client (first install vs update), stored on the event. Charts read only from the daily table.
- **Publisher analytics** live in the desktop app (Publish → My Harnesses → Analytics tab); data via an RPC `publisher_downloads(harness_id, range)` protected by RLS to the owner. CSV export is client-side.
- **Admin dashboard**: a separate minimal web app inside the Store project (server-rendered or SPA, decide at implementation), signed in with the same GitHub OAuth, authorised by `profiles.is_admin`. Sections: Overview, Reports, Featured, Publishers, Audit log.
- **Tables**: `download_daily` as above; `admin_actions` (id, admin_id, action: takedown | restore | feature | unfeature | resolve_report | dismiss_report, target_type, target_id, note, created_at). `reports` gains `severity` (derived from reason: malware and bypasses_gateway high; others normal).
- Takedown/restore/feature actions go through Edge Functions (existing `admin/takedown` extended with `restore`, new `admin/feature`, `admin/resolve_report`) so the audit log is written server-side.
- Search impressions are **not** recorded in P1 unless trivially available; leave a note.
- No personal data beyond what P0 already stores; charts never expose reporter identities to Publishers.

## Testing Decisions

- Behaviour under test: aggregate correctness against known event fixtures, RLS (a Publisher cannot read another's analytics), admin authorisation, audit entries for every admin action.
- Primary seam: **Store seam** (architecture §8, item 4): aggregation job and RPCs under Supabase local with seeded events.
- Admin web app: a few HTTP-level tests for authorisation and one browser smoke test.
- Prior art: P0-07 RLS tests, P0-12 takedown tests.

## Out of Scope

- Client telemetry and any usage data from inside the app (P1-06).
- Revenue analytics beyond a link to purchases (P1-01 owns purchase summaries).
- Public stats pages.
- Alerting or emailed digests.

## Further Notes

The admin dashboard is the first web UI in the Store project; keep it deliberately plain and dependency-light so lower-cost models can maintain it.

## Blocked by

- P0-07 Store backend (Supabase schema, auth, storage, edge functions)
- P0-08 Publish flow
