import type { DriverPlanInputType } from "../src/driver/definition.ts";
import { withFileSystem } from "./reliability.ts";
import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem, FileSystemError } from "../mod.ts";
import { createObjectAdapter } from "../src/adapter/object.ts";
import {
  defineObjectDriver,
  type ObjectBackendType,
  type ObjectCopyOptionsType,
  type ObjectEntryType,
  type ObjectGetOptionsType,
  type ObjectListOptionsType,
  type ObjectListType,
  type ObjectPutOptionsType,
  type ObjectStatType,
} from "../src/driver/object.ts";

/** Materialized object and metadata retained by the in-memory provider double. */
interface StoredObjectType {
  /** Owned object bytes. */
  readonly bytes: Uint8Array;
  /** Provider-neutral metadata returned by HEAD/list operations. */
  readonly stat: ObjectStatType;
}

/** Materializes one test stream so the provider double can persist its object body. */
async function collect(source: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(source).arrayBuffer());
}

/**
 * Small provider double that preserves object-store semantics instead of
 * pretending to be a filesystem. Counters make it possible to prove when the
 * facade takes a provider-native path instead of silently downloading bytes.
 */
class MemoryObjectBackend implements ObjectBackendType {
  /** Stable adapter/provider name surfaced through the object-store contract. */
  readonly name = "object-test";
  /** Native paths the provider double deliberately claims for facade-selection tests. */
  readonly capabilities = {
    rangeRead: true,
    streamRead: true,
    streamWrite: true,
    copy: true,
    conditionalWrite: true,
  } as const;

  /** Stored objects keyed by provider object key. */
  readonly values = new Map<string, StoredObjectType>();
  /** Number of object GET operations, used to prove server-side copy avoids downloads. */
  gets = 0;
  /** Requested byte windows, independent of the returned byte oracle. */
  readonly ranges: ObjectGetOptionsType[] = [];
  /** Number of native provider copy operations. */
  copies = 0;
  /** Monotonic value used to produce deterministic synthetic ETags. */
  version = 0;
  /** Physical metadata work used to compare enabled and disabled admission routes. */
  heads = 0;
  /** Physical prefix pages read by namespace admission. */
  lists = 0;

  /** Returns metadata for one exact object key. */
  async head(key: string): Promise<ObjectStatType | null> {
    this.heads += 1;
    return this.values.get(key)?.stat ?? null;
  }

  /** Opens one full object or bounded byte range as a Web stream. */
  async get(key: string, options: ObjectGetOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    this.gets += 1;
    this.ranges.push({ ...options });
    const value = this.values.get(key);
    if (value === undefined) throw new FileSystemError("not-found", "read", key, "Object does not exist.");
    const start = options.at ?? 0;
    const end = options.length === undefined
      ? value.bytes.byteLength
      : Math.min(value.bytes.byteLength, start + options.length);
    const bytes = value.bytes.slice(start, end);
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  /** Replaces one object while enforcing the conditional-write contract. */
  async put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    options: ObjectPutOptionsType = {},
  ): Promise<ObjectStatType> {
    const bytes = body instanceof Uint8Array ? body.slice() : await collect(body);
    const current = this.values.get(key);
    if (options.ifMatch !== undefined && current?.stat.etag !== options.ifMatch) {
      throw new Error("precondition failed: if-match");
    }
    if (options.ifNoneMatch === "*" && current !== undefined) {
      throw new Error("precondition failed: if-none-match");
    }
    this.version += 1;
    const stat: ObjectStatType = {
      size: bytes.byteLength,
      lastModified: this.version,
      etag: `\"v${this.version}\"`,
      ...(options.mediaType === undefined ? {} : { mediaType: options.mediaType }),
      ...(options.metadata === undefined ? {} : { metadata: { ...options.metadata } }),
    };
    this.values.set(key, { bytes, stat });
    return stat;
  }

