---
spec_id: P0-06
title: Harness SDK and reference Harnesses
phase: P0
blocked_by: [P0-05]
requirements: [R-0601, R-0602, R-0603]
---

# P0-06 Harness SDK and reference Harnesses

## Problem Statement

The launch contract and Gateway protocol are documented, but a Publisher starting from a blank folder still has to read three documents, get environment variables right and handle `slot_unbound` themselves. The Store also needs its first listings, and the test suites need realistic Harnesses. Without a tiny SDK and two complete examples, the first Publishers will make the same mistakes and the platform will launch with an empty Store.

## Solution

`@harness-store/sdk` for Node: a few functions that read the launch environment, hand back a configured OpenAI client pointed at the Gateway, expose Slot constants and a typed `SlotUnboundError`. Two reference Harnesses built with it, one web UI Kind and one terminal UI Kind, that are complete, publishable, localized and used by tests. Plus an authoring guide that walks a Publisher from empty folder to published Harness.

## User Stories

1. As a Harness author, I want to install one package and call one function to get an OpenAI client that already talks to the Gateway, so that my first model call is three lines.
2. As a Harness author, I want `getContext()` to give me Harness ID, version, Data Directory, Workspace, locale, platform and port as typed values, so that I never parse environment variables.
3. As a Harness author, I want a clear exception when I run outside Harness Store (missing environment), telling me to use "Install from folder", so that I am not confused by connection errors.
4. As a Harness author, I want a `SlotUnboundError` I can catch and render as "please bind a model in Harness Store", so that Users get an actionable message.
5. As a Harness author, I want helpers to list my Slots and their current bindings, so that I can show which model is active.
6. As a Harness author, I want a helper to build a `http.Server` bound to `HARNESS_PORT` on loopback, so that web Harnesses do not get the host/port wrong.
7. As a Harness author, I want the SDK to work with plain `fetch` too (a `gatewayFetch` that adds the token), so that I am not forced to use the OpenAI SDK.
8. As a Harness author, I want streaming examples in the guide, so that I copy a working pattern.
9. As a Harness author, I want a starter template I can copy (`hello-web`), so that I start from a passing baseline.
10. As a Harness author, I want the examples to show how to bundle `node_modules` into the package and keep it small, so that my package validates and installs fast.
11. As a Harness author, I want the examples to show reading `HARNESS_LOCALE` and shipping en/zh-CN strings, so that my Harness fits the app's language.
12. As a Harness author, I want the examples to show `workspace: optional` handling, so that I know how to behave with and without a folder.
13. As a Harness author, I want the guide to explain Slots and Recommended Models with a worked example, so that I declare requirements correctly.
14. As a Harness author, I want the guide to state plainly what the platform does not do (no sandbox, no credential access, no fallback), so that I design accordingly.
15. As a User, I want two working Harnesses in the Store on day one, so that I can try the platform immediately.
16. As a User, I want `hello-web` to show a simple chat page that uses my bound model and displays which model answered, so that I can verify my setup.
17. As a User, I want `hello-term` to run a short interactive loop in the terminal window, so that I see the terminal UI Kind works.
18. As a developer, I want the examples used as fixtures in Supervisor and E2E tests, so that they cannot rot.
19. As a developer, I want the SDK to have no dependency on Electron or the Gateway package, so that it is a small pure-Node library.
20. As a developer, I want the SDK versioned independently and published to npm later, so that Publishers can depend on it.

## Implementation Decisions

- **SDK API** (decision-encoding snippet):
  ```ts
  getContext(): HarnessContext            // throws NotInHarnessStoreError if HARNESS_GATEWAY_URL/TOKEN absent
  createOpenAIClient(opts?): OpenAI       // baseURL + apiKey from env; thin wrapper, returns the official client
  gatewayFetch(path, init?): Promise<Response>
  listSlots(): Promise<SlotInfo[]>        // GET /v1/models
  createServer(handler): http.Server      // listens on 127.0.0.1:HARNESS_PORT
  Slots = { default: 'default', fast: 'fast', smart: 'smart' } as const
  class SlotUnboundError extends Error { slot: string }
  isSlotUnbound(err): boolean             // recognises the Gateway error shape from OpenAI SDK errors
  ```
- **Examples**: `examples/hello-web`: Node + a minimal server serving a single HTML page; the page posts to its own backend which calls the Gateway (never the page directly, per protocol §1); streams tokens via SSE to the page; shows resolved model; en/zh-CN toggle by `HARNESS_LOCALE`. `examples/hello-term`: readline loop, streams answers, `/model` command lists Slots, exits on `/quit`. Both declare `default` Slot with `tools: false`, permissions all none/false/empty, `workspace: none` (hello-web) and `optional` (hello-term, prints the folder if given). Both bundle with a single-file bundler so `node_modules` is not shipped; Manifest `entry` points at the bundle.
- **Build**: each example has `build` (bundle + copy assets) and `pack` (zip with the layout from manifest-spec §1) scripts, and passes the P0-01 CLI in CI.
- **Guide**: `docs/guides/authoring-harnesses.md` (en) with a zh-CN twin; sections: what a Harness is, folder layout, Manifest walkthrough, launch contract table, SDK usage, streaming, Slots, permissions honesty, testing locally with "Install from folder", publishing.
- **Publishing**: the two examples are published under the project owner's Publisher account as the first Store listings and marked Featured (P0-09 owns Featured).

## Testing Decisions

- SDK unit tests with a stubbed environment and the fake Provider: `getContext` parsing, error on missing env, `isSlotUnbound` recognising the Gateway error shape, `createServer` binding to the given port.
- Examples exercised through the **Supervisor seam** (P0-05 uses them as fixtures) and the **Desktop E2E seam** (P0-13 installs `hello-web` and completes a chat).
- Good test: "hello-web served page → POST /chat → SSE stream ends with resolved model equal to the fake Provider id".

## Out of Scope

- Python SDK (P0.5-02); npm publication pipeline (later); a declarative "chat runtime" Harness (not planned for P0); Store listing mechanics (P0-08/P0-09).

## Further Notes

- The SDK is intentionally tiny; resist adding agent-loop helpers, which would recreate ADR-0001's rejected direction.

## Blocked by

- P0-05 Runtime: install from folder, launch and supervise Harnesses
