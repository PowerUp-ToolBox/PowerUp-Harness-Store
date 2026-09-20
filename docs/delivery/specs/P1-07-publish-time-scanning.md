---
spec_id: P1-07
title: Publish-time automated scanning
phase: P1
blocked_by: [P0-07]
requirements: [R-P1-07]
---

## Problem Statement

In P0 the rule "a Harness must access models only through the Model Gateway" is enforced purely reactively: a User notices, files a Report, an admin performs a Takedown. By P1 the Store will have more Harnesses than the admin can inspect by hand, and paid Harnesses (P1-01) raise the stakes. A Harness that talks to a vendor directly breaks the "any model" promise, escapes Usage Records, and (in P2) escapes credits. The admin needs an early, cheap signal at publish time without adding friction for Users or honest Publishers.

## Solution

When a Harness Package is published, the Store runs a set of static checks over the archive. Findings are attached to the Harness Version as **scan findings** with a severity. In this first version scanning is **warning-only**: publishing still succeeds and the listing goes live, the Publisher sees the findings in the publish result and on their version page, and findings above a threshold put the version in the admin's review queue. No automatic Takedown. Users are not shown scan results in P1 (decide later whether a "verified" badge is worth it).

## User Stories

1. As an admin, I want every published version scanned for direct vendor API usage, so that likely Gateway bypasses surface without a User Report.
2. As an admin, I want a review queue of versions with findings above a threshold, so that I spend review time where it matters.
3. As an admin, I want each finding to show the file, line (where applicable), the matched pattern and a severity, so that I can judge it in seconds.
4. As an admin, I want to mark a finding as a false positive with a note, so that the same finding on the next version of the same Harness does not re-enter the queue.
5. As an admin, I want to trigger a Takedown from the review queue with the findings pre-filled in the note, so that acting on a real bypass is one step.
6. As an admin, I want to re-run scanning on all published versions when the pattern set changes, so that new rules apply retroactively.
7. As a Publisher, I want to see scan findings immediately in the publish result, so that I can fix accidental issues (for example a leftover `.env` file) in the next version.
8. As a Publisher, I want scanning never to block or delay my publish in this version, so that a false positive cannot stop a release.
9. As a Publisher, I want a clear explanation of why each pattern matters and how to comply, so that the rule feels fair, not arbitrary.
10. As a Publisher, I want to run the same scan locally before publishing, so that I get no surprises.
11. As a Publisher, I want my previously dismissed false positives to stay dismissed for future versions, so that I am not nagged about the same line.
12. As a User, I want scanning to be invisible to me (no extra steps, no slower installs), so that the Store stays simple.
13. As the maintainer, I want the pattern set to be data (a versioned rule list), so that adding a rule is a config change with tests, not a code change.
14. As the maintainer, I want scanning to be bounded in time and memory per package, so that a large package cannot stall the publish function.
15. As the maintainer, I want scan coverage to include text files inside `node_modules`, so that a bypass hidden in a dependency is still visible, but with lower severity than first-party code.

## Implementation Decisions

- **Where it runs:** inside the `publish` Edge Function after validation succeeds, or as an asynchronous job it enqueues when the package exceeds a size threshold. Decide at implementation which threshold; the publish response must return within the current time limit either way, with findings marked `pending` if asynchronous.
- **Rule set (initial), stored as versioned data:**
  - Credential environment variable names: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` used other than as the injected Gateway alias, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`, `MOONSHOT_API_KEY`, `ZHIPUAI_API_KEY`, `MINIMAX_API_KEY`, `ARK_API_KEY`, `GROQ_API_KEY`.
  - Vendor API hostnames: `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `openrouter.ai/api`, `api.deepseek.com`, `dashscope.aliyuncs.com`, `api.moonshot.cn`, `open.bigmodel.cn`, `api.minimax.chat`, `ark.cn-beijing.volces.com`, `api.groq.com`.
  - Hard-coded secret shapes: `sk-ant-`, `sk-` followed by 20+ base62 chars, `AIza` followed by 35 chars.
  - Presence of `.env`, `.env.*` or private key files in the archive.
  - Obfuscation heuristics (large base64 blobs in scripts, `eval` of decoded strings) at low severity.
- **Severity:** `high` (hard-coded secret, vendor host in first-party code), `medium` (credential env name in first-party code, vendor host in dependencies), `low` (heuristics, dotfiles). Threshold for the review queue: any `high`, or two or more `medium`.
- **Exemptions:** the Gateway alias variables `OPENAI_BASE_URL` / `OPENAI_API_KEY` read from the environment are expected and do not match; matches inside comments and Markdown files are `low`.
- **Persistence:** `scan_findings` table (version id, rule id, severity, path, line, snippet ≤ 200 chars, status `open` / `dismissed`, dismissed_by, note). Dismissals keyed by (Harness, rule id, path) carry forward to later versions when the snippet is identical.
- **Warning-only:** publish outcome never changes based on findings in this spec. Automatic blocking is a future decision requiring an ADR.
- **Local parity:** the same rule engine is exported from the shared manifest package so the desktop Publish flow and the CLI can run it before upload and show identical findings.
- Admin surfaces (queue, dismiss, re-run) live in the admin dashboard from P1-05; if P1-05 lands later, a minimal admin-only Edge Function plus a table view is acceptable.

## Testing Decisions

- Good tests assert findings produced for fixture packages, not the internals of the matcher.
- **Manifest/scan seam (architecture §8 seam 2):** the rule engine is a pure function over an archive listing plus file contents; fixtures include a clean Harness, one with a hard-coded key, one with a vendor host in a dependency, one with the Gateway alias pattern (must produce no finding), and one with dotfiles.
- **Store seam (seam 4):** publishing each fixture through the `publish` function yields the expected findings rows and queue membership; dismissing a finding and republishing an identical snippet keeps it dismissed.
- **Performance test:** a 400 MB fixture package completes scanning within the configured bound or is deferred to the asynchronous path.
- Prior art: `packages/manifest` fixture-driven validator tests.

## Out of Scope

- Blocking or auto-Takedown based on findings.
- Runtime detection of bypasses (network interception on the User's machine).
- Malware or vulnerability scanning of dependencies; license compliance checks.
- Any User-visible "verified" badge.
- Admin dashboard UI itself: P1-05.

## Further Notes

- The reactive path (Report → Takedown, P0-12) remains the enforcement mechanism; scanning only feeds it.
- The product owner explicitly chose not to add friction for Users; scanning is Publisher- and admin-facing only.

## Blocked by

- P0-07 Store backend (Supabase schema, auth, storage, edge functions)
