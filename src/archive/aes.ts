/** Internal WinZip AES native primitives. Format framing and resource admission remain in the ZIP reader. @module */
import { ArchiveError } from "./record.ts";

/** Native cryptography is explicitly supplied; no import-time global capability is acquired. */
export interface ZipAesOptionsType {
  readonly subtle: SubtleCrypto;
  /** Whole ciphertext buffer bound, default 8 MiB. Implementation ceiling 8 MiB. Native HMAC copies it twice. */
  readonly maxCiphertextBytes?: number;
  /** Serial native AES block-call allowance, default 8192. Implementation ceiling 8192. */
  readonly maxBlocks?: number;
}

/** Authenticated ciphertext with one owned native key; retirement stops further operations but cannot erase native memory. */
export interface ZipAesStateType {
  decryptBlock(offset: number, bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
  clear(): void;
}

/**
 * Authenticate the entire bounded ciphertext before exposing a decryption capability.
 * The WinZip tag truncates HMAC-SHA1 to ten bytes. Constructing a complete candidate tag
 * from the archived prefix and computed suffix lets native verify compare all bytes.
 * This deliberately performs two complete native HMAC passes, not a JavaScript tag comparison.
 */
export async function openZipAes(
  password: Uint8Array<ArrayBuffer>,
  salt: Uint8Array<ArrayBuffer>,
  verifier: Uint8Array<ArrayBuffer>,
  ciphertext: Uint8Array<ArrayBuffer>,
  tag: Uint8Array<ArrayBuffer>,
  options: ZipAesOptionsType,
  signal?: AbortSignal,
): Promise<ZipAesStateType> {
  const subtle = options.subtle;
  const keySize = salt.length * 2;
  let material: Uint8Array<ArrayBuffer> | undefined;
  let key: CryptoKey | undefined;
  signal?.throwIfAborted();
  try {
    const input = await subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
    signal?.throwIfAborted();
    material = new Uint8Array(
      await subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-1", salt, iterations: 1000 },
        input,
        (keySize * 2 + 2) * 8,
      ),
    );
    signal?.throwIfAborted();
    if (material[keySize * 2] !== verifier[0] || material[keySize * 2 + 1] !== verifier[1]) {
      throw new ArchiveError(
        "checksum-mismatch",
        "WinZip AES password verifier failed; wrong password or corrupt data.",
      );
    }
    const authentication = await subtle.importKey(
      "raw",
      material.subarray(keySize, keySize * 2),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign", "verify"],
    );
    signal?.throwIfAborted();
    const expected = new Uint8Array(await subtle.sign("HMAC", authentication, ciphertext));
    signal?.throwIfAborted();
    expected.set(tag, 0);
    const verified = await subtle.verify("HMAC", authentication, expected, ciphertext);
    signal?.throwIfAborted();
    expected.fill(0);
    if (!verified) throw new ArchiveError("checksum-mismatch", "WinZip AES ciphertext authentication failed.");
    key = await subtle.importKey("raw", material.subarray(0, keySize), "AES-CTR", false, ["decrypt"]);
    signal?.throwIfAborted();
  } finally {
    material?.fill(0);
  }
  return {
    async decryptBlock(offset, bytes) {
      signal?.throwIfAborted();
      if (!key) throw new TypeError("WinZip AES state has retired.");
      if (!Number.isSafeInteger(offset) || offset < 0 || offset % 16 || bytes.length > 16) {
        throw new RangeError("WinZip AES native calls require one aligned block of at most sixteen bytes.");
      }
      // WinZip increments a little-endian counter before each block. Native AES-CTR
      // increments big-endian, so never submit more than one block per native call.
      const counter = new Uint8Array(16);
      new DataView(counter.buffer).setBigUint64(0, BigInt(offset / 16) + 1n, true);
      const plain = new Uint8Array(await subtle.decrypt({ name: "AES-CTR", counter, length: 128 }, key, bytes));
      signal?.throwIfAborted();
      return plain;
    },
    clear() {
      key = undefined;
    },
  };
}
