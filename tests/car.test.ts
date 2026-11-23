import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { readFile } from "node:fs/promises";
import { createByteSource, createSourceBudget } from "../src/source.ts";
import { openCar } from "../src/content/car.ts";

const fixture = async (): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await readFile(new URL("./fixtures/car/carv1-basic.car", import.meta.url)));
const root = "bafyreihyrpefhacm6kkp4ql6j6udakdit7g3dmkzfriqfykhjw6cad5lrm";
const raw = "bafkreifw7plhl6mofk6sfvhnfh64qmkq73oeqwl6sloru6rehaoujituke";

describe("CAR v1 block access", () => {
  it("indexes official IPLD producer bytes against independent expected layout and hashes", async () => {
    const bytes = await fixture();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    expect([...digest].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe(
      "543ff9c45bbcb5c439e8f8683115cf97fc5de6bb14175a749055304427c33c2e",
    );
    const car = await openCar(createByteSource(bytes));
    expect(car.roots[0]).toBe(root);
    expect(car.entries.length).toBe(8);
    expect(car.entries[0]).toEqual({ cid: root, offset: 137, size: 55, integrity: "unchecked" });
    const block = await car.read(raw);
    expect(block.integrity).toBe("sha2-256");
    expect(new TextDecoder().decode(block.bytes)).toBe("cccc");
    let count = 0;
    for await (const block of car.blocks()) {
      expect(block.integrity).toBe("sha2-256");
      count++;
    }
    expect(count).toBe(8);
  });
  it("does not label indexing as verification and rejects a corrupt selected block", async () => {
    const bytes = await fixture();
    bytes[362] = 0;
    const car = await openCar(createByteSource(bytes));
    expect(car.entries[2]?.integrity).toBe("unchecked");
    await expect(car.read(raw)).rejects.toThrow("digest mismatch");
    expect((await car.read(root)).integrity).toBe("sha2-256");
  });
  it("rejects unsupported section hashes and overlong frame varints", async () => {
    const bytes = await fixture();
    const unsupported = new Uint8Array(bytes);
    unsupported[328] = 0;
    await expect(openCar(createByteSource(unsupported))).rejects.toThrow("multihash");
    const oversized = new Uint8Array(bytes.length + 1);
    oversized[0] = bytes[0]! | 128;
    oversized[1] = 0;
    oversized.set(bytes.subarray(1), 2);
    await expect(openCar(createByteSource(oversized))).rejects.toThrow("Non-minimal");
  });
  it("rejects truncated frames, malformed header, duplicate blocks and policy overruns", async () => {
    const bytes = await fixture();
    await expect(openCar(createByteSource(bytes.slice(0, -1)))).rejects.toThrow();
    const invalid = bytes.slice();
    invalid[1] = 0xa1;
    await expect(openCar(createByteSource(invalid))).rejects.toThrow("header");
    const duplicate = new Uint8Array(bytes.length + 41);
    duplicate.set(bytes);
    duplicate.set(bytes.subarray(325, 366), bytes.length);
    await expect(openCar(createByteSource(duplicate))).rejects.toThrow("Duplicate");
    for (
      const options of [{ maxHeaderBytes: 10 }, { maxBlocks: 2 }, { maxRoots: 1 }, { maxArchiveBytes: 100 }, {
        maxBlockBytes: 3,
      }, { budget: createSourceBudget({ maxBytes: 20, maxRequests: 1 }) }]
    ) {
      await expect(openCar(createByteSource(bytes), options)).rejects.toThrow();
    }
  });
  it("performs no further physical reads after iterator return and refuses aborted reads", async () => {
    const car = await openCar(createByteSource(await fixture()));
    for await (const _block of car.blocks()) break;
    const consumed = car.budget.inspect();
    await Promise.resolve();
    expect(car.budget.inspect()).toEqual(consumed);
    const abort = new AbortController();
    abort.abort("stop");
    await expect(car.read(root, { signal: abort.signal })).rejects.toBe("stop");
    expect(car.budget.inspect()).toEqual(consumed);
  });
});
