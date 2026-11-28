/** Installed archive compression contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createByteSource } from "@okikio/opfs/source";
import { createLz4Decoder } from "@okikio/opfs/archive/lz4";
import { createLzmaDecoder } from "@okikio/opfs/archive/lzma";
import { createBzipDecoder } from "@okikio/opfs/archive/bzip";
import { openXz } from "@okikio/opfs/archive/xz";
import { compressStream, decompressStream } from "@okikio/opfs/archive/compress";
import { archivePayload, assertBytes } from "../../bytes.mjs";
import nativeCodecsInput from "../../data/archive/nativecodecs.json" with { type: "json" };
import lz4Input from "../../data/archive/lz4.json" with { type: "json" };
import xzInput from "../../data/archive/xz.json" with { type: "json" };
import bzipInput from "../../data/archive/bzip.json" with { type: "json" };
import lzmaInput from "../../data/archive/lzma.json" with { type: "json" };

describe("packed archive compression", () => {
  it("gzip streaming round trip", async () => {
    const compressed = new Uint8Array(
      await new Response(compressStream(
        new Blob([archivePayload]).stream(),
        "gzip",
      )).arrayBuffer(),
    );
    assertBytes(
      new Uint8Array(
        await new Response(decompressStream(
          new Blob([compressed]).stream(),
          "gzip",
        )).arrayBuffer(),
      ),
      archivePayload,
    );
  });
  it("native Brotli and Zstandard profiles", async () => {
    const nativeCodecs = nativeCodecsInput;
    for (const format of ["brotli", "zstd"]) {
      let decoded;
      try {
        decoded = decompressStream(
          new Blob([Uint8Array.from(atob(nativeCodecs.formats[format].bytes), (byte) => byte.charCodeAt(0))]).stream(),
          format,
        );
      } catch (reason) {
        if (reason.code !== "unsupported-profile") throw reason;
        continue;
      }
      assertBytes(
        new Uint8Array(await new Response(decoded).arrayBuffer()),
        Uint8Array.from(atob(nativeCodecs.payload), (byte) => byte.charCodeAt(0)),
      );
    }
  });
  it("LZ4 streaming completion", async () => {
    const lz4Fixture = lz4Input;
    const lz4 = createLz4Decoder(
      new Blob([Uint8Array.from(atob(lz4Fixture.archive), (byte) => byte.charCodeAt(0))]).stream(),
    );
    assertBytes(
      new Uint8Array(await new Response(lz4.stream).arrayBuffer()),
      Uint8Array.from(atob(lz4Fixture.body), (byte) => byte.charCodeAt(0)),
    );
    if ((await lz4.finished).status !== "complete") throw new Error("Packed LZ4 completion failed");
  });
  it("XZ CRC64 evidence", async () => {
    const xzFixture = xzInput;
    const xz = await openXz(createByteSource(Uint8Array.from(atob(xzFixture.archive), (byte) => byte.charCodeAt(0))));
    const xzRead = await xz.read();
    assertBytes(xzRead.bytes, Uint8Array.from(atob(xzFixture.body), (byte) => byte.charCodeAt(0)));
    if (
      xz.check !== "crc64" || xzRead.checks[0].integrity !== "crc64-verified" ||
      xzRead.checks[0].crc64 !== "995dc9bbdf1939fa"
    ) throw new Error("Packed XZ CRC64 evidence changed");
  });
  it("BZip2 terminal evidence", async () => {
    const bzipFixture = bzipInput;
    const bzip = createBzipDecoder(
      createByteSource(Uint8Array.from(atob(bzipFixture.packed), (byte) => byte.charCodeAt(0))),
    );
    const [bzipBody, bzipEnd] = await Promise.all([new Response(bzip.stream).arrayBuffer(), bzip.finished]);
    assertBytes(new Uint8Array(bzipBody), Uint8Array.from(atob(bzipFixture.body), (byte) => byte.charCodeAt(0)));
    if (bzipEnd.status !== "complete" || bzipEnd.integrity !== "checksum-verified") {
      throw new Error("Packed BZip2 terminal scope changed");
    }
  });
  it("raw LZMA2 completion evidence", async () => {
    const lzmaFixture = lzmaInput;
    const lzma = createLzmaDecoder(
      createByteSource(Uint8Array.from(atob(lzmaFixture.packed), (byte) => byte.charCodeAt(0))),
      { format: "raw-lzma2", dictionary: lzmaFixture.dictionary },
    );
    const lzmaChunks = [];
    for await (const bytes of lzma.stream) lzmaChunks.push(...bytes);
    assertBytes(Uint8Array.from(lzmaChunks), Uint8Array.from(atob(lzmaFixture.body), (byte) => byte.charCodeAt(0)));
    const lzmaEnd = await lzma.finished;
    if (lzmaEnd.status !== "complete" || lzmaEnd.termination !== "lzma2-end" || lzmaEnd.integrity !== "none") {
      throw new Error("Packed LZMA terminal scope changed");
    }
  });
});
