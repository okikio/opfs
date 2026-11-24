import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { gzipSync } from "node:zlib";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { openWarc } from "../src/archive/warc/mod.ts";
import { createWarcStream, type WarcWrittenType } from "../src/archive/warc/write.ts";
import fixtures from "./fixtures/warc/independent.json" with { type: "json" };

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const source = (bytes: Uint8Array): ByteSourceType => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const collect = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(stream).arrayBuffer());

/** Gzip with the host's native encoder, which is independent of the reader. */
async function nativeGzip(bytes: Uint8Array): Promise<Uint8Array> {
  return await collect(new Blob([new Uint8Array(bytes).buffer]).stream().pipeThrough(new CompressionStream("gzip")));
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function record(body: string, id = "one"): Uint8Array {
  return encode(
    `WARC/1.1\r\nWARC-Record-ID: <urn:test:${id}>\r\nWARC-Date: 2026\r\nWARC-Type: resource\r\nContent-Length: ${
      encode(body).length
    }\r\n\r\n${body}\r\n\r\n`,
  );
}

describe(".warc.gz reading", () => {
  for (const fixture of fixtures.archives) {
    for (
      const [label, compress] of [["native", nativeGzip], [
        "node:zlib level 9",
        (bytes: Uint8Array) => Promise.resolve(new Uint8Array(gzipSync(bytes, { level: 9 }))),
      ]] as const
    ) {
      it(`reads warcio WARC${fixture.version} records gzipped per member with ${label}`, async () => {
        const plainBytes = decodeBase64(fixture.base64);
        const plain = await openWarc(source(plainBytes));
        // The plain index's offsets and lengths tile the file exactly.
        expect(plain.entries.reduce((sum, entry) => sum + entry.length, 0)).toBe(plainBytes.length);
        const members = await Promise.all(
          plain.entries.map((entry) => compress(plainBytes.subarray(entry.offset, entry.offset + entry.length))),
        );
        const gzipped = await openWarc(source(concat(...members)));
        expect(gzipped.compression).toBe("gzip");
        expect(gzipped.entries.map(({ offset: _, length: __, ...rest }) => rest)).toEqual(
          plain.entries.map(({ offset: _, length: __, ...rest }) => rest),
        );
        let offset = 0;
        for (const [index, entry] of gzipped.entries.entries()) {
          expect(entry.offset).toBe(offset);
          expect(entry.length).toBe(members[index]!.length);
          offset += entry.length;
          const read = await gzipped.read(index);
          expect(read.bytes).toEqual(decodeBase64(fixture.records[index]!.blockBase64));
          expect(read.integrity).toBe("gzip-member");
          expect((await gzipped.verifyBlock(index, { subtle: crypto.subtle })).integrity).toBe("stored-block-digest");
        }
        const http = await gzipped.read(1, { offset: 0, length: 8 });
        expect(text(http.bytes)).toBe("HTTP/1.1");
      });
    }
  }

  it("skips gzip magic bytes that occur inside a stored member", async () => {
    // Level 0 stores bytes uncompressed, so the magic appears in the member body.
    const magic = new Uint8Array([0x1f, 0x8b, 0x08]);
    const body = concat(encode("a"), magic, encode("b"), magic, encode("c"));
    const header = encode(
      `WARC/1.1\r\nWARC-Record-ID: <urn:test:one>\r\nWARC-Date: 2026\r\nWARC-Type: resource\r\nContent-Length: ${body.length}\r\n\r\n`,
    );
    const first = new Uint8Array(gzipSync(concat(header, body, encode("\r\n\r\n")), { level: 0 }));
    const second = new Uint8Array(gzipSync(record("second", "two"), { level: 0 }));
    const inside = first.subarray(10).findIndex((_, at, all) =>
      all[at] === 0x1f && all[at + 1] === 0x8b && all[at + 2] === 8
    );
    expect(inside).toBeGreaterThan(0);
    const archive = await openWarc(source(concat(first, second)));
    expect(archive.entries.map((entry) => entry.recordId)).toEqual(["<urn:test:one>", "<urn:test:two>"]);
    expect(archive.entries[1]!.offset).toBe(first.length);
    expect((await archive.read(0)).bytes).toEqual(body);
    expect(text((await archive.read(1)).bytes)).toBe("second");
  });

  it("refuses one member that holds several records", async () => {
    const whole = await nativeGzip(concat(record("one"), record("two", "two")));
    await expect(openWarc(source(whole))).rejects.toMatchObject({ code: "unsupported-profile" });
  });

  it("refuses a truncated last member", async () => {
    const first = await nativeGzip(record("one"));
    const second = await nativeGzip(record("two", "two"));
    const bytes = concat(first, second.subarray(0, second.length - 3));
    await expect(openWarc(source(bytes))).rejects.toMatchObject({ code: "invalid-archive" });
  });

  it("reports a decode budget stop as a budget failure, not a bad boundary", async () => {
    const bytes = await nativeGzip(record("x".repeat(4096)));
    await expect(openWarc(source(bytes), { maxDecodedBytes: 1024 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });
});

describe("WARC writing", () => {
  for (const compression of ["none", "gzip"] as const) {
    it(`writes records that openWarc reads back (${compression})`, async () => {
      const written: WarcWrittenType[] = [];
      const http = encode("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nhello");
      const stream = createWarcStream([
        { type: "warcinfo", contentType: "application/warc-fields", block: encode("software: test\r\n") },
        {
          type: "response",
          targetUri: "https://example.com/",
          date: new Date("2026-11-24T10:00:00.123Z"),
          contentType: "application/http; msgtype=response",
          fields: [{ name: "WARC-IP-Address", value: "192.0.2.1" }],
          block: http,
        },
        {
          type: "resource",
          targetUri: "https://example.com/big",
          recordId: "<urn:test:streamed>",
          block: { size: 6, stream: new Blob(["abc", "def"]).stream() },
        },
      ], { compression, onRecord: (record) => written.push(record) });
      const bytes = await collect(stream);
      const archive = await openWarc(source(bytes));
      expect(archive.compression).toBe(compression);
      expect(archive.entries.map((entry) => [entry.type, entry.offset, entry.length])).toEqual(
        written.map((record) => [record.type, record.offset, record.length]),
      );
      expect(archive.entries[1]!.date).toBe("2026-11-24T10:00:00Z");
      expect(archive.entries[1]!.fields.find((field) => field.name === "WARC-Target-URI")?.value).toBe(
        "https://example.com/",
      );
      expect((await archive.read(1)).bytes).toEqual(http);
      expect((await archive.verifyBlock(1, { subtle: crypto.subtle })).algorithm).toBe("SHA-256");
      expect(archive.entries[2]!.recordId).toBe("<urn:test:streamed>");
      expect(text((await archive.read(2)).bytes)).toBe("abcdef");
      expect(written[2]!.blockDigest).toBeUndefined();
    });
  }

  it("errors when a streamed block does not match its size", async () => {
    const stream = createWarcStream([{ type: "resource", block: { size: 4, stream: new Blob(["abc"]).stream() } }]);
    await expect(collect(stream)).rejects.toThrow(RangeError);
  });

  it("refuses header injection and fields the writer owns", async () => {
    await expect(collect(createWarcStream([{
      type: "resource",
      targetUri: "https://example.com/\r\nWARC-Type: revisit",
      block: new Uint8Array(),
    }]))).rejects.toThrow(TypeError);
    await expect(collect(createWarcStream([{
      type: "resource",
      fields: [{ name: "Content-Length", value: "1" }],
      block: new Uint8Array(),
    }]))).rejects.toThrow(TypeError);
  });

  it("pulls records only as the output is read", async () => {
    let pulled = 0;
    function* records() {
      for (let at = 0; at < 100; at++) {
        pulled++;
        yield { type: "resource", block: encode(`record ${at}`) };
      }
    }
    const reader = createWarcStream(records()).getReader();
    await reader.read();
    expect(pulled).toBe(1);
    await reader.cancel();
  });
});
