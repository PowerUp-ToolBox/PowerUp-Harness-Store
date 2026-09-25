/**
 * Stable problem codes and the English message table.
 *
 * Codes are additive-only: once shipped, a code is never renamed or removed, because the
 * desktop app, the Store and Publishers' own tooling match on them. `schema_*` codes name the
 * JSON Schema keyword that failed (`schema_max_items` is `maxItems`, and so on).
 */
export const PROBLEM_CODES = Object.freeze({
  /**
   * The input is not JSON (or, for a JavaScript value, cannot be serialised as JSON), or it is too
   * large to check. Reported alone: no other rule runs.
   */
  schema_invalid_json: 'schema_invalid_json',
  /**
   * A value has the wrong JSON type, or is a number beyond the range of a double (`1e400` in JSON
   * text), which has no JSON form.
   */
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

  // Whole Harness Package rules (validatePackage). Their `path` is a path inside the Harness
  // Package (`assets/icon.png`), or `$` for the Harness Package as a whole.

  /** A required file (`manifest.json`, `README.md`, `assets/icon.png`) is not in the package. */
  file_missing: 'file_missing',
  /**
   * A file has the wrong format: an icon that is not a PNG, a screenshot that is not PNG/JPEG. Also
   * an entry that is neither a file, a folder nor a link (a device, a named pipe, a socket).
   */
  file_type: 'file_type',
  /** `assets/icon.png` is a PNG, but not 512×512 pixels. */
  icon_dimensions: 'icon_dimensions',
  /** An entry is a symbolic link. */
  archive_symlink: 'archive_symlink',
  /**
   * An entry name (or another name an unpacker could use for it) has a `..` segment or is
   * absolute, so it would unpack outside the package.
   */
  archive_path_traversal: 'archive_path_traversal',
  /** The archive is larger than 500 MB (compressed). */
  archive_too_large: 'archive_too_large',
  /** The package holds more than 20 000 files. */
  archive_too_many_files: 'archive_too_many_files',
  /**
   * The archive cannot be read or unpacked safely: not a zip, corrupt, ambiguous (a local header
   * that disagrees with the central directory, bytes that belong to no entry), an entry that is
   * encrypted or uses a compression method other than stored or Deflate, paths that would unpack
   * to the same place (stored twice, differing only in letter case, a file where a folder is
   * needed), or names that Windows reads differently (with a `\` or a `:`).
   */
  archive_invalid: 'archive_invalid',
  /** Warning only: `README.md` is over 50 KB, or a screenshot over 2 MB. */
  file_too_large: 'file_too_large',
  /** Warning only: `assets/` holds more than 5 screenshots. */
  screenshots_too_many: 'screenshots_too_many',
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
  'schema_invalid_json.too_large':
    'The Manifest is too large to check: it has more than {limit} values (objects, arrays, strings, numbers, booleans and nulls, not counting top-level "x-" keys). A valid Manifest has fewer than 200.',
  'schema_invalid_json.too_many_problems':
    'The Manifest has too many problems to check at once here. Remove the keys and list items the Manifest format does not define, then check it again.',
  schema_type: 'Expected {expected}; found {actual}.',
  'schema_type.non_finite':
    'The number is out of the range JSON numbers can hold (about ±1.8e308); found {actual}.',
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
  'schema_pattern.httpUrl':
    'Must be an absolute http:// or https:// URL, without a user name or password before the host. Found {actual}.',
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
  'schema_invalid_json.file_too_large':
    'manifest.json is larger than {limit} bytes (1 MB), far more than any Manifest needs, so it was not read.',
  'entry_missing_for_platform.file':
    'The Entry file "{file}" is not in the Harness Package, so the Runtime could not start the Harness.',
  'entry_missing_for_platform.platform_file':
    'The Entry file "{file}" for platform "{platform}" is not in the Harness Package, so the Runtime could not start the Harness there.',
  file_missing: 'The Harness Package must contain "{file}".',
  'file_missing.manifest_nested':
    'manifest.json must be at the root of the Harness Package, but it is at "{found}". Package the contents of the Harness folder, not the folder itself.',
  'file_type.icon':
    'The icon must be a PNG image; this file is not one, or its PNG header is damaged.',
  'file_type.screenshot':
    'Screenshots in assets/ must be PNG or JPEG images named .png, .jpg or .jpeg, with content to match.',
  'file_type.special':
    'The entry is neither a file nor a folder (it is a device, a named pipe or a socket). A Harness Package holds only files and folders.',
  icon_dimensions: 'The icon must be {expected}×{expected} pixels; found {width}×{height}.',
  archive_symlink: 'The entry is a symbolic link. A Harness Package may not contain links.',
  archive_path_traversal:
    'The entry name has a ".." segment, so it would be unpacked outside the Harness Package.',
  'archive_path_traversal.absolute':
    'The entry name is an absolute path. Entries must be relative to the root of the Harness Package.',
  'archive_path_traversal.other_name':
    'The entry also carries the name {name} (in an Info-ZIP Unicode Path field), which is absolute or has a ".." segment, so some unpackers would place it outside the Harness Package.',
  'archive_path_traversal.local_name':
    'The entry\'s local header names it {name}, which is absolute or has a ".." segment, so unpackers that read the archive in order would place it outside the Harness Package.',
  archive_too_large:
    'The Harness Package is {actual} bytes; the limit is {limit} bytes (500 MB), compressed.',
  archive_too_many_files: 'The Harness Package holds {actual} files; the limit is {limit}.',
  'archive_too_many_files.not_counted':
    'The Harness Package has more than {counted} entries, far more than the limit of {limit} files, so it was not checked further.',
  archive_invalid: 'The Harness Package is not a readable zip archive: {detail}.',
  'archive_invalid.entry': 'The file cannot be read from the zip archive: {detail}.',
  'archive_invalid.duplicate': 'The zip archive holds this path more than once.',
  'archive_invalid.encrypted': 'The file is encrypted. Files in a Harness Package must not be.',
  'archive_invalid.compression_method':
    'The file uses compression method {method}; only stored (0) and Deflate (8) files can be unpacked.',
  'archive_invalid.local_name':
    "The entry's local header names it {name} instead. Unpackers that read the archive in order would use that name, so they would see other files than the ones checked.",
  'archive_invalid.inconsistent':
    'The zip entry is inconsistent: {detail}. Different unpackers could see different files here.',
  'archive_invalid.unlisted_data':
    'The zip archive holds {length} bytes at offset {offset} that belong to no entry of its central directory. Unpackers that read the archive in order could find files there that were never checked.',
  'archive_invalid.name_character':
    'The entry name contains {character}, which unpackers on Windows read differently from others ("\\" as a folder separator, ":" as a file stream of another file). Use "/" between folders and no ":" in names.',
  'archive_invalid.case_conflict':
    'The Harness Package also holds {other}, whose path differs from this one only in letter case, Unicode form or trailing dots and spaces. On macOS or Windows both are the same file, so one would overwrite the other.',
  'archive_invalid.file_folder_conflict':
    'The Harness Package also holds the folder {other}, with files in it, at the path of this file (ignoring letter case and Unicode form), so the two cannot both be unpacked.',
  'file_too_large.readme': 'README.md is {actual} bytes; keep it to at most {limit} bytes (50 KB).',
  'file_too_large.screenshot':
    'The screenshot is {actual} bytes; keep each screenshot to at most {limit} bytes (2 MB).',
  screenshots_too_many: 'assets/ holds {actual} screenshots; keep it to at most {limit}.',
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
