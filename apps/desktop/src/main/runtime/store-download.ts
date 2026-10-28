import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { validateManifest, type Manifest, type Platform } from '@harness-store/manifest';
import type { IpcResult } from '../../shared/ipc.js';
import { fail, ok } from './ipc-result.js';
import type { StoreFetch } from './store-auth.js';

/** The `download` call gives up after this long. */
const TICKET_TIMEOUT_MS = 15_000;

/** A transfer that receives nothing for this long is given up as `store_unreachable`. */
const IDLE_TIMEOUT_MS = 120_000;

/** What the Store's `download` function answers (api.md): where the package is, and what it is. */
export interface PackageTicket {
  /** The signed URL of the Harness Package, valid for 60 seconds. */
  readonly url: string;
  /** The package's SHA-256, lower-case hex. */
  readonly sha256: string;
  /** The package's size in bytes. */
  readonly size: number;
  /** The version's Manifest as the Store keeps it, validated. */
  readonly manifest: Manifest;
}

export interface StoreDownloadOptions {
  /** Makes the Store calls and the transfer (Electron's `net.fetch`, so system proxies apply). */
  readonly fetch: StoreFetch;
  /** The Store base URL, read on every call (the `store_base_url` setting). */
  readonly storeBaseUrl: () => string;
  /** The Store's anon key: `download` needs no account. */
  readonly anonKey: string;
  /** The desktop app's version, which the Store counts the download with. */
  readonly appVersion: string;
  /** How long the `download` call may take. Default: 15 seconds. */
  readonly ticketTimeoutMs?: number;
  /** How long the transfer may receive nothing. Default: 120 seconds. */
  readonly idleTimeoutMs?: number;
}

/** The two Store steps of a Store install: asking for the package, and fetching it. */
export interface StoreDownloader {
  /**
   * Calls the Store's `download` function for `version` of the Harness (null: its latest
   * published one) on `platform`; the Store counts the download. `not_found` (unknown, taken
   * down, Unpublished), `platform_not_supported` (the version does not declare `platform`),
   * `store_unreachable` (no answer within the timeout), `store_error` (any other answer, or one
   * whose Manifest is not a valid one of this Harness and version), `download_cancelled` once
   * `signal` aborted.
   */
  ticket(
    request: { harnessId: string; version: string | null; platform: Platform },
    signal: AbortSignal,
  ): Promise<IpcResult<PackageTicket>>;
  /**
   * Streams the package at the ticket's URL into the new file `file` (none may be there),
   * hashing it on the way, and reports the bytes received so far with `onProgress`. No header is
   * sent to the signed URL. `checksum_mismatch` when more bytes arrive than the ticket's `size`
   * (the transfer is stopped there), or, at the end, another size or SHA-256 than the ticket's;
   * `store_unreachable` when the transfer fails or receives nothing for the idle timeout;
   * `store_error` when the URL answers anything but the package (an expired URL);
   * `download_cancelled` once `signal` aborted. The caller deletes the file whatever the outcome.
   */
  fetchPackage(
    ticket: PackageTicket,
    file: string,
    progress: { signal: AbortSignal; onProgress: (received: number) => void },
  ): Promise<IpcResult<null>>;
}

/**
 * The Store download of a Store install (P0-10, docs/tech/api.md `download`): the Store counts
 * the download when it answers the ticket, so the app counts nothing itself.
 */
export function createStoreDownloader(options: StoreDownloadOptions): StoreDownloader {
  const ticketTimeoutMs = options.ticketTimeoutMs ?? TICKET_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  return {
    async ticket({ harnessId, version, platform }, signal) {
      const base = options.storeBaseUrl().replace(/\/+$/, '');
      let response: Response;
      let text: string;
      try {
        // The timeout covers the body too: a Store that answers and then stalls did not answer.
        response = await options.fetch(`${base}/functions/v1/download`, {
          method: 'POST',
          headers: { apikey: options.anonKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            harness_id: harnessId,
            version,
            platform,
            app_version: options.appVersion,
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(ticketTimeoutMs)]),
        });
        text = await response.text();
      } catch {
        return signal.aborted ? fail('download_cancelled') : fail('store_unreachable');
      }
      const body = parseJson(text);
      if (!response.ok) {
        const code = isRecord(body) && isRecord(body.error) ? body.error.code : undefined;
        if (response.status === 404) return fail('not_found');
        if (response.status === 422 && code === 'platform_not_supported') {
          return fail('platform_not_supported');
        }
        return fail('store_error');
      }
      const ticket = ticketOf(body);
      if (
        ticket?.manifest.id !== harnessId ||
        (version !== null && ticket.manifest.version !== version)
      ) {
        return fail('store_error');
      }
      return ok(ticket);
    },

    async fetchPackage(ticket, file, { signal, onProgress }) {
      const idle = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const restartIdleTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          idle.abort();
        }, idleTimeoutMs);
      };
      const stopped = () =>
        signal.aborted ? fail('download_cancelled') : fail('store_unreachable');
      let handle: FileHandle | undefined;
      restartIdleTimer();
      try {
        let response: Response;
        try {
          response = await options.fetch(ticket.url, {
            method: 'GET',
            signal: AbortSignal.any([signal, idle.signal]),
          });
        } catch {
          return stopped();
        }
        if (!response.ok || response.body === null) {
          await response.body?.cancel().catch(() => undefined);
          return fail('store_error');
        }
        handle = await open(file, 'wx');
        const hash = createHash('sha256');
        const reader = (response.body as ReadableStream<Uint8Array>).getReader();
        let received = 0;
        for (;;) {
          const chunk = await reader.read().then(
            (read) => read,
            () => null,
          );
          if (chunk === null) return stopped();
          if (chunk.done) break;
          restartIdleTimer();
          received += chunk.value.byteLength;
          if (received > ticket.size) {
            await reader.cancel().catch(() => undefined);
            return fail('checksum_mismatch');
          }
          hash.update(chunk.value);
          await handle.write(chunk.value);
          onProgress(received);
        }
        if (signal.aborted) return fail('download_cancelled');
        if (received !== ticket.size || hash.digest('hex') !== ticket.sha256) {
          return fail('checksum_mismatch');
        }
        return ok(null);
      } finally {
        clearTimeout(timer);
        await handle?.close();
      }
    },
  };
}

/** The ticket of a `200` body, or null when it is not what api.md says `download` answers. */
function ticketOf(body: unknown): PackageTicket | null {
  if (!isRecord(body)) return null;
  const { url, sha256, size, manifest } = body;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(sha256)) return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null;
  const validation = validateManifest(manifest);
  if (!validation.ok) return null;
  return { url, sha256: sha256.toLowerCase(), size, manifest: validation.manifest };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
