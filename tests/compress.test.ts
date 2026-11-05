import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { toRequestBytes } from "../src/bytes.ts";
import { createArchiveLedger } from "../src/archive/record.ts";
import { compressStream, createCompressedTar, decompressStream, readCompressedTar } from "../src/archive/compress.ts";
import fixtures from "./fixtures/compression/independent.json" with { type: "json" };
import tarFixtures from "./fixtures/tar/independent.json" with { type: "json" };

function stream(bytes: Uint8Array, chunkBytes = 512): ReadableStream<Uint8Array<ArrayBuffer>> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + chunkBytes, bytes.length);
      controller.enqueue(toRequestBytes(bytes.subarray(offset, end)));
      offset = end;
    },
  }, { highWaterMark: 0 });
}

async function collect(source: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(source).arrayBuffer());
}

function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(a.length + b.length);
  bytes.set(a);
  bytes.set(b, a.length);
  return bytes;
}

describe("native bounded compression", () => {
  for (const format of ["gzip", "deflate", "deflate-raw"] as const) {
    it(`decodes independent Python ${format} across producer chunk sizes and round-trips native output`, async () => {
      const record = fixtures.formats[format];
      const bytes = decodeBase64(record.bytes);
      const expected = decodeBase64(fixtures.payload);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
      expect(Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(record.sha256);
      for (let chunkBytes = 1; chunkBytes <= bytes.length; chunkBytes++) {
        expect(await collect(decompressStream(stream(bytes, chunkBytes), format))).toEqual(expected);
      }
      expect(await collect(decompressStream(stream(decodeBase64(record.empty)), format))).toEqual(new Uint8Array());
      const encoded = await collect(compressStream(stream(expected, 13), format));
      expect(await collect(decompressStream(stream(encoded, 7), format))).toEqual(expected);
    });
  }

  it("rejects gzip footer CRC/ISIZE corruption, truncation, concatenated members and trailing data", async () => {
    const bytes = decodeBase64(fixtures.formats.gzip.bytes);
    const crc = bytes.slice();
    // The independent fixture contains the complete eight-byte gzip trailer.
    crc[crc.length - 8] = crc[crc.length - 8]! ^ 1;
    const size = bytes.slice();
    size[size.length - 4] = size[size.length - 4]! ^ 1;
    for (
      const bad of [
        crc,
        size,
        bytes.subarray(0, -1),
        bytes.subarray(0, -8),
        join(bytes, new Uint8Array([1])),
        join(bytes, bytes),
      ]
    ) {
      await expect(collect(decompressStream(stream(bad, 17), "gzip"))).rejects.toBeInstanceOf(Error);
    }
  });

  it("accepts independent gzip optional headers and refuses corrupt FHCRC, reserved flags and unterminated fields", async () => {
    const bytes = decodeBase64(fixtures.gzipHeaders.bytes);
    expect(await collect(decompressStream(stream(bytes, 1), "gzip"))).toEqual(decodeBase64(fixtures.payload));
    const crc = bytes.slice();
    // Producer metadata identifies the existing FHCRC byte after all optional fields.
    crc[fixtures.gzipHeaders.fhcrcOffset] = crc[fixtures.gzipHeaders.fhcrcOffset]! ^ 1;
    const reserved = bytes.slice();
    reserved[3] = reserved[3]! | 0x20;
    const method = bytes.slice();
    method[2] = 7;
    const extra = bytes.slice();
    extra[10] = 0xff;
    extra[11] = 0xff;
    // Excluding the two-byte FHCRC and compressed body leaves a comment field without its terminator.
    const unterminated = bytes.subarray(0, fixtures.gzipHeaders.fhcrcOffset - 1);
    for (const bad of [crc, reserved, method, extra, unterminated]) {
      await expect(collect(decompressStream(stream(bad, 1), "gzip"))).rejects.toBeInstanceOf(Error);
    }
  });

  it("independently rejects zlib checksum corruption/dictionaries and truncated zlib trailers", async () => {
    const zlib = decodeBase64(fixtures.formats.deflate.bytes);
    const corrupt = zlib.slice();
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    for (
      const [bytes, format] of [
        [corrupt, "deflate"],
        [zlib.subarray(0, -1), "deflate"],
        [new Uint8Array([0x78, 0x20, 0, 0, 0, 0]), "deflate"],
      ] as const
    ) await expect(collect(decompressStream(stream(bytes), format))).rejects.toBeInstanceOf(Error);
  });

  it("does not infer raw DEFLATE truncation integrity from native EOF", async () => {
    const bytes = decodeBase64(fixtures.formats["deflate-raw"].bytes).subarray(0, -1);
    const native = new DecompressionStream("deflate-raw");
    let nativeResult: Uint8Array | undefined;
    try {
      nativeResult = await collect(stream(bytes).pipeThrough(native));
    } catch { /* Strict engines reject incomplete final blocks. */ }
    if (nativeResult === undefined) {
      await expect(collect(decompressStream(stream(bytes), "deflate-raw"))).rejects.toBeInstanceOf(Error);
    } else {
      // Deno 2.9.8 returns shortened plaintext here. This records the native
      // deficiency without requiring other supported runtimes to share it.
      expect(await collect(decompressStream(stream(bytes), "deflate-raw"))).toEqual(nativeResult);
      expect(nativeResult).not.toEqual(decodeBase64(fixtures.payload));
    }
  });

  it("enforces source/request/decode/output/producer/codec chunk budgets and shared aggregate limits", async () => {
    const bytes = decodeBase64(fixtures.formats.gzip.expanded);
    for (
      const options of [
        { maxSourceBytes: 0 },
        { maxRequests: 0 },
        { maxDecodedBytes: 10 },
        { maxOutputBytes: 10 },
        { maxChunkBytes: 1 },
        { maxCodecChunkBytes: 1 },
      ]
    ) {
      await expect(collect(decompressStream(stream(bytes), "gzip", options))).rejects.toMatchObject({
        code: "budget-exceeded",
      });
    }
    const ledger = createArchiveLedger({ maxOutputBytes: 400 });
    const payload = decodeBase64(fixtures.formats.gzip.bytes);
    await collect(decompressStream(stream(payload), "gzip", { ledger }));
    await expect(collect(decompressStream(stream(payload), "gzip", { ledger }))).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    const encodedLedger = createArchiveLedger();
    const plain = decodeBase64(fixtures.payload);
    await collect(compressStream(stream(plain), "gzip", { ledger: encodedLedger }));
    expect(encodedLedger.inspect()).toMatchObject({ sourceBytes: plain.length, decodedBytes: plain.length });
  });

  it("does not acquire or read a producer without output demand and bounds output views", async () => {
    let pulls = 0;
    const bytes = decodeBase64(fixtures.formats.gzip.expanded);
    let offset = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (offset === bytes.length) return controller.close();
        const end = Math.min(offset + 100, bytes.length);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
    }, { highWaterMark: 0 });
    const output = decompressStream(source, "gzip", { outputChunkBytes: 31, inputChunkBytes: 32 });
    expect(source.locked).toBe(false);
    expect(pulls).toBe(0);
    const reader = output.getReader();
    expect((await reader.read()).value?.length).toBeLessThanOrEqual(31);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const before = pulls;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(pulls).toBe(before);
    await reader.cancel();
    reader.releaseLock();
    expect(source.locked).toBe(false);
    // A native implementation may consume this small compressed fixture before
    // its first output. Once a chunk is retained, demand no longer advances input.
    expect(pulls).toBeLessThanOrEqual(Math.ceil(bytes.length / 100) + 1);
  });

  it("cancels stalled producer reads on signal and consumer cancellation, releasing the original lock", async () => {
    for (const trigger of ["abort", "cancel"] as const) {
      const signal = new AbortController();
      let retired = 0;
      const source = new ReadableStream<Uint8Array>({
        cancel() {
          retired++;
        },
      }, { highWaterMark: 0 });
      const reader = decompressStream(source, "gzip", { signal: signal.signal }).getReader();
      const pending = reader.read();
      await Promise.resolve();
      if (trigger === "abort") {
        const reason = new Error("compression abort");
        signal.abort(reason);
        await expect(pending).rejects.toBe(reason);
      } else {
        await reader.cancel("stop");
        expect((await pending).done).toBe(true);
      }
      reader.releaseLock();
      expect(retired).toBe(1);
      expect(source.locked).toBe(false);
    }
  });

  it("preserves source and cleanup failures, rejects non-byte chunks, and accepts foreign native bytes", async () => {
    const primary = new Error("producer primary");
    const source = new ReadableStream<Uint8Array>({
      pull() {
        throw primary;
      },
    });
    await expect(collect(decompressStream(source, "gzip"))).rejects.toBe(primary);
    expect(source.locked).toBe(false);
    const wrong = new ReadableStream({
      start(controller) {
        controller.enqueue("not bytes");
      },
    });
    const output = Reflect.apply(decompressStream, undefined, [wrong, "gzip"]);
    await expect(collect(output)).rejects.toBeInstanceOf(TypeError);
    expect(wrong.locked).toBe(false);
    const foreign: Uint8Array = runInNewContext("new Uint8Array([1,2,3,255])");
    const encoded = await collect(compressStream(stream(foreign), "gzip"));
    expect(await collect(decompressStream(stream(encoded), "gzip"))).toEqual(new Uint8Array([1, 2, 3, 255]));
    const cleanup = new Error("producer cancel secondary");
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100));
      },
      cancel() {
        throw cleanup;
      },
    });
    let failure: unknown;
    try {
      await collect(decompressStream(oversized, "gzip", { maxChunkBytes: 1 }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toContain(cleanup);
    expect(oversized.locked).toBe(false);
  });

  it("rejects invalid policy, formats and missing native codecs before acquiring the producer", async () => {
    const source = stream(new Uint8Array());
    expect(() => decompressStream(source, "gzip", { inputChunkBytes: 65537 })).toThrow(RangeError);
    expect(() => decompressStream(source, "gzip", { outputChunkBytes: 0 })).toThrow(RangeError);
    expect(() => Reflect.apply(decompressStream, undefined, [source, "unknown"])).toThrow();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "DecompressionStream")!;
    try {
      Object.defineProperty(globalThis, "DecompressionStream", {
        configurable: true,
        writable: true,
        value: undefined,
      });
      expect(() => decompressStream(source, "gzip")).toThrow();
    } finally {
      Object.defineProperty(globalThis, "DecompressionStream", descriptor);
    }
    expect(source.locked).toBe(false);
  });
});

