/**
 * Ticket P0-01.4: `harness-manifest validate <path> [--publisher <login>] [--json]` (and
 * `--published-version`), run in this process through main(). Every acceptance criterion, every
 * fixture as a folder and as a zip file, every flag and every wrong command line.
 * test/cli-command.test.ts runs the built command itself.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validatePackage, validateManifest } from '../src/index.js';
import type { Problem, ValidationResult } from '../src/index.js';
import { DirectorySource, openArchiveFile } from '../src/node/index.js';
import {
  EXIT_ERROR,
  EXIT_PROBLEMS,
  EXIT_VALID,
  escapeForTerminal,
  formatHuman,
  formatJson,
  USAGE,
} from '../src/node/cli.js';
import { fixtureNames, loadFixture } from './helpers.js';
import { optionFlags, runInProcess as run, shapeErrors } from './support/cli.js';
import { fixtureDir, folderEntries, writeHostileArchive, zipFolder } from './support/packages.js';
import { buildZip } from './support/zip-writer.js';

const names = fixtureNames();
const withRecipe = names.filter((name) => loadFixture(name).expected.archive !== undefined);

let scratch = '';
/** The zip file of each fixture folder, as `zipFolder()` makes it. */
const zipOf = (name: string) => join(scratch, 'zips', `${name}.zip`);
/** The hostile archive of each fixture with a recipe. */
const hostileOf = (name: string) => join(scratch, 'hostile', `${name}.zip`);

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'manifest-cli-'));
  mkdirSync(join(scratch, 'zips'));
  mkdirSync(join(scratch, 'hostile'));
  mkdirSync(join(scratch, 'copies'));
  for (const name of names) writeFileSync(zipOf(name), zipFolder(fixtureDir(name)));
  for (const name of withRecipe) writeHostileArchive(name, hostileOf(name));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A copy of a fixture folder in the scratch folder, to change. */
function copyFixture(name: string, as = name): string {
  const dir = join(scratch, 'copies', as);
  cpSync(fixtureDir(name), dir, { recursive: true });
  return dir;
}

/**
 * The characters in `text` that a terminal would act on, other than the line breaks between the
 * lines of a report: C0 and C1 controls, DEL, and bidirectional embeddings, overrides and isolates.
 */
function rawControls(text: string): number[] {
  const found: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (
      (code <= 0x1f && code !== 0x0a) ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      found.push(code);
    }
  }
  return found;
}

async function resultOf(path: string, name: string): Promise<ValidationResult> {
  return validatePackage(await DirectorySource.open(path), loadFixture(name).expected.options);
}

