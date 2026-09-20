---
status: superseded by ADR-0004
date: 2026-09-19
---

# A Harness is a declarative package run by our Runtime, not a third-party executable

"Harness" in the wider ecosystem can mean a full agent program (Claude Code, OpenCode, Codex CLI). We decided that a Harness in the Store is a **declarative package** (prompts, skills, tool references, model requirements, permissions) executed by the Harness Store Runtime, and that the Store does not distribute third-party agent binaries.

## Considered Options

1. Distribute and wrap existing agent executables. Rejected: the platform would have to hand model credentials to arbitrary third-party code, and "connect to any model" would depend on each tool's own provider support.
2. Declarative packages only (chosen). The Runtime owns the agent loop and all model calls, so credentials never leave the Runtime and any Provider works for any Harness.
3. Both. Deferred: the Manifest reserves room for an "external runtime" kind so option 1 can be added later without breaking published Harnesses.

## Consequences

- Publishers cannot ship custom code in P0; extensibility comes from skills, MCP servers and Manifest fields.
- Paid Harnesses (P1) are plain text and therefore trivially copyable; licensing needs its own design.
