import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { CloudflareKvPublicationError, createCloudflareKvDriver } from "../src/driver/cloudflare-kv.ts";
import type { CloudflareKvBindingType } from "../src/driver/cloudflare-kv.ts";
import { createCloudflareKvAdapter } from "../src/adapter/cloudflare-kv.ts";

// Authored binding contract; fixture visibility is immediate, while real KV is explicitly eventual.
function fixture() {
  const entries = new Map<string, { bytes: ArrayBuffer; metadata?: object }>();
  const calls: string[] = [];
  const binding: CloudflareKvBindingType = {
    getWithMetadata(key, options) {
      calls.push(`get:${key}`);
      expect(options.type).toBe("stream");
      const entry = entries.get(key);
      return Promise.resolve({
        value: entry ? new Blob([entry.bytes]).stream() : null,
        metadata: entry?.metadata ?? null,
      });
    },
    put(key, bytes, options) {
      calls.push(`put:${key}`);
      entries.set(key, { bytes, ...(options?.metadata === undefined ? {} : { metadata: options.metadata }) });
      return Promise.resolve();
    },
    delete(key) {
      calls.push(`delete:${key}`);
      entries.delete(key);
      return Promise.resolve();
    },
    list(options) {
      calls.push("list");
      return Promise.resolve({
        keys: [...entries].filter(([name]) => name.startsWith(options?.prefix ?? "")).map(([name, entry]) => ({
          name,
          metadata: entry.metadata,
        })),
        list_complete: true,
      });
    },
  };
  return { binding, calls, entries };
}
const metadata = { opfs: 1, key: "a", size: 3, metadata: {} };
describe("injected Workers KV contract", () => {
  it("does no discovery, writes raw bytes with one associated envelope, and slices bounded reads", async () => {
    const f = fixture();
    const driver = createCloudflareKvDriver(f.binding, { prefix: "owned/v1/" });
    expect(f.calls).toEqual([]);
    await driver.put("a", new TextEncoder().encode("abc"), { metadata: { note: "authored" } });
    expect([...f.entries.keys()]).toEqual(["owned/v1/a"]);
    expect(f.entries.get("owned/v1/a")?.bytes.byteLength).toBe(3);
    expect(await new Response(await driver.get("a", { at: 1, length: 1 })).text()).toBe("b");
    expect(await driver.head("a")).toEqual({ size: 3, metadata: { note: "authored" } });
    expect(driver.consistency).toBe("eventual");
    expect(driver.capabilities.conditionalWrite).toBe(false);
    expect(driver.capabilities.rangeRead).toBe(false);
  });
  it("rejects conditions and revisions before native IO", async () => {
    const f = fixture();
    const driver = createCloudflareKvDriver(f.binding, { prefix: "owned/" });
    await expect(driver.put("a", new Uint8Array(), { ifNoneMatch: "*" })).rejects.toThrow();
    await expect(driver.get("a", { revision: { kind: "etag", value: '"x"' } })).rejects.toThrow();
    await expect(driver.delete("a", { revision: { kind: "version", value: "x" } })).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it("rejects foreign, copied or malformed envelopes rather than taking ownership", async () => {
    for (const info of [null, { ...metadata, opfs: 2 }, { ...metadata, key: "other" }, { ...metadata, extra: true }]) {
      let cancelled = false;
      const f = fixture();
      f.binding.getWithMetadata = () =>
        Promise.resolve({
          metadata: info,
          value: new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        });
      await expect(createCloudflareKvDriver(f.binding, { prefix: "owned/" }).head("a")).rejects.toThrow();
      expect(cancelled).toBe(true);
    }
  });
  it("cancels over-budget metadata before collecting any value bytes", async () => {
    const f = fixture();
    let cancelled = false;
    f.binding.getWithMetadata = () =>
      Promise.resolve({
        metadata,
        value: new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      });
    await expect(createCloudflareKvDriver(f.binding, { prefix: "owned/", maxReadBytes: 2 }).get("a")).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
  it("aborts a blocked full-value read and releases its reader", async () => {
    const f = fixture();
    let cancelled: unknown;
    const abort = new AbortController();
    f.binding.getWithMetadata = () =>
      Promise.resolve({
        metadata,
        value: new ReadableStream({
          cancel(reason) {
            cancelled = reason;
          },
        }),
      });
    const reading = createCloudflareKvDriver(f.binding, { prefix: "owned/" }).get("a", { signal: abort.signal });
    await Promise.resolve();
    await Promise.resolve();
    abort.abort("stop");
    await expect(reading).rejects.toBe("stop");
    expect(cancelled).toBe("stop");
  });
  it("rejects short/oversized values and shadowed upload extents", async () => {
    const f = fixture();
    f.entries.set("owned/a", { bytes: new Uint8Array(2).buffer, metadata });
    const driver = createCloudflareKvDriver(f.binding, { prefix: "owned/", maxUploadBytes: 2 });
    await expect(driver.get("a")).rejects.toThrow();
    const bytes = new Uint8Array(3);
    Object.defineProperty(bytes, "byteLength", { value: 0 });
    await expect(driver.put("a", bytes)).rejects.toThrow();
    expect(f.calls.filter((call) => call.startsWith("put:"))).toEqual([]);
  });
  it("preserves empty-page opaque cursors and expiration facts", async () => {
    const f = fixture();
    f.binding.list = (options) =>
      Promise.resolve(
        options?.cursor === undefined
          ? { keys: [], list_complete: false, cursor: "next+/=" }
          : { keys: [{ name: "owned/a", metadata, expiration: 123456 }], list_complete: true },
      );
    const driver = createCloudflareKvDriver(f.binding, { prefix: "owned/" });
    expect(await driver.listKeys({ prefix: "" })).toEqual({ keys: [], cursor: "next+/=" });
    expect(await driver.listKeys({ prefix: "", cursor: "next+/=" })).toEqual({
      keys: [{ key: "a", size: 3, metadata: {}, expiration: 123456 }],
    });
  });
  it("refuses listing collisions and nonadvancing cursors", async () => {
    const f = fixture();
    const driver = createCloudflareKvDriver(f.binding, { prefix: "owned/" });
    f.binding.list = () => Promise.resolve({ keys: [{ name: "foreign/a", metadata }], list_complete: true });
    await expect(driver.listKeys({ prefix: "" })).rejects.toThrow();
    f.binding.list = () => Promise.resolve({ keys: [], list_complete: false, cursor: "same" });
    await expect(driver.listKeys({ prefix: "", cursor: "same" })).rejects.toThrow();
  });
  it("retains native dispatch uncertainty without replay", async () => {
    const f = fixture();
    let calls = 0;
    f.binding.put = () => {
      calls++;
      throw new Error("lost acknowledgement");
    };
    await expect(createCloudflareKvDriver(f.binding, { prefix: "owned/" }).put("a", new Uint8Array())).rejects
      .toBeInstanceOf(CloudflareKvPublicationError);
    expect(calls).toBe(1);
  });
  it("passes explicit TTLs and keeps borrowed adapter directory markers in one native record", async () => {
    const f = fixture();
    const put = f.binding.put;
    f.binding.put = (key, bytes, options) => {
      expect(options?.expirationTtl).toBe(60);
      return put(key, bytes, options);
    };
    const adapter = createCloudflareKvAdapter(f.binding, { prefix: "owned/", expirationTtl: 60 });
    await adapter.createDir("/dir");
    expect(f.entries.has("owned/dir/")).toBe(true);
    expect(f.entries.get("owned/dir/")?.metadata).toMatchObject({
      opfs: 1,
      key: "dir/",
      size: 0,
      metadata: { okikio_opfs_kind: "directory" },
    });
    await adapter.dispose?.();
    expect(f.entries.has("owned/dir/")).toBe(true);
  });
  it("rejects oversized metadata, key aliases, and unsupported TTL before IO", async () => {
    const f = fixture();
    expect(() => createCloudflareKvDriver(f.binding, { prefix: "owned/", cacheTtl: 29 })).toThrow();
    const driver = createCloudflareKvDriver(f.binding, { prefix: "owned/" });
    await expect(driver.put("a", new Uint8Array(), { metadata: { huge: "x".repeat(1024) } })).rejects.toThrow();
    await expect(driver.put("\ud800", new Uint8Array())).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
});
