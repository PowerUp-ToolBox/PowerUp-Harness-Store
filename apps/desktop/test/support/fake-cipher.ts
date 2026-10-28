import type { SecretCipher } from '../../src/main/runtime/secret-cipher.js';

const MARKER = new TextEncoder().encode('fake-cipher:');

/** A reversible in-memory stand-in for Electron's safeStorage, whose availability a test sets. */
export interface FakeCipher extends SecretCipher {
  available: boolean;
  /** How many times `decrypt` ran. */
  readonly decrypts: number;
  /** `decrypt`, synchronously, for a test to read what was stored. */
  reveal(ciphertext: Uint8Array): string;
  /**
   * Holds every `decrypt` (as a keychain prompt does) until the returned function is called, so
   * a test can act while one is pending.
   */
  holdDecrypts(): () => void;
}

/**
 * Encrypts by flipping every byte and prefixing a marker, so the ciphertext never contains the
 * plaintext and only this fake can read it back. Like safeStorage, `encrypt` and `decrypt` reject
 * while unavailable, and `decrypt` rejects anything it did not produce.
 */
export function createFakeCipher(available = true): FakeCipher {
  let decrypts = 0;
  let held: Promise<void> | null = null;
  const reveal = (ciphertext: Uint8Array) => {
    const marker = ciphertext.subarray(0, MARKER.length);
    if (!marker.every((byte, index) => byte === MARKER[index])) {
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.');
    }
    return new TextDecoder().decode(ciphertext.subarray(MARKER.length).map((byte) => byte ^ 0xff));
  };
  return {
    available,
    get decrypts() {
      return decrypts;
    },
    reveal,
    isAvailable() {
      return Promise.resolve(this.available);
    },
    encrypt(plaintext) {
      if (!this.available) return Promise.reject(new Error('Encryption is not available.'));
      const bytes = new TextEncoder().encode(plaintext).map((byte) => byte ^ 0xff);
      return Promise.resolve(new Uint8Array([...MARKER, ...bytes]));
    },
    async decrypt(ciphertext) {
      decrypts += 1;
      await Promise.resolve();
      if (held !== null) await held;
      if (!this.available) throw new Error('Decryption is not available.');
      return reveal(ciphertext);
    },
    holdDecrypts() {
      let release!: () => void;
      held = new Promise((resolve) => {
        release = () => {
          held = null;
          resolve();
        };
      });
      return release;
    },
  };
}
