import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createArchiveLedger, openZip } from "../src/archive/zip.ts";
import type { ByteSourceType } from "../src/source.ts";
import fixtures from "./fixtures/zip-bzip/independent.json" with { type: "json" };

function source(bytes: Uint8Array): ByteSourceType & { reads: number; bytes: number } {
  return {
    size: bytes.length,
    stability: "immutable",
    reads: 0,
    bytes: 0,
    async read(offset, length, options) {
      options?.signal?.throwIfAborted();
      this.reads++;
      this.bytes += length;
      return bytes.slice(offset, offset + length);
    },
  };
}

/** Locate genuine central/local records without relying on the candidate index. */
function headers(bytes: Uint8Array, name: string): { central: number; local: number } {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = data.getUint32(bytes.length - 6, true);
  while (data.getUint32(at, true) === 0x02014b50) {
    const n = data.getUint16(at + 28, true), x = data.getUint16(at + 30, true), c = data.getUint16(at + 32, true);
    if (new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + n)) === name) {
      return { central: at, local: data.getUint32(at + 42, true) };
    }
    at += 46 + n + x + c;
  }
  throw new Error("Independent ZIP member is absent.");
}

const native = fixtures.fixtures.find((item) => item.name === "python-1")!;
const many = native.members.find((member) => member.name === "many.bin")!;
const original = decodeBase64(many.original.base64);

