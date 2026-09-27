/**
 * `harness-manifest validate <path> [--publisher <login>] [--published-version <version>]...
 * [--json]`: the check a Publisher runs on their Harness folder or zip before uploading it. A thin
 * wrapper: it picks the source, calls validatePackage() and prints the result. Every rule lives in
 * validatePackage(), so the CLI, the Publish flow and the Store give the same answer. Nothing goes
 * over the network. The command itself is bin/harness-manifest.js, which runs {@link runCli}.
 */
import { stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { validatePackage } from '../index.js';
import type { PackageSource, Problem, ValidatePackageOptions, ValidationResult } from '../index.js';
import { normalizeOptions } from '../rules.js';
import { openArchiveFile } from './archive-file.js';
import { DirectorySource } from './directory-source.js';

/** The Harness Package is valid; warnings alone never change this. */
export const EXIT_VALID = 0;
/** validatePackage() found problems (`result.ok === false`). */
export const EXIT_PROBLEMS = 1;
/** Nothing was checked: the command line is wrong, `<path>` cannot be read, or the CLI failed. */
export const EXIT_ERROR = 2;

export const USAGE = `Usage: harness-manifest validate <path> [--publisher <login>]
                                [--published-version <version>]... [--json]

Checks a Harness Package before you publish it and prints every problem at once.
Nothing is uploaded: the check runs on this computer only.

  <path>                         The Harness folder, or the .zip file you will upload.
  --publisher <login>            Your GitHub login: also check that it is the publisher
                                 segment of the Harness ID in the Manifest.
  --published-version <version>  A version of this Harness already in the Store: also
                                 check that the Manifest's version is greater. Repeat
                                 it for each published version.
  --json                         Print the result as JSON (a ValidationResult) and
                                 nothing else.
  -h, --help                     Print this help.

Exit status: 0 when the Harness Package is valid (warnings do not count),
1 when it has problems, 2 when nothing was checked (a wrong command line,
or a <path> that cannot be read).
`;

const HELP_HINT = 'Run "harness-manifest --help" for usage.\n';

/** Where the CLI writes: the process's streams, or strings in tests. */
export interface CliOutput {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** A command line the CLI cannot run: reported with a pointer to the usage text. */
class UsageError extends Error {}

/** A `<path>` that cannot be checked. */
class InputError extends Error {}

type Command =
  | { kind: 'help' }
  | { kind: 'validate'; path: string; options: ValidatePackageOptions; json: boolean };

/**
 * Runs the CLI with `args` (the arguments after the command name) and returns its exit status.
 * A wrong command line or an unreadable path prints a message to stderr and returns
 * {@link EXIT_ERROR}; stdout only ever holds the report (or, with `--json`, the result alone).
 */
export async function main(args: readonly string[], output: CliOutput): Promise<number> {
  let command: Command;
  try {
    command = parseCommand(args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    // Node's parseArgs messages span lines; keep those breaks but escape everything else.
    const lines = error.message.split('\n').map(escapeForTerminal).join('\n');
    const message = `harness-manifest: ${lines}\n${HELP_HINT}`;
    output.stderr(args.length === 0 ? USAGE : message);
    return EXIT_ERROR;
  }
  if (command.kind === 'help') {
    output.stdout(USAGE);
    return EXIT_VALID;
  }

  let result: ValidationResult;
  try {
    result = await validatePackage(await openPackage(command.path), command.options);
  } catch (error) {
    const reason =
      error instanceof InputError ? error.message : `cannot check it: ${messageOf(error)}`;
    output.stderr(`harness-manifest: ${escapeForTerminal(`${command.path}: ${reason}`)}\n`);
    return EXIT_ERROR;
  }
  output.stdout(command.json ? formatJson(result) : formatHuman(result));
  return result.ok ? EXIT_VALID : EXIT_PROBLEMS;
}

/**
 * The CLI as a process: `process.argv`, the standard streams and `process.exitCode`. It never
 * calls `process.exit()`, which could cut off output still on its way through a pipe.
 */
export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  // `harness-manifest validate x --json | head -1` closes the pipe early: that is not an error.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
  });
  try {
    process.exitCode = await main(args, {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    });
  } catch (error) {
    // A bug in the CLI, not a problem with the Harness Package: never exit 1 for it.
    process.stderr.write(`harness-manifest: internal error: ${stackOf(error)}\n`);
    process.exitCode = EXIT_ERROR;
  }
}

