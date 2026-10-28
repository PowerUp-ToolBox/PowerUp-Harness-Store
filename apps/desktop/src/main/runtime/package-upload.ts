import { randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** The body is written this many bytes at a time, with a progress report after each. */
export const UPLOAD_CHUNK_BYTES = 64 * 1024;

/** An upload whose connection carries nothing either way for this long has failed. */
export const UPLOAD_IDLE_TIMEOUT_MS = 120_000;

/** The Store's answer is read up to this size; an error with every problem fits easily. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface PackageUpload {
  /** The `publish` function's URL. */
  readonly url: string;
  /** `apikey` and `authorization`; the multipart headers are added here. */
  readonly headers: Readonly<Record<string, string>>;
  /** The `package` part's file name, `<slug>-<version>.zip`. */
  readonly fileName: string;
  /** The Harness Package zip. */
  readonly bytes: Uint8Array;
  /** Called after each chunk the connection took: bytes of the body sent, of `total`. */
  readonly onProgress: (sent: number, total: number) => void;
  /**
   * Cancels the upload while the body is still being sent. Once all of it is sent it changes
   * nothing: the Store may already be saving the version, so the answer is awaited.
   */
  readonly signal: AbortSignal;
  /** Default: {@link UPLOAD_IDLE_TIMEOUT_MS}. */
  readonly idleTimeoutMs?: number;
}

/** How an upload ended: the Store's answer (its JSON body, or null), cancelled, or no answer. */
export type UploadOutcome =
  | { readonly kind: 'answered'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unreachable' };

/**
 * Sends a Harness Package to the Store's `publish` function (docs/tech/api.md): a multipart body
 * with the one part `package`, of a known Content-Length, written {@link UPLOAD_CHUNK_BYTES} at a
 * time so the progress is the bytes the connection actually took. A Node `http`/`https` request
 * rather than Electron's `net.fetch`, which reports no upload progress; the OS proxy settings are
 * therefore not applied to it. Never rejects.
 */
export function uploadPackage(upload: PackageUpload): Promise<UploadOutcome> {
  const boundary = `----HarnessStore${randomBytes(12).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="package"; filename="${upload.fileName}"\r\n` +
      'Content-Type: application/zip\r\n\r\n',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const total = head.length + upload.bytes.length + tail.length;
  const url = new URL(upload.url);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve) => {
    /** Mutated by the request's events, the writer and Cancel alike. */
    const state = { settled: false, answered: false, allSent: false, cancelled: false };
    const finish = (outcome: UploadOutcome) => {
      if (state.settled) return;
      state.settled = true;
      upload.signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const failed = () => {
      finish(state.cancelled ? { kind: 'cancelled' } : { kind: 'unreachable' });
    };

    const request = send(url, {
      method: 'POST',
      headers: {
        ...upload.headers,
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(total),
      },
    });
    request.setTimeout(upload.idleTimeoutMs ?? UPLOAD_IDLE_TIMEOUT_MS, () => {
      request.destroy(new Error('The Store did not answer in time.'));
    });
    request.on('error', failed);
    // A request destroyed before any answer: cancelled, timed out or cut off.
    request.on('close', () => {
      if (!state.answered) failed();
    });
    request.on('response', (response) => {
      state.answered = true;
      // The Store may answer before taking the whole body (a refusal): nothing more is sent, and
      // the connection is dropped once the answer is read.
      readAnswer(response).then(
        (body) => {
          finish({ kind: 'answered', status: response.statusCode ?? 0, body });
          if (!state.allSent) request.destroy();
        },
        () => {
          finish({ kind: 'unreachable' });
        },
      );
    });

    function onAbort() {
      if (state.allSent || state.settled) return;
      state.cancelled = true;
      request.destroy();
    }
    upload.signal.addEventListener('abort', onAbort);
    if (upload.signal.aborted) onAbort();

    const stopped = () => state.settled || state.answered || state.cancelled;
    const write = (chunk: Uint8Array) =>
      new Promise<void>((done, reject) => {
        request.write(chunk, (error) => {
          if (error) reject(error);
          else done();
        });
      });
    void (async () => {
      let sent = 0;
      const chunks = function* () {
        yield head;
        for (let start = 0; start < upload.bytes.length; start += UPLOAD_CHUNK_BYTES) {
          yield upload.bytes.subarray(start, start + UPLOAD_CHUNK_BYTES);
        }
        yield tail;
      };
      for (const chunk of chunks()) {
        if (stopped() || request.destroyed) return;
        await write(chunk);
        sent += chunk.length;
        // From the last chunk on, Cancel no longer applies, even to the report of it.
        if (sent === total) {
          state.allSent = true;
          request.end();
        }
        if (!stopped()) upload.onProgress(sent, total);
      }
    })().catch(() => {
      // The request failed while writing: its 'error' or 'close' settles the upload.
    });
  });
}

/** The answer's body as JSON (its first {@link MAX_RESPONSE_BYTES}), null when it is not JSON. */
async function readAnswer(response: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response as AsyncIterable<Buffer>) {
    if (length < MAX_RESPONSE_BYTES) chunks.push(chunk);
    length += chunk.length;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}
