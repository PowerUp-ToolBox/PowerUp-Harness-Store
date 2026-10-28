import type { GatewayOptions } from '@harness-store/gateway';
import { resolveHarnessSlot } from './bindings.js';
import type { ConnectionStore } from './connection-store.js';
import { decryptSecret } from './connections.js';
import type { InstallStore } from './install-store.js';
import type { SecretCipher } from './secret-cipher.js';

/** The Model Gateway's callbacks that read the User's local data. */
export type GatewayHost = Pick<GatewayOptions, 'resolveBinding' | 'getConnection' | 'getManifest'>;

export interface GatewayHostOptions {
  readonly store: ConnectionStore;
  readonly cipher: SecretCipher;
  /** The installed Harnesses (the `installs` table), whose Manifests declare the Model Slots. */
  readonly installs: Pick<InstallStore, 'get'>;
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
 * `resolveBinding` runs the normative order ({@link resolveHarnessSlot}) over the Harness's Model
 * Overrides, the Recommended Models of its installed Manifest, the Default Models and the enabled
 * Connections as they are now, so an override or Default Model set, changed or cleared, or a
 * Connection disabled or removed, applies to the next request. `getManifest` answers the installed
 * Manifest, read from the `installs` table on every request, so a Harness installed or replaced
 * declares its Slots from its next request on.
 */
export function createGatewayHost(options: GatewayHostOptions): GatewayHost {
  const { store, cipher, installs } = options;
  const manifestOf = (harnessId: string) => installs.get(harnessId)?.manifest ?? null;
  return {
    resolveBinding: ({ harnessId, slot }) =>
      Promise.resolve(resolveHarnessSlot(store, manifestOf(harnessId), harnessId, slot)),
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
    getManifest: (harnessId) => Promise.resolve(manifestOf(harnessId)),
  };
}