describe('P0-01.4 acceptance criteria', () => {
  const valid = names.filter((name) => name.startsWith('valid-'));

  it.each(valid)(
    '1. a valid fixture directory (%s) prints one success line and exits 0',
    async (name) => {
      const manifest = JSON.parse(loadFixture(name).manifestText) as {
        id: string;
        version: string;
      };
      expect(await run(['validate', fixtureDir(name)])).toEqual({
        status: EXIT_VALID,
        stdout: `The Harness Package ${manifest.id} ${manifest.version} is valid: no problems, no warnings.\n`,
        stderr: '',
      });
    },
  );

  it("2. a fixture missing its icon prints that problem's code, path and message, and exits 1", async () => {
    const { status, stdout, stderr } = await run(['validate', fixtureDir('file_missing')]);
    expect(status).toBe(EXIT_PROBLEMS);
    expect(stderr).toBe('');
    expect(stdout).toBe(
      [
        'Problems (1), which block publishing:',
        '  assets/icon.png',
        '    file_missing: The Harness Package must contain "assets/icon.png".',
        '',
        'The Harness Package is not valid: 1 problem, 0 warnings.',
        '',
      ].join('\n'),
    );
  });

  it('2. every problem is printed with its code, path and message, grouped by path', async () => {
    for (const name of names) {
      const { options, problems } = loadFixture(name).expected;
      const { status, stdout } = await run(['validate', fixtureDir(name), ...optionFlags(options)]);
      expect({ name, status }).toEqual({
        name,
        status: problems.length > 0 ? EXIT_PROBLEMS : EXIT_VALID,
      });
      const result = await resultOf(fixtureDir(name), name);
      for (const problem of result.ok ? [] : result.problems) {
        expect(stdout).toContain(`\n  ${escapeForTerminal(problem.path)}\n`);
        expect(stdout).toContain(
          `    ${escapeForTerminal(`${problem.code}: ${problem.message}`)}\n`,
        );
      }
    }
  });

  it.each(names)(
    '3. %s zipped prints exactly what the folder prints, in both output modes',
    async (name) => {
      const flags = optionFlags(loadFixture(name).expected.options);
      for (const mode of [[], ['--json']]) {
        const folder = await run(['validate', fixtureDir(name), ...flags, ...mode]);
        const zip = await run(['validate', zipOf(name), ...flags, ...mode]);
        expect(zip).toEqual(folder);
      }
    },
  );

  const zipTool = spawnSync('zip', ['-v'], { encoding: 'utf8' }).status === 0;

  it.skipIf(!zipTool)(
    '3. a zip made with Info-ZIP `zip -r` prints exactly what the folder prints',
    async () => {
      mkdirSync(join(scratch, 'info-zip'), { recursive: true });
      for (const name of names) {
        const archive = join(scratch, 'info-zip', `${name}.zip`);
        const zipped = spawnSync('zip', ['-qr', archive, '.'], { cwd: fixtureDir(name) });
        expect(zipped.status).toBe(0);
        const flags = optionFlags(loadFixture(name).expected.options);
        expect({ name, run: await run(['validate', archive, ...flags]) }).toEqual({
          name,
          run: await run(['validate', fixtureDir(name), ...flags]),
        });
      }
    },
  );

  it.each(names)(
    '4. --json on %s prints the ValidationResult as JSON and nothing else',
    async (name) => {
      const { options } = loadFixture(name).expected;
      const { status, stdout, stderr } = await run([
        'validate',
        fixtureDir(name),
        '--json',
        ...optionFlags(options),
      ]);
      expect(stderr).toBe('');
      // JSON.parse rejects anything but whitespace around the one JSON value.
      const parsed = JSON.parse(stdout) as unknown;
      expect(shapeErrors(parsed)).toEqual([]);
      const expected = await resultOf(fixtureDir(name), name);
      expect(parsed).toEqual(expected);
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(expected));
      expect(status).toBe(expected.ok ? EXIT_VALID : EXIT_PROBLEMS);
      const result = parsed as ValidationResult;
      if (result.ok) expect(validateManifest(result.manifest).ok).toBe(true);
    },
  );

  it('5. --publisher alice finds publisher_mismatch in bob/..., and without it there is none', async () => {
    const dir = fixtureDir('publisher_mismatch');
    const manifest = JSON.parse(loadFixture('publisher_mismatch').manifestText) as { id: string };
    expect(manifest.id).toMatch(/^bob\//);

    const flagged = await run(['validate', dir, '--publisher', 'alice']);
    expect(flagged.status).toBe(EXIT_PROBLEMS);
    expect(flagged.stdout).toContain('\n  id\n    publisher_mismatch: ');
    const json = await run(['validate', dir, '--publisher', 'alice', '--json']);
    expect(json.status).toBe(EXIT_PROBLEMS);
    const problems = (JSON.parse(json.stdout) as { problems: Problem[] }).problems;
    expect(problems.map(({ code, path }) => `${code}@${path}`)).toEqual(['publisher_mismatch@id']);

    const unflagged = await run(['validate', dir]);
    expect(unflagged.status).toBe(EXIT_VALID);
    expect(unflagged.stdout).not.toContain('publisher_mismatch');
    const unflaggedJson = JSON.parse((await run(['validate', dir, '--json'])).stdout) as {
      ok: boolean;
    };
    expect(unflaggedJson.ok).toBe(true);
  });

  it('5. --publisher is forwarded as given: --publisher=alice, and a login in another case', async () => {
    const dir = fixtureDir('publisher_mismatch');
    expect((await run(['validate', dir, '--publisher=alice'])).status).toBe(EXIT_PROBLEMS);
    expect((await run(['--publisher', 'alice', 'validate', dir])).status).toBe(EXIT_PROBLEMS);
    // validatePackage() compares logins case-insensitively, as GitHub does.
    expect((await run(['validate', dir, '--publisher', 'Bob'])).status).toBe(EXIT_VALID);
  });

  const warningsOnly = names.filter((name) => {
    const { problems, warnings } = loadFixture(name).expected;
    return problems.length === 0 && warnings.length > 0;
  });

  it('6. there are fixtures with warnings and no problems', () => {
    expect(warningsOnly).toEqual(
      expect.arrayContaining(['ignored_key', 'file_too_large', 'screenshots_too_many']),
    );
  });

  it.each(warningsOnly)(
    '6. %s (warnings only) exits 0 and still prints its warnings, labeled non-blocking',
    async (name) => {
      const { status, stdout, stderr } = await run(['validate', fixtureDir(name)]);
      expect(status).toBe(EXIT_VALID);
      expect(stderr).toBe('');
      const result = await resultOf(fixtureDir(name), name);
      expect(result.ok).toBe(true);
      const { warnings } = result;
      expect(stdout.startsWith(`Warnings (${String(warnings.length)}), non-blocking:\n`)).toBe(
        true,
      );
      for (const warning of warnings) {
        expect(stdout).toContain(`\n  ${warning.path}\n    ${warning.code}: ${warning.message}\n`);
      }
      expect(stdout).not.toContain('Problems');
      expect(stdout).toMatch(/\nThe Harness Package \S+ \S+ is valid, with \d+ warnings?\.\n$/);
    },
  );
});

