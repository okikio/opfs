import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createZipStream } from "../../src/archive/zip/write.ts";
import type { ZipWriteEntryType } from "../../src/archive/zip/write.ts";
import { openZip } from "../../src/archive/zip/mod.ts";
import { createByteSource } from "../../src/source.ts";

const encode = (value: string) => new TextEncoder().encode(value);
const collect = async (stream: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(stream).arrayBuffer());
function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at < chunks.length) controller.enqueue(chunks[at++]!);
      else controller.close();
    },
  }, { highWaterMark: 0 });
}

describe("streaming ZIP32 writer", () => {
  it("writes stored data descriptors, deterministic timestamps and UTF8 names", async () => {
    const bytes = await collect(
      createZipStream([{ name: "folder/", kind: "directory" }, {
        name: "folder/é.txt",
        source: stream([encode("ab"), encode("c")]),
      }, { name: "empty.txt" }]),
    );
    const zip = await openZip(createByteSource(bytes));
    expect(zip.entries.map((entry) => [entry.name, entry.size, entry.method, entry.directory])).toEqual([
      ["folder/", 0, 0, true],
      ["folder/é.txt", 3, 0, false],
      ["empty.txt", 0, 0, false],
    ]);
    expect((await zip.read(1, { verify: true })).bytes).toEqual(encode("abc"));
    expect(zip.entries[1]!.crc32).toBe(0x352441c2); // Independent published CRC32 abc known answer.
    const local = new DataView(bytes.buffer);
    expect(local.getUint16(6, true)).toBe(0x0808);
    expect(local.getUint16(12, true)).toBe(33);
    expect(local.getUint32(14, true)).toBe(0);
    expect(
      await collect(
        createZipStream([{ name: "folder/", kind: "directory" }, {
          name: "folder/é.txt",
          source: stream([encode("a"), encode("bc")]),
        }, { name: "empty.txt" }]),
      ),
    ).toEqual(bytes);
  });
  it("emits an interoperable empty archive end record", async () => {
    const bytes = await collect(createZipStream([]));
    expect(bytes.byteLength).toBe(22);
    expect((await openZip(createByteSource(bytes))).entries).toEqual([]);
  });
  it("does not acquire iterators or entry readers until demanded", async () => {
    let started = 0;
    let reads = 0;
    function* entries() {
      started++;
      yield {
        name: "file",
        source: new ReadableStream<Uint8Array>({
          pull() {
            reads++;
          },
        }, { highWaterMark: 0 }),
      };
    }
    const output = createZipStream(entries());
    expect(started).toBe(0);
    const reader = output.getReader();
    await reader.read();
    expect(started).toBe(1);
    expect(reads).toBe(0);
    await reader.cancel();
    reader.releaseLock();
    expect(reads).toBe(0);
  });
  it("pulls one source chunk per payload demand and copies queued producer bytes", async () => {
    let reads = 0;
    const data = encode("abc");
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(data);
      },
    }, { highWaterMark: 0 });
    const reader = createZipStream([{ name: "file", source }]).getReader();
    await reader.read();
    expect(reads).toBe(0);
    const payload = await reader.read();
    expect(reads).toBe(1);
    data.fill(0);
    expect(payload.value).toEqual(encode("abc"));
    await reader.cancel();
    reader.releaseLock();
    expect(source.locked).toBe(false);
  });
  it("cancels a blocked active source and retires the entries iterator", async () => {
    let cancelled = 0;
    let returned = 0;
    const source = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelled++;
      },
    }, { highWaterMark: 0 });
    async function* entries() {
      try {
        yield { name: "file", source };
      } finally {
        returned++;
      }
    }
    const reader = createZipStream(entries()).getReader();
    await reader.read();
    const pending = reader.read();
    await Promise.resolve();
    await Promise.resolve();
    await reader.cancel("stop");
    await pending;
    reader.releaseLock();
    expect(cancelled).toBe(1);
    expect(returned).toBe(1);
    expect(source.locked).toBe(false);
  });
  it("preserves source failure together with cleanup failures", async () => {
    const cause = new Error("source failure");
    const cleanup = new Error("iterator cleanup");
    async function* entries() {
      try {
        yield {
          name: "file",
          source: new ReadableStream<Uint8Array>({
            pull() {
              throw cause;
            },
          }, { highWaterMark: 0 }),
        };
      } finally {
        await Promise.reject(cleanup);
      }
    }
    const output = createZipStream(entries());
    try {
      await collect(output);
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([cause, cleanup]);
    }
  });
  it("reports source cancellation failure while releasing the acquired lock", async () => {
    const cleanup = new Error("cancel cleanup");
    const source = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        return Promise.reject(cleanup);
      },
    }, { highWaterMark: 0 });
    const reader = createZipStream([{ name: "file", source }]).getReader();
    await reader.read();
    const pending = reader.read();
    await Promise.resolve();
    await Promise.resolve();
    await expect(reader.cancel()).rejects.toBe(cleanup);
    await pending;
    reader.releaseLock();
    expect(source.locked).toBe(false);
  });
  it("honors external abort during a pending source read", async () => {
    let cancelled = 0;
    const controller = new AbortController();
    const source = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelled++;
      },
    }, { highWaterMark: 0 });
    const reader = createZipStream([{ name: "file", source }], { signal: controller.signal }).getReader();
    await reader.read();
    const pending = reader.read();
    await Promise.resolve();
    await Promise.resolve();
    const cause = new Error("abort");
    controller.abort(cause);
    await expect(pending).rejects.toBe(cause);
    // Allow the abort owner's observed cleanup to settle after error delivery.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(1);
    expect(source.locked).toBe(false);
    reader.releaseLock();
  });
  it("rejects bad names, duplicate aliases and file/directory collisions", async () => {
    for (
      const name of [
        "/abs",
        "../up",
        "a/../b",
        "a//b",
        "a\\b",
        "C:drive",
        "a/./b",
        "a\0b",
        "a ",
        "con.txt",
        "e\u0301",
        "a/",
      ]
    ) await expect(collect(createZipStream([{ name }]))).rejects.toThrow();
    for (const names of [["A", "a"], ["a", "a/b"], ["a/b", "a"]]) {
      await expect(collect(createZipStream(names.map((name) => ({ name }))))).rejects.toThrow();
    }
  });
  it("rejects link kinds and nonempty directories before acquiring source readers", async () => {
    let reads = 0;
    const source = new ReadableStream<Uint8Array>({
      pull() {
        reads++;
      },
    }, { highWaterMark: 0 });
    await expect(collect(createZipStream([{ name: "dir/", kind: "directory", source }]))).rejects.toThrow();
    await expect(collect(createZipStream([{ name: "link", kind: "symbolic-link" } as unknown as ZipWriteEntryType])))
      .rejects.toThrow();
    expect(reads).toBe(0);
    expect(source.locked).toBe(false);
  });
  it("bounds chunks, entry bytes, declared size and final archive bytes", async () => {
    for (
      const entry of [{ name: "file", source: stream([new Uint8Array(3)]) }, {
        name: "file",
        source: stream([new Uint8Array(1)]),
        size: 2,
      }]
    ) await expect(collect(createZipStream([entry], { maxChunkBytes: 2 }))).rejects.toThrow();
    await expect(
      collect(
        createZipStream([{ name: "file", source: stream([new Uint8Array(2), new Uint8Array(2)]) }], {
          maxEntryBytes: 3,
        }),
      ),
    ).rejects.toThrow();
    await expect(collect(createZipStream([{ name: "file" }], { maxArchiveBytes: 50 }))).rejects.toThrow();
    await expect(collect(createZipStream([{ name: "file", source: new Uint8Array(3), size: 2 }]))).rejects.toThrow();
  });
  it("bounds directory count and UTF8 name bytes before another source opens", async () => {
    await expect(collect(createZipStream([{ name: "a" }, { name: "b" }], { maxEntries: 1 }))).rejects.toThrow();
    await expect(collect(createZipStream([{ name: "é" }], { maxNameBytes: 1 }))).rejects.toThrow();
    await expect(collect(createZipStream([{ name: "file" }], { maxDirectoryBytes: 49 }))).rejects.toThrow();
    expect(() => createZipStream([], { maxEntries: 65535 })).toThrow();
    expect(() => createZipStream([], { maxEntryBytes: 0xffffffff })).toThrow();
    expect(() => createZipStream([], { maxChunkBytes: 0 })).toThrow();
  });
  it("bounds empty chunks and ancestor-index depth without acquiring unreached sources", async () => {
    await expect(
      collect(
        createZipStream([{ name: "file", source: stream([new Uint8Array(), new Uint8Array()]) }], {
          maxSourceChunks: 1,
        }),
      ),
    ).rejects.toThrow("chunk-count");
    await expect(collect(createZipStream([{ name: "a/b/c" }], { maxPathDepth: 2 }))).rejects.toThrow("depth");
    let started = 0;
    function* entries() {
      started++;
      yield { name: "file" };
    }
    await createZipStream(entries()).cancel();
    expect(started).toBe(0);
  });
  it("reports abort together with independent source cleanup failure", async () => {
    const controller = new AbortController();
    const cause = new Error("abort");
    const cleanup = new Error("cleanup");
    const source = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        return Promise.reject(cleanup);
      },
    }, { highWaterMark: 0 });
    const reader = createZipStream([{ name: "file", source }], { signal: controller.signal }).getReader();
    await reader.read();
    const pending = reader.read();
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(cause);
    try {
      await pending;
      throw new Error("Expected abort");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([cause, cleanup]);
    }
    expect(source.locked).toBe(false);
    reader.releaseLock();
  });
  it("uses native byte extents and splits materialized inputs under the output chunk limit", async () => {
    const bytes = encode("abc");
    Object.defineProperty(bytes, "byteLength", {
      get() {
        throw new Error("spoof getter");
      },
    });
    const result = await collect(createZipStream([{ name: "file", source: bytes }], { maxChunkBytes: 1 }));
    expect((await (await openZip(createByteSource(result))).read(0, { verify: true })).bytes).toEqual(encode("abc"));
    const spoofed = new Uint8Array(3);
    Object.defineProperty(spoofed, "byteLength", { value: 1 });
    await expect(collect(createZipStream([{ name: "file", source: stream([spoofed]) }], { maxChunkBytes: 2 }))).rejects
      .toThrow("chunk");
  });
});

