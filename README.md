# Harness Store

A desktop platform (PowerUp) where you install and launch AI agent **Harnesses** as standalone local apps, and where publishers share them. Every Harness reaches language models only through the local **Model Gateway**, so any Harness runs on any model you have access to: Anthropic, OpenAI, Google, OpenRouter, DeepSeek, Qwen, Kimi, GLM, MiniMax, Doubao, Ollama, LM Studio or any OpenAI-compatible endpoint.

Status: **design complete, implementation not started.** Everything below is documentation.

## Start here
- [`CONTEXT.md`](./CONTEXT.md) — the glossary. Use these words and no others.
- [`docs/adr/`](./docs/adr) — decisions and why. ADR-0004 explains the whole shape.
- [`docs/product/prd.md`](./docs/product/prd.md) — PRD (with 中文摘要), [`requirements.md`](./docs/product/requirements.md), [`roadmap.md`](./docs/product/roadmap.md)
- [`docs/tech/`](./docs/tech) — [architecture](./docs/tech/architecture.md), [Manifest spec](./docs/tech/manifest-spec.md), [Gateway protocol](./docs/tech/gateway-protocol.md), [data model](./docs/tech/data-model.md), [API](./docs/tech/api.md), [security](./docs/tech/security.md)
- [`docs/ux/`](./docs/ux) — [principles](./docs/ux/design-principles.md), [flows](./docs/ux/flows.md), [screens](./docs/ux/screens.md)
- [`docs/delivery/specs/`](./docs/delivery/specs) — one spec per feature, mirrored to GitHub issues labelled `spec` + phase (`P0`, `P0.5`, `P1`, `P2`), ordered by ID and linked by "blocked by".

## Phases
- **P0** — launcher + Model Gateway + Store, end to end, for technical users with their own model accounts.
- **P0.5** — Python Harnesses, Python SDK, GitHub import.
- **P1** — paid Harnesses (one-time purchase), beta channel, ratings, analytics, telemetry (opt-in), scanning, background Harnesses.
- **P2** — platform subscription: cloud Gateway with credits, sync, private Harnesses.

## Working on it
Pick the lowest-numbered open issue in the current milestone whose "Blocked by" issues are all closed. Read the spec, the linked `docs/tech` pages and `CONTEXT.md` before writing code.
