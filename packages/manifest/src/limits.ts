/**
 * The Harness Package limits of docs/tech/manifest-spec.md §1, and the bounds validatePackage()
 * puts on its own work. Sizes are in bytes; "KB" and "MB" are binary (1 KB = 1 024 bytes), as for
 * the changelog's 5 KB (5 120 bytes).
 */
export const PACKAGE_LIMITS = Object.freeze({
  /** Archives over 500 MB (compressed) are rejected: `archive_too_large`. */
  maxArchiveBytes: 500 * 1024 * 1024,
  /** More files than this (directories do not count) are rejected: `archive_too_many_files`. */
  maxFiles: 20_000,
  /** The icon must be exactly this many pixels wide and high: `icon_dimensions`. */
  iconSize: 512,
  /** A longer README.md gives a warning: `file_too_large`. */
  maxReadmeBytes: 50 * 1024,
  /** More screenshots give a warning: `screenshots_too_many`. */
  maxScreenshots: 5,
  /** A larger screenshot gives a warning: `file_too_large`. */
  maxScreenshotBytes: 2 * 1024 * 1024,
  /**
   * validatePackage() reads at most this much of manifest.json (the largest valid Manifest is a
   * few hundred KB even with every character escaped); a larger one is `schema_invalid_json`.
   */
  maxManifestBytes: 1024 * 1024,
  /**
   * Listing stops after this many entries (files, directories and links): the package is then
   * reported as having too many files and not checked further. Five times `maxFiles`, so
   * directory entries in a valid archive never reach it.
   */
  maxListedEntries: 100_000,
  /**
   * A zip whose central directory (its list of entries) is larger is not read: a valid Harness
   * Package needs a few MB at most.
   */
  maxCentralDirectoryBytes: 64 * 1024 * 1024,
});
