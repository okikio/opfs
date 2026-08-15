import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem } from "../mod.ts";
import {
  createObjectAdapter,
  type ObjectCopyOptionsType,
  type ObjectEntryType,
  type ObjectGetOptionsType,
  type ObjectListOptionsType,
  type ObjectListType,
  type ObjectPutOptionsType,
  type ObjectStatType,
  type ObjectStoreType,
} from "../src/adapter/object.ts";

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
class MemoryObjectStore implements ObjectStoreType {
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
  /** Number of native provider copy operations. */
  copies = 0;
  /** Monotonic value used to produce deterministic synthetic ETags. */
  version = 0;

  /** Returns metadata for one exact object key. */
  async head(key: string): Promise<ObjectStatType | null> {
    return this.values.get(key)?.stat ?? null;
  }

  /** Opens one full object or bounded byte range as a Web stream. */
  async get(key: string, options: ObjectGetOptionsType = {}): Promise<ReadableStream<Uint8Array>> {
    this.gets += 1;
    const value = this.values.get(key);
    if (value === undefined) return new Response(null, { status: 404 }).body!;
    const start = options.at ?? 0;
    const end = options.length === undefined ? value.bytes.byteLength : Math.min(value.bytes.byteLength, start + options.length);
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
    const current = this.values.get(key);
    if (options.ifMatch !== undefined && current?.stat.etag !== options.ifMatch) {
      throw new Error("precondition failed: if-match");
    }
    if (options.ifNoneMatch === "*" && current !== undefined) {
      throw new Error("precondition failed: if-none-match");
    }
    const bytes = body instanceof Uint8Array ? body.slice() : await collect(body);
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
      ...(value.stat.mediaType === undefined ? {} : { mediaType: value.stat.mediaType }),
      ...(value.stat.metadata === undefined ? {} : { metadata: value.stat.metadata }),
    });
  }
}

/** Creates a facade plus its observable provider double for one object-store test. */
function createObjectFileSystem(store = new MemoryObjectStore()) {
  return {
    store,
    fileSystem: createFileSystem(createObjectAdapter(store), { coordination: "none" }),
  };
}

describe("object-store adapter", () => {
  it("preserves empty directories and implicit prefix directories", async () => {
    const { store, fileSystem } = createObjectFileSystem();
    await fileSystem.mkdir("/empty", { recursive: true });
    await fileSystem.writeFile("/external/nested.txt", "outside marker", { parents: true });

    expect((await fileSystem.stat("/empty")).kind).toBe("directory");
    expect((await fileSystem.stat("/external")).kind).toBe("directory");
    expect(store.values.has("empty/")).toBe(true);

    const names: string[] = [];
    for await (const entry of fileSystem.readDir("/")) names.push(entry.name);
    expect(names.sort()).toEqual(["empty", "external"]);
  });

  it("prefers an exact file when foreign objects also create the same prefix", async () => {
    const { store, fileSystem } = createObjectFileSystem();
    await store.put("mixed", new TextEncoder().encode("file"));
    await store.put("mixed/child.txt", new TextEncoder().encode("child"));

    expect((await fileSystem.stat("/mixed")).kind).toBe("file");
    await fileSystem.writeFile("/mixed", "updated");
    expect(await fileSystem.readText("/mixed")).toBe("updated");
  });

  it("uses ranged object reads without materializing the complete object", async () => {
    const { fileSystem } = createObjectFileSystem();
    await fileSystem.writeFile("/range.txt", "0123456789", { parents: true });
    expect(new TextDecoder().decode(await fileSystem.readFile("/range.txt", { at: 3, length: 4 }))).toBe("3456");
  });

  it("applies append and update as optimistic read-modify-write operations", async () => {
    const { fileSystem } = createObjectFileSystem();
    await fileSystem.writeFile("/state.txt", "hello", { parents: true });
    await fileSystem.writeFile("/state.txt", " world", { mode: "append" });
    await fileSystem.writeFile("/state.txt", "OPFS", { mode: "update", at: 6 });
    expect(await fileSystem.readText("/state.txt")).toBe("hello OPFSd");
  });

  it("can disable native copy and exposes the emulated route through inspection and metrics", async () => {
    const store = new MemoryObjectStore();
    const fileSystem = createFileSystem(createObjectAdapter(store), {
      coordination: "none",
      optimizations: { nativeCopy: false },
      metrics: "basic",
    });
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
    await fileSystem.close();
  });


  it("rejects an oversized emulated copy when its streaming read route is disabled", async () => {
    const store = new MemoryObjectStore();
    const fileSystem = createFileSystem(createObjectAdapter(store), {
      coordination: "none",
      optimizations: { nativeCopy: false, streamRead: false },
      maxBufferedWriteBytes: 2,
    });
    await fileSystem.writeFile("/source.bin", new Uint8Array([1, 2, 3]), { parents: true });

    const plan = fileSystem.plan({ operation: "copy", size: 3 });
    expect(plan.supported).toBe(false);
    await expect(fileSystem.copy("/source.bin", "/copy.bin")).rejects.toMatchObject({ code: "too-large" });
    await fileSystem.close();
  });

  it("fails an oversized streamed copy before opening the source when direct stream writes are disabled", async () => {
    const store = new MemoryObjectStore();
    const fileSystem = createFileSystem(createObjectAdapter(store), {
      coordination: "none",
      optimizations: { nativeCopy: false, streamWrite: false },
      maxBufferedWriteBytes: 2,
    });
    await fileSystem.writeFile("/source.bin", new Uint8Array([1, 2, 3]), { parents: true });
    store.gets = 0;

    const plan = fileSystem.plan({ operation: "copy", size: 3 });
    expect(plan.supported).toBe(false);
    await expect(fileSystem.copy("/source.bin", "/copy.bin")).rejects.toMatchObject({ code: "too-large" });
    expect(store.gets).toBe(0);
    await fileSystem.close();
  });

  it("uses provider copy without opening the source stream", async () => {
    const { store, fileSystem } = createObjectFileSystem();
    await fileSystem.writeFile("/source.bin", new Uint8Array([1, 2, 3]), { parents: true });
    store.gets = 0;

    await fileSystem.copy("/source.bin", "/copy.bin");

    expect(store.copies).toBe(1);
    expect(store.gets).toBe(0);
    expect([...await fileSystem.readFile("/copy.bin")]).toEqual([1, 2, 3]);
  });

  it("streams a replacement directly to a streaming object store", async () => {
    const { store, fileSystem } = createObjectFileSystem();
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
