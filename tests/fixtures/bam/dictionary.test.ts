/** Node-only native zlib oracle for the authored maximum-distance RFC 1951 history vector. */
import { describe, it } from "node:test";
import { Buffer } from "node:buffer";
import { inflateRawSync } from "node:zlib";
import { expect } from "@std/expect";

/** LSB-first integer fields; fixed Huffman code integers are explicitly bit-reversed. */
function packed(): Uint8Array {
  // BFINAL, fixed BTYPE, length 3, distance symbol 29 + 13 extra bits (32768), end-of-block.
  const fields = [[1, 1], [1, 2], [64, 7], [23, 5], [8191, 13], [0, 7]] as const;
  const bytes = new Uint8Array(5);
  let at = 0;
  for (const [value, width] of fields) {
    for (let bit = 0; bit < width; bit++, at++) bytes[at >>> 3]! |= (value >>> bit & 1) << (at & 7);
  }
  return bytes;
}

describe("Node native raw-DEFLATE dictionary oracle", () => {
  it("reads the complete authored maximum-distance history match without candidate code", () => {
    const history = new Uint8Array(32768);
    history.set([12, 34, 56]);
    const before = history.slice();
    expect(inflateRawSync(packed(), { dictionary: history })).toEqual(Buffer.from([12, 34, 56]));
    expect(history).toEqual(before);
  });
});
