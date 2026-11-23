import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { Sha256 } from "../src/archive/sha256.ts";

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** Deterministic bytes, so a failure names a reproducible input. */
function bytes(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  let state = seed >>> 0 || 1;
  for (let index = 0; index < length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[index] = state & 255;
  }
  return out;
}

describe("incremental SHA-256", () => {
  it("matches the FIPS 180-4 examples", () => {
    const cases = [
      ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
      [
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
      ],
    ];
    for (const [text, digest] of cases) {
      const hash = new Sha256();
      hash.update(new TextEncoder().encode(text));
      expect(hash.hex()).toBe(digest);
    }
  });
  it("agrees with Web Crypto at every padding boundary and chunk size", async () => {
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 4096, 65537]) {
      const input = bytes(length, length + 7);
      const expected = hex(await crypto.subtle.digest("SHA-256", input));
      for (const step of [1, 7, 63, 64, 65, 1000, Math.max(1, length)]) {
        const hash = new Sha256();
        for (let at = 0; at < length; at += step) hash.update(input.subarray(at, at + step));
        expect(hash.hex()).toBe(expected);
      }
    }
  });
  it("starts a new message after reset", () => {
    const hash = new Sha256();
    hash.update(bytes(100, 3));
    hash.hex();
    hash.reset();
    hash.update(new TextEncoder().encode("abc"));
    expect(hex(hash.digest())).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