describe('P0-01.4 How to verify', () => {
  it.each(names)(
    '1. the exit code of fixtures/%s says whether its expected.json lists problems',
    async (name) => {
      const { options, problems } = loadFixture(name).expected;
      const { status } = await run(['validate', fixtureDir(name), ...optionFlags(options)]);
      expect(status).toBe(problems.length > 0 ? EXIT_PROBLEMS : EXIT_VALID);
    },
  );

  it.each(withRecipe)(
    '1. the exit code of the hostile archive of fixtures/%s says whether it has problems',
    async (name) => {
      const { options, archive } = loadFixture(name).expected;
      const { status, stdout } = await run(['validate', hostileOf(name), ...optionFlags(options)]);
      expect(status).toBe((archive?.problems.length ?? 0) > 0 ? EXIT_PROBLEMS : EXIT_VALID);
      for (const { code, path } of archive?.problems ?? []) {
        expect(stdout).toContain(`  ${escapeForTerminal(path)}\n`);
        expect(stdout).toContain(`    ${code}: `);
      }
    },
  );

  it('3. no arguments print the usage help to stderr and exit 2', async () => {
    expect(await run([])).toEqual({ status: EXIT_ERROR, stdout: '', stderr: USAGE });
    expect(USAGE).toMatch(/^Usage: harness-manifest validate <path> \[--publisher <login>\]/);
    expect(USAGE).toContain('--json');
  });
});

