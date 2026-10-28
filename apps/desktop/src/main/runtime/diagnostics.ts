import type { Diagnostics } from '../../shared/ipc.js';

/** How long the Model Gateway has to answer the diagnostics' request. */
export const GATEWAY_PROBE_TIMEOUT_MS = 1000;

/** The diagnostics of Settings (`diagnostics.get`, `diagnostics.copy`). */
export interface DiagnosticsService {
  /** The diagnostics as they are now: the Model Gateway is asked again on every call. */
  get(): Promise<Diagnostics>;
  /** Writes {@link formatDiagnostics} of a fresh {@link DiagnosticsService.get} to the clipboard. */
  copy(): Promise<void>;
}

export interface DiagnosticsOptions {
  /** The desktop app's version. */
  readonly version: string;
  /** The app data root. */
  readonly dataRoot: string;
  /** The SQLite database file. */
  readonly databasePath: string;
  /** The bundled Node's version. Default: `process.versions.node`. */
  readonly nodeVersion?: string;
  /** The Model Gateway's port while it listens; null when it is not running. */
  readonly gatewayPort: () => number | null;
  /** Whether the Model Gateway on this port answers now ({@link probeGateway}). */
  readonly probe: (port: number) => Promise<boolean>;
  /** The Store base URL now. */
  readonly storeBaseUrl: () => string;
  /** Whether that URL is the build's default Store. */
  readonly isDefaultStore: () => boolean;
  /** Puts text on the clipboard (Electron's `clipboard.writeText`). */
  readonly writeClipboard: (text: string) => Promise<void>;
}

/**
 * The facts a support request needs, read fresh each time. Nothing secret is in them: no API key,
 * no Store session or token, no Harness token.
 */
export function createDiagnosticsService(options: DiagnosticsOptions): DiagnosticsService {
  const get = async (): Promise<Diagnostics> => {
    const port = options.gatewayPort();
    return {
      version: options.version,
      gateway:
        port === null
          ? { running: false }
          : { running: true, port, reachable: await options.probe(port) },
      nodeVersion: options.nodeVersion ?? process.versions.node,
      dataRoot: options.dataRoot,
      databasePath: options.databasePath,
    };
  };
  return {
    get,
    async copy() {
      const diagnostics = await get();
      await options.writeClipboard(
        formatDiagnostics(diagnostics, options.storeBaseUrl(), options.isDefaultStore()),
      );
    },
  };
}

/**
 * Whether the Model Gateway on `port` answers: a GET of `/v1/models` without a token, any HTTP
 * answer (its 401 included) counting, within {@link GATEWAY_PROBE_TIMEOUT_MS}. Never rejects.
 */
export async function probeGateway(
  port: number,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/models`, {
      signal: AbortSignal.timeout(GATEWAY_PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/** The diagnostics as the plain-text block `diagnostics.copy` puts on the clipboard, in English. */
export function formatDiagnostics(
  diagnostics: Diagnostics,
  storeBaseUrl: string,
  defaultStore: boolean,
): string {
  const { gateway } = diagnostics;
  const status = !gateway.running
    ? 'not running'
    : `running on port ${String(gateway.port)}, ${gateway.reachable ? 'reachable' : 'not reachable'}`;
  return [
    'Harness Store diagnostics',
    `Version: ${diagnostics.version}`,
    `Model Gateway: ${status}`,
    `Node: ${diagnostics.nodeVersion}`,
    `Data root: ${diagnostics.dataRoot}`,
    `Database: ${diagnostics.databasePath}`,
    `Store URL: ${storeBaseUrl}${defaultStore ? '' : ' (custom)'}`,
  ].join('\n');
}
