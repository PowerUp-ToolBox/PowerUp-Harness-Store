/**
 * The launch environment as typed values. The Runtime starts every Harness with the variables of
 * the launch contract (docs/tech/architecture.md §4); these helpers read them from `process.env`
 * at call time, never at module load, and never make a network call.
 */

/** The app's languages; a Harness's own UI should follow `HARNESS_LOCALE`. */
export const LOCALES = ['en', 'zh-CN'] as const;
export type Locale = (typeof LOCALES)[number];

/** Who and where this launch is, from the launch contract's environment variables. */
export interface HarnessContext {
  /** `HARNESS_ID`: the Harness ID, `publisher/slug`. */
  readonly harnessId: string;
  /** `HARNESS_VERSION`: the installed Harness Version. */
  readonly harnessVersion: string;
  /** `HARNESS_DATA_DIR`: the absolute path of the Data Directory, private to this Harness. */
  readonly dataDir: string;
  /** `HARNESS_WORKSPACE`: the Workspace the User chose for this launch, if any. */
  readonly workspace: string | undefined;
  /** `HARNESS_LOCALE`: the app's locale at launch; anything unrecognised reads as `en`. */
  readonly locale: Locale;
  /** `HARNESS_PLATFORM`: the platform the Harness runs on, e.g. `darwin-arm64`. */
  readonly platform: string;
  /** `HARNESS_PORT`: the port to serve the UI on; set only for UI Kind `web`. */
  readonly port: number | undefined;
}

/** The variables the Runtime sets on every launch, whatever the UI Kind and Workspace. */
export const REQUIRED_ENV = [
  'HARNESS_GATEWAY_URL',
  'HARNESS_GATEWAY_TOKEN',
  'HARNESS_ID',
  'HARNESS_VERSION',
  'HARNESS_DATA_DIR',
  'HARNESS_LOCALE',
  'HARNESS_PLATFORM',
] as const;

/**
 * Thrown when a launch contract variable is missing: the process was not started by Harness
 * Store (for example with `node dist/index.mjs` from a shell). `missing` names the variables.
 */
export class NotInHarnessStoreError extends Error {
  override readonly name = 'NotInHarnessStoreError';
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Not running inside Harness Store: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        'Install this folder with "Install this folder locally" on the Publish screen of Harness Store, then launch it from the Library.',
    );
    this.missing = missing;
  }
}

/**
 * Reads the launch environment. Throws {@link NotInHarnessStoreError} when any variable the
 * Runtime always sets is missing or empty, and an `Error` when `HARNESS_PORT` is set but is not
 * a port number.
 */
export function getContext(): HarnessContext {
  const env = readEnv(REQUIRED_ENV);
  const locale = env.HARNESS_LOCALE;
  return {
    harnessId: env.HARNESS_ID,
    harnessVersion: env.HARNESS_VERSION,
    dataDir: env.HARNESS_DATA_DIR,
    workspace: optionalEnv('HARNESS_WORKSPACE'),
    locale: isLocale(locale) ? locale : 'en',
    platform: env.HARNESS_PLATFORM,
    port: harnessPort(),
  };
}

/**
 * The values of `names`, or {@link NotInHarnessStoreError} naming every one that is missing or
 * empty.
 */
export function readEnv<const Name extends string>(names: readonly Name[]): Record<Name, string> {
  const values: Partial<Record<Name, string>> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = optionalEnv(name);
    if (value === undefined) missing.push(name);
    else values[name] = value;
  }
  if (missing.length > 0) throw new NotInHarnessStoreError(missing);
  return values as Record<Name, string>;
}

/** `HARNESS_PORT` as a number, `undefined` when unset; throws when it is not a port number. */
export function harnessPort(): number | undefined {
  const value = optionalEnv('HARNESS_PORT');
  if (value === undefined) return undefined;
  const port = /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  if (!(port >= 1 && port <= 65_535)) {
    throw new Error(
      `HARNESS_PORT must be an integer from 1 to 65535, got ${JSON.stringify(value)}`,
    );
  }
  return port;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}