describe('the human-readable report', () => {
  const problem = (path: string, code: string, message: string): Problem => ({
    path,
    code,
    message,
    messageKey: code,
  });

  it('groups findings by path in the order each path first appears, warnings last', () => {
    const report = formatHuman({
      ok: false,
      problems: [
        problem('assets/icon.png', 'file_type', 'Not a PNG.'),
        problem('name', 'schema_required', 'Required key "name" is missing.'),
        problem('assets/icon.png', 'icon_dimensions', 'Too small.'),
      ],
      warnings: [problem('ui.path', 'ignored_key', 'Ignored.')],
    });
    expect(report).toBe(
      [
        'Problems (3), which block publishing:',
        '  assets/icon.png',
        '    file_type: Not a PNG.',
        '    icon_dimensions: Too small.',
        '  name',
        '    schema_required: Required key "name" is missing.',
        '',
        'Warnings (1), non-blocking:',
        '  ui.path',
        '    ignored_key: Ignored.',
        '',
        'The Harness Package is not valid: 3 problems, 1 warning.',
        '',
      ].join('\n'),
    );
  });

  it('prints problems and warnings of one package in two sections, warnings below', async () => {
    const dir = copyFixture('ignored_key', 'problems-and-warnings');
    rmSync(join(dir, 'assets/icon.png'));
    const { status, stdout } = await run(['validate', dir]);
    expect(status).toBe(EXIT_PROBLEMS);
    expect(stdout).toBe(
      [
        'Problems (1), which block publishing:',
        '  assets/icon.png',
        '    file_missing: The Harness Package must contain "assets/icon.png".',
        '',
        'Warnings (1), non-blocking:',
        '  ui.readyTimeoutSeconds',
        '    ignored_key: "readyTimeoutSeconds" applies to UI Kind "web" only; it is ignored for "terminal".',
        '',
        'The Harness Package is not valid: 1 problem, 1 warning.',
        '',
      ].join('\n'),
    );
  });

  it('writes the characters a terminal would act on in hostile entry names as escapes', async () => {
    const names = [
      'dist/\u001b[2J\u001b[31mred.js', // clears the screen, turns red
      'dist/a\nThe Harness Package alice/x 1.0.0 is valid: no problems, no warnings.', // forged line
      'dist/\u009b31mc1.js', // C1 control sequence introducer
      'dist/\u202eevil\u2066.js', // bidirectional override and isolate
    ];
    const archive = join(scratch, 'terminal.zip');
    writeFileSync(
      archive,
      buildZip([
        ...folderEntries(fixtureDir('valid-minimal-node')),
        // Symbolic links, so that the names reach the report through archive_symlink too.
        ...names.map((name) => ({ name, data: '/etc/passwd', method: 0, unixMode: 0o120777 })),
      ]),
    );
    const human = await run(['validate', archive]);
    expect(human.status).toBe(EXIT_PROBLEMS);
    expect(human.stdout).toContain('dist/\\u001b[2J\\u001b[31mred.js');
    expect(human.stdout).toContain('dist/\\u009b31mc1.js');
    expect(human.stdout).toContain('dist/\\u202eevil\\u2066.js');
    expect(human.stdout).toContain('dist/a\\u000aThe Harness Package alice/x');
    expect(rawControls(human.stdout)).toEqual([]);
    const json = await run(['validate', archive, '--json']);
    expect(rawControls(json.stdout)).toEqual([]);
    const parsed = JSON.parse(json.stdout) as { problems: Problem[] };
    expect(new Set(parsed.problems.map(({ path }) => path))).toEqual(new Set(names));
    expect(parsed).toEqual(await validatePackage(await openArchiveFile(archive)));
    // The forged line stays inside its entry name: the report has one summary line, the real one.
    const summaries = human.stdout.split('\n').filter((line) => line.startsWith('The Harness'));
    expect(summaries).toEqual([
      `The Harness Package is not valid: ${String(parsed.problems.length)} problems, 0 warnings.`,
    ]);
  });

  it('escapes control, separator and bidirectional characters and nothing else', () => {
    expect(escapeForTerminal('assets/icon.png')).toBe('assets/icon.png');
    expect(escapeForTerminal('日本語/ü.txt')).toBe('日本語/ü.txt');
    expect(escapeForTerminal('a\u0000b\u007fc\u0085d\u2028e\u200ff')).toBe(
      'a\\u0000b\\u007fc\\u0085d\\u2028e\\u200ff',
    );
  });

  it('keeps --json output equal to the result after escaping', () => {
    const result: ValidationResult = {
      ok: false,
      problems: [problem('dist/\u009b\u202e\u2028\u0007\n.js', 'archive_symlink', 'Link.')],
      warnings: [],
    };
    const json = formatJson(result);
    expect(json).toContain('dist/\\u009b\\u202e\\u2028\\u0007\\n.js');
    expect(JSON.parse(json)).toEqual(result);
    expect(json.endsWith('}\n')).toBe(true);
  });
});

