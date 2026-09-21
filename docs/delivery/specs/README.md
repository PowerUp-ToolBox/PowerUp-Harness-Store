# Specs

One file per spec, mirrored to a GitHub issue. File name `<SPEC-ID>-<slug>.md`. Each file starts with YAML front matter:

```yaml
---
spec_id: P0-02
title: Model Gateway core
phase: P0            # P0 | P0.5 | P1 | P2
blocked_by: [P0-01]  # spec ids; [] if none
requirements: [R-0201, R-0202]
---
```

Body sections, in order: Problem Statement, Solution, User Stories (long numbered list "As a <actor>, I want <feature>, so that <benefit>"), Implementation Decisions, Testing Decisions, Out of Scope, Further Notes, Blocked by (bullet list of spec ids with titles, or "None (can start immediately)").

Rules: use `CONTEXT.md` vocabulary; respect ADRs; cite requirement IDs from `docs/product/requirements.md`; no file paths or code, except a schema/type/state-machine snippet that encodes a decision more precisely than prose; reference `docs/tech/*.md` and `docs/ux/*.md` by name for normative detail rather than repeating it.

## Dependency graph

| Spec | Blocked by |
|---|---|
| P0-01 | — |
| P0-02 | P0-01 |
| P0-04 | P0-01 |
| P0-03 | P0-02, P0-04 |
| P0-05 | P0-02, P0-03, P0-04 |
| P0-06 | P0-05 |
| P0-07 | P0-01 |
| P0-08 | P0-04, P0-07 |
| P0-09 | P0-04, P0-07 |
| P0-10 | P0-05, P0-09 |
| P0-11 | P0-02, P0-04 |
| P0-12 | P0-07, P0-09 |
| P0-13 | P0-06, P0-08, P0-10, P0-11, P0-12 |
| P0.5-01 | P0-05 |
| P0.5-02 | P0.5-01, P0-06 |
| P0.5-03 | P0-08 |
| P1-01 | P0-13 |
| P1-02 | P0-08, P0-10 |
| P1-03 | P0-02 |
| P1-04 | P0-09, P0-10 |
| P1-05 | P0-07, P0-08 |
| P1-06 | P0-04 |
| P1-07 | P0-07 |
| P1-08 | P0-05 |
| P1-09 | P0.5-03 |
| P2-01 | P0-02, P1-01 |
| P2-02 | P2-01 |
| P2-03 | P0-07, P0-10 |
| P2-04 | P2-03 |

## Tickets

Each spec is broken into tracer-bullet tickets, published as native GitHub sub-issues of the spec issue (issues #30–#112), labelled `ticket` + phase + `ready-for-agent`, with native "blocked by" links between tickets. A ticket's body is self-contained: What to build, Key decisions (inline, not just links — the target implementer is a cheaper model that won't reliably follow doc links), Acceptance criteria, How to verify, Constraints. Open a spec issue on GitHub and its sub-issues list is the ticket breakdown; the dependency graph is native GitHub issue dependencies, not re-documented here.

Pick the lowest-numbered open ticket whose blockers are all closed.
