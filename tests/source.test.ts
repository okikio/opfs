import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { runInNewContext } from "node:vm";
import { budgetSource, createByteSource, createSourceBudget, openObjectSource, sourceRange } from "../src/source.ts";
import type { ObjectBackendType, ObjectGetOptionsType } from "../src/driver/object.ts";

/** Unused mutations deliberately fail so a source test cannot accidentally publish data. */
function backend(get: ObjectBackendType["get"], etag = '"one"'): ObjectBackendType {
  return {
    name: "source-fixture",
    identity: "https://fixture.example/bucket",
    capabilities: { rangeRead: true, streamRead: true, streamWrite: false, copy: false, conditionalWrite: false },
    head: () => Promise.resolve({ size: 4, etag }),
    get,
    put: () => Promise.reject(new Error("No writes")),
    delete: () => Promise.reject(new Error("No deletion")),
    list: () => Promise.reject(new Error("No listing")),
  };
}

describe("revision-bound byte sources", () => {
  it("owns a snapshot and rejects unsafe extents before a read", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const source = createByteSource(bytes, { identity: "fixture-v1" });
    bytes.fill(9);
    expect(await source.read(1, 2)).toEqual(new Uint8Array([2, 3]));
    expect(source.stability).toBe("immutable");
    for (const [at, length] of [[-1, 1], [0, NaN], [3, 2], [5, 0], [0.5, 1]]) {
      expect(() => sourceRange(source.size, at!, length!)).toThrow(RangeError);
    }
    const abort = new AbortController();
    abort.abort("stop");
    await expect(source.read(0, 1, { signal: abort.signal })).rejects.toBe("stop");
  });

  it("shares one budget across nested wrappers and counts failed requests", async () => {
    const ledger = createSourceBudget({ maxBytes: 3, maxRequests: 2 });
    const source = budgetSource(createByteSource(new Uint8Array(4)), ledger);
    expect(await source.read(4, 0)).toEqual(new Uint8Array());
    await source.read(0, 2);
    await source.read(2, 1);
    await expect(source.read(0, 1)).rejects.toThrow("budget");
    expect(ledger.inspect()).toEqual({ bytes: 3, requests: 2 });
    const failed = budgetSource({ size: 2, read: () => Promise.reject("network") }, ledger);
    await expect(failed.read(0, 1)).rejects.toThrow("budget");
    const fresh = createSourceBudget({ maxBytes: 2, maxRequests: 1 });
    await expect(budgetSource({ size: 2, read: () => Promise.reject("network") }, fresh).read(0, 2)).rejects.toBe(
      "network",
    );
    expect(fresh.inspect()).toEqual({ bytes: 2, requests: 1 });
  });

  it("accepts native cross-realm bytes without accepting arbitrary byte-shaped objects", async () => {
    const foreign: Uint8Array = runInNewContext("new Uint8Array([3, 5])");
    const source = budgetSource(
      { size: 2, read: () => Promise.resolve(foreign) },
      createSourceBudget({ maxBytes: 2, maxRequests: 1 }),
    );
    expect([...(await source.read(0, 2))]).toEqual([3, 5]);
  });

  it("never invents replay identity without a service namespace", async () => {
    const service = backend(() => Promise.resolve(new Blob([new Uint8Array([1])]).stream()));
    const { identity: _identity, ...anonymous } = service;
    expect((await openObjectSource(anonymous, "item")).identity).toBeUndefined();
    const first = await openObjectSource(anonymous, "item", { namespace: "bucket-one" });
    const second = await openObjectSource(anonymous, "item", { namespace: "bucket-two" });
    expect(first.identity).not.toBe(second.identity);
  });

  it("uses native extents without invoking shadowed byte metadata", async () => {
    const bytes = new Uint8Array([7, 11]);
    Object.defineProperty(bytes, "byteLength", {
      get() {
        throw new Error("shadow getter");
      },
    });
    const wrapped = budgetSource(
      { size: 2, read: () => Promise.resolve(bytes) },
      createSourceBudget({ maxBytes: 2, maxRequests: 1 }),
    );
    expect([...(await wrapped.read(0, 2))]).toEqual([7, 11]);
    const short = new Uint8Array([1]);
    Object.defineProperty(short, "byteLength", { value: 2 });
    const invalid = budgetSource(
      { size: 2, read: () => Promise.resolve(short) },
      createSourceBudget({ maxBytes: 2, maxRequests: 1 }),
    );
    await expect(invalid.read(0, 2)).rejects.toThrow("extent");
  });

  it("pins every range to the original ETag and never closes the borrowed backend", async () => {
    const requests: ObjectGetOptionsType[] = [];
    let disposed = false;
    const service = backend((_key, options) => {
      requests.push(options!);
      return Promise.resolve(new Blob([new Uint8Array([2, 3])]).stream());
    });
    service.dispose = () => {
      disposed = true;
    };
    const source = await openObjectSource(service, "item", { maxReadBytes: 2 });
    expect(await source.read(1, 2)).toEqual(new Uint8Array([2, 3]));
    expect(requests[0]?.revision).toEqual({ kind: "etag", value: '"one"' });
    expect(source.stability).toBe("provider");
    await expect(source.read(0, 3)).rejects.toThrow("maxReadBytes");
    expect(disposed).toBe(false);
  });

  it("preserves opaque immutable versions without treating them as generations or ETags", async () => {
    const calls: ObjectGetOptionsType[] = [];
    const service = backend((_key, options) => {
      calls.push(options!);
      return Promise.resolve(new Blob([new Uint8Array([9])]).stream());
    });
    service.head = () => Promise.resolve({ size: 1, revision: { kind: "version", value: "4_zOpaque_+/=" } });
    const source = await openObjectSource(service, "item");
    expect(source.stability).toBe("provider");
    expect(await source.read(0, 1)).toEqual(new Uint8Array([9]));
    expect(calls[0]?.revision).toEqual({ kind: "version", value: "4_zOpaque_+/=" });
    expect(calls[0]).not.toHaveProperty("ifMatch");
  });

  it("refuses weak revisions and keeps caller assertions visibly weaker", async () => {
    for (const tag of ['W/"one"', "*", "bare", '"one", "two"']) {
      await expect(openObjectSource(backend(() => Promise.reject("must not read"), tag), "item"))
        .rejects.toThrow("revision");
    }
    const source = await openObjectSource(backend(() => Promise.reject("must not read"), 'W/"one"'), "item", {
      assumeStable: true,
    });
    expect(source.stability).toBe("caller");
  });

  it("rejects a truncated body or a full-body fallback and cancels overflow", async () => {
    const short = await openObjectSource(
      backend(() => Promise.resolve(new Blob([new Uint8Array(1)]).stream())),
      "item",
    );
    await expect(short.read(0, 2)).rejects.toThrow("truncated");
    let cancelled = false;
    const large = await openObjectSource(
      backend(() =>
        Promise.resolve(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(4));
            },
            cancel() {
              cancelled = true;
            },
          }),
        )
      ),
      "item",
    );
    await expect(large.read(0, 2)).rejects.toThrow("exceeded");
    expect(cancelled).toBe(true);
  });

  it("cancels a stalled response on abort and releases its lock", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const source = await openObjectSource(backend(() => Promise.resolve(stream)), "item");
    const controller = new AbortController();
    const pending = source.read(0, 2, { signal: controller.signal });
    await Promise.resolve();
    controller.abort("stop");
    await expect(pending).rejects.toBe("stop");
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });
});