describe("compressed TAR consumer workflow", () => {
  for (const format of ["gzip", "deflate", "deflate-raw"] as const) {
    it(`visits independent Python PAX TAR through ${format} without collecting the archive`, async () => {
      const members: string[] = [];
      const result = await readCompressedTar(
        stream(decodeBase64(fixtures.formats[format].tar), 31),
        format,
        async (entry, body) => {
          members.push(entry.name);
          let offset = 0;
          const expected = decodeBase64(tarFixtures.pax.entries[entry.id]!.body);
          for await (const bytes of body) {
            expect(bytes).toEqual(expected.subarray(offset, offset + bytes.length));
            offset += bytes.length;
          }
          expect(offset).toBe(expected.length);
        },
      );
      expect(members).toEqual(tarFixtures.pax.entries.map((entry) => entry.name));
      expect(result).toMatchObject({ complete: true, entries: 3, compression: { complete: true, format } });
      expect(result.compression.integrity).toBe(
        format === "gzip" ? "gzip-crc32" : format === "deflate" ? "zlib-adler32" : "none",
      );
      expect(result.compression.work.decodedBytes).toBe(10240);
      expect(result.compression.work.outputBytes).toBe(10240);
      expect(result.work.outputBytes).toBe(283);
    });
  }

  it("writes and consumes compressed TAR incrementally and reports early previews as pending", async () => {
    const bytes = new TextEncoder().encode("streamed member");
    const output = createCompressedTar([{ name: "one", size: bytes.length, body: stream(bytes, 3) }], "gzip");
    let offset = 0;
    const result = await readCompressedTar(output, "gzip", async (_entry, body) => {
      for await (const chunk of body) {
        expect(chunk).toEqual(bytes.subarray(offset, offset + chunk.length));
        offset += chunk.length;
      }
    });
    expect(offset).toBe(bytes.length);
    expect(result.compression.complete).toBe(true);
    const partial = await readCompressedTar(
      stream(decodeBase64(fixtures.formats.gzip.tar), 31),
      "gzip",
      async (_entry, body) => {
        for await (const chunk of body) {
          expect(chunk.length).toBe(3);
          break;
        }
        return false;
      },
      { tar: { bodyChunkBytes: 3, maxOutputBytes: 3 } },
    );
    expect(partial).toMatchObject({ complete: false, compression: { complete: false, integrity: "pending" } });
  });

  it("checks the gzip footer after TAR end blocks and refuses a corrupt or truncated footer", async () => {
    const bytes = decodeBase64(fixtures.formats.gzip.tar);
    const corrupt = bytes.slice();
    corrupt[corrupt.length - 8] = corrupt[corrupt.length - 8]! ^ 1;
    for (const input of [corrupt, bytes.subarray(0, -1), bytes.subarray(0, -8)]) {
      const source = stream(input, Math.max(1, input.length - 8));
      await expect(readCompressedTar(source, "gzip", () => {})).rejects.toBeInstanceOf(Error);
      expect(source.locked).toBe(false);
    }
  });

  it("applies independent expanded/TAR budgets and closes the codec on visitor failure", async () => {
    const bytes = decodeBase64(fixtures.formats.gzip.tar);
    await expect(readCompressedTar(stream(bytes), "gzip", () => {}, { compression: { maxDecodedBytes: 100 } })).rejects
      .toMatchObject({ code: "budget-exceeded" });
    await expect(readCompressedTar(stream(bytes), "gzip", () => {}, { tar: { maxDecodedBytes: 1 } })).rejects
      .toMatchObject({ code: "budget-exceeded" });
    const source = stream(bytes);
    const primary = new Error("visitor primary");
    await expect(readCompressedTar(source, "gzip", () => {
      throw primary;
    })).rejects.toBe(primary);
    expect(source.locked).toBe(false);
  });
});