describe('the command line', () => {
  const valid = () => fixtureDir('valid-minimal-node');

  it.each([
    { args: ['--help'] },
    { args: ['-h'] },
    { args: ['validate', '--help'] },
    { args: ['validate', 'x', '-h'] },
  ])('$args prints the usage help to stdout and exits 0', async ({ args }) => {
    expect(await run(args)).toEqual({ status: EXIT_VALID, stdout: USAGE, stderr: '' });
  });

  it.each([
    [['frob'], 'unknown command "frob"'],
    [['validate'], 'validate needs the path of a Harness folder or .zip file'],
    [['validate', 'a', 'b'], 'validate takes one path, but 2 were given'],
    [['validate', 'a', '--bogus'], "Unknown option '--bogus'"],
    [['validate', 'a', '--publisher'], "Option '--publisher <value>' argument missing"],
    [['validate', 'a', '--publisher', ''], '--publisher needs your GitHub login'],
    [['validate', 'a', '--publisher', '  '], '--publisher needs your GitHub login'],
    [['validate', 'a', '--json=yes'], "Option '--json' does not take an argument"],
    [['validate', 'a', '--published-version', '1.0'], '--published-version "1.0" is not a version'],
    [['validate', 'a', '--published-version', '1.0.0+build.1'], '"1.0.0+build.1" is not a version'],
    [['--json'], 'no command given'],
  ])(
    '%j is a usage error: exit 2, a message on stderr, nothing on stdout',
    async (args, message) => {
      const { status, stdout, stderr } = await run(args);
      expect(status).toBe(EXIT_ERROR);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/^harness-manifest: /);
      expect(stderr).toContain(message);
      expect(stderr.endsWith('Run "harness-manifest --help" for usage.\n')).toBe(true);
    },
  );

  it('keeps the line breaks of a multi-line usage message instead of escaping them', async () => {
    const { status, stderr } = await run(['validate', 'a', '--publisher', '--json']);
    expect(status).toBe(EXIT_ERROR);
    expect(stderr).toContain('argument is ambiguous.\nDid you forget');
    expect(stderr).not.toContain('\\u000a');
  });

  it('reports a path that does not exist, or is neither a folder nor a .zip file, with exit 2', async () => {
    const missing = join(scratch, 'missing');
    expect(await run(['validate', missing, '--json'])).toEqual({
      status: EXIT_ERROR,
      stdout: '',
      stderr: `harness-manifest: ${missing}: no such folder or file\n`,
    });
    const notZip = join(scratch, 'package.tar');
    writeFileSync(notZip, 'x');
    expect(await run(['validate', notZip])).toEqual({
      status: EXIT_ERROR,
      stdout: '',
      stderr: `harness-manifest: ${notZip}: not a folder or a .zip file\n`,
    });
    const inFile = join(notZip, 'manifest.json');
    expect((await run(['validate', inFile])).stderr).toContain('no such folder or file');
  });

  it('takes a folder by what it is and a zip file by its name, in any letter case', async () => {
    const upper = join(scratch, 'UPPER.ZIP');
    writeFileSync(upper, zipFolder(valid()));
    expect((await run(['validate', upper])).status).toBe(EXIT_VALID);
    const folderNamedZip = join(scratch, 'copies', 'folder.zip');
    cpSync(valid(), folderNamedZip, { recursive: true });
    expect(await run(['validate', folderNamedZip])).toEqual(await run(['validate', valid()]));
  });

  it('reports a .zip file that is not a zip archive as a problem (exit 1), not a usage error', async () => {
    const broken = join(scratch, 'broken.zip');
    writeFileSync(broken, 'not a zip');
    const { status, stdout, stderr } = await run(['validate', broken, '--json']);
    expect(status).toBe(EXIT_PROBLEMS);
    expect(stderr).toBe('');
    const result = JSON.parse(stdout) as { problems: Problem[] };
    expect(result.problems.map(({ code, path }) => `${code}@${path}`)).toEqual([
      'archive_invalid@$',
    ]);
  });

  it('forwards --published-version (repeatable) as publishedVersions', async () => {
    const dir = fixtureDir('version_not_greater');
    const { options } = loadFixture('version_not_greater').expected;
    expect(options?.publishedVersions).toEqual(['1.0.0', '1.2.0']);
    const flagged = await run(['validate', dir, '--json', ...optionFlags(options)]);
    expect(flagged.status).toBe(EXIT_PROBLEMS);
    expect(JSON.parse(flagged.stdout)).toEqual(
      await validatePackage(await DirectorySource.open(dir), options),
    );
    expect((await run(['validate', dir, '--published-version', '1.0.0'])).status).toBe(EXIT_VALID);
    expect((await run(['validate', dir])).status).toBe(EXIT_VALID);
  });
});
