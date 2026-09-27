# Manifest Specification (manifestVersion 1)

The **Manifest** is `manifest.json` at the root of a **Harness Package** (a zip archive). It is the only file the Store and the Runtime interpret. Everything else in the archive belongs to the Harness. The machine-readable schema lives in `packages/manifest` (`src/manifest-v1.schema.json`, JSON Schema draft 2020-12) and is the source of truth; this document explains it.

## 1. Package layout

```
<archive root>/
  manifest.json          required (≤ 1 MB)
  README.md              required (Store description, Markdown, ≤ 50 KB)
  assets/icon.png        required, 512×512 PNG
  assets/<screenshots>   optional, PNG/JPEG, ≤ 5 files, ≤ 2 MB each
  <anything else>        the Harness itself
```

Limits: archive ≤ 500 MB compressed; ≤ 20 000 files (directories do not count); no symlinks or other special files (devices, pipes, sockets); no absolute or `..` paths, `/` as the only separator and no `:` or control characters in names; no two paths that would be one file on macOS or Windows (stored twice, differing only in letter case, Unicode form or trailing dots and spaces, or a file where a folder is needed); every file stored or Deflate-compressed, unencrypted. The zip must read the same in every unpacker: each local header matches the central directory, and every byte belongs to an entry, the central directory or its end records. Violations are rejected at publish and at install.

Screenshots are the files directly in `assets/` other than `icon.png` (hidden files such as `.DS_Store` are ignored). A screenshot that is not a PNG or JPEG matching its `.png`, `.jpg` or `.jpeg` extension is rejected; a README over 50 KB, more than 5 screenshots or a screenshot over 2 MB only gives a warning. Sizes are binary: 1 KB = 1 024 bytes.

## 2. Fields

| Field | Type | Req | Rules |
|---|---|---|---|
| `manifestVersion` | `1` | yes | Literal `1`. |
| `id` | string | yes | `publisher/slug`. `publisher` must equal the signed-in Publisher's GitHub login (lower-cased): 1–39 lower-case letters, digits or hyphens, starting with a letter or digit. `slug`: `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`. Immutable for the life of the Harness. |
| `version` | string | yes | Strict semver (`MAJOR.MINOR.PATCH`, optional pre-release; no build metadata, no `v` prefix). Each published version must be greater than every previously published version of the same Harness. |
| `name` | string | yes | 2–40 chars (Unicode code points), display name. |
| `summary` | string | yes | ≤ 120 chars, one sentence, shown in lists. |
| `tags` | string[] | no | ≤ 5, no duplicates, each from the curated tag list (`coding`, `writing`, `research`, `data`, `productivity`, `devops`, `design`, `education`, `fun`, `other`). |
| `license` | string | yes | A single SPDX identifier (e.g. `MIT`, `Apache-2.0`; not an expression such as `MIT OR Apache-2.0`) or `proprietary`. |
| `homepage` | url | no | Absolute `http://` or `https://` URL, without a user name or password before the host (`https://user:pass@host/` is rejected). |
| `sourceRepo` | url | no | Absolute `http://` or `https://` URL, without a user name or password before the host. Shown as "Source" on the detail page. |
| `channel` | `"stable"` | no | Default `stable`. `beta` is reserved for P1; P0 rejects any other value. |
| `platforms` | string[] | yes | Non-empty subset of `darwin-arm64`, `darwin-x64`, `win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64`, without duplicates. |
| `runtime` | object | yes | See §3. |
| `entry` | string \| object | yes | See §3. |
| `ui` | object | yes | See §4. |
| `workspace` | `required` \| `optional` \| `none` | no | Default `none`. |
| `models` | object | yes | See §5. Must declare a `default` Slot. |
| `permissions` | object | yes | See §6. All three keys required (explicit is the point). |
| `changelog` | string | no | Markdown for this version, ≤ 5 KB (5 120 bytes of UTF-8). Shown in version history and update prompts. |

Unknown keys are rejected at every level of the Manifest (keeps the format honest). Use top-level `x-` prefixed keys for Publisher-private data: they are never validated and are ignored by the Store and the Runtime. An `x-` key inside a nested object is an unknown key like any other. A top-level `$schema` key is allowed on the same terms, so an editor can check the file against the Manifest JSON Schema: `"$schema": "https://raw.githubusercontent.com/PowerUp-ToolBox/PowerUp-Harness-Store/main/packages/manifest/src/manifest-v1.schema.json"`.

Reserved for later phases, and rejected in P0: `runtime.kind: "python"` (P0.5, §3), `channel: "beta"` (P1) and `distribution: { "encrypted": boolean }` (P1, paid Harnesses; until then `distribution` is an unknown key).

