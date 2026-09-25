/**
 * Stable problem codes and the English message table.
 *
 * Codes are additive-only: once shipped, a code is never renamed or removed, because the
 * desktop app, the Store and Publishers' own tooling match on them. `schema_*` codes name the
 * JSON Schema keyword that failed (`schema_max_items` is `maxItems`, and so on).
 */
export const PROBLEM_CODES = Object.freeze({
  /** The input is not JSON (or, for a JavaScript value, cannot be serialised as JSON). */
  schema_invalid_json: 'schema_invalid_json',
  /** A value has the wrong JSON type. */
  schema_type: 'schema_type',
  /** A value (or an object key) is not one of the allowed values. Also used for `const`. */
  schema_enum: 'schema_enum',
  /** A string (or an object key) does not have the required format. */
  schema_pattern: 'schema_pattern',
  /** A required key is missing. */
  schema_required: 'schema_required',
  schema_min_length: 'schema_min_length',
  schema_max_length: 'schema_max_length',
  schema_min_items: 'schema_min_items',
  schema_max_items: 'schema_max_items',
  schema_max_properties: 'schema_max_properties',
  schema_minimum: 'schema_minimum',
  schema_maximum: 'schema_maximum',
  /** A list that must not repeat itself lists the same value twice. */
  schema_unique_items: 'schema_unique_items',
  /** A key the Manifest format does not define. Top-level `x-` keys are exempt. */
  unknown_key: 'unknown_key',
  /** `models.slots` has no `default` Model Slot. */
  slot_default_missing: 'slot_default_missing',
  /** A `binary` Harness declares a platform that `entry` has no path for. */
  entry_missing_for_platform: 'entry_missing_for_platform',
  /** The Harness ID's publisher segment is not the Publisher's GitHub login. */
  publisher_mismatch: 'publisher_mismatch',
  /** `version` is not strict semver (pre-release allowed, build metadata not). */
  version_invalid: 'version_invalid',
  /** `version` is not greater than every already published Harness Version. */
  version_not_greater: 'version_not_greater',
  /** Warning only: a key has no effect in this Manifest (e.g. `ui.path` for a terminal UI Kind). */
  ignored_key: 'ignored_key',
});

export type ProblemCode = (typeof PROBLEM_CODES)[keyof typeof PROBLEM_CODES];

/**
 * English message templates, keyed by `messageKey`. A key is either a problem code or
 * `<code>.<variant>` for a more specific wording of the same problem. `{name}` placeholders
 * are filled from the problem's `params`. Translations (e.g. zh-CN in the desktop app) map the
 * same keys and interpolate the same params with {@link interpolate}.
 */
