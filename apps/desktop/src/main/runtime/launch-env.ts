/**
 * Inherited variables a Harness never gets: the credentials and base URLs of the Providers the
 * Model Gateway fronts (the P0-05 spec's pattern), so a Harness cannot use the User's own shell
 * credentials around the Gateway (ADR-0004), and every `HARNESS_` variable, which only the Runtime
 * sets, so a stray `HARNESS_WORKSPACE` of the parent never reaches a Harness. Matched ignoring
 * case, as Windows treats variable names.
 */
const STRIPPED = /^(?:(?:OPENAI|ANTHROPIC|GOOGLE_API|GEMINI|OPENROUTER)_|HARNESS_)/i;

/** The values of the launch contract's variables (docs/tech/architecture.md §4). */
export interface LaunchContract {
  /** `http://127.0.0.1:<gateway-port>/v1`. */
  readonly gatewayUrl: string;
  /** The launch's Gateway Token. */
  readonly token: string;
  /** `publisher/slug`. */
  readonly harnessId: string;
  /** The installed version. */
  readonly version: string;
  /** The Data Directory's absolute path. */
  readonly dataDir: string;
  /** `en` or `zh-CN`. */
  readonly locale: string;
  /** Such as `darwin-arm64`. */
  readonly platform: string;
}

/**
 * The environment a Harness process starts with: the inherited one without the
 * {@link STRIPPED} variables, then the launch contract's. `HARNESS_PORT` (web UI Kind) and
 * `HARNESS_WORKSPACE` (a chosen Workspace) are added by P0-05.3 and P0-05.4.
 */
export function launchEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  contract: LaunchContract,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && !STRIPPED.test(name)) env[name] = value;
  }
  return {
    ...env,
    HARNESS_GATEWAY_URL: contract.gatewayUrl,
    HARNESS_GATEWAY_TOKEN: contract.token,
    // So unmodified OpenAI SDKs talk to the Gateway with the Gateway Token.
    OPENAI_BASE_URL: contract.gatewayUrl,
    OPENAI_API_KEY: contract.token,
    HARNESS_ID: contract.harnessId,
    HARNESS_VERSION: contract.version,
    HARNESS_DATA_DIR: contract.dataDir,
    HARNESS_LOCALE: contract.locale,
    HARNESS_PLATFORM: contract.platform,
  };
}
