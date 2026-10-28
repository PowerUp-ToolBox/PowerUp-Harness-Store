/**
 * The requests the Gateway is serving right now, by launch and by token, so that revoking a
 * Gateway Token (or closing the Gateway) stops work already under way instead of letting it
 * finish with a token that is no longer valid.
 */

/** Why an in-flight request was stopped. */
export type AbortReason = 'revoked' | 'closed';

/** Thrown into a request handler whose request was aborted. */
export class RequestAbortedError extends Error {
  constructor(readonly reason: AbortReason) {
    super(`Request aborted: ${reason}.`);
    this.name = 'RequestAbortedError';
  }
}

export interface InFlight {
  /** Aborted, with a {@link RequestAbortedError} as its reason, when the request must stop. */
  readonly signal: AbortSignal;
  /**
   * Removes the request from the registry; call once its response has ended (and its Usage
   * Record, if any, has been handed over).
   */
  end(): void;
}

interface Entry {
  readonly launchId: string;
  readonly tokenHash: string;
  readonly controller: AbortController;
}

export class InFlightRegistry {
  /** The requests that can still be aborted. */
  readonly #entries = new Set<Entry>();
  /** One promise per request that has not ended yet, aborted or not; settles at its `end()`. */
  readonly #open = new Set<Promise<void>>();

  start(launchId: string, tokenHash: string): InFlight {
    const entry: Entry = { launchId, tokenHash, controller: new AbortController() };
    this.#entries.add(entry);
    let ended: () => void = () => undefined;
    const open = new Promise<void>((resolve) => {
      ended = resolve;
    });
    this.#open.add(open);
    return {
      signal: entry.controller.signal,
      end: () => {
        this.#entries.delete(entry);
        this.#open.delete(open);
        ended();
      },
    };
  }

  /** Resolves once every request started so far has ended, including the aborted ones. */
  async ended(): Promise<void> {
    await Promise.all(this.#open);
  }

  abortToken(tokenHash: string): void {
    this.#abortWhere((entry) => entry.tokenHash === tokenHash, 'revoked');
  }

  abortLaunch(launchId: string): void {
    this.#abortWhere((entry) => entry.launchId === launchId, 'revoked');
  }

  abortAll(): void {
    this.#abortWhere(() => true, 'closed');
  }

  #abortWhere(matches: (entry: Entry) => boolean, reason: AbortReason): void {
    for (const entry of this.#entries) {
      if (!matches(entry)) continue;
      this.#entries.delete(entry);
      entry.controller.abort(new RequestAbortedError(reason));
    }
  }
}

/** Settles like `promise`, unless `signal` aborts first: then it rejects with the abort reason. */
export async function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
