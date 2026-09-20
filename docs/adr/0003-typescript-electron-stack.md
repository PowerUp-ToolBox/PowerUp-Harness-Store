---
status: accepted
date: 2026-09-19
---

# Single-language TypeScript stack with Electron for the desktop app

The codebase will be built largely by lower-cost AI models, and the app must ship on macOS, Windows and Linux with one UI codebase. We decided on TypeScript everywhere: Electron + React for the desktop app, Node for the embedded Runtime and the Store API, Postgres for Store data.

## Considered Options

- Tauri: smaller binaries, but introduces Rust and a second language boundary that raises error rates for AI-generated code.
- Native per-platform apps: rejected on maintenance cost.
