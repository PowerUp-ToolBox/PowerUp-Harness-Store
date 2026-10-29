import { describe, expect, it } from 'vitest';
import { GatewayError, isSlotUnbound, SlotUnboundError } from '../src/index.js';

/** The Gateway's 409 body, gateway-protocol.md §4 step 5. */
const unboundBody = {
  code: 'slot_unbound',
  slot: 'fast',
  message: 'No model is bound to the Model Slot "fast"',
  type: 'harness_store',
};

/** What the `openai` client throws for that answer: the error body's `error`, flattened. */
const openAIShaped = Object.assign(new Error('409 No model is bound'), {
  status: 409,
  code: 'slot_unbound',
  error: unboundBody,
});

describe('isSlotUnbound', () => {
  it('recognises a SlotUnboundError', () => {
    expect(isSlotUnbound(new SlotUnboundError('fast'))).toBe(true);
  });

  it('recognises the shape of the openai client error, by `code` or by `error.code`', () => {
    expect(isSlotUnbound(openAIShaped)).toBe(true);
    expect(isSlotUnbound({ status: 409, code: 'slot_unbound' })).toBe(true);
    expect(isSlotUnbound({ status: 409, error: { code: 'slot_unbound' } })).toBe(true);
  });

  it.each([
    ['a network error', new TypeError('fetch failed')],
    ['a connection error with no status', { status: undefined, code: null, error: undefined }],
    ['a 502', { status: 502, code: 'provider_error', error: { code: 'provider_error' } }],
    ['another 409', { status: 409, code: 'conflict' }],
    ['slot_unbound with another status', { status: 400, code: 'slot_unbound' }],
    ['a plain GatewayError', new GatewayError(404, 'unknown_slot', 'Unknown Slot')],
    ['null', null],
    ['a string', 'slot_unbound'],
  ])('is false for %s', (_name, err) => {
    expect(isSlotUnbound(err)).toBe(false);
  });
});

describe('SlotUnboundError', () => {
  it('is a GatewayError carrying the 409 code and the Slot', () => {
    const error = new SlotUnboundError('fast');
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'SlotUnboundError',
      status: 409,
      code: 'slot_unbound',
      slot: 'fast',
    });
    expect(error.message).toContain('fast');
  });

  it('turns a recognised openai client error into the typed error', () => {
    const error = SlotUnboundError.from(openAIShaped);
    expect(error).toBeInstanceOf(SlotUnboundError);
    expect(error).toMatchObject({ slot: 'fast', message: unboundBody.message });
  });

  it('returns a SlotUnboundError as it is', () => {
    const error = new SlotUnboundError('smart');
    expect(SlotUnboundError.from(error)).toBe(error);
  });

  it('returns undefined for any other error', () => {
    expect(SlotUnboundError.from(new Error('boom'))).toBeUndefined();
    expect(SlotUnboundError.from({ status: 502, code: 'provider_error' })).toBeUndefined();
  });
});

describe('GatewayError.fromResponse', () => {
  it('carries the status, code, message and Slot of the error body', async () => {
    const response = Response.json(
      { error: { code: 'unknown_slot', message: 'Unknown Slot', type: 'harness_store' } },
      { status: 404 },
    );
    const error = await GatewayError.fromResponse(response);
    expect(error).not.toBeInstanceOf(SlotUnboundError);
    expect(error).toMatchObject({
      name: 'GatewayError',
      status: 404,
      code: 'unknown_slot',
      message: 'Unknown Slot',
      slot: undefined,
    });
  });

  it('gives a 409 slot_unbound body as a SlotUnboundError', async () => {
    const response = Response.json({ error: unboundBody }, { status: 409 });
    const error = await GatewayError.fromResponse(response);
    expect(error).toBeInstanceOf(SlotUnboundError);
    expect(error.slot).toBe('fast');
  });

  it('reads a body that is not JSON as code unknown', async () => {
    const error = await GatewayError.fromResponse(new Response('Bad Gateway', { status: 502 }));
    expect(error).toMatchObject({ status: 502, code: 'unknown' });
    expect(error.message).toContain('502');
  });
});