  /** Removes one exact object key. */
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  /** Lists provider keys and delimiter-derived prefixes under one prefix. */
  async list(options: ObjectListOptionsType): Promise<ObjectListType> {
    this.lists += 1;
    const objects: ObjectEntryType[] = [];
    const prefixes = new Set<string>();
    for (const [key, value] of this.values) {
      if (!key.startsWith(options.prefix)) continue;
      const rest = key.slice(options.prefix.length);
      if (options.delimiter !== undefined) {
        const delimiter = rest.indexOf(options.delimiter);
        if (delimiter >= 0) {
          prefixes.add(`${options.prefix}${rest.slice(0, delimiter + options.delimiter.length)}`);
          continue;
        }
      }
      objects.push({ key, ...value.stat });
    }
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    return { objects: objects.slice(0, limit), prefixes: [...prefixes].slice(0, limit) };
  }

  /** Copies one object without routing its bytes through the facade GET path. */
  async copy(source: string, destination: string, options: ObjectCopyOptionsType = {}): Promise<ObjectStatType> {
    this.copies += 1;
    const value = this.values.get(source);
    if (value === undefined) throw new Error(`missing source ${source}`);
    if (options.sourceIfMatch !== undefined && value.stat.etag !== options.sourceIfMatch) {
      throw new Error("precondition failed: source if-match");
    }
    return await this.put(destination, value.bytes, {
      ...(options.ifMatch === undefined ? {} : { ifMatch: options.ifMatch }),
      ...(options.ifNoneMatch === undefined ? {} : { ifNoneMatch: options.ifNoneMatch }),
      ...(value.stat.mediaType === undefined ? {} : { mediaType: value.stat.mediaType }),
      ...(value.stat.metadata === undefined ? {} : { metadata: value.stat.metadata }),
    });
  }
}

/** Attaches driver metadata to the deterministic object backend used by tests. */
function createMemoryObjectDriver(store: MemoryObjectBackend) {
  return defineObjectDriver(store, {
    name: store.name,
    requirements: [],
    limits: [],
    optimizations: [],
  });
}

/** Creates a facade plus its observable provider backend for one object-store test. */
function createObjectFileSystem(store = new MemoryObjectBackend(), optimizations: { writeAdmission?: boolean } = {}) {
  const driver = createMemoryObjectDriver(store);
  return {
    store,
    driver,
    fileSystem: createFileSystem(createObjectAdapter(driver), { coordination: "none", optimizations }),
  };
}

