import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { ArchiveError } from "../src/archive/record.ts";
import { compressStream, createCompressedTar, decompressStream, readCompressedTar } from "../src/archive/compress.ts";
import fixtures from "./fixtures/compression/native.json" with { type: "json" };

function stream(bytes: Uint8Array, chunk = 64): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at === bytes.length) return controller.close();
      const end = Math.min(at + chunk, bytes.length);
      controller.enqueue(bytes.slice(at, end));
      at = end;
    },
  }, { highWaterMark: 0 });
}
async function collect(value: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const bytes of value) {
    chunks.push(bytes);
    length += bytes.length;
  }
  const result = new Uint8Array(length);
  let at = 0;
  for (const bytes of chunks) {
    result.set(bytes, at);
    at += bytes.length;
  }
  return result;
}
describe("optional native Brotli and Zstandard codecs", () => {
  for (const format of ["brotli", "zstd"] as const) {
    it(`decodes independent ${format} bytes or refuses before source acquisition`, async () => {
      const fixture = fixtures.formats[format];
      const encoded = decodeBase64(fixture.bytes);
      const input = stream(encoded);
      let decoded: ReadableStream<Uint8Array>;
      try {
        decoded = decompressStream(input, format);
      } catch (reason) {
        expect(reason).toBeInstanceOf(ArchiveError);
        expect((reason as ArchiveError).code).toBe("unsupported-profile");
        expect(input.locked).toBe(false);
        return;
      }
      const expected = decodeBase64(fixtures.payload);
      expect(await collect(decoded)).toEqual(expected);
      for (const chunk of [1, 2, 7, 64, encoded.length]) {
        expect(await collect(decompressStream(stream(encoded, chunk), format))).toEqual(expected);
      }
      expect(await collect(decompressStream(stream(decodeBase64(fixture.empty)), format))).toEqual(new Uint8Array());
      await expect(collect(decompressStream(stream(encoded), format, { maxDecodedBytes: expected.length - 1 }))).rejects
        .toBeInstanceOf(ArchiveError);
      await expect(collect(decompressStream(stream(encoded.subarray(0, -1)), format))).rejects.toBeInstanceOf(Error);
      let encodedStream: ReadableStream<Uint8Array>;
      try {
        encodedStream = compressStream(stream(expected), format);
      } catch (reason) {
        expect((reason as ArchiveError).code).toBe("unsupported-profile");
        return;
      }
      expect(await collect(decompressStream(encodedStream, format))).toEqual(expected);
      const tar = createCompressedTar(
        [{ name: "note", size: 4, body: stream(new TextEncoder().encode("note")) }],
        format,
      );
      let body: Uint8Array = new Uint8Array();
      const result = await readCompressedTar(tar, format, async (_entry, source) => {
        body = await collect(source);
      });
      expect(body).toEqual(new TextEncoder().encode("note"));
      expect(result.compression.complete).toBe(true);
      expect(result.compression.integrity).toBe("none");
    });
  }
});