describe("ZIP writer compression and ZIP64", () => {
  /** Walks the end records by hand, without the library's reader. */
  function ends(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = bytes.byteLength - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    const zip64 = eocd >= 20 && view.getUint32(eocd - 20, true) === 0x07064b50;
    return { view, eocd, zip64 };
  }

  it("deflates text entries so an independent inflater restores them, and keeps STORED entries byte-exact", async () => {
    const text = encode('{"url":"https://example.com/","ts":"2026-11-24T10:00:00Z"}\n'.repeat(200));
    const stored = encode("already compressed");
    const bytes = await collect(createZipStream([
      { name: "pages.jsonl", source: stream([text.subarray(0, 1000), text.subarray(1000)]), compression: "deflate" },
      { name: "data.warc.gz", source: stored, compression: "store" },
    ]));
    const zip = await openZip(createByteSource(bytes));
    const [pages, warc] = zip.entries;
    expect([pages!.method, warc!.method]).toEqual([8, 0]);
    expect(pages!.compressedSize).toBeLessThan(text.byteLength / 10);
    expect((await zip.read(0, { verify: true })).bytes).toEqual(text);
    // An independent inflater reads the raw DEFLATE body straight out of the archive.
    const view = new DataView(bytes.buffer);
    const start = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    const { inflateRawSync } = await import("node:zlib");
    expect(new Uint8Array(inflateRawSync(bytes.subarray(start, start + pages!.compressedSize)))).toEqual(text);
    expect((await zip.read(1, { verify: true })).bytes).toEqual(stored);
  });

  it("keeps ZIP32 output unchanged unless zip64 is set", async () => {
    const entries = () => [{ name: "a.txt", source: encode("abc") }];
    const plain = await collect(createZipStream(entries()));
    expect(ends(plain).zip64).toBe(false);
    expect(await collect(createZipStream(entries(), { zip64: true }))).toEqual(plain);
  });

  it("writes ZIP64 sizes for an unknown-size stream whose limit passes 4 GiB", async () => {
    const options = { zip64: true, maxEntryBytes: 8 * 1024 ** 3, maxArchiveBytes: 16 * 1024 ** 3 };
    const bytes = await collect(createZipStream([{ name: "big.bin", source: stream([encode("abc")]) }], options));
    const { view, eocd, zip64 } = ends(bytes);
    // Local header: version 45, sentinel sizes, and a 16-byte ZIP64 extra field.
    expect(view.getUint16(4, true)).toBe(45);
    expect(view.getUint32(18, true)).toBe(0xffffffff);
    expect(view.getUint16(30 + 7, true)).toBe(0x0001);
    // The ZIP64 data descriptor holds 8-byte sizes.
    const descriptor = 30 + 7 + 20 + 3;
    expect(view.getUint32(descriptor, true)).toBe(0x08074b50);
    expect(view.getBigUint64(descriptor + 8, true)).toBe(3n);
    expect(view.getBigUint64(descriptor + 16, true)).toBe(3n);
    expect(zip64).toBe(true);
    expect(view.getUint32(Number(view.getBigUint64(eocd - 20 + 8, true)), true)).toBe(0x06064b50);
    const zip = await openZip(createByteSource(bytes));
    expect(zip.entries[0]!.size).toBe(3);
    expect((await zip.read(0, { verify: true })).bytes).toEqual(encode("abc"));
  });

  it("deflates inside ZIP64 entries", async () => {
    const text = encode("abc".repeat(5000));
    const bytes = await collect(
      createZipStream([{ name: "t.txt", source: stream([text]), compression: "deflate" }], {
        zip64: true,
        maxEntryBytes: 8 * 1024 ** 3,
        maxArchiveBytes: 16 * 1024 ** 3,
      }),
    );
    const zip = await openZip(createByteSource(bytes));
    expect(zip.entries[0]!.method).toBe(8);
    expect((await zip.read(0, { verify: true })).bytes).toEqual(text);
  });

  it("rejects an unknown compression method", async () => {
    await expect(
      collect(createZipStream([{ name: "a", source: encode("a"), compression: "zstd" as "store" }])),
    ).rejects.toThrow("store or deflate");
  });
});