describe("object driver adapter", () => {
  for (const evidence of ["object", "prefix"] as const) {
    it(`finds ${evidence} directory evidence beyond an empty first page`, async () => {
      const store = new MemoryObjectBackend();
      const original = store.list.bind(store);
      store.list = async (options) =>
        options.prefix === "directory/"
          ? options.cursor === undefined
            ? { objects: [], prefixes: [], cursor: "opaque+token" }
            : evidence === "object"
            ? { objects: [{ key: "directory/child", size: 1 }], prefixes: [] }
            : { objects: [], prefixes: ["directory/nested/"] }
          : await original(options);
      const adapter = createObjectAdapter(createMemoryObjectDriver(store));
      expect(await adapter.stat("/directory")).toEqual({ kind: "directory" });
      await expect(adapter.writeFile("/directory", new Uint8Array([9]), { mode: "replace" }))
        .rejects.toMatchObject({ code: "type-mismatch" });
      expect(store.values.has("directory")).toBe(false);
      await store.put("directory", new Uint8Array([1]));
      await expect(adapter.stat("/directory")).rejects.toMatchObject({ code: "invalid-operation" });
    });
  }

  it("preserves a directory marker when later pages contain children", async () => {
    const store = new MemoryObjectBackend();
    await store.put("directory/", new Uint8Array(), { metadata: { okikio_opfs_kind: "directory" } });
    const original = store.list.bind(store);
    store.list = async (options) =>
      options.prefix === "directory/"
        ? options.cursor === undefined
          ? { objects: [{ key: "directory/", size: 0 }], prefixes: [], cursor: "next" }
          : { objects: [{ key: "directory/child", size: 1 }], prefixes: [] }
        : await original(options);
    const adapter = createObjectAdapter(createMemoryObjectDriver(store));
    await expect(adapter.remove("/directory")).rejects.toMatchObject({ code: "invalid-operation" });
    expect(store.values.has("directory/")).toBe(true);
  });

  it("follows exhausted empty pages, bounds scans, and rejects cursor cycles without mutation", async () => {
    const store = new MemoryObjectBackend();
    const requests: (string | undefined)[] = [];
    store.list = async (options) => {
      requests.push(options.cursor);
      return {
        objects: [],
        prefixes: [],
        ...(options.cursor === "B" ? {} : { cursor: options.cursor === undefined ? "A" : "B" }),
      };
    };
    const adapter = createObjectAdapter(createMemoryObjectDriver(store), { maxListPages: 3 });
    expect(await adapter.stat("/missing")).toBe(null);
    expect(requests).toEqual([undefined, "A", "B"]);
    store.list = async (options) => ({ objects: [], prefixes: [], cursor: options.cursor === "A" ? "B" : "A" });
    await expect(adapter.stat("/missing")).rejects.toMatchObject({ code: "invalid-operation" });
    store.list = async (options) => ({ objects: [], prefixes: [], cursor: `${options.cursor ?? ""}x` });
    await expect(adapter.writeFile("/missing", new Uint8Array([1]), { mode: "replace" }))
      .rejects.toMatchObject({ code: "too-large" });
    expect(store.values.size).toBe(0);
    expect(() => createObjectAdapter(createMemoryObjectDriver(store), { maxListPages: 0 })).toThrow(RangeError);
  });

  it("keeps listing lazy and observes abort even when a backend ignores its signal", async () => {
    const store = new MemoryObjectBackend();
    let lists = 0;
    store.list = async () => {
      lists++;
      return { objects: [{ key: "child", size: 1 }], prefixes: [], cursor: "next" };
    };
    const adapter = createObjectAdapter(createMemoryObjectDriver(store));
    for await (const entry of adapter.readDir("/")) {
      expect(entry.name).toBe("child");
      break;
    }
    expect(lists).toBe(1);
    const controller = new AbortController();
    store.list = async () => {
      controller.abort("stop during page fetch");
      return { objects: [], prefixes: [] };
    };
    await expect(adapter.stat("/missing", { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    const failure = new Error("later page unavailable");
    store.list = async (options) => {
      if (options.cursor !== undefined) throw failure;
      return { objects: [], prefixes: [], cursor: "next" };
    };
    await expect(adapter.stat("/missing")).rejects.toBe(failure);
    store.list = async () => ({ objects: [{ key: "foreign/child", size: 1 }], prefixes: [] });
    await expect(adapter.remove("/missing")).rejects.toMatchObject({ code: "invalid-operation" });
  });

  for (const stream of [false, true]) {
    for (const present of [false, true]) {
      it(`uses fresh exact destination preconditions (stream=${stream}, present=${present})`, async () => {
        const store = new MemoryObjectBackend();
        if (present) await store.put("value", new Uint8Array([1]));
        const original = store.put.bind(store);
        let condition: ObjectPutOptionsType | undefined;
        store.put = async (key, bytes, options) => {
          condition = options;
          await original(key, new Uint8Array([7])); // An outside owner publishes after admission.
          return await original(key, bytes, options);
        };
        const adapter = createObjectAdapter(createMemoryObjectDriver(store));
        const source = new Blob([new Uint8Array([9])]).stream();
        await expect(
          stream
            ? adapter.writeStream!("/value", source, { mode: "replace" })
            : adapter.writeFile("/value", new Uint8Array([9]), { mode: "replace" }),
        )
          .rejects.toThrow("precondition failed");
        expect(condition).toMatchObject(present ? { ifMatch: '"v1"' } : { ifNoneMatch: "*" });
        expect([...store.values.get("value")!.bytes]).toEqual([7]);
      });
    }
  }

  it("rejects missing conditional identity and pre-aborted streams before producer acquisition", async () => {
    const store = new MemoryObjectBackend();
    await store.put("value", new Uint8Array([1]));
    const value = store.values.get("value")!;
    store.values.set("value", { bytes: value.bytes, stat: { size: 1 } });
    const adapter = createObjectAdapter(createMemoryObjectDriver(store));
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull() {
        pulls++;
      },
    }, { highWaterMark: 0 });
    await expect(adapter.writeStream!("/value", source, { mode: "replace" })).rejects.toMatchObject({
      code: "unknown",
    });
    expect(pulls).toBe(0);
    const controller = new AbortController();
    controller.abort();
    store.heads = 0;
    await expect(adapter.writeStream!("/value", source, { mode: "replace", signal: controller.signal }))
      .rejects.toMatchObject({ code: "aborted" });
    expect(store.heads).toBe(0);
    await source.cancel();
  });

  it("treats slash-only prefixes as the root and pins native copy to admitted source identity", async () => {
    const store = new MemoryObjectBackend();
    await store.put("source", new Uint8Array([1]));
    const copy = store.copy.bind(store);
    store.copy = async (source, destination, options) => {
      await store.put(source, new Uint8Array([7]));
      return await copy(source, destination, options);
    };
    const adapter = createObjectAdapter(createMemoryObjectDriver(store), { prefix: "///" });
    expect(await adapter.stat("/source")).toMatchObject({ kind: "file", size: 1 });
    await expect(adapter.copy!("/source", "/destination", { overwrite: false }))
      .rejects.toThrow("source if-match");
    expect(store.values.has("destination")).toBe(false);
  });

  it("stops after metadata cancellation before publication even with an injected signal-ignoring backend", async () => {
    const store = new MemoryObjectBackend();
    const controller = new AbortController();
    const head = store.head.bind(store);
    store.head = async (key) => {
      controller.abort();
      return await head(key);
    };
    const adapter = createObjectAdapter(createMemoryObjectDriver(store));
    await expect(adapter.writeFile("/value", new Uint8Array([9]), { mode: "replace", signal: controller.signal }))
      .rejects.toMatchObject({ code: "aborted" });
    expect(store.values.size).toBe(0);
  });

  it("validates at the facade and adapter by default and rejects directories before adapter writes", async () => {
    const store = new MemoryObjectBackend();
    const adapter = createObjectAdapter(createMemoryObjectDriver(store));
    const write = adapter.writeFile.bind(adapter);
    let writes = 0;
    adapter.writeFile = async (...args) => {
      writes += 1;
      return await write(...args);
    };
    const fs = createFileSystem(adapter, { coordination: "none" });
    try {
      expect(fs.inspect().optimizations.writeAdmission).toBe(false);
      await fs.writeFile("/value", new Uint8Array([1]));
      store.heads = 0;
      store.lists = 0;
      writes = 0;
      await fs.writeFile("/value", new Uint8Array([2]));
      expect(store.heads).toBe(4);
      expect(store.lists).toBe(2);
      expect(writes).toBe(1);
      expect([...await fs.readFile("/value")]).toEqual([2]);
      await fs.mkdir("/directory");
      writes = 0;
      await expect(fs.writeFile("/directory", new Uint8Array([9]))).rejects.toMatchObject({ code: "type-mismatch" });
      expect(writes).toBe(0);
    } finally {
      await fs.close();
    }
  });

  for (const enabled of [true, false]) {
    it(`preserves replacement bytes and namespace validation with delegation ${enabled}`, async () => {
      const store = new MemoryObjectBackend();
      const adapter = createObjectAdapter(createMemoryObjectDriver(store));
      const fs = createFileSystem(adapter, { coordination: "none", optimizations: { writeAdmission: enabled } });
      try {
        await fs.writeFile("/value", new Uint8Array([1, 2]));
        store.heads = 0;
        store.lists = 0;
        await fs.writeFile("/value", new Uint8Array([3, 4, 5]));
        expect(store.heads).toBe(enabled ? 2 : 4);
        expect(store.lists).toBe(enabled ? 1 : 2);
        expect(fs.inspect().adapter.native.validatesReplacement).toBe(true);
        expect(fs.inspect().optimizations.writeAdmission).toBe(enabled);
        expect([...await fs.readFile("/value")]).toEqual([3, 4, 5]);
        await fs.mkdir("/directory");
        await expect(fs.writeFile("/directory", new Uint8Array([9]))).rejects.toMatchObject({ code: "type-mismatch" });
        await store.put("value/child", new Uint8Array([8]));
        await expect(fs.writeFile("/value", new Uint8Array([9]))).rejects.toMatchObject({ code: "invalid-operation" });
        expect([...store.values.get("value")!.bytes]).toEqual([3, 4, 5]);
      } finally {
        await fs.close();
      }
    });
  }

  it("keeps facade admission for custom adapters that omit the replacement guarantee", async () => {
    const store = new MemoryObjectBackend();
    const adapter = createObjectAdapter(createMemoryObjectDriver(store));
    const { validatesReplacement: _guarantee, ...capabilities } = adapter.capabilities;
    Object.assign(adapter, { capabilities });
    const fs = createFileSystem(adapter, { coordination: "none", optimizations: { writeAdmission: true } });
    try {
      await fs.writeFile("/value", new Uint8Array([1]));
      store.heads = 0;
      store.lists = 0;
      await fs.writeFile("/value", new Uint8Array([2]));
      expect(store.heads).toBe(4);
      expect(store.lists).toBe(2);
      expect([...await fs.readFile("/value")]).toEqual([2]);
    } finally {
      await fs.close();
    }
  });

  for (const enabled of [false, true]) {
    it(`keeps fresh conditional publication with delegation ${enabled}`, async () => {
      const { store, fileSystem: fs } = createObjectFileSystem(new MemoryObjectBackend(), { writeAdmission: enabled });
      try {
        await fs.writeFile("/value", new Uint8Array([1]));
        const put = store.put.bind(store);
        let precondition: string | undefined;
        store.put = async (key, body, options = {}) => {
          precondition = options.ifMatch;
          // An independent writer commits after admission but before this PUT.
          await put(key, new Uint8Array([7]));
          return await put(key, body, options);
        };
        await expect(fs.writeFile("/value", new Uint8Array([9]))).rejects.toBeInstanceOf(FileSystemError);
        expect(precondition).toBeDefined();
        expect([...store.values.get("value")!.bytes]).toEqual([7]);
      } finally {
        await fs.close();
      }
    });
  }

  it("delegates binary views but retains append, update, parent, and pre-abort admission", async () => {
    const { store, fileSystem: fs } = createObjectFileSystem(new MemoryObjectBackend(), { writeAdmission: true });
    try {
      await fs.writeFile("/value", new Uint8Array([1]));
      const bytes = new Uint8Array([8, 2, 3, 8]);
      store.heads = 0;
      await fs.writeFile("/value", new DataView(bytes.buffer, 1, 2));
      expect(store.heads).toBe(2);
      expect([...store.values.get("value")!.bytes]).toEqual([2, 3]);
      for (const mode of ["append", "update"] as const) {
        store.heads = 0;
        await fs.writeFile("/value", new Uint8Array([4]), { mode });
        expect(store.heads).toBe(4);
      }
      expect([...store.values.get("value")!.bytes]).toEqual([4, 3, 4]);
      await expect(fs.writeFile("/missing/child", bytes)).rejects.toMatchObject({ code: "not-found" });
      expect(store.values.has("missing/child")).toBe(false);
      const controller = new AbortController();
      controller.abort();
      store.heads = 0;
      await expect(fs.writeFile("/value", bytes, { signal: controller.signal })).rejects.toMatchObject({
        code: "aborted",
      });
      expect(store.heads).toBe(0);
      expect([...store.values.get("value")!.bytes]).toEqual([4, 3, 4]);
    } finally {
      await fs.close();
    }
  });

  for (const enabled of [false, true]) {
    it(`rejects destinations before source acquisition with delegation ${enabled}`, async () => {
      const { fileSystem: fs } = createObjectFileSystem(new MemoryObjectBackend(), { writeAdmission: enabled });
      let reads = 0;
      let acquisitions = 0;
      class ObservedBlob extends Blob {
        override async arrayBuffer(): Promise<ArrayBuffer> {
          reads += 1;
          return await super.arrayBuffer();
        }
      }
      const iterable = {
        async *[Symbol.asyncIterator]() {
          acquisitions += 1;
          yield new Uint8Array([1]);
        },
      };
      try {
        await fs.mkdir("/directory");
        await expect(fs.writeFile("/directory", new ObservedBlob(["content"]))).rejects.toMatchObject({
          code: "type-mismatch",
        });
        await expect(fs.writeFile("/directory", iterable)).rejects.toMatchObject({ code: "type-mismatch" });
        expect(reads).toBe(0);
        expect(acquisitions).toBe(0);
      } finally {
        await fs.close();
      }
    });
  }

  it("admits physical prefixed fallback writes without probing provider state", async () => {
    const seen: DriverPlanInputType[] = [];
    const store = Object.assign(new MemoryObjectBackend(), {
      admit(input: DriverPlanInputType) {
        seen.push(input);
        return {
          operation: input.operation,
          supported: input.source !== "bytes",
          support: input.source === "bytes" ? "unsupported" as const : "native" as const,
          problems: input.source === "bytes"
            ? [{
              code: "native-limit",
              layer: "driver" as const,
              severity: "error" as const,
              message: "Single-request bytes rejected.",
            }]
            : [],
          actions: [],
        };
      },
    });
    const adapter = createObjectAdapter(createMemoryObjectDriver(store), { prefix: "owned/prefix" });
    const fs = createFileSystem(adapter, { optimizations: { nativeCopy: false, streamWrite: false } });
    try {
      const plan = fs.plan({ operation: "write", path: "/value", source: "stream", size: 1 });
      expect(plan.supported).toBe(false);
      expect(seen.at(-1)).toMatchObject({ operation: "write", path: "/owned/prefix/value", source: "bytes" });
      expect(fs.plan({ operation: "copy", path: "/source", destination: "/target", size: 1 }).supported).toBe(false);
      expect(seen.at(-1)).toMatchObject({ operation: "write", path: "/owned/prefix/target", source: "bytes" });
      expect(store.values.size).toBe(0);
      expect(store.gets).toBe(0);
      expect(store.copies).toBe(0);
    } finally {
      await fs.close();
    }
  });

  it("preserves empty directories and implicit prefix directories", async () => {
    const fixture = createObjectFileSystem();
    const { store } = fixture;
    const fileSystem = fixture.fileSystem;
    await withFileSystem(fileSystem, async () => {
      await fileSystem.mkdir("/empty", { recursive: true });
      await store.put("external/nested.txt", new TextEncoder().encode("outside marker"));
      expect(store.values.has("external/")).toBe(false);

      expect((await fileSystem.stat("/empty")).kind).toBe("directory");
      expect((await fileSystem.stat("/external")).kind).toBe("directory");
      expect(store.values.has("empty/")).toBe(true);
      expect(store.values.get("empty/")?.stat.metadata).toEqual({ okikio_opfs_kind: "directory" });

      const names: string[] = [];
      for await (const entry of fileSystem.readDir("/")) names.push(entry.name);
      expect(names.sort()).toEqual(["empty", "external"]);
    });
  });

  it("rejects ambiguous foreign file/prefix identities without deleting either", async () => {
    const fixture = createObjectFileSystem();
    const { store } = fixture;
    const fileSystem = fixture.fileSystem;
    await withFileSystem(fileSystem, async () => {
      await store.put("mixed", new TextEncoder().encode("file"));
      await store.put("mixed/child.txt", new TextEncoder().encode("child"));

      await expect(fileSystem.stat("/mixed")).rejects.toMatchObject({ code: "invalid-operation" });
      await expect(fileSystem.writeFile("/mixed", "updated")).rejects.toMatchObject({ code: "invalid-operation" });
      await expect(fileSystem.remove("/mixed", { recursive: true })).rejects.toMatchObject({
        code: "invalid-operation",
      });
      expect(await store.head("mixed")).not.toBe(null);
      expect(await store.head("mixed/child.txt")).not.toBe(null);
    });
  });

  it("uses ranged object reads without materializing the complete object", async () => {
    const fixture = createObjectFileSystem();
    const { store } = fixture;
    const fileSystem = fixture.fileSystem;
    await withFileSystem(fileSystem, async () => {
      await fileSystem.writeFile("/range.txt", "0123456789", { parents: true });
      store.ranges.length = 0;
      expect(new TextDecoder().decode(await fileSystem.readFile("/range.txt", { at: 3, length: 4 }))).toBe("3456");
      expect(store.ranges).toHaveLength(1);
      expect(store.ranges[0]).toMatchObject({ at: 3, length: 4 });
    });
  });

  it("applies append and update as optimistic read-modify-write operations", async () => {
    const fixture = createObjectFileSystem();
    const fileSystem = fixture.fileSystem;
    await withFileSystem(fileSystem, async () => {
      await fileSystem.writeFile("/state.txt", "hello", { parents: true });
      await fileSystem.writeFile("/state.txt", " world", { mode: "append" });
      await fileSystem.writeFile("/state.txt", "OPFS", { mode: "update", at: 6 });
      expect(await fileSystem.readText("/state.txt")).toBe("hello OPFSd");
    });
  });

  it("can disable native copy and exposes the emulated route through inspection and metrics", async () => {
    const store = new MemoryObjectBackend();
    const fileSystem = createFileSystem(createObjectAdapter(createMemoryObjectDriver(store)), {
      coordination: "none",
      optimizations: { nativeCopy: false },
      metrics: "basic",
    });
    await withFileSystem(fileSystem, async () => {
      await fileSystem.writeFile("/source.bin", new Uint8Array([1, 2, 3]), {
        parents: true,
        mediaType: "application/x-test",
      });
      store.gets = 0;
      store.copies = 0;

      expect(fileSystem.inspect().support.copy).toBe("emulated");
      expect(fileSystem.plan({ operation: "copy", size: 3 }).support).toBe("emulated");
      await fileSystem.copy("/source.bin", "/copy.bin");

      expect(store.copies).toBe(0);
      expect(store.gets).toBeGreaterThan(0);
      expect([...await fileSystem.readFile("/copy.bin")]).toEqual([1, 2, 3]);
      const stat = await fileSystem.stat("/copy.bin");
      expect(stat.kind).toBe("file");
      if (stat.kind === "file") expect(stat.mediaType).toBe("application/x-test");
    });
  });

  it("rejects an oversized emulated copy when its streaming read route is disabled", async () => {
    const store = new MemoryObjectBackend();
    const fileSystem = createFileSystem(createObjectAdapter(createMemoryObjectDriver(store)), {
      coordination: "none",
      optimizations: { nativeCopy: false, streamRead: false },
      maxBufferedWriteBytes: 2,
    });
    await withFileSystem(fileSystem, async () => {
      await fileSystem.writeFile("/source.bin", new Uint8Array([1, 2, 3]), { parents: true });

      const plan = fileSystem.plan({ operation: "copy", size: 3 });
      expect(plan.supported).toBe(false);
      await expect(fileSystem.copy("/source.bin", "/copy.bin")).rejects.toMatchObject({ code: "too-large" });
    });
  });

  it("fails an oversized streamed copy before opening the source when direct stream writes are disabled", async () => {
    const store = new MemoryObjectBackend();
    const fileSystem = createFileSystem(createObjectAdapter(createMemoryObjectDriver(store)), {
      coordination: "none",
      optimizations: { nativeCopy: false, streamWrite: false },
      maxBufferedWriteBytes: 2,
    });
    await withFileSystem(fileSystem, async () => {
      await fileSystem.writeFile("/source.bin", new Uint8Array([1, 2, 3]), { parents: true });
      store.gets = 0;

      const plan = fileSystem.plan({ operation: "copy", size: 3 });
      expect(plan.supported).toBe(false);
      await expect(fileSystem.copy("/source.bin", "/copy.bin")).rejects.toMatchObject({ code: "too-large" });
      expect(store.gets).toBe(0);
    });
  });

  it("uses provider copy without opening the source stream", async () => {
    const fixture = createObjectFileSystem();
    const { store } = fixture;
    const fileSystem = fixture.fileSystem;
    await withFileSystem(fileSystem, async () => {
      await fileSystem.writeFile("/source.bin", new Uint8Array([1, 2, 3]), { parents: true });
      store.gets = 0;

      await fileSystem.copy("/source.bin", "/copy.bin");

      expect(store.copies).toBe(1);
      expect(store.gets).toBe(0);
      expect([...await fileSystem.readFile("/copy.bin")]).toEqual([1, 2, 3]);
    });
  });

  it("streams a replacement directly to a streaming object store", async () => {
    const fixture = createObjectFileSystem();
    const { store } = fixture;
    const fileSystem = fixture.fileSystem;
    await withFileSystem(fileSystem, async () => {
      let pulled = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array([pulled]));
          if (pulled === 3) controller.close();
        },
      });

      await fileSystem.writeFile("/stream.bin", source, { parents: true });
      expect([...store.values.get("stream.bin")!.bytes]).toEqual([1, 2, 3]);
    });
  });
});
