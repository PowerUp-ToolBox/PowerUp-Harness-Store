/**
 * The single mapper from a failed upstream call (an AI SDK or HTTP error) to the Gateway's
 * documented error codes (gateway-protocol.md §5).
 */
import {
  APICallError,
  EmptyResponseBodyError,
  InvalidResponseDataError,
  JSONParseError,
  StreamProviderError,
  TypeValidationError,
} from 'ai';
import type { GatewayErrorCode } from './errors.js';

/** How much of a raw upstream error body `provider_message` keeps. */
const MAX_RAW_MESSAGE = 1000;

export interface MappedProviderError {
  code: Extract<GatewayErrorCode, 'provider_error' | 'provider_timeout'>;
  message: string;
  /** `provider_status`, `provider_message` and `provider_code`, when known. */
  fields: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The upstream error body's `error` object, when the body is OpenAI-shaped JSON. */
function upstreamError(body: string | undefined): Record<string, unknown> | undefined {
  if (body === undefined || body === '') return undefined;
  try {
    const parsed = JSON.parse(body) as unknown;
    return isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `error` reports something the Provider did (or failed to do), not a Gateway bug. */
export function isProviderFailure(error: unknown): boolean {
  return (
    APICallError.isInstance(error) ||
    InvalidResponseDataError.isInstance(error) ||
    JSONParseError.isInstance(error) ||
    TypeValidationError.isInstance(error) ||
    EmptyResponseBodyError.isInstance(error) ||
    // An error the Provider sent inside a 200 stream (`data: {"error": {...}}`).
    StreamProviderError.isInstance(error)
  );
}

/**
 * `provider_error` for a failed upstream call. `provider_status` is present when the Provider
 * answered with an error status (never for a failed connection, a broken success response or an
 * error sent inside a 200 stream); `provider_message` is the upstream `error.message`, else the
 * raw body (cut to 1000 characters), else the error's own message; `provider_code` is the upstream
 * `error.code` when it is a string. Any occurrence of the Connection's API key is replaced with
 * `[redacted]`.
 */
export function providerError(error: unknown, apiKey: string | undefined): MappedProviderError {
  const hide = (text: string) =>
    apiKey === undefined || apiKey === '' ? text : text.replaceAll(apiKey, '[redacted]');
  const fields: Record<string, unknown> = {};
  // Every source is redacted before anything else touches it, so a cut never splits the key.
  let message = hide(error instanceof Error ? error.message : String(error));
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    if (status !== undefined && (status < 200 || status > 299)) fields.provider_status = status;
    const upstream = upstreamError(error.responseBody);
    if (typeof upstream?.message === 'string' && upstream.message !== '') {
      message = hide(upstream.message);
    } else if (error.responseBody !== undefined && error.responseBody !== '') {
      message = hide(error.responseBody).slice(0, MAX_RAW_MESSAGE);
    }
    if (typeof upstream?.code === 'string') fields.provider_code = hide(upstream.code);
  }
  // The AI SDK's error for an in-stream `{"error": {...}}` keeps its `message` and `code`. Its
  // `statusCode` is declared or guessed from the payload, not an HTTP status, so it is not kept.
  if (StreamProviderError.isInstance(error) && typeof error.code === 'string') {
    fields.provider_code = hide(error.code);
  }
  if (message === '') message = 'The Provider call failed.';
  fields.provider_message = message;
  return {
    code: 'provider_error',
    message: `The Provider returned an error: ${message}`,
    fields,
  };
}

/** `provider_timeout` for an upstream call aborted by the first-byte or idle timeout. */
export function providerTimeout(timeoutMs: number, firstByte: boolean): MappedProviderError {
  return {
    code: 'provider_timeout',
    message: firstByte
      ? `The Provider sent no response within ${String(timeoutMs)} ms.`
      : `The Provider sent nothing for ${String(timeoutMs)} ms.`,
    fields: {},
  };
}
