import type { GatewayOptions } from '@harness-store/gateway';
import type { ConnectionStore } from './connection-store.js';
import { decryptSecret } from './connections.js';
import type { SecretCipher } from './secret-cipher.js';

/** The Model Gateway's callbacks that read the User's local data. */
export type GatewayHost = Pick<GatewayOptions, 'resolveBinding' | 'getConnection' | 'getManifest'>;

export interface GatewayHostOptions {
  readonly store: ConnectionStore;
  readonly cipher: SecretCipher;
  /** The installed Manifest of a Harness. Default: none (P0-05 installs Harnesses). */
  readonly getManifest?: GatewayOptions['getManifest'];
}

/**
 * The Runtime's side of the Model Gateway. Every callback reads SQLite when the Gateway asks, on
 * every request, with no snapshot taken at startup, so adding, disabling or removing a Connection
 * applies to the very next request without a restart.
 *
 * `getConnection` answers the Connection whose id is the requested Provider id
 * (`openai-compatible:vllm` for a custom endpoint), with its key decrypted just for this call;
 * null when there is none or it is disabled (403 `provider_not_connected`). A key that cannot be
 * decrypted rejects, which the Gateway answers with 500 `internal_error`.
 *
 * `resolveBinding` resolves nothing until the resolver arrives (P0-03.4), and `getManifest` knows
 * no Harness until installs do, so a Slot name ends in `unknown_slot`; explicit `provider/model`
 * ids already reach the User's Connections.
 */
export function createGatewayHost(options: GatewayHostOptions): GatewayHost {
  const { store, cipher } = options;
  return {
    resolveBinding: () => Promise.resolve(null),
    async getConnection(providerId) {
      const row = store.get(providerId);
      if (!row?.enabled) return null;
      return {
        ...(row.secretRef === null
          ? {}
          : { apiKey: await decryptSecret(store, cipher, row.secretRef) }),
        ...(row.baseUrl === null ? {} : { baseUrl: row.baseUrl }),
      };
    },
    getManifest: options.getManifest ?? (() => Promise.resolve(null)),
  };
}
