// e2ee.ts — E2EE boundary (P0-1 placeholder, noop)
// P2 will inject WebCrypto implementation. Keep interface stable.
export interface Crypto {
  encrypt(plain: string): Promise<string>;
  decrypt(cipher: string): Promise<string>;
}

export const noopCrypto: Crypto = {
  async encrypt(plain: string): Promise<string> {
    return plain;
  },
  async decrypt(cipher: string): Promise<string> {
    return cipher;
  },
};
