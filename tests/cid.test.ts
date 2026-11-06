import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeHex } from "@std/encoding/hex";
import { parseCid, readUnsigned, verifyBlock } from "../src/content/cid.ts";

// The current primary CID spec gives these exact bytes for the raw block "hello".
const hello = "015512202cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe("bounded content identifiers", () => {
  it("reads the primary spec raw hello vector and verifies the complete block", async () => {
    const cid = parseCid(`f${hello}`);
    expect(cid.version).toBe(1);
    expect(cid.codec).toBe(0x55);
    expect(parseCid(cid.id).bytes).toEqual(decodeHex(hello));
    await verifyBlock(cid.id, new TextEncoder().encode("hello"));
    await expect(verifyBlock(cid.id, new TextEncoder().encode("hell"))).rejects.toThrow("digest mismatch");
  });
  it("normalizes the official CAR fixture CIDv0 without changing its DAG-PB codec", () => {
    const cid = parseCid("QmNX6Tffavsya4xgBi2VJQnSuqy9GsxongxZZ9uZBqp16d");
    expect(cid.version).toBe(0);
    expect(cid.codec).toBe(0x70);
    expect(parseCid(cid.id).digest).toEqual(cid.digest);
  });
  it("refuses ambiguous encodings, reserved versions, trailing and truncated digests", () => {
    for (
      const value of [
        "",
        "b!",
        "zQmNX6Tffavsya4xgBi2VJQnSuqy9GsxongxZZ9uZBqp16d",
        `f${hello}00`,
        `f${hello.slice(0, -2)}`,
        `f02${hello.slice(2)}`,
        "b".repeat(513),
      ]
    ) {
      expect(() => parseCid(value)).toThrow();
    }
    expect(() => readUnsigned(new Uint8Array([0x81, 0]))).toThrow("Non-minimal");
    expect(() => readUnsigned(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]))).toThrow();
    expect(() => readUnsigned(new Uint8Array([0x80]))).toThrow();
  });
  it("refuses unsupported hashes and over-budget blocks before hashing", async () => {
    await expect(verifyBlock("f0155000161", new Uint8Array([97]))).rejects.toThrow("Unsupported");
    await expect(verifyBlock(`f${hello}`, new Uint8Array(5), { maxBytes: 4 })).rejects.toThrow("byte limit");
    const abort = new AbortController();
    abort.abort("stop");
    await expect(verifyBlock(`f${hello}`, new Uint8Array(), { signal: abort.signal })).rejects.toBe("stop");
  });
});
