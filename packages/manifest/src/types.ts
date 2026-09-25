import type { Manifest } from './manifest.generated.js';

/**
 * One finding about a Manifest. `problems` block publishing and installing; `warnings` never do.
 */
export interface Problem {
  /**
   * Where the finding is, relative to the Manifest root: `name`, `models.slots.default`,
   * `platforms[1]`, `entry.win32-x64`, `["key with.dots"]`. `$` is the Manifest as a whole.
   */
  path: string;
  /** Stable snake_case code from `PROBLEM_CODES`. */
  code: string;
  /** English text with `params` already interpolated. */
  message: string;
  /** Stable i18n key: the code itself or `<code>.<variant>`; see `MESSAGES_EN`. */
  messageKey: string;
  /** The raw values interpolated into `message`, for rendering it in another language. */
  params?: Record<string, string | number>;
}

export type ValidationResult =
  | { ok: true; manifest: Manifest; warnings: Problem[] }
  | { ok: false; problems: Problem[]; warnings: Problem[] };

export interface ValidateManifestOptions {
  /**
   * GitHub login of the signed-in Publisher. When given, the Harness ID's publisher segment must
   * be this login, compared case-insensitively as GitHub does (`publisher_mismatch`); the schema
   * separately requires the segment to be lower case. The Store always passes it.
   */
  publisher?: string;
  /**
   * Every already published Harness Version of this Harness. When given, `version` must be
   * greater than all of them (`version_not_greater`). Each entry must be a valid semver string.
   */
  publishedVersions?: readonly string[];
}
