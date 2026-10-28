/**
 * The Model Gateway over HTTP, exactly as any third-party Harness reaches it: the base URL and
 * the Gateway Token come from `HARNESS_GATEWAY_URL` and `HARNESS_GATEWAY_TOKEN`, read at call
 * time. Wire behaviour: docs/tech/gateway-protocol.md.
 */
import OpenAI from 'openai';
import type { ClientOptions } from 'openai';
import { readEnv } from './context.js';
import { GatewayError } from './errors.js';

/** The `openai` client options a caller may set; the base URL and key always come from the env. */
export type OpenAIClientOptions = Omit<ClientOptions, 'baseURL' | 'apiKey'>;

/**
 * The official `openai` client, pointed at the Model Gateway with the Gateway Token. Send a Model
 * Slot name (`Slots.default`) as `model`. Retries are off unless `opts.maxRetries` says otherwise:
 * the Gateway never needs them, and a retried 409 or 502 only repeats the failure.
 */
export function createOpenAIClient(opts: OpenAIClientOptions = {}): OpenAI {
  const env = gatewayEnv();
  return new OpenAI({
    ...opts,
    // After the spread, so `{ maxRetries: undefined }` still means none (openai would read it as 2).
    maxRetries: opts.maxRetries ?? 0,
    baseURL: env.HARNESS_GATEWAY_URL,
    apiKey: env.HARNESS_GATEWAY_TOKEN,
  });
}

/**
 * `fetch` against the Model Gateway: `path` is relative to `HARNESS_GATEWAY_URL` (which already
 * ends in `/v1`), so `gatewayFetch('/models')` calls `<HARNESS_GATEWAY_URL>/models`. The Gateway
 * Token replaces any `Authorization` header in `init`; other headers are kept. The response comes
 * back as it is, whatever its status. Rejects with `NotInHarnessStoreError` when the Gateway
 * variables are not set.
 */
export async function gatewayFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const env = gatewayEnv();
  const url = `${env.HARNESS_GATEWAY_URL.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${env.HARNESS_GATEWAY_TOKEN}`);
  return await fetch(url, { ...init, headers });
}

/** A Model Slot the Harness's Manifest declares and what it is bound to right now. */
export interface SlotInfo {
  /** The Slot name, what to send as `model`. */
  name: string;
  /** The Slot Binding as `provider/model`, `null` when no model is bound to the Slot. */
  resolvedModel: string | null;
}

/**
 * Every Model Slot the Manifest declares, in Manifest order, with its current binding
 * (`GET /v1/models`). Throws {@link GatewayError} when the Gateway does not answer 2xx.
 */
export async function listSlots(): Promise<SlotInfo[]> {
  const body = await getJson<{ data: { id: string; resolved_model: string | null }[] }>('/models');
  return body.data.map((model) => ({ name: model.id, resolvedModel: model.resolved_model }));
}

/** A Model Slot's Model Requirements, as the Manifest declares them. Advisory only. */
export interface ModelRequirements {
  tools?: boolean;
  /** Minimum context window, in tokens. */
  minContext?: number;
  vision?: boolean;
  json?: boolean;
}

/** The body of `GET /v1/harness/context`, with the wire field names. */
export interface GatewayContext {
  harnessId: string;
  /** The Harness Version. */
  version: string;
  /** The app's locale at launch. */
  locale: string;
  /** Present only when the launch has a Workspace. */
  workspace?: string;
  /** Every Model Slot the Manifest declares; never binding data (see {@link listSlots}). */
  slots: Record<string, { description?: string; requirements: ModelRequirements }>;
}

/**
 * What the Model Gateway knows about this launch (`GET /v1/harness/context`): the Gateway Token's
 * claims and the Manifest's Model Slots. Throws {@link GatewayError} when it does not answer 2xx.
 */
export function getGatewayContext(): Promise<GatewayContext> {
  return getJson<GatewayContext>('/harness/context');
}

async function getJson<T>(path: string): Promise<T> {
  const response = await gatewayFetch(path);
  if (!response.ok) throw await GatewayError.fromResponse(response);
  return (await response.json()) as T;
}

function gatewayEnv() {
  return readEnv(['HARNESS_GATEWAY_URL', 'HARNESS_GATEWAY_TOKEN']);
}