export const MESSAGES_EN = Object.freeze({
  schema_invalid_json: 'The Manifest is not valid JSON: {detail}',
  'schema_invalid_json.not_serializable': 'The Manifest cannot be serialised as JSON: {detail}',
  schema_type: 'Expected {expected}; found {actual}.',
  'schema_type.entry_for_runtime_kind':
    'entry must be {expected} when runtime.kind is "{runtimeKind}"; found {actual}.',
  schema_enum: 'Must be one of {allowed}; found {actual}.',
  'schema_enum.const': 'Must be {allowed}; found {actual}.',
  'schema_enum.property_name': '"{key}" is not allowed here. Allowed keys: {allowed}.',
  schema_pattern: 'Does not match the pattern {pattern}; found {actual}.',
  'schema_pattern.harnessId':
    'Must be a Harness ID "publisher/slug": publisher is the Publisher\'s GitHub login in lower case; slug is 3 to 40 lower-case letters, digits or hyphens, starting and ending with a letter or digit. Found {actual}.',
  'schema_pattern.license':
    'Must be an SPDX license identifier such as "MIT" or "Apache-2.0", or "proprietary". Found {actual}.',
  'schema_pattern.httpUrl': 'Must be an absolute http:// or https:// URL. Found {actual}.',
  'schema_pattern.relativePath':
    'Must be a path relative to the root of the Harness Package, with "/" separators and no leading "/", no "." or ".." segments, backslashes or colons. Found {actual}.',
  'schema_pattern.nodeEntryPath':
    'Must be the path of a .js, .mjs or .cjs file relative to the root of the Harness Package, with "/" separators and no leading "/", no "." or ".." segments, backslashes or colons. Found {actual}.',
  'schema_pattern.uiPath':
    'Must be a path on the Harness\'s local server that starts with a single "/", such as "/" or "/app", without spaces or backslashes. Found {actual}.',
  'schema_pattern.slotName':
    'Model Slot name "{key}" must start with a lower-case letter and contain only lower-case letters, digits and hyphens (at most 32 characters).',
  'schema_pattern.modelId':
    'Recommended Models must be "provider/model" ids such as "anthropic/claude-sonnet-4-5", with a lower-case Provider id. Found {actual}.',
  'schema_pattern.domain':
    'Must be a lower-case domain name such as "api.github.com", optionally starting with "*.". Found {actual}.',
  schema_required: 'Required key "{key}" is missing.',
  'schema_required.network_access':
    'Declare network access with "domains" (a list, which may be empty) or with "any": true.',
  schema_min_length: 'Must be at least {limit} characters long; found {actual}.',
  schema_max_length: 'Must be at most {limit} characters long; found {actual}.',
  'schema_max_length.bytes': 'Must be at most {limit} bytes of UTF-8 text; found {actual}.',
  schema_min_items: 'Must list at least {limit} item(s); found {actual}.',
  schema_max_items: 'Must list at most {limit} items; found {actual}.',
  schema_max_properties: 'Must have at most {limit} entries; found {actual}.',
  schema_minimum: 'Must be at least {limit}; found {actual}.',
  schema_maximum: 'Must be at most {limit}; found {actual}.',
  schema_unique_items: '{value} is listed more than once (first at index {firstIndex}).',
  unknown_key:
    'Unknown key "{key}". Remove it, or rename it with an "x-" prefix to keep Publisher-private data in the Manifest.',
  'unknown_key.nested': 'Unknown key "{key}".',
  slot_default_missing: 'The Manifest must declare a Model Slot named "default".',
  entry_missing_for_platform:
    'entry has no path for platform "{platform}". A binary Harness needs an entry for every platform in platforms.',
  publisher_mismatch:
    'The Harness ID belongs to publisher "{idPublisher}", but the Publisher is "{publisher}". The publisher segment must be your GitHub login in lower case.',
  version_invalid:
    '"{version}" is not a strict semantic version. Use MAJOR.MINOR.PATCH with an optional pre-release (for example 1.2.0 or 1.2.0-beta.1) and no build metadata.',
  version_not_greater:
    'Version {version} must be greater than every published version of this Harness; the latest is {latest}.',
  'ignored_key.entry_platform':
    'entry has a path for platform "{platform}", which is not listed in platforms; it is ignored.',
  'ignored_key.ui_web_only': '"{key}" applies to UI Kind "web" only; it is ignored for "{kind}".',
  'ignored_key.runtime_node':
    '"node" applies to runtime kind "node" only; it is ignored for "{kind}".',
  'ignored_key.filesystem_paths':
    '"paths" applies to filesystem scope "paths" only; it is ignored for scope "{scope}".',
  'ignored_key.network_domains': '"domains" is ignored because "any" is true.',
});

export type MessageKey = keyof typeof MESSAGES_EN;

export type ProblemParams = Record<string, string | number>;

/**
 * Fills `{name}` placeholders in a message template from `params`. Placeholders without a
 * matching param are left as they are.
 */
export function interpolate(template: string, params: Readonly<ProblemParams> = {}): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}

/** The code a message key belongs to: the key itself, or the part before `.<variant>`. */
export function codeOfMessageKey(messageKey: MessageKey): ProblemCode {
  return messageKey.split('.', 1)[0] as ProblemCode;
}
