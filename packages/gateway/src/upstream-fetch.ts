/**
 * The `fetch` every Provider adapter makes its upstream calls with. It enforces the Gateway's two
 * timeouts (gateway-protocol.md §5): the response headers must arrive within the first-byte
 * timeout, and once they have, no gap between body chunks may exceed the idle timeout, for
 * streamed and non-streamed bodies alike. A timeout aborts the upstream request.
 */

/** The production default of both timeouts: 120 s. */
export const DEFAULT_TIMEOUT_MS = 120_000;

export interface UpstreamTimeouts {
  /** How long to wait for the upstream response headers, in milliseconds. */
  firstByteMs: number;
  /** The longest allowed gap between upstream body chunks, in milliseconds. */
  idleMs: number;
}

/** One upstream call's `fetch`, and what it saw. */
export interface UpstreamFetch {
  readonly fetch: typeof globalThis.fetch;
  /** True once the adapter called `fetch`: from then on the Provider may have been reached. */
  readonly attempted: boolean;
  /** True once a timeout aborted the upstream request. */
  readonly timedOut: boolean;
  /** The upstream HTTP status, once the response headers arrived. */
  readonly status: number | undefined;
}

/**
 * A `fetch` with the Gateway's timeouts, over `base` (default: the global `fetch`). The caller's
 * own signal (the AI SDK passes the request's abort signal) still aborts the call.
 */
export function createUpstreamFetch(
  { firstByteMs, idleMs }: UpstreamTimeouts,
  base: typeof globalThis.fetch = globalThis.fetch,
): UpstreamFetch {
  let attempted = false;
  let timedOut = false;
  let status: number | undefined;

  const timedFetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init: RequestInit = {},
  ): Promise<Response> => {
    attempted = true;
    const controller = new AbortController();
    const outer = init.signal;
    const forward = () => {
      controller.abort(outer?.reason);
    };
    if (outer?.aborted) forward();
    outer?.addEventListener('abort', forward, { once: true });
    const cleanup = () => {
      outer?.removeEventListener('abort', forward);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new DOMException('The Provider took too long to answer.', 'TimeoutError'));
      }, ms);
    };

    let response: Response;
    arm(firstByteMs);
    try {
      response = await base(input, { ...init, signal: controller.signal });
    } catch (error) {
      cleanup();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    status = response.status;
    if (response.body === null) {
      cleanup();
      return response;
    }

    // Re-wrap the body so each read waits at most `idleMs` for the next upstream chunk. Reads are
    // pulled by the consumer, so a slow consumer never counts as an idle Provider.
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        arm(idleMs);
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            cleanup();
            stream.close();
          } else {
            stream.enqueue(chunk.value);
          }
        } catch (error) {
          cleanup();
          stream.error(error);
        } finally {
          clearTimeout(timer);
        }
      },
      async cancel(reason) {
        cleanup();
        await reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  return {
    fetch: timedFetch,
    get attempted() {
      return attempted;
    },
    get timedOut() {
      return timedOut;
    },
    get status() {
      return status;
    },
  };
}
