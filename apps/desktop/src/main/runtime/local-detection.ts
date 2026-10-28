import { PROVIDERS, type ProviderInfo } from '@harness-store/gateway';

/** The Providers that run on the User's machine, which detection looks for. */
export const LOCAL_PROVIDER_IDS: ReadonlySet<string> = new Set(['ollama', 'lmstudio']);

/** How long one probe may take before its Provider counts as not running: 1.5 seconds. */
export const DETECT_TIMEOUT_MS = 1500;

/** Where detection looks for one local Provider: its OpenAI base URL, such as `…:11434/v1`. */
export interface LocalProbeTarget {
  readonly providerId: string;
  readonly baseUrl: string;
}

/** A local Provider that answered its probe, with the models it listed. */
export interface DetectedProvider {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly models: readonly string[];
}

/** Probes every target once and lists those running; never rejects. */
export type LocalDetector = () => Promise<readonly DetectedProvider[]>;

/** The default targets: the base URL of each local Provider in `providers` (Ollama, LM Studio). */
export function localProbeTargets(
  providers: readonly ProviderInfo[] = PROVIDERS,
): readonly LocalProbeTarget[] {
  return providers.flatMap((provider) =>
    LOCAL_PROVIDER_IDS.has(provider.id) && provider.baseUrl !== undefined
      ? [{ providerId: provider.id, baseUrl: provider.baseUrl }]
      : [],
  );
}

export interface LocalDetectorOptions {
  /** Node's `fetch`, the one Connection tests and the Model Gateway's upstream calls use. */
  readonly fetch: typeof globalThis.fetch;
  /** Default: {@link localProbeTargets}. Tests point them at fake Providers on OS-chosen ports. */
  readonly targets?: readonly LocalProbeTarget[];
  /** Default: {@link DETECT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Looks for local Providers: `GET {baseUrl}/models` on every target at once, each bounded by the
 * timeout (the response body included), so one detection takes at most about that long. A target
 * counts as running only when it answers HTTP 200 with a JSON `data` array, as Ollama's and LM
 * Studio's OpenAI-compatible APIs do (or `data: null`, Ollama's empty list); a refused connection, a timeout, another status or another
 * body means it is not. Detection only reports: it never adds a Connection.
 */
export function createLocalDetector(options: LocalDetectorOptions): LocalDetector {
  const { fetch, targets = localProbeTargets(), timeoutMs = DETECT_TIMEOUT_MS } = options;

  const probe = async (target: LocalProbeTarget): Promise<DetectedProvider | null> => {
    try {
      const response = await fetch(`${target.baseUrl}/models`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        return null;
      }
      const models = modelIds(await response.json());
      return models === undefined ? null : { ...target, models };
    } catch {
      return null;
    }
  };

  return async () =>
    (await Promise.all(targets.map(probe))).filter(
      (found): found is DetectedProvider => found !== null,
    );
}

/**
 * The `data[].id` of an OpenAI-shaped model list, else undefined when `data` is neither an array
 * nor null. Ollama answers `"data": null` while no model is pulled yet, an empty list.
 */
function modelIds(body: unknown): string[] | undefined {
  if (typeof body !== 'object' || body === null || !('data' in body)) return undefined;
  const { data } = body;
  if (data === null) return [];
  if (!Array.isArray(data)) return undefined;
  const ids = data
    .map((entry: unknown) =>
      typeof entry === 'object' && entry !== null && 'id' in entry ? entry.id : undefined,
    )
    .filter((id): id is string => typeof id === 'string' && id !== '');
  return [...new Set(ids)];
}
