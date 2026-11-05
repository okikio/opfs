import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createArchiveLedger, openArc } from "../src/archive/arc.ts";
import fixture from "./fixtures/arc/independent.json" with { type: "json" };
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const source = (bytes: Uint8Array): ByteSourceType => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const join = (...chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};
const body = encode("1 0 Authored\nURL IP-address Archive-date Content-type Archive-length\n");
const header = (url: string, size: number, date = "20260102030405", ip = "192.0.2.1"): Uint8Array =>
  encode(`${url} ${ip} ${date} application/octet-stream ${size}\n`);
function authored(block: Uint8Array = encode("abc"), separator = "\n", descriptor = body): Uint8Array {
  return join(
    encode(`filedesc://authored.arc 0 20260102030405 text/plain ${descriptor.length}\n`),
    descriptor,
    encode(separator),
    header("urn:example:authored", block.length),
    block,
    encode("\n"),
  );
}
const hash = async (bytes: Uint8Array): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

describe("Internet Archive ARC1.0 physical stored records", () => {
  it("matches both unchanged independent producers and exact authored stored blocks", async () => {
    expect(fixture.warcio).toBe("1.7.5");
    for (const object of fixture.objects) {
      const bytes = decodeBase64(object.base64);
      expect(await hash(bytes)).toBe(object.sha256);
      const archive = await openArc(source(bytes), {
        filedescSeparator: object.separator as "outside-length" | "inside-length",
      });
      expect(archive.format).toBe("internet-archive-arc");
      expect(archive.version).toBe("1.0");
      expect(archive.entries.length).toBe(5);
      const descriptor = await archive.read(0);
      expect([...descriptor.bytes]).toEqual([...decodeBase64(object.descriptor.base64)]);
      expect(await hash(descriptor.bytes)).toBe(object.descriptor.sha256);
      for (const [index, expected] of fixture.records.entries()) {
        const entry = archive.entries[index + 1]!;
        expect(entry).toMatchObject({
          id: index + 1,
          kind: "record",
          url: expected.url,
          ip: expected.ip,
          date: expected.date,
          contentType: expected.contentType,
        });
        const block = await archive.read(entry.id);
        expect([...block.bytes]).toEqual([...decodeBase64(expected.base64)]);
        expect(block.integrity).toBe("none");
        expect(await hash(block.bytes)).toBe(expected.sha256);
        const selected = archive.source(entry.id);
        expect([...await selected.read(0, selected.size)]).toEqual([...block.bytes]);
      }
      expect(archive.entries[1]!.url).toBe(archive.entries[3]!.url);
      expect(archive.entries[1]!.id).not.toBe(archive.entries[3]!.id);
    }
  });
  it("retains honest independent framing diagnostics instead of repairing a producer's bytes", async () => {
    const standard = fixture.objects.find((object) => object.separator === "outside-length")!;
    const counted = fixture.objects.find((object) => object.separator === "inside-length")!;
    expect(standard.warcio.accepted).toBe(true);
    expect(standard.warcio.warnings).toBe("");
    expect(standard.nativeJwat.strict).toBe(true);
    expect(counted.warcio.accepted).toBe(false);
    expect(counted.warcio.failure?.type).toBe("ArchiveLoadFailed");
    expect(counted.warcio.warnings).toContain("Record not followed by newline");
    expect(counted.nativeJwat.strict).toBe(false);
    expect(fixture.iipcStrictJwat.split("\n")[0]).toContain("false");
    await expect(openArc(source(decodeBase64(counted.base64)))).rejects.toThrow("outside-length filedesc");
    await expect(openArc(source(decodeBase64(standard.base64)), { filedescSeparator: "inside-length" })).rejects
      .toThrow("inside-length filedesc");
  });
  it("keeps HTTP headers and fake record lines in selected binary blocks", async () => {
    const archive = await openArc(source(decodeBase64(fixture.objects[0]!.base64)));
    expect(decode((await archive.read(1, { offset: 0, length: 8 })).bytes)).toBe("HTTP/1.1");
    expect((await archive.read(2)).bytes.length).toBe(316);
    expect((await archive.read(4)).bytes.length).toBe(0);
    expect(Object.isFrozen(archive.entries[0])).toBe(true);
  });
  it("indexes exact headers across every small physical read chunk without scanning skipped blocks", async () => {
    const bytes = authored(encode("\nfiledesc://fake.arc 0 20260102030405 text/plain 0\n"));
    for (let chunk = 1; chunk <= 90; chunk++) {
      const archive = await openArc(source(bytes), { maxChunkBytes: chunk });
      expect(archive.entries.length).toBe(2);
      expect(decode((await archive.read(1)).bytes)).toContain("filedesc://fake");
    }
    const large = authored(new Uint8Array(1024 * 1024));
    const archive = await openArc(source(large));
    expect(archive.work.sourceBytes).toBeLessThan(16384);
    expect(archive.work.decodedBytes).toBeLessThan(1024);
  });
  it("rejects missing/extra separators, CRLF metadata and unsupported concatenated files", async () => {
    const good = authored();
    const prefix = encode(`filedesc://authored.arc 0 20260102030405 text/plain ${body.length}\n`);
    await expect(openArc(source(authored(encode("a"), "")))).rejects.toThrow("separator");
    await expect(openArc(source(authored(encode("a"), "\n\n")))).rejects.toThrow("blank ARC");
    await expect(openArc(source(join(prefix, body, encode("\r\n"), header("urn:example:a", 0), encode("\n"))))).rejects
      .toThrow("separator");
    await expect(openArc(source(encode(decode(good).replaceAll("\n", "\r\n"))))).rejects.toThrow("ASCII");
    await expect(openArc(source(join(good, good)))).rejects.toThrow("Concatenated");
    await expect(openArc(source(new Uint8Array([31, 139, 8, 0])))).rejects.toThrow("gzip");
    await expect(openArc(source(new Uint8Array()))).rejects.toThrow("no filedesc");
  });
  it("refuses version/schema extensions while preserving the caller's original source", async () => {
    for (const version of ["1 1 Authored", "2 0 Authored", "1 other Authored"]) {
      const descriptor = encode(version + "\nURL IP-address Archive-date Content-type Archive-length\n");
      await expect(openArc(source(authored(encode("a"), "\n", descriptor)))).rejects.toThrow("unsupported profiles");
    }
    await expect(openArc(source(authored(encode("a"), "\n", encode("1 0 Authored\nURL Archive-length\n"))))).rejects
      .toThrow("field definition");
    await expect(openArc(source(join(header("urn:example:no-desc", 0), encode("\n"))))).rejects.toThrow("must begin");
    const descriptor = encode("1 0 Alexa Internet\nURL IP-address Archive-date Content-type Archive-length\n");
    expect((await openArc(source(authored(encode("a"), "\n", descriptor)))).filedesc.origin).toBe("Alexa Internet");
  });
  it("uses exact nonnegative safe lengths and refuses truncated payload/framing", async () => {
    for (const length of ["-1", "+1", "1.0", "9007199254740992", "999999999999999999999999999"]) {
      const bytes = encode(
        decode(authored()).replace("application/octet-stream 3\n", `application/octet-stream ${length}\n`),
      );
      await expect(openArc(source(bytes))).rejects.toThrow();
    }
    await expect(openArc(source(authored().subarray(0, authored().length - 1)))).rejects.toThrow("Truncated");
    await expect(openArc(source(authored().subarray(0, authored().length - 3)))).rejects.toThrow("exceeds source");
    const record = header("urn:example:empty", 0);
    const descriptor = join(encode(`filedesc://x 0 20260102030405 text/plain ${body.length}\n`), body, encode("\n"));
    expect((await openArc(source(join(descriptor, record, encode("\n"))))).entries[1]!.size).toBe(0);
  });
  it("checks calendar/IP profile and exact ASCII field delimiters without URL normalization", async () => {
    const prefix = decode(authored());
    for (const date of ["20260230030405", "20260102240405", "20260102030460", "202601020304", "00000102030405"]) {
      await expect(openArc(source(encode(prefix.replaceAll("20260102030405", date))))).rejects.toThrow();
    }
    for (const ip of ["256.0.0.1", "1.2.3", "2001:db8::1"]) {
      await expect(openArc(source(encode(prefix.replace("192.0.2.1", ip))))).rejects.toThrow();
    }
    for (
      const value of [
        prefix.replace("urn:example:authored ", "urn:example:authored  "),
        prefix.replace("urn:example:authored ", "urn:example:authored\t"),
        prefix.replace("urn:example:authored", "urn:example:é"),
        prefix.replace("urn:example:authored", "urn:example:\u0000"),
      ]
    ) await expect(openArc(source(encode(value)))).rejects.toThrow();
    const literal = prefix.replace("urn:example:authored", "HTTP://EXAMPLE.test/%2f?X=Y");
    expect((await openArc(source(encode(literal)))).entries[1]!.url).toBe("HTTP://EXAMPLE.test/%2f?X=Y");
  });
  it("admits metadata and entry ceilings before impossible work and bounds descriptor allocations", async () => {
    let reads = 0;
    const counted: ByteSourceType = {
      size: authored().length,
      stability: "caller",
      async read(offset, length) {
        reads++;
        return authored().subarray(offset, offset + length);
      },
    };
    await expect(openArc(counted, { maxEntries: 0 })).rejects.toThrow("entries");
    expect(reads).toBe(0);
    await expect(openArc(counted, { maxMetadataBytes: 0 })).rejects.toThrow("metadata");
    expect(reads).toBe(0);
    await expect(openArc(counted, { maxLineBytes: 1 })).rejects.toThrow("line bytes");
    await expect(openArc(counted, { maxFiledescBytes: 1 })).rejects.toThrow("filedesc bytes");
    await expect(openArc(counted, { maxDecodedBytes: 1 })).rejects.toThrow("Decoded");
    await expect(openArc(counted, { maxChunkBytes: 65537 })).rejects.toThrow("ceiling");
  });
  it("reserves the final header LF at the exact retained-metadata boundary", async () => {
    const bytes = authored();
    const initial = await openArc(source(bytes));
    const required = initial.entries.reduce(
      (sum, entry) => sum + entry.blockOffset - entry.headerOffset + 128 + (entry.kind === "filedesc" ? entry.size : 0),
      0,
    );
    expect((await openArc(source(bytes), { maxMetadataBytes: required })).entries.length).toBe(2);
    await expect(openArc(source(bytes), { maxMetadataBytes: required - 1 })).rejects.toThrow("metadata line bytes");
  });
  it("returns exact selected ranges, cumulative source limits and unambiguous physical identities", async () => {
    const bytes = authored();
    const raw = source(bytes);
    const archive = await openArc({ ...raw, identity: "[a,b]" });
    const selected = archive.source(1, { offset: 1, length: 2, maxSourceBytes: 2 });
    expect(selected.size).toBe(2);
    expect(decode(await selected.read(0, 2))).toBe("bc");
    await expect(selected.read(0, 1)).rejects.toThrow("limit");
    expect(selected.identity).not.toBe(archive.source(1).identity);
    expect(JSON.parse(selected.identity!)).toEqual([
      "[a,b]",
      "internet-archive-arc",
      archive.entries[1]!.blockOffset + 1,
      2,
    ]);
    await expect(archive.read(1, { offset: 4, length: 0 })).rejects.toThrow();
    await expect(archive.read(1, { offset: 0, length: 4 })).rejects.toThrow();
    expect(() => archive.source(99)).toThrow("Unknown");
    const empty = archive.source(1, { offset: 3, length: 0 });
    expect((await empty.read(0, 0)).length).toBe(0);
    await expect(archive.read(1, { maxOutputBytes: 0 })).rejects.toThrow("Output");
    await expect(archive.read(1, { ledger: createArchiveLedger({ maxDecodedBytes: 0 }) })).rejects.toThrow("limit");
  });
  it("captures borrowed source descriptors, propagates aborts and rejects spoofed byte extents", async () => {
    const bytes = authored();
    let calls = 0;
    const mutable = {
      size: bytes.length,
      identity: "original",
      stability: "caller" as const,
      async read(offset: number, length: number) {
        calls++;
        return bytes.subarray(offset, offset + length);
      },
    };
    const archive = await openArc(mutable, { maxChunkBytes: 1 });
    mutable.size = 0;
    mutable.identity = "changed";
    mutable.read = async () => {
      throw new Error("replaced");
    };
    expect(decode((await archive.read(1)).bytes)).toBe("abc");
    expect(archive.provenance.identity).toBe("original");
    const abort = new AbortController();
    abort.abort(new Error("stop"));
    const before = calls;
    await expect(archive.source(1).read(0, 1, { signal: abort.signal })).rejects.toThrow("stop");
    expect(calls).toBe(before);
    const spoof = new Uint8Array(1);
    Object.defineProperty(spoof, "byteLength", { value: bytes.length });
    await expect(openArc({
      size: bytes.length,
      stability: "caller",
      async read() {
        return spoof;
      },
    })).rejects.toThrow("incomplete extent");
    await expect(openArc({
      size: 0,
      async read() {
        return new Uint8Array();
      },
    })).rejects.toThrow("stable source");
    await expect(openArc({
      size: bytes.length,
      async read(offset, length) {
        return bytes.subarray(offset, offset + length);
      },
    }, { allowUnverifiedSource: true, maxSourceBytes: 0 })).rejects.toThrow("Source byte");
  });
});