Some keys are ignored in some configurations (for example `ui.path` for a `terminal` UI, `runtime.node` for a `binary` runtime). Such a key gives a warning, not a problem, but its value must still be valid: remove the key rather than leave a malformed value in it.

## 3. `runtime` and `entry`

```jsonc
"runtime": { "kind": "node", "node": "22" }      // Runtime supplies Node 22 LTS
"runtime": { "kind": "binary" }                   // Publisher ships executables
// P0.5 adds: { "kind": "python", "python": "3.12" } with pyproject.toml / requirements.txt
```

- `kind: node`: `runtime.node` is required and must be `"22"` (the only Node the Runtime bundles in P0). `entry` is a path to a `.js`/`.mjs`/`.cjs` file relative to the archive root. The Runtime executes it with its bundled Node; `node_modules` must be included in the archive (no install step in P0). Same entry on all platforms, so `entry` is a string.
- `kind: binary`: `entry` is an object mapping each declared platform to a relative path of an executable inside the archive. Every declared platform must have an entry. An entry for a platform that is not in `platforms`, and a `runtime.node`, are ignored (a warning, not a problem).
- Every `entry` path is relative to the archive root and uses `/` separators: no leading `/`, no `.` or `..` segments (so `./dist/index.js` is written `dist/index.js`), no backslashes and no colons.

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

- `web`: the Harness must listen on `127.0.0.1:$HARNESS_PORT`. The Runtime opens a window once the port accepts connections. `path` default `/`, and must start with a single `/` (no `//`, backslashes or spaces); `readyTimeoutSeconds` an integer 5–120, default 30; `window` optional hints (`width`, `height`: positive integers, in pixels).
- `terminal`: the Runtime runs the process in a pty inside an embedded terminal window. stdin/stdout are the UI. `path`, `readyTimeoutSeconds` and `window` are ignored (a warning, not a problem).

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
- `requirements`: optional `tools`, `vision`, `json` (booleans) and `minContext` (integer ≥ 1, in tokens); absent means "no requirement".
- `recommended`: ≤ 5 model ids without duplicates, each `provider/model` where `provider` is a (lower-case) Provider id from [`gateway-protocol.md`](./gateway-protocol.md) §6 and `model` is the Provider's own model name. Order is preference order. The Runtime uses the first reachable one as the initial binding; Users can always override.

## 6. `permissions` (Declared Permissions)

```jsonc
"permissions": {
  "filesystem": { "scope": "workspace", "paths": [] },   // scope: none | workspace | home | paths
  "shell": true,
  "network": { "domains": ["api.github.com"] }             // or { "any": true } or { "domains": [] }
}
```

- `filesystem.scope`: `none` (only its Data Directory), `workspace` (the chosen Workspace), `home` (anywhere under the User's home), `paths` (explicit list of ≤ 20 paths of 1–1 024 characters each, `~` allowed; required and non-empty for this scope, ignored with a warning for the others).
- `shell`: whether the Harness executes commands.
- `network`: `domains` (list of ≤ 20 lower-case domain names such as `api.github.com`, optionally starting with `*.`; may be empty) or `any: true`. One of the two is required; `domains` next to `any: true` is ignored with a warning. Traffic to the Model Gateway is implied and not declared.
- Lists (`paths`, `domains`) never repeat a value.

Declared Permissions are **informational in P0**: they are displayed for consent at install and re-consent on change; the Runtime does not enforce them. Copy in the UI states this plainly.

## 7. Validation rules the Store and Runtime both apply

1. Schema validity (types, enums, patterns, limits). A `manifest.json` that is not JSON, or that holds more than 2 000 JSON values (objects, arrays, strings, numbers, booleans and nulls) outside its top-level `x-` and `$schema` keys, is rejected as a whole with a single `schema_invalid_json` problem. Every list and map in the Manifest has a maximum size, so the largest valid Manifest has fewer than 200 values; the limit only bounds the work spent on hostile input. A number beyond the range of a 64-bit float (such as `1e400`) cannot be stored or read back as JSON and is a `schema_type` problem.
2. Referenced files exist in the archive (`entry` targets, icon, README, screenshots).
3. `id.publisher` matches the authenticated Publisher (Store only).
4. `version` is greater than all published versions (Store only).
5. Archive limits (§1).
6. Every declared platform has an `entry` (binary kind).

Validation returns every problem at once, each as `{ path, code, message, messageKey, params }` with a stable `code` (the `PROBLEM_CODES` of `packages/manifest`), plus non-blocking warnings such as a key that has no effect. The Publish flow shows them verbatim, in the User's language where a translation exists.

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
