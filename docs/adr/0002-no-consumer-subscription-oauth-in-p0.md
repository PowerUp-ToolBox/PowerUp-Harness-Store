---
status: accepted
date: 2026-09-19
---

# P0 connects to models via API keys and local endpoints only; consumer subscription OAuth is deferred

The product vision includes reusing a User's consumer subscriptions (Claude Pro/Max, ChatGPT Plus). Anthropic and OpenAI terms of service forbid third-party harnesses from consuming those subscriptions and accounts have been banned for it. We decided P0 supports only API-key Providers and local Providers. Consumer-subscription access stays on the roadmap as a research item gated on an officially sanctioned channel from each vendor.

## Consequences

- P0 targets technical Users who already hold funded API accounts.
- The Connection model must be designed so a future OAuth-based Connection type can be added without changing how Harnesses declare Model Requirements.
