import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createByteSource } from "../src/source.ts";
import { testByteSource } from "../src/testing/source.ts";

describe("external source conformance", () => {
  it("checks independent bytes and retires the fixture after success", async () => {
    let closed = false;
    await testByteSource(() => ({
      source: createByteSource(new Uint8Array([2, 3, 5, 7])),
      expected: new Uint8Array([2, 3, 5, 7]),
      close() {
        closed = true;
      },
    }));
    expect(closed).toBe(true);
  });
  it("preserves an incorrect extension failure and cleanup failure independently", async () => {
    const cleanup = new Error("cleanup");
    await expect(testByteSource(() => ({
      source: createByteSource(new Uint8Array([1, 2])),
      expected: new Uint8Array([2, 1]),
      close() {
        throw cleanup;
      },
    }))).rejects.toMatchObject({ errors: [expect.any(Error), cleanup] });
  });

  it("checks native oracle and result extents rather than caller properties", async () => {
    const bytes = new Uint8Array([2, 3]);
    Object.defineProperty(bytes, "byteLength", {
      get() {
        throw new Error("shadow getter");
      },
    });
    await testByteSource(() => ({
      source: createByteSource(bytes),
      expected: bytes,
      close() {},
    }));
  });
});
