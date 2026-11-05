import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { runInNewContext } from "node:vm";
import { createArchiveLedger, openZip } from "../src/archive/zip.ts";
import { openTar } from "../src/archive/tar.ts";
import type { ByteSourceType } from "../src/source.ts";

// Python 3.9 stdlib zipfile, fixed 2020-01-01 timestamp: stored hello, deflated
// 80,000 ASCII A bytes, duplicate stored name, deflated UTF-8 name. The expected
// payloads and CRC values come from the independent producer, not this parser.
const zipFixture =
  "UEsDBBQAAAAAAAAAIVCFEUoNCwAAAAsAAAAJAAAAZmlyc3QudHh0aGVsbG8gd29ybGRQSwMEFAAAAAgAAAAhUHnPp1NfAAAAgDgBAAkAAABsYXJnZS50eHTtwYEAAAAAwyC2+Usd4ApVAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAG1BLAwQUAAAAAAAAACFQG4FHEgkAAAAJAAAACQAAAGZpcnN0LnR4dGR1cGxpY2F0ZVBLAwQUAAAICAAAACFQsymFUwgAAAAGAAAACQAAAGNhZsOpLnR4dEvOT0tLTQUAUEsBAhQDFAAAAAAAAAAhUIURSg0LAAAACwAAAAkAAAAAAAAAAAAAAIABAAAAAGZpcnN0LnR4dFBLAQIUAxQAAAAIAAAAIVB5z6dTXwAAAIA4AQAJAAAAAAAAAAAAAACAATIAAABsYXJnZS50eHRQSwECFAMUAAAAAAAAACFQG4FHEgkAAAAJAAAACQAAAAAAAAAAAAAAgAG4AAAAZmlyc3QudHh0UEsBAhQDFAAACAgAAAAhULMphVMIAAAABgAAAAkAAAAAAAAAAAAAAIAB6AAAAGNhZsOpLnR4dFBLBQYAAAAABAAEANwAAAAXAQAAAAA=";
// Same independent fixture with standard ZIP64 end/locator records, assembled
// through Python struct.pack; central members do not need widened values.
const zip64Tail =
  "UEsGBiwAAAAAAAAALQAtAAAAAAAAAAAABAAAAAAAAAAEAAAAAAAAANwAAAAAAAAAFwEAAAAAAABQSwYHAAAAAPMBAAAAAAAAAQAAAFBLBQYAAAAA////////////////AAA=";

function source(bytes: Uint8Array = decodeBase64(zipFixture)): ByteSourceType & { reads: [number, number][] } {
  const reads: [number, number][] = [];
  return {
    size: bytes.byteLength,
    identity: "fixture-immutable",
    stability: "immutable",
    reads,
    read(offset, length, options) {
      options?.signal?.throwIfAborted();
      reads.push([offset, length]);
      return Promise.resolve(bytes.slice(offset, offset + length));
    },
  };
}

