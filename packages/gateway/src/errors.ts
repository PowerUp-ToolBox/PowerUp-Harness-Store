/**
 * The Model Gateway's error responses (gateway-protocol.md §5). Every error, whatever produced it,
 * is `{ error: { code, message, type, ... } }` at the HTTP status its code fixes.
 */

/** Every error code the Gateway emits, with its HTTP status. */
export const GATEWAY_ERROR_STATUS = {
  invalid_request: 400,
  invalid_token: 401,
  invalid_host: 403,
  provider_not_connected: 403,
  not_supported: 404,
  unknown_slot: 404,
  slot_unbound: 409,
  internal_error: 500,
  provider_error: 502,
  provider_timeout: 504,
} as const;

export type GatewayErrorCode = keyof typeof GATEWAY_ERROR_STATUS;

/** `provider` for the codes that report an upstream failure, `harness_store` for the rest. */
export type GatewayErrorType = 'harness_store' | 'provider';

export interface GatewayErrorBody {
  error: {
    code: GatewayErrorCode;
    message: string;
    type: GatewayErrorType;
    /** Code-specific fields, e.g. `slot` for `slot_unbound`, `provider_status` for `provider_error`. */
    [field: string]: unknown;
  };
}

export function errorType(code: GatewayErrorCode): GatewayErrorType {
  return code === 'provider_error' || code === 'provider_timeout' ? 'provider' : 'harness_store';
}

export function errorBody(
  code: GatewayErrorCode,
  message: string,
  fields: Record<string, unknown> = {},
): GatewayErrorBody {
  return { error: { ...fields, code, message, type: errorType(code) } };
}

/** The complete HTTP response for an error. */
export function errorResponse(
  code: GatewayErrorCode,
  message: string,
  fields?: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(errorBody(code, message, fields)), {
    status: GATEWAY_ERROR_STATUS[code],
    headers: { 'content-type': 'application/json' },
  });
}
