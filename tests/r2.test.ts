import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createR2Client, R2Error, R2PublicationError } from "../src/r2.ts";
import type { R2BindingType, R2ObjectType } from "../src/r2.ts";
import { createR2Driver } from "../src/driver/r2.ts";
import { createR2Adapter } from "../src/adapter/r2.ts";

// Authored binding-contract fixture. This does not establish Workers or remote R2 conformance.
function object(key = "a", size = 3): R2ObjectType {
  return {
    key,
    size,
    version: "opaque-upload-id",
    etag: "abc",
    httpEtag: '"abc"',
    uploaded: new Date(0),
    customMetadata: {},
  };
}
function binding(overrides: Partial<R2BindingType> = {}): R2BindingType {
  return {
    head: (key) => Promise.resolve(key === "a" ? object() : null),
    get: () => Promise.resolve({ ...object(), body: new Blob(["abc"]).stream() }),
    put: (key, bytes, options) =>
      Promise.resolve({
        ...object(key, bytes.byteLength),
        ...(options?.customMetadata === undefined ? {} : { customMetadata: options.customMetadata }),
        ...(options?.httpMetadata === undefined ? {} : { httpMetadata: options.httpMetadata }),
      }),
    delete: () => Promise.resolve(),
    list: () => Promise.resolve({ objects: [], truncated: false, delimitedPrefixes: [] }),
    ...overrides,
  };
}
describe("injected R2 binding contract", () => {
  it("does no acquisition and preserves actual HTTP validator separately from upload version", async () => {
    let calls = 0;
    const client = createR2Client(binding({
      head: () => {
        calls++;
        return Promise.resolve(object());
      },
    }));
    expect(calls).toBe(0);
    expect(await client.head("a")).toMatchObject({
      etag: '"abc"',
      version: "opaque-upload-id",
      revision: { kind: "etag", value: '"abc"' },
    });
    expect(calls).toBe(1);
  });
  it("uses native ranges and ETag Headers, including clamped EOF", async () => {
    const client = createR2Client(binding({
      get: (key, options) => {
        expect(key).toBe("a");
        expect(options?.range).toEqual({ offset: 1, length: 9 });
        expect(options?.onlyIf?.get("if-match")).toBe('"abc"');
        return Promise.resolve({ ...object(), range: { offset: 1, length: 2 }, body: new Blob(["bc"]).stream() });
      },
    }));
    expect(
      await new Response(await client.get("a", { at: 1, length: 9, revision: { kind: "etag", value: '"abc"' } }))
        .text(),
    ).toBe("bc");
  });
  it("recognizes metadata-only conditional failure and native put null", async () => {
    const client = createR2Client(binding({ get: () => Promise.resolve(object()), put: () => Promise.resolve(null) }));
    await expect(client.get("a", { revision: { kind: "etag", value: '"old"' } })).rejects.toBeInstanceOf(R2Error);
    await expect(client.put("a", new Uint8Array(), { ifNoneMatch: "*" })).rejects.toMatchObject({ code: "locked" });
    const adapter = createR2Adapter(client);
    await expect(adapter.writeFile("/a", new Uint8Array(), { mode: "replace" })).rejects.toMatchObject({
      code: "locked",
    });
  });
  it("refuses unsupported revision, conditional deletion and stream upload before IO", async () => {
    let calls = 0;
    const client = createR2Client(binding({
      delete: () => {
        calls++;
        return Promise.resolve();
      },
      get: () => {
        calls++;
        return Promise.resolve(null);
      },
      put: () => {
        calls++;
        return Promise.resolve(null);
      },
    }));
    await expect(client.get("a", { revision: { kind: "version", value: "upload-id" } })).rejects.toThrow();
    await expect(client.delete("a", { revision: { kind: "etag", value: '"abc"' } })).rejects.toThrow();
    await expect(client.put("a", new Blob().stream())).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("keeps unknown dispatch outcomes distinct from known conditional failures", async () => {
    let calls = 0;
    const client = createR2Client(binding({
      put: () => {
        calls++;
        throw new Error("connection gone");
      },
    }));
    await expect(client.put("a", new Uint8Array([1]))).rejects.toBeInstanceOf(R2PublicationError);
    expect(calls).toBe(1);
    await expect(
      createR2Client(binding({ put: () => Promise.resolve(object("different")) })).put("a", new Uint8Array(3)),
    ).rejects.toMatchObject({ outcome: "unknown" });
  });
  it("admits native extents rather than shadowed Uint8Array lengths", async () => {
    const bytes = new Uint8Array(3);
    Object.defineProperty(bytes, "byteLength", { value: 0 });
    let calls = 0;
    const client = createR2Client(
      binding({
        put: () => {
          calls++;
          return Promise.resolve(object());
        },
      }),
      { maxUploadBytes: 2 },
    );
    await expect(client.put("a", bytes)).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("validates ranges, short bodies and cancels rejected receipt bodies", async () => {
    let cancelled = false;
    const client = createR2Client(
      binding({
        get: () =>
          Promise.resolve({
            ...object(),
            range: { offset: 0, length: 2 },
            body: new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          }),
      }),
    );
    await expect(client.get("a", { at: 1, length: 2 })).rejects.toThrow();
    expect(cancelled).toBe(true);
    const short = createR2Client(
      binding({ get: () => Promise.resolve({ ...object(), body: new Blob(["a"]).stream() }) }),
    );
    await expect(new Response(await short.get("a")).arrayBuffer()).rejects.toThrow();
  });
  it("cancels a blocked body read when the caller aborts", async () => {
    let cancelled: unknown;
    const abort = new AbortController();
    const client = createR2Client(
      binding({
        get: () =>
          Promise.resolve({
            ...object(),
            body: new ReadableStream({
              cancel(reason) {
                cancelled = reason;
              },
            }),
          }),
      }),
    );
    const reading = new Response(await client.get("a", { signal: abort.signal })).arrayBuffer();
    abort.abort("stop");
    await expect(reading).rejects.toBe("stop");
    expect(cancelled).toBe("stop");
  });
  it("retains opaque cursors through empty native pages and requests metadata", async () => {
    const client = createR2Client(binding({
      list: (request) => {
        expect(request?.include).toEqual(["httpMetadata", "customMetadata"]);
        return Promise.resolve({ objects: [], delimitedPrefixes: [], truncated: true, cursor: "opaque+/=" });
      },
    }));
    expect(await client.list({ prefix: "" })).toEqual({ objects: [], prefixes: [], cursor: "opaque+/=" });
  });
  it("keeps upload policies separate from existing readable size and performs no plan IO", () => {
    const driver = createR2Driver(binding(), { maxUploadBytes: 2 });
    expect(driver.plan({ operation: "write", size: 3 }).supported).toBe(false);
    expect(driver.plan({ operation: "read", size: 3 }).supported).toBe(true);
    expect(driver.capabilities.streamWrite).toBe(false);
  });
});
