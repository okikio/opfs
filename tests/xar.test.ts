import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { deflateSync } from "node:zlib";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import type { XarOpenOptionsType } from "../src/archive/xar.ts";
import { createArchiveLedger, openXar } from "../src/archive/xar.ts";
import fixture from "./fixtures/xar/independent.json" with { type: "json" };
const open = (input: ByteSourceType, options: XarOpenOptionsType = {}) =>
  openXar(input, { subtle: crypto.subtle, ...options });
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const source = (bytes: Uint8Array): ByteSourceType => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const digest = async (bytes: Uint8Array, algorithm = "SHA-256"): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest(algorithm, new Uint8Array(bytes).buffer)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
const file = (extra = "", name = "hello", type = "file", id = "1"): string =>
  `<file id="${id}"><name>${name}</name><type>${type}</type>${extra}</file>`;
const data = (extra = "", size = 3, length = 3, offset = 0, encoding = "application/octet-stream"): string =>
  `<data><offset>${offset}</offset><length>${length}</length><size>${size}</size><encoding style="${encoding}"/>${extra}</data>`;
/** Authored invalid/edge fixtures use native zlib only for framing, never candidate output. */
function authored(files = file(data()), bytes = encode("abc"), extra = ""): Uint8Array {
  const xml = encode(`<?xml version="1.0"?><xar><toc>${extra}${files}</toc></xar>`);
  const packed = deflateSync(xml),
    out = new Uint8Array(28 + packed.length + bytes.length),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x78617221);
  view.setUint16(4, 28);
  view.setUint16(6, 1);
  view.setBigUint64(8, BigInt(packed.length));
  view.setBigUint64(16, BigInt(xml.length));
  out.set(packed, 28);
  out.set(bytes, 28 + packed.length);
  return out;
}
describe("Apple-profile XAR1 bounded heap preview", () => {
  it("matches unmodified native producers and independently checked authored member bytes", async () => {
    expect(fixture.producer).toBe("xar 1.8dev");
    for (const object of fixture.objects) {
      const bytes = decodeBase64(object.base64);
      expect(await digest(bytes)).toBe(object.sha256);
      const archive = await open(source(bytes));
      expect(archive.profile).toBe("apple-v1");
      expect(archive.toc).toEqual({ checksum: object.algorithm, status: "verified" });
      for (const record of fixture.records) {
        const entry = archive.entries.find((entry) => entry.path === record.path)!;
        const result = await archive.read(entry.id);
        expect([...result.bytes]).toEqual([...decodeBase64(record.base64)]);
        expect(result.archived).toBe(entry.data ? "verified" : "not-provided");
        expect(result.extracted).toBe(entry.data ? "verified" : "not-provided");
      }
      expect(object.nativeExtractExact).toBe(true);
      for (const receipt of object.bsdtar) {
        expect(receipt.exact).toBe(object.algorithm === "sha1");
        expect(receipt.exitCode).toBe(object.algorithm === "sha1" ? 0 : 1);
      }
    }
  });
  it("preserves EA extents separately and never treats them as file data", async () => {
    const archive = await open(source(decodeBase64(fixture.objects[0]!.base64)));
    const entry = archive.entries.find((entry) => entry.path === "hello.txt")!;
    expect(entry.data!.size).toBe(20);
    expect(entry.attributes.some((attribute) => attribute.name === "com.apple.provenance")).toBe(true);
    expect(new TextDecoder().decode((await archive.read(entry.id)).bytes)).toBe("authored XAR oracle\n");
  });
  it("separates stored selective reads from complete checksum and compressed work", async () => {
    for (const object of fixture.objects.filter((item) => item.algorithm === "sha1")) {
      const archive = await open(source(decodeBase64(object.base64)));
      const entry = archive.entries.find((entry) => entry.path === "nested/data.bin")!;
      const result = await archive.read(entry.id, { offset: 250, length: 9, verify: false });
      expect([...result.bytes]).toEqual([250, 251, 252, 253, 254, 255, 0, 1, 2]);
      expect(result.archived).toBe("pending");
      expect(result.extracted).toBe("pending");
      expect(result.work.decodedBytes).toBe(object.compression === "none" ? 9 : 768);
      const empty = await archive.read(entry.id, { offset: entry.data!.size, length: 0 });
      expect(empty.archived).toBe("verified");
      expect(empty.work.sourceBytes).toBe(entry.data!.length);
    }
  });
  it("provides stored physical sources with stable captured identity and cumulative budgets", async () => {
    const bytes = authored(), original = source(bytes);
    const mutable = { ...original, identity: "snapshot", read: original.read.bind(original) };
    const archive = await open(mutable);
    mutable.read = async () => {
      throw new Error("mutated");
    };
    mutable.identity = "changed";
    const member = archive.source(0, { maxOutputBytes: 3 });
    expect(JSON.parse(member.identity!)[0]).toBe("snapshot");
    expect([...await member.read(1, 2)]).toEqual([98, 99]);
    await expect(member.read(0, 2)).rejects.toThrow("outputBytes");
    const compressed = await open(
      source(decodeBase64(fixture.objects.find((object) => object.compression === "gzip")!.base64)),
    );
    expect(() => compressed.source(compressed.entries.find((entry) => entry.path === "hello.txt")!.id)).toThrow(
      "stored XAR",
    );
  });
  it("rejects unsupported header dialects before TOC allocation", async () => {
    for (const [field, value] of [[4, 64], [6, 2], [24, 2], [24, 99]]) {
      const bytes = authored();
      const view = new DataView(bytes.buffer);
      if (field === 24) view.setUint32(field!, value!);
      else view.setUint16(field!, value!);
      await expect(open(source(bytes))).rejects.toThrow("supported");
    }
    const bytes = authored();
    new DataView(bytes.buffer).setBigUint64(8, 2n ** 60n);
    await expect(open(source(bytes))).rejects.toThrow("exact JavaScript");
  });
  it("bounds TOC lengths, native decoded output, XML markup and metadata before retention", async () => {
    const bytes = authored();
    let reads = 0;
    const original = source(bytes);
    const counted = {
      ...original,
      read: async (offset: number, length: number) => {
        reads++;
        return await original.read(offset, length);
      },
    };
    await expect(open(counted, { maxTocBytes: 0 })).rejects.toThrow("compressed TOC");
    expect(reads).toBe(1);
    await expect(open(source(bytes), { maxXmlBytes: 0 })).rejects.toThrow("XML bytes");
    await expect(open(source(bytes), { maxXmlTokens: 2 })).rejects.toThrow("XML tokens");
    const xmlSize = Number(new DataView(bytes.buffer).getBigUint64(16));
    await expect(open(source(bytes), { maxMetadataBytes: xmlSize + 260 })).rejects.toThrow("retained metadata");
    expect((await open(source(bytes), { maxMetadataBytes: xmlSize + 261 })).entries.length).toBe(1);
    new DataView(bytes.buffer).setBigUint64(16, 1n);
    await expect(open(source(bytes))).rejects.toThrow();
  });
  it("rejects DTD, entities, namespaces, duplicate authority and nested scalar injection", async () => {
    for (
      const files of [
        file(data() + data()),
        file(data().replace("<offset>0</offset>", "<offset><offset>0</offset></offset>")),
        file(data(), "hello") + file(data(), "other"),
        file(data(), "hello", "file", "2") + file(data(), "hello"),
        file(data() + "<name>other</name>"),
        file(data(), "../escape"),
      ]
    ) {
      await expect(open(source(authored(files)))).rejects.toThrow();
    }
    await expect(open(source(authored(file(data()), encode("abc"), "<!DOCTYPE forbidden>")))).rejects.toThrow("DTD");
    await expect(open(source(authored(file(data()), encode("abc"), "<alien:field xmlns:alien='urn:x'/>")))).rejects
      .toThrow("namespaces");
  });
  it("checks exact heap extents, stored sizes, finite path/entry limits and link refusal", async () => {
    for (
      const body of [
        data("", 3, 4),
        data("", 4, 4),
        data("", 3, 3, 900),
        data("", 3, 3).replace("<offset>0", "<offset>-1"),
      ]
    ) await expect(open(source(authored(file(body))))).rejects.toThrow();
    await expect(open(source(authored()), { maxPathBytes: 4 })).rejects.toThrow("path bytes");
    await expect(open(source(authored()), { maxEntries: 0 })).rejects.toThrow("entries");
    const archive = await open(source(authored(file("", "link", "symlink"))));
    await expect(archive.read(0)).rejects.toThrow("links are never followed");
    expect(() => archive.source(0)).toThrow("links are never followed");
  });
  it("rejects encrypted, inline and unsupported compressed data profiles without a fallback", async () => {
    await expect(open(source(authored(file(data() + "<encryption>aes</encryption>"))))).rejects.toThrow("Encrypted");
    await expect(open(source(authored(file(data("<content>YWJj</content>")))))).rejects.toThrow("transform");
    const archive = await open(source(authored(file(data("", 3, 3, 0, "application/x-bzip2")))));
    await expect(archive.read(0)).rejects.toThrow("encoding");
  });
  it("distinguishes digest mismatch, pending, absent and unsupported checksum algorithms", async () => {
    const extra = `<archived-checksum style="sha1">${"00".repeat(20)}</archived-checksum>`;
    const archive = await open(source(authored(file(data(extra)))));
    expect((await archive.read(0, { verify: false })).archived).toBe("pending");
    await expect(archive.read(0)).rejects.toThrow("checksum mismatch");
    const absent = await open(source(authored()));
    expect(absent.toc.status).toBe("not-provided");
    const unknown = await open(
      source(authored(file(data('<extracted-checksum style="unknown">00</extracted-checksum>')))),
    );
    await expect(unknown.read(0)).rejects.toThrow("not supported");
    expect((await unknown.read(0, { verify: false })).extracted).toBe("pending");
  });
  it("detects TOC corruption independently of valid XML and member checksums", async () => {
    const bytes = decodeBase64(fixture.objects[0]!.base64);
    const view = new DataView(bytes.buffer);
    const heap = 28 + Number(view.getBigUint64(8));
    bytes[heap] = bytes[heap]! ^ 1;
    await expect(open(source(bytes))).rejects.toThrow("checksum mismatch");
    expect((await open(source(bytes), { verifyToc: false })).toc.status).toBe("pending");
  });
  it("preflights whole digest work and preserves separate caller aggregate ledgers", async () => {
    const bytes = authored(
      file(data(`<extracted-checksum style="sha1">${await digest(encode("abc"), "SHA-1")}</extracted-checksum>`)),
    );
    const archive = await open(source(bytes), { maxVerifyBytes: 2 });
    await expect(archive.read(0, { length: 1 })).rejects.toThrow("verification bytes");
    expect([...(await archive.read(0, { length: 1, verify: false })).bytes]).toEqual([97]);
    const ledger = createArchiveLedger({ maxOutputBytes: 2 });
    const plain = await open(source(authored()));
    await plain.read(0, { length: 2, ledger });
    await expect(plain.read(0, { length: 1, ledger })).rejects.toThrow("outputBytes");
  });
  it("rejects truncated codec frames and preflights decoded member ceilings before member IO", async () => {
    const packed = deflateSync(encode("abc"));
    const truncated = packed.subarray(0, packed.length - 1);
    const archive = await open(
      source(authored(file(data("", 3, truncated.length, 0, "application/x-gzip")), truncated)),
    );
    await expect(archive.read(0, { verify: false })).rejects.toThrow();
    const good = await open(source(authored(file(data("", 3, packed.length, 0, "application/x-gzip")), packed)), {
      maxMemberBytes: 2,
    });
    await expect(good.read(0, { length: 1 })).rejects.toThrow("decoded member");
    await expect(open(source(authored(file(data()).replace("<name>", '<name enctype="base64">'))))).rejects.toThrow(
      "Encoded",
    );
    await expect(open(source(authored(file(data()), encode("abc"), "<heap/>")))).rejects.toThrow("Whole-heap");
  });
  it("requires explicitly supplied crypto only for requested whole checksum verification", async () => {
    const bytes = decodeBase64(fixture.objects[0]!.base64);
    await expect(openXar(source(bytes))).rejects.toThrow("caller-supplied SubtleCrypto");
    const pending = await openXar(source(bytes), { verifyToc: false });
    expect(pending.toc.status).toBe("pending");
    const entry = pending.entries.find((entry) => entry.path === "hello.txt")!;
    await expect(pending.read(entry.id)).rejects.toThrow("caller-supplied SubtleCrypto");
    expect((await pending.read(entry.id, { verify: false })).archived).toBe("pending");
    expect((await openXar(source(authored()))).toc.status).toBe("not-provided");
  });
  it("captures injected digest authority before awaited source callbacks", async () => {
    const bytes = decodeBase64(fixture.objects[0]!.base64);
    const subtle = Object.assign({}, crypto.subtle, { digest: crypto.subtle.digest.bind(crypto.subtle) });
    const archive = await openXar({
      size: bytes.length,
      stability: "immutable",
      async read(offset, length) {
        subtle.digest = async () => {
          throw new Error("changed digest authority");
        };
        return bytes.slice(offset, offset + length);
      },
    }, { subtle });
    expect(archive.toc.status).toBe("verified");
    const entry = archive.entries.find((entry) => entry.path === "hello.txt")!;
    expect((await archive.read(entry.id)).extracted).toBe("verified");
  });
  it("propagates aborts, exact native byte extents and source stability requirements", async () => {
    const bytes = authored(), stable = source(bytes), controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(open(stable, { signal: controller.signal })).rejects.toThrow("stop");
    await expect(open({ size: bytes.length, read: stable.read.bind(stable) })).rejects.toThrow("stable source");
    const spoof = new Uint8Array(1);
    Object.defineProperty(spoof, "byteLength", { get: () => 28 });
    await expect(open({ size: bytes.length, stability: "caller", read: async () => spoof })).rejects.toThrow(
      "incomplete",
    );
    const openingAbort = new AbortController();
    const capturedArchive = await open(stable, { signal: openingAbort.signal });
    const capturedMember = capturedArchive.source(0);
    openingAbort.abort(new Error("opening stop"));
    await expect(capturedMember.read(0, 1, { signal: new AbortController().signal })).rejects.toThrow("opening stop");
    const archive = await open(stable), member = archive.source(0);
    await expect(member.read(0, 1, { signal: controller.signal })).rejects.toThrow("stop");
    await expect(archive.read(0, { offset: 4, length: 0 })).rejects.toThrow();
  });
});
