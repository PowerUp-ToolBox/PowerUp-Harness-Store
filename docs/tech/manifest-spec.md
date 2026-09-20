# Manifest Specification (manifestVersion 1)

The **Manifest** is `manifest.json` at the root of a **Harness Package** (a zip archive). It is the only file the Store and the Runtime interpret. Everything else in the archive belongs to the Harness. The machine-readable schema lives in `packages/manifest` and is the source of truth; this document explains it.

## 1. Package layout

```
<archive root>/
  manifest.json          required
  README.md              required (Store description, Markdown, ≤ 50 KB)
  assets/icon.png        required, 512×512 PNG
  assets/<screenshots>   optional, PNG/JPEG, ≤ 5 files, ≤ 2 MB each
  <anything else>        the Harness itself
```

Limits: archive ≤ 500 MB compressed; ≤ 20 000 files; no symlinks; no absolute or `..` paths. Violations are rejected at publish and at install.

## 2. Fields

| Field | Type | Req | Rules |
|---|---|---|---|
| `manifestVersion` | `1` | yes | Literal `1`. |
| `id` | string | yes | `publisher/slug`. `publisher` must equal the signed-in Publisher's GitHub login (lower-cased). `slug`: `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`. Immutable for the life of the Harness. |
| `version` | string | yes | Strict semver (`MAJOR.MINOR.PATCH`, optional pre-release). Each published version must be greater than every previously published version of the same Harness. |
| `name` | string | yes | 2–40 chars, display name. |
| `summary` | string | yes | ≤ 120 chars, one sentence, shown in lists. |
| `tags` | string[] | no | ≤ 5, each from the curated tag list (`coding`, `writing`, `research`, `data`, `productivity`, `devops`, `design`, `education`, `fun`, `other`). |
| `license` | string | yes | SPDX identifier or `proprietary`. |
| `homepage` | url | no | |
| `sourceRepo` | url | no | Shown as "Source" on the detail page. |
| `channel` | `"stable"` | no | Default `stable`. `beta` is reserved for P1; P0 rejects any other value. |
| `platforms` | string[] | yes | Non-empty subset of `darwin-arm64`, `darwin-x64`, `win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64`. |
| `runtime` | object | yes | See §3. |
| `entry` | string \| object | yes | See §3. |
| `ui` | object | yes | See §4. |
| `workspace` | `required` \| `optional` \| `none` | no | Default `none`. |
| `models` | object | yes | See §5. Must declare a `default` Slot. |
| `permissions` | object | yes | See §6. All three keys required (explicit is the point). |
| `changelog` | string | no | Markdown for this version, ≤ 5 KB. Shown in version history and update prompts. |

Unknown top-level keys are rejected (keeps the format honest; use `x-` prefixed keys for Publisher-private data, which are ignored).

## 3. `runtime` and `entry`

```jsonc
"runtime": { "kind": "node", "node": "22" }      // Runtime supplies Node 22 LTS
"runtime": { "kind": "binary" }                   // Publisher ships executables
// P0.5 adds: { "kind": "python", "python": "3.12" } with pyproject.toml / requirements.txt
```

- `kind: node`: `entry` is a path to a `.js`/`.mjs`/`.cjs` file relative to the archive root. The Runtime executes it with its bundled Node; `node_modules` must be included in the archive (no install step in P0). Same entry on all platforms, so `entry` is a string.
- `kind: binary`: `entry` is an object mapping each declared platform to a relative path of an executable inside the archive. Every declared platform must have an entry.

```jsonc
"entry": "dist/index.js"
"entry": { "darwin-arm64": "bin/mac-arm64/reviewer", "win32-x64": "bin/win-x64/reviewer.exe" }
```

Only the Runtime-provided environment (see architecture §4) is guaranteed. Harnesses must not assume a system Node, Python or shell is present.

## 4. `ui`

```jsonc
"ui": { "kind": "web", "path": "/", "readyTimeoutSeconds": 30, "window": { "width": 1100, "height": 760 } }
"ui": { "kind": "terminal" }
```

- `web`: the Harness must listen on `127.0.0.1:$HARNESS_PORT`. The Runtime opens a window once the port accepts connections. `path` default `/`; `readyTimeoutSeconds` 5–120, default 30; `window` optional hints.
- `terminal`: the Runtime runs the process in a pty inside an embedded terminal window. stdin/stdout are the UI.

## 5. `models`

```jsonc
"models": {
  "slots": {
    "default": {
      "description": "Main reasoning model used for reviews",
      "requirements": { "tools": true, "minContext": 64000, "vision": false, "json": false },
      "recommended": ["anthropic/claude-sonnet-4-5", "openai/gpt-5", "deepseek/deepseek-chat"]
    },
    "fast": {
      "description": "Cheap model for summarising diffs",
      "requirements": { "tools": false, "minContext": 16000 },
      "recommended": ["ollama/qwen3:8b", "openai/gpt-5-mini"]
    }
  }
}
```

- Slot names: `^[a-z][a-z0-9-]{0,31}$`; `default` is mandatory; ≤ 8 Slots.
- `requirements`: all optional booleans/ints; absent means "no requirement". `minContext` in tokens.
- `recommended`: ≤ 5 model ids, each `provider/model` where `provider` is a Provider id from [`gateway-protocol.md`](./gateway-protocol.md) §6 and `model` is the Provider's own model name. Order is preference order. The Runtime uses the first reachable one as the initial binding; Users can always override.

## 6. `permissions` (Declared Permissions)

```jsonc
"permissions": {
  "filesystem": { "scope": "workspace", "paths": [] },   // scope: none | workspace | home | paths
  "shell": true,
  "network": { "domains": ["api.github.com"] }             // or { "any": true } or { "domains": [] }
}
```

- `filesystem.scope`: `none` (only its Data Directory), `workspace` (the chosen Workspace), `home` (anywhere under the User's home), `paths` (explicit list, `~` allowed).
- `shell`: whether the Harness executes commands.
- `network`: `domains` (list, ≤ 20) or `any`. Traffic to the Model Gateway is implied and not declared.

Declared Permissions are **informational in P0**: they are displayed for consent at install and re-consent on change; the Runtime does not enforce them. Copy in the UI states this plainly.

## 7. Validation rules the Store and Runtime both apply

1. Schema validity (types, enums, patterns, limits).
2. Referenced files exist in the archive (`entry` targets, icon, README, screenshots).
3. `id.publisher` matches the authenticated Publisher (Store only).
4. `version` is greater than all published versions (Store only).
5. Archive limits (§1).
6. Every declared platform has an `entry` (binary kind).

Validation returns a list of `{ path, code, message }` problems; the Publish flow shows them verbatim, in the User's language where a translation exists.

## 8. Example (complete, minimal)

```json
{
  "manifestVersion": 1,
  "id": "alice/hello-web",
  "version": "0.1.0",
  "name": "Hello Web",
  "summary": "A minimal web-UI harness that says hello with your model.",
  "tags": ["fun"],
  "license": "MIT",
  "platforms": ["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"],
  "runtime": { "kind": "node", "node": "22" },
  "entry": "dist/index.js",
  "ui": { "kind": "web" },
  "workspace": "none",
  "models": { "slots": { "default": { "requirements": { "tools": false } } } },
  "permissions": { "filesystem": { "scope": "none" }, "shell": false, "network": { "domains": [] } }
}
```