function parseCommand(args: readonly string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        publisher: { type: 'string' },
        'published-version': { type: 'string', multiple: true },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new UsageError(messageOf(error));
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: 'help' };
  const [name, ...paths] = positionals;
  if (name === undefined) throw new UsageError('no command given');
  if (name !== 'validate') throw new UsageError(`unknown command "${name}"`);
  const [path, ...extra] = paths;
  if (path === undefined) {
    throw new UsageError('validate needs the path of a Harness folder or .zip file');
  }
  if (extra.length > 0) {
    throw new UsageError(`validate takes one path, but ${String(paths.length)} were given`);
  }

  const options: ValidatePackageOptions = {};
  if (values.publisher !== undefined) {
    if (values.publisher.trim() === '') throw new UsageError('--publisher needs your GitHub login');
    options.publisher = values.publisher;
  }
  const publishedVersions = values['published-version'];
  if (publishedVersions !== undefined) {
    for (const version of publishedVersions) {
      // The same check validatePackage() makes of its options, so a typo is not mistaken for a
      // problem with the Harness Package.
      try {
        normalizeOptions({ publishedVersions: [version] });
      } catch {
        throw new UsageError(
          `--published-version ${JSON.stringify(version)} is not a version such as 1.2.0 or 1.2.0-beta.1`,
        );
      }
    }
    options.publishedVersions = publishedVersions;
  }
  return { kind: 'validate', path, options, json: values.json === true };
}

/**
 * The source for `path`: a folder is a `DirectorySource`, a file ending in `.zip` (in any letter
 * case) an `ArchiveSource`. Anything else cannot be a Harness Package.
 */
async function openPackage(path: string): Promise<PackageSource> {
  let stats;
  try {
    stats = await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new InputError('no such folder or file');
    throw error;
  }
  if (stats.isDirectory()) return DirectorySource.open(path);
  if (stats.isFile() && /\.zip$/i.test(path)) return openArchiveFile(path);
  throw new InputError('not a folder or a .zip file');
}

/**
 * The human-readable report: problems grouped by path, then warnings in their own section, then
 * a summary line. A valid Harness Package without warnings gets the summary line alone. Nothing
 * in it depends on whether the package is a folder or a zip, so both print the same report.
 */
export function formatHuman(result: ValidationResult): string {
  const problems = result.ok ? [] : result.problems;
  const { warnings } = result;
  const lines: string[] = [];
  if (problems.length > 0) {
    lines.push(`Problems (${String(problems.length)}), which block publishing:`);
    lines.push(...groupByPath(problems), '');
  }
  if (warnings.length > 0) {
    lines.push(`Warnings (${String(warnings.length)}), non-blocking:`);
    lines.push(...groupByPath(warnings), '');
  }
  if (result.ok) {
    const name = escapeForTerminal(`${result.manifest.id} ${result.manifest.version}`);
    lines.push(
      warnings.length === 0
        ? `The Harness Package ${name} is valid: no problems, no warnings.`
        : `The Harness Package ${name} is valid, with ${count(warnings.length, 'warning')}.`,
    );
  } else {
    const found = `${count(problems.length, 'problem')}, ${count(warnings.length, 'warning')}`;
    lines.push(`The Harness Package is not valid: ${found}.`);
  }
  return `${lines.join('\n')}\n`;
}

/** `--json`: the ValidationResult itself, as JSON that parses back to an equal object. */
export function formatJson(result: ValidationResult): string {
  // JSON.stringify escapes C0 control characters already; the other characters a terminal could
  // act on are escaped the same way (only strings can hold them), and JSON.parse reads them back.
  const json = JSON.stringify(result, null, 2);
  return `${escapeCharacters(json, (code) => code > 0x1f && isUnsafeCharacter(code))}\n`;
}

/** Findings grouped by path, in the order each path first appears. */
function groupByPath(findings: readonly Problem[]): string[] {
  const groups = new Map<string, Problem[]>();
  for (const finding of findings) {
    const group = groups.get(finding.path);
    if (group === undefined) groups.set(finding.path, [finding]);
    else group.push(finding);
  }
  return [...groups].flatMap(([path, group]) => [
    `  ${path === '' ? '""' : escapeForTerminal(path)}`,
    ...group.map((finding) => `    ${escapeForTerminal(`${finding.code}: ${finding.message}`)}`),
  ]);
}

function count(value: number, noun: string): string {
  return `${String(value)} ${noun}${value === 1 ? '' : 's'}`;
}

/**
 * Text with every character a terminal could act on written as a `\uXXXX` escape: control
 * characters (a hostile zip entry name may hold an escape sequence, or a line break that forges
 * a line of the report), line and paragraph separators, and the bidirectional formatting
 * characters that make text display in another order than it is stored.
 */
export function escapeForTerminal(text: string): string {
  return escapeCharacters(text, isUnsafeCharacter);
}

function escapeCharacters(text: string, unsafe: (code: number) => boolean): string {
  let out = '';
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (!unsafe(code)) continue;
    out += `${text.slice(start, index)}\\u${code.toString(16).padStart(4, '0')}`;
    start = index + 1;
  }
  return start === 0 ? text : out + text.slice(start);
}

function isUnsafeCharacter(code: number): boolean {
  return (
    code <= 0x1f || // C0 controls: escape sequences, line breaks, NUL
    (code >= 0x7f && code <= 0x9f) || // DEL and C1 controls (0x9b starts an escape sequence)
    code === 0x200e || // left-to-right mark
    code === 0x200f || // right-to-left mark
    code === 0x2028 || // line separator
    code === 0x2029 || // paragraph separator
    (code >= 0x202a && code <= 0x202e) || // bidirectional embeddings and overrides
    (code >= 0x2066 && code <= 0x2069) // bidirectional isolates
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stackOf(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