describe("bounded ZIP previews", () => {
  it("lists duplicate identities and UTF-8 names without decoding any members", async () => {
    const zip = await openZip(source());
    expect(zip.entries.map(({ id, name }) => [id, name])).toEqual([
      [0, "first.txt"],
      [1, "large.txt"],
      [2, "first.txt"],
      [3, "café.txt"],
    ]);
    expect(zip.entries[1]?.size).toBe(80000);
    expect(zip.work.decodedBytes).toBe(0);
    expect(Object.isFrozen(zip.entries)).toBe(true);
  });

  it("reads a stored selected range without reading another member", async () => {
    const input = source();
    const zip = await openZip(input);
    input.reads.length = 0;
    const result = await zip.read(0, { offset: 6, length: 5 });
    expect(new TextDecoder().decode(result.bytes)).toBe("world");
    expect(result.integrity).toBe("checksum-pending");
    expect(input.reads).toEqual([[0, 30], [30, 9], [45, 5]]);
    expect(result.work.sourceBytes).toBe(44);
    expect(result.work.decodedBytes).toBe(5);
  });

  it("verifies a complete stored member and keeps duplicate names independent", async () => {
    const zip = await openZip(source());
    expect(new TextDecoder().decode((await zip.read(0)).bytes)).toBe("hello world");
    expect((await zip.read(0)).integrity).toBe("checksum-verified");
    expect(new TextDecoder().decode((await zip.read(2)).bytes)).toBe("duplicate");
  });

  it("decodes raw DEFLATE with exact CRC and bounded selected output", async () => {
    const zip = await openZip(source());
    const full = await zip.read(1);
    expect(full.bytes).toEqual(new Uint8Array(80000).fill(65));
    expect(full.integrity).toBe("checksum-verified");
    const preview = await zip.read(1, { offset: 100, length: 7 });
    expect(preview.bytes).toEqual(new Uint8Array(7).fill(65));
    expect(preview.integrity).toBe("checksum-pending");
    expect(preview.work.decodedBytes).toBeGreaterThanOrEqual(107);
    expect(preview.work.outputBytes).toBe(7);
    expect((await zip.read(3)).bytes).toEqual(new TextEncoder().encode("coffee"));
  });

  it("verifies full protected scope even when returning only a short range", async () => {
    const zip = await openZip(source());
    const read = await zip.read(1, { length: 3, verify: true });
    expect(read.bytes).toEqual(new Uint8Array(3).fill(65));
    expect(read.work.decodedBytes).toBe(80000);
    expect(read.integrity).toBe("checksum-verified");
  });

  it("refuses output, decode, source and request budgets", async () => {
    const zip = await openZip(source());
    await expect(zip.read(1, { maxOutputBytes: 3 })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(zip.read(1, { length: 3, maxDecodedBytes: 3 })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(zip.read(0, { length: 1, maxSourceBytes: 20 })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(zip.read(0, { maxRequests: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(openZip(source(), { maxDirectoryBytes: 2 })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(openZip(source(), { maxEntries: 3 })).rejects.toMatchObject({ code: "budget-exceeded" });
  });

  it("plans without I/O and refuses encryption before opening member bytes", async () => {
    const bytes = decodeBase64(zipFixture);
    // Central directory begins at 279. Set encryption on the first directory entry.
    bytes[279 + 8] = 1;
    const input = source(bytes);
    const zip = await openZip(input);
    input.reads.length = 0;
    expect(zip.plan(0).reason).toBe("encrypted-member");
    expect(input.reads).toEqual([]);
    await expect(zip.read(0)).rejects.toMatchObject({ code: "unsupported-profile" });
    expect(input.reads).toEqual([]);
  });

  it("rejects payload corruption, conflicting headers and malformed extents", async () => {
    const bytes = decodeBase64(zipFixture);
    bytes[39] = 0;
    const zip = await openZip(source(bytes));
    await expect(zip.read(0)).rejects.toMatchObject({ code: "checksum-mismatch" });
    bytes[30] = 0;
    await expect((await openZip(source(bytes))).read(0)).rejects.toMatchObject({ code: "invalid-archive" });
    await expect(openZip(source(bytes.subarray(0, bytes.length - 1)))).rejects.toMatchObject({
      code: "invalid-archive",
    });
    const truncated = source();
    truncated.read = () => Promise.resolve(new Uint8Array());
    await expect(openZip(truncated)).rejects.toMatchObject({ code: "invalid-archive" });
  });

  it("reads ZIP64 directory metadata without narrowing 64-bit fields", async () => {
    const bytes = decodeBase64(zipFixture);
    const tail = decodeBase64(zip64Tail);
    const widened = new Uint8Array(bytes.length - 22 + tail.length);
    widened.set(bytes.subarray(0, bytes.length - 22));
    widened.set(tail, bytes.length - 22);
    const zip = await openZip(source(widened));
    expect(zip.entries).toHaveLength(4);
    expect(new TextDecoder().decode((await zip.read(0)).bytes)).toBe("hello world");
    new DataView(widened.buffer).setBigUint64(bytes.length - 22 + 32, 9007199254740992n, true);
    await expect(openZip(source(widened))).rejects.toMatchObject({ code: "unsupported-profile" });
  });

  it("reads data-descriptor members from an independent non-seekable ZIP writer", async () => {
    // Python zipfile writing to a BytesIO subclass whose seek() raises UnsupportedOperation.
    const bytes = decodeBase64(
      "UEsDBBQACAAIAAAAIVAAAAAAAAAAAAAAAAAIAAAAZGF0YS50eHTLSM3JyVdISS1OLsosKMkvAgBQSwcIjr1z2RIAAAAQAAAAUEsBAhQDFAAIAAgAAAAhUI69c9kSAAAAEAAAAAgAAAAAAAAAAAAAAIABAAAAAGRhdGEudHh0UEsFBgAAAAABAAEANgAAAEgAAAAAAA==",
    );
    const zip = await openZip(source(bytes));
    const result = await zip.read(0);
    expect(new TextDecoder().decode(result.bytes)).toBe("hello descriptor");
    expect(result.integrity).toBe("checksum-verified");
  });

  it("propagates cancellation before source acquisition", async () => {
    const controller = new AbortController();
    const reason = new Error("closed preview");
    controller.abort(reason);
    const input = source();
    await expect(openZip(input, { signal: controller.signal })).rejects.toBe(reason);
    expect(input.reads).toEqual([]);
  });

  it("requires explicit acceptance for sources without stability evidence", async () => {
    const input = source();
    const unverified = { size: input.size, read: input.read };
    await expect(openZip(unverified)).rejects.toMatchObject({ code: "unsupported-profile" });
    expect(input.reads).toEqual([]);
    expect((await openZip(unverified, { allowUnverifiedSource: true })).source.stability).toBe("unverified");
  });

  it("accepts genuine cross-realm source bytes using native view slots", async () => {
    const input = source();
    const foreign = runInNewContext("(bytes) => new Uint8Array(bytes)") as (bytes: Uint8Array) => Uint8Array;
    const zip = await openZip({
      ...input,
      async read(offset, length, options) {
        return foreign(await input.read(offset, length, options));
      },
    });
    expect(new TextDecoder().decode((await zip.read(0)).bytes)).toBe("hello world");
  });

  it("shares decoded and returned-byte admission across independent member reads", async () => {
    const ledger = createArchiveLedger({ maxDecodedBytes: 8, maxOutputBytes: 8 });
    const zip = await openZip(source(), { ledger });
    await zip.read(0, { length: 5, ledger });
    await expect(zip.read(2, { length: 5, ledger })).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(ledger.inspect().decodedBytes).toBe(5);
    expect(ledger.inspect().outputBytes).toBe(5);
    expect(() => zip.plan(0, { maxRequests: Number.NaN })).toThrow();
  });

  it("cancels a pending codec read and preserves an injected factory failure", async () => {
    const zip = await openZip(source());
    const entered = Promise.withResolvers<void>();
    const controller = new AbortController();
    let cancelled = 0;
    const reading = zip.read(1, {
      length: 1,
      signal: controller.signal,
      inflate: () => ({
        readable: new ReadableStream<Uint8Array>({
          cancel() {
            cancelled++;
          },
        }),
        writable: new WritableStream<Uint8Array>({
          write() {
            entered.resolve();
          },
        }),
      }),
    });
    void reading.catch(() => {});
    await entered.promise;
    const reason = new Error("preview closed during decode");
    controller.abort(reason);
    await expect(reading).rejects.toBe(reason);
    expect(cancelled).toBe(1);
    const factoryFailure = new Error("explicit codec failed");
    await expect(zip.read(1, {
      inflate() {
        throw factoryFailure;
      },
    })).rejects.toBe(factoryFailure);
  });
});

// First independent Python tarfile USTAR header, stripped payload/padding so the
// fixture stays readable; payload is the separately specified eleven bytes.
const tarHeader =
  "Zmlyc3QudHh0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAwMDA2NDQAMDAwMDAwMAAwMDAwMDAwADAwMDAwMDAwMDEzADAwMDAwMDAwMDAwADAwNzYyNwAgMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB1c3RhcgAwMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC=";

function tarFixture(): Uint8Array {
  const bytes = new Uint8Array(2048);
  bytes.set(decodeBase64(tarHeader).subarray(0, 512));
  bytes.set(new TextEncoder().encode("hello world"), 512);
  return bytes;
}

describe("ustar inspection", () => {
  it("scans headers, skips payloads and reads a bounded selected range", async () => {
    const input = source(tarFixture());
    const tar = await openTar(input);
    expect(tar.entries).toEqual([{ id: 0, name: "first.txt", size: 11, kind: "file", link: "" }]);
    expect(input.reads).toEqual([[0, 512], [1024, 512], [1536, 512]]);
    const read = await tar.read(0, { offset: 6, length: 5 });
    expect(new TextDecoder().decode(read.bytes)).toBe("world");
    expect(read.integrity).toBe("header-checksum-only");
    expect(read.work.sourceBytes).toBe(5);
  });

  it("rejects bad header checksums, truncation and entry/output limits", async () => {
    const bytes = tarFixture();
    bytes[0] = bytes[0]! ^ 1;
    await expect(openTar(source(bytes))).rejects.toMatchObject({ code: "checksum-mismatch" });
    await expect(openTar(source(tarFixture().subarray(0, 1024)))).rejects.toMatchObject({ code: "invalid-archive" });
    await expect(openTar(source(tarFixture()), { maxEntries: 0 })).rejects.toMatchObject({ code: "budget-exceeded" });
    const tar = await openTar(source(tarFixture()));
    await expect(tar.read(0, { maxOutputBytes: 2 })).rejects.toMatchObject({ code: "budget-exceeded" });
  });
});
