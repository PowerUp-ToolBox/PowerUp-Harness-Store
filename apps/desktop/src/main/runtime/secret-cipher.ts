import type { SafeStorage } from 'electron';

/**
 * Encrypts Connection secrets (API keys) and the Publisher's Store session for the `secrets`
 * table. The app uses Electron's `safeStorage`, backed by the OS keychain
 * ({@link createSafeStorageCipher}); tests pass a reversible in-memory fake. There is no plaintext
 * fallback: when {@link isAvailable} resolves false, the Runtime refuses to store either.
 */
export interface SecretCipher {
  /** Whether secrets can be encrypted on this machine right now. */
  isAvailable(): Promise<boolean>;
  /** Rejects when encryption is unavailable. */
  encrypt(plaintext: string): Promise<Uint8Array>;
  /** Rejects when the ciphertext cannot be decrypted (another OS user, a reset keychain). */
  decrypt(ciphertext: Uint8Array): Promise<string>;
}

/**
 * A {@link SecretCipher} over Electron's asynchronous `safeStorage` API (the synchronous one is
 * deprecated). On Linux, the `basic_text` backend (used when no keyring such as GNOME Keyring or
 * KWallet answers) encrypts with a password hard-coded in Chromium, which is plaintext in all but
 * name, so it counts as unavailable. `safeStorage` is only usable once the app is ready.
 *
 * `decryptStringAsync` may report that a secret should be re-encrypted after a key rotation; the
 * secret still decrypts, and is re-encrypted the next time the User replaces the key.
 */
export function createSafeStorageCipher(
  safeStorage: Pick<
    SafeStorage,
    | 'isAsyncEncryptionAvailable'
    | 'getSelectedStorageBackend'
    | 'encryptStringAsync'
    | 'decryptStringAsync'
  >,
  platform: NodeJS.Platform,
): SecretCipher {
  const isAvailable = async () =>
    (await safeStorage.isAsyncEncryptionAvailable()) &&
    (platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  return {
    isAvailable,
    async encrypt(plaintext) {
      if (!(await isAvailable())) throw new Error('OS encryption for secrets is not available.');
      return safeStorage.encryptStringAsync(plaintext);
    },
    async decrypt(ciphertext) {
      return (await safeStorage.decryptStringAsync(Buffer.from(ciphertext))).result;
    },
  };
}