describe("ZIP method 12 BZip2 preview", () => {
  it("reads every original byte from reciprocal Python/7-Zip fixtures, including descriptors and empty streams", async () => {
    let actualBzip = 0;
    for (const item of fixtures.fixtures) {
      // A lifetime allowance covers four full native members, including BWT verification/replay work.
      const archive = await openZip(source(decodeBase64(item.archive.base64)), { maxDecodedBytes: 64 * 1024 ** 2 });
      for (const member of item.members) {
        const entry = archive.entries.find((candidate) => candidate.name === member.name)!;
        const result = await archive.read(entry.id);
        expect(result.bytes).toEqual(decodeBase64(member.original.base64));
        expect(result.integrity).toBe("checksum-verified");
        if (member.method === 12) {
          actualBzip++;
          expect(result.codec?.integrity).toBe("checksum-verified");
          expect(result.codec?.kind).toBe("bzip2");
          if (result.codec?.kind !== "bzip2") throw new Error("Method 12 must report BZip2 evidence.");
          if (member.name === "many.bin" && item.name === "python-1") {
            expect(result.codec!.verifiedBlocks).toBeGreaterThan(1);
          }
        }
      }
    }
    expect(actualBzip).toBe(20);
  });
  it("keeps prefix ZIP/stream checks pending while verifying covering blocks and bounds exact selected output", async () => {
    const input = source(decodeBase64(native.archive.base64));
    const ledger = createArchiveLedger({ maxOutputBytes: 64 });
    const archive = await openZip(input, { ledger });
    const entry = archive.entries.find((item) => item.name === many.name)!;
    input.reads = 0;
    input.bytes = 0;
    const prefix = await archive.read(entry.id, { length: 7, bzip: { outputChunkBytes: 257 } });
    expect(prefix.bytes).toEqual(original.slice(0, 7));
    expect(prefix.integrity).toBe("checksum-pending");
    expect(prefix.codec?.integrity).toBe("checksum-pending");
    if (prefix.codec?.kind !== "bzip2") throw new Error("Method 12 must report BZip2 evidence.");
    expect(prefix.codec!.verifiedBlocks).toBe(1);
    expect(prefix.work.outputBytes).toBe(7);
    expect(ledger.inspect().outputBytes).toBe(7);
    expect(prefix.work.sourceBytes).toBe(input.bytes);
    expect(prefix.work.requests).toBe(input.reads);
    expect(prefix.work.decodedBytes).toBeGreaterThan(prefix.bytes.length);
    const late = await archive.read(entry.id, { offset: 100023, length: 11 });
    expect(late.bytes).toEqual(original.slice(100023, 100034));
    const verified = await archive.read(entry.id, { offset: 100023, length: 11, verify: true });
    expect(verified.bytes).toEqual(late.bytes);
    expect(verified.integrity).toBe("checksum-verified");
    expect(verified.codec?.integrity).toBe("checksum-verified");
    const empty = await archive.read(entry.id, { length: 0 });
    expect(empty.bytes.length).toBe(0);
    if (empty.codec?.kind !== "bzip2") throw new Error("Method 12 must report BZip2 evidence.");
    expect(empty.codec.verifiedBlocks).toBe(0);
  });
  it("rejects corrupted block/footer, ZIP CRC, truncated exact extents and unsupported method versions", async () => {
    const raw = decodeBase64(native.archive.base64), h = headers(raw, many.name);
    for (const where of [many.offset + 10, many.offset + many.compressedSize - 5]) {
      const bytes = raw.slice();
      bytes[where] = bytes[where]! ^ 128;
      const ledger = createArchiveLedger();
      const archive = await openZip(source(bytes), { ledger });
      await expect(archive.read(archive.entries.find((entry) => entry.name === many.name)!.id)).rejects.toThrow();
      if (where === many.offset + 10) expect(ledger.inspect().outputBytes).toBe(0);
    }
    for (const edit of ["crc", "truncate", "central-version", "local-version", "encrypted"] as const) {
      const bytes = raw.slice(), data = new DataView(bytes.buffer);
      if (edit === "crc") {
        data.setUint32(h.central + 16, many.crc32 ^ 1, true);
        data.setUint32(h.local + 14, many.crc32 ^ 1, true);
      } else if (edit === "truncate") {
        data.setUint32(h.central + 20, many.compressedSize - 1, true);
        data.setUint32(h.local + 18, many.compressedSize - 1, true);
      } else if (edit === "central-version") data.setUint16(h.central + 6, 45, true);
      else if (edit === "local-version") data.setUint16(h.local + 4, 45, true);
      else {
        data.setUint16(h.central + 8, 1, true);
        data.setUint16(h.local + 6, 1, true);
      }
      const archive = await openZip(source(bytes));
      const entry = archive.entries.find((candidate) => candidate.name === many.name)!;
      await expect(archive.read(entry.id, { password: new Uint8Array([1]) })).rejects.toMatchObject({
        code: edit === "crc" ? "checksum-mismatch" : edit === "truncate" ? "invalid-archive" : "unsupported-profile",
      });
    }
  });
  it("enforces codec/aggregate budgets and never charges internal codec output as caller output", async () => {
    const bytes = decodeBase64(native.archive.base64);
    for (const bzip of [{ maxBlockBytes: 1 }, { maxMemoryBytes: 1 }, { maxSteps: 1 }, { maxBlocks: 0 }]) {
      const archive = await openZip(source(bytes));
      const id = archive.entries.find((entry) => entry.name === many.name)!.id;
      await expect(archive.read(id, { length: 1, bzip })).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    const ledger = createArchiveLedger({ maxOutputBytes: 1 });
    const archive = await openZip(source(bytes), { ledger });
    const id = archive.entries.find((entry) => entry.name === many.name)!.id;
    const result = await archive.read(id, { length: 1, ledger });
    expect(ledger.inspect().outputBytes).toBe(1);
    expect(result.work.outputBytes).toBe(1);
    expect(result.work.decodedBytes).toBeGreaterThan(100000);
    await expect(archive.read(id, { length: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
    const limited = await openZip(source(bytes), { maxDecodedBytes: 10000 });
    await expect(limited.read(id, { length: 1, maxDecodedBytes: 99999999 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    // A rejected request never reaches the packed member, even with a fresh kernel.
    const input = source(bytes), probe = await openZip(input);
    const exhausted = createArchiveLedger({ maxSourceBytes: 0 });
    input.reads = 0;
    await expect(probe.read(id, { length: 1, ledger: exhausted })).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(input.reads).toBe(0);
  });
  it("refuses concatenated BZip2 streams and decoded sizes smaller than a genuine block", async () => {
    const raw = decodeBase64(native.archive.base64), h = headers(raw, many.name);
    const packedEnd = many.offset + many.compressedSize;
    const concatenated = new Uint8Array(raw.length + many.compressedSize);
    concatenated.set(raw.subarray(0, packedEnd));
    concatenated.set(raw.subarray(many.offset, packedEnd), packedEnd);
    concatenated.set(raw.subarray(packedEnd), packedEnd + many.compressedSize);
    const data = new DataView(concatenated.buffer);
    const directory = new DataView(raw.buffer).getUint32(raw.length - 6, true);
    data.setUint32(concatenated.length - 6, directory + many.compressedSize, true);
    data.setUint32(h.central + many.compressedSize + 20, many.compressedSize * 2, true);
    data.setUint32(h.local + 18, many.compressedSize * 2, true);
    const archive = await openZip(source(concatenated));
    const id = archive.entries.find((entry) => entry.name === many.name)!.id;
    await expect(archive.read(id)).rejects.toMatchObject({ code: "unsupported-profile" });
    const smaller = raw.slice(), metadata = new DataView(smaller.buffer);
    metadata.setUint32(h.central + 24, original.length - 1, true);
    metadata.setUint32(h.local + 22, original.length - 1, true);
    const short = await openZip(source(smaller));
    await expect(short.read(id, { length: 1, verify: true })).rejects.toMatchObject({ code: "invalid-archive" });
  });
  it("joins cancellation and retains the original provider/yield error without owning the source", async () => {
    const bytes = decodeBase64(native.archive.base64);
    const parent = new AbortController(), input = source(bytes);
    const archive = await openZip(input, { signal: parent.signal });
    const id = archive.entries.find((entry) => entry.name === many.name)!.id;
    const reason = new Error("stop during pure BZip2 work");
    await expect(archive.read(id, { length: 1, bzip: { yield: async () => parent.abort(reason) } })).rejects.toBe(
      reason,
    );
    const failure = new Error("borrowed provider failure");
    let fail = false;
    const broken: ByteSourceType = {
      size: bytes.length,
      stability: "immutable",
      async read(at, n) {
        if (fail && at >= many.offset && at < many.offset + many.compressedSize) throw failure;
        return bytes.slice(at, at + n);
      },
    };
    const second = await openZip(broken);
    fail = true;
    await expect(second.read(id, { length: 1 })).rejects.toBe(failure);
    const third = await openZip(source(bytes));
    await expect(third.read(id, {
      length: 1,
      bzip: {
        yield: async () => {
          throw failure;
        },
      },
    })).rejects.toBe(failure);
  });
  it("uses captured codec options and handles every packed byte boundary on an independent small member", async () => {
    const bytes = decodeBase64(native.archive.base64);
    let pause = false, release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input: ByteSourceType = {
      size: bytes.length,
      stability: "immutable",
      async read(at, n) {
        if (pause) await gate;
        return bytes.slice(at, at + n);
      },
    };
    const archive = await openZip(input);
    const entry = archive.entries.find((candidate) => candidate.name === "odd.bin")!;
    const options = { bzip: { inputChunkBytes: 1, outputChunkBytes: 1 } };
    pause = true;
    const pending = archive.read(entry.id, options);
    options.bzip.inputChunkBytes = 0;
    options.bzip.outputChunkBytes = 0;
    release();
    const result = await pending;
    expect(result.bytes).toEqual(
      decodeBase64(native.members.find((member) => member.name === entry.name)!.original.base64),
    );
    expect(result.codec?.integrity).toBe("checksum-verified");
  });
});
