/** Internal legacy ZIP password state. This cipher is obsolete and provides no authentication. @module */
import { isBytes, toView } from "../bytes.ts";
import { ArchiveError, integer } from "./record.ts";

/** One sequential legacy cipher state; independent reads must never reuse it. */
export interface ZipCryptoType {
  decrypt(bytes: Uint8Array): Uint8Array;
  clear(): void;
}

/** Bounds and copies caller bytes before any source await; no password encoding is guessed or cached. */
export function createZipCrypto(password: Uint8Array, maximum = 1024): ZipCryptoType {
  integer(maximum, "maxPasswordBytes");
  if (!isBytes(password)) throw new TypeError("ZIP password must be explicit byte data.");
  const input = toView(password);
  if (input.byteLength > maximum) throw new ArchiveError("budget-exceeded", "ZIP password exceeds maxPasswordBytes.");
  const bytes = new Uint8Array(input);
  let first = 0x12345678;
  let second = 0x23456789;
  let third = 0x34567890;
  let active = true;
  const crc = (state: number, byte: number): number => {
    state ^= byte;
    for (let bit = 0; bit < 8; bit++) state = state >>> 1 ^ ((state & 1) ? 0xedb88320 : 0);
    return state >>> 0;
  };
  const update = (byte: number): void => {
    first = crc(first, byte);
    // The protocol multiplies modulo 2^32; ordinary Number multiplication loses low bits.
    second = (Math.imul((second + (first & 255)) >>> 0, 134775813) + 1) >>> 0;
    third = crc(third, second >>> 24);
  };
  try {
    for (const byte of bytes) update(byte);
  } finally {
    bytes.fill(0);
  }
  return {
    decrypt(input: Uint8Array): Uint8Array {
      if (!active) throw new TypeError("ZIP password state has retired.");
      const output = new Uint8Array(input);
      for (let index = 0; index < output.length; index++) {
        const temporary = (third | 2) & 0xffff;
        const byte = output[index]! ^ ((Math.imul(temporary, temporary ^ 1) >>> 8) & 255);
        output[index] = byte;
        update(byte);
      }
      return output;
    },
    clear(): void {
      first = second = third = 0;
      active = false;
    },
  };
}
