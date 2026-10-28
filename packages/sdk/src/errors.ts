/**
 * Typed errors for Model Gateway answers (docs/tech/gateway-protocol.md §5). The Gateway's error
 * body is `{ "error": { "code", "message", "type", ... } }`; these classes carry its `code`.
 *
 * Errors from the `openai` client are recognised by their shape, never with `instanceof`, so a
 * Harness that bundles its own copy of `openai` gets the same answers.
 */

/** A Model Gateway answer that was not 2xx. */
export class GatewayError extends Error {
  override readonly name: string = 'GatewayError';
  /** The HTTP status. */
  readonly status: number;
  /** The Gateway's error code (`invalid_token`, `slot_unbound`, ...), `unknown` when it sent none. */
  readonly code: string;
  /** The Model Slot the error is about, when the Gateway named one. */
  readonly slot: string | undefined;

  constructor(status: number, code: string, message: string, slot?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.slot = slot;
  }

  /** The error for a Gateway response that was not 2xx, from its JSON error body. */
  static async fromResponse(response: Response): Promise<GatewayError> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const error = isRecord(body) && isRecord(body.error) ? body.error : {};
    const code = typeof error.code === 'string' ? error.code : 'unknown';
    const message =
      typeof error.message === 'string'
        ? error.message
        : `Model Gateway answered ${String(response.status)}`;
    const slot = typeof error.slot === 'string' ? error.slot : undefined;
    if (response.status === 409 && code === 'slot_unbound') {
      return new SlotUnboundError(slot ?? '', message);
    }
    return new GatewayError(response.status, code, message, slot);
  }
}

/**
 * No model is bound to the Model Slot (409 `slot_unbound`): the User has to bind one in Harness
 * Store, on the Models page. Show that, rather than a generic failure.
 */
export class SlotUnboundError extends GatewayError {
  override readonly name: string = 'SlotUnboundError';
  override readonly code = 'slot_unbound';
  override readonly slot: string;

  constructor(slot: string, message = `No model is bound to the Model Slot "${slot}"`) {
    super(409, 'slot_unbound', message, slot);
    this.slot = slot;
  }

  /**
   * The typed error for an error {@link isSlotUnbound} recognises (such as the `openai` client's
   * 409 error), with `slot` taken from its `error.slot`; `undefined` for any other error.
   */
  static from(err: unknown): SlotUnboundError | undefined {
    if (err instanceof SlotUnboundError) return err;
    if (!isSlotUnbound(err) || !isRecord(err)) return undefined;
    const body = isRecord(err.error) ? err.error : {};
    const slot =
      typeof body.slot === 'string' ? body.slot : typeof err.slot === 'string' ? err.slot : '';
    const message =
      typeof body.message === 'string'
        ? body.message
        : err instanceof Error
          ? err.message
          : undefined;
    return new SlotUnboundError(slot, message);
  }
}

/**
 * True for a {@link SlotUnboundError}, and for any error shaped like the Gateway's 409
 * `slot_unbound` answer as the `openai` client surfaces it: `status` 409 and a `code` or
 * `error.code` of `slot_unbound`. False for everything else, network errors and 502s included.
 */
export function isSlotUnbound(err: unknown): boolean {
  if (err instanceof SlotUnboundError) return true;
  if (!isRecord(err) || err.status !== 409) return false;
  return err.code === 'slot_unbound' || (isRecord(err.error) && err.error.code === 'slot_unbound');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
