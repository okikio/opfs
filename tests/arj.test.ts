import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import native from "./fixtures/arj/independent.json" with { type: "json" };
import { ArchiveError, createArchiveLedger, openArj } from "../src/archive/arj.ts";
import type { ByteSourceType } from "../src/source.ts";

// Authored grammar controls use a table-driven CRC independent of the production
// bit recurrence. Genuine native interoperability is a separate fixture proof.
function crc(bytes: Uint8Array): number {
  const table = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    return value >>> 0;
  });
  let state = 0xffffffff;
  for (const byte of bytes) state = table[(state ^ byte) & 255]! ^ (state >>> 8);
  return (state ^ 0xffffffff) >>> 0;
}
function join(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, value) => sum + value.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
function record(name: string, payload: Uint8Array, main = false, fixed = 30): Uint8Array {
  const text = new TextEncoder().encode(name), body = new Uint8Array(fixed + text.length + 2);
  body.set([fixed, 11, 1, 2, 0x10, 0, main ? 2 : 0]);
  const fields = new DataView(body.buffer);
  if (!main) {
    fields.setUint32(12, payload.length, true);
    fields.setUint32(16, payload.length, true);
    fields.setUint32(20, crc(payload), true);
  }
  body.set(text, fixed);
  const prefix = Uint8Array.of(0x60, 0xea, body.length & 255, body.length >>> 8);
  const sum = new Uint8Array(4);
  new DataView(sum.buffer).setUint32(0, crc(body), true);
  return join(prefix, body, sum, new Uint8Array(2), payload);
}
function fixture(payload = Uint8Array.of(49, 50, 51, 52, 53, 54, 55, 56, 57), name = "tiny.txt", fixed = 30) {
  const main = record("archive.arj", new Uint8Array(), true, 34), file = record(name, payload, false, fixed);
  const bytes = join(main, file, Uint8Array.of(0x60, 0xea, 0, 0));
  return { bytes, payload, headerOffset: main.length, offset: main.length + file.length - payload.length };
}
function source(bytes: Uint8Array, action?: (offset: number, length: number) => void): ByteSourceType {
  return {
    size: bytes.length,
    stability: "caller",
    identity: "authored/arj",
    async read(offset, length) {
      action?.(offset, length);
      return bytes.slice(offset, offset + length);
    },
  };
}
function changeHeader(
  bytes: Uint8Array,
  offset: number,
  change: (body: Uint8Array, fields: DataView) => void,
): Uint8Array {
  const result = bytes.slice(), length = new DataView(result.buffer).getUint16(offset + 2, true);
  const body = result.subarray(offset + 4, offset + 4 + length);
  change(body, new DataView(body.buffer, body.byteOffset, body.length));
  new DataView(result.buffer).setUint32(offset + 4 + length, crc(body), true);
  return result;
}

describe("bounded ARJ STORED preview", () => {
  it("reads every original native STORED member and labels native compressed extents honestly", async () => {
    for (const item of native.fixtures) {
      const archive = await openArj(source(decodeBase64(item.archive.base64)));
      expect(archive.entries.map((entry) => entry.name).sort()).toEqual(
        [...Object.keys(item.payloads), ...item.directories].sort(),
      );
      expect(archive.comment).toBe(item.archiveComment);
      for (const [name, comment] of Object.entries(item.fileComments)) {
        const record = archive.entries.find((entry) => entry.name === name)!;
        expect(record.comment).toBe(comment);
        expect(new TextDecoder().decode(record.rawComment)).toBe(comment);
      }
      for (const name of item.directories) {
        const directory = archive.entries.find((entry) => entry.name === name)!;
        expect(directory.kind).toBe("directory");
        expect(directory.size).toBe(0);
        expect(directory.readable).toBe(false);
      }
      for (const [name, payload] of Object.entries(item.payloads)) {
        const entry = archive.entries.find((value) => value.name === name)!;
        const original = decodeBase64(payload.base64);
        if (entry.method !== 0) {
          expect(entry.readable).toBe(false);
          await expect(archive.read(entry.id)).rejects.toMatchObject({ code: "unsupported-profile" });
          continue;
        }
        const full = await archive.read(entry.id);
        expect(full.bytes).toEqual(original);
        expect(full.integrity).toBe("crc32-verified");
        const from = Math.min(2, original.length), length = Math.min(37, original.length - from);
        expect((await archive.read(entry.id, { offset: from, length })).bytes).toEqual(
          original.slice(from, from + length),
        );
        expect(await archive.member(entry.id).read(from, length)).toEqual(original.slice(from, from + length));
      }
    }
  });
  it("checks independent CRC32 vector and distinguishes full verification from selected pending bytes", async () => {
    const value = fixture();
    expect(crc(value.payload)).toBe(0xcbf43926);
    const archive = await openArj(source(value.bytes));
    expect(archive.entries[0]?.name).toBe("tiny.txt");
    const full = await archive.read(0);
    expect(full.bytes).toEqual(value.payload);
    expect(full.integrity).toBe("crc32-verified");
    const prefix = await archive.read(0, { length: 2 });
    expect(prefix.bytes).toEqual(value.payload.slice(0, 2));
    expect(prefix.work.sourceBytes).toBe(9);
    const selected = await archive.read(0, { offset: 2, length: 3, verify: false });
    expect(selected.bytes).toEqual(value.payload.slice(2, 5));
    expect(selected.integrity).toBe("pending");
    expect(selected.work).toEqual({ sourceBytes: 3, decodedBytes: 3, outputBytes: 3, requests: 1 });
  });
  it("checks an unselected corrupt suffix and full selections even with verify false", async () => {
    const value = fixture();
    value.bytes[value.offset + 8] = 0;
    const archive = await openArj(source(value.bytes));
    expect((await archive.read(0, { length: 1, verify: false })).bytes).toEqual(value.payload.slice(0, 1));
    await expect(archive.read(0, { length: 1 })).rejects.toMatchObject({ code: "checksum-mismatch" });
    await expect(archive.read(0, { verify: false })).rejects.toMatchObject({ code: "checksum-mismatch" });
  });
  it("validates zero-byte members and the revision-9 fields", async () => {
    const empty = fixture(new Uint8Array(), "empty", 46);
    const archive = await openArj(source(empty.bytes));
    expect((await archive.read(0)).work).toEqual({ sourceBytes: 0, decodedBytes: 0, outputBytes: 0, requests: 0 });
    expect((await archive.read(0)).integrity).toBe("crc32-verified");
    expect(archive.entries[0]?.created).toBe(0);
  });
  it("refuses basic-header CRC errors and every truncation", async () => {
    const value = fixture();
    const broken = value.bytes.slice();
    broken[5] = 0;
    await expect(openArj(source(broken))).rejects.toMatchObject({ code: "checksum-mismatch" });
    for (let length = 0; length < value.bytes.length; length++) {
      await expect(openArj(source(value.bytes.slice(0, length)))).rejects.toBeInstanceOf(ArchiveError);
    }
  });
  it("refuses extensions and unsupported flags, kinds, layouts, methods and trailing data", async () => {
    const value = fixture();
    for (
      const change of [
        (body: Uint8Array) => {
          body[4] = 1;
        },
        (body: Uint8Array) => {
          body[6] = 6;
        },
        (body: Uint8Array) => {
          body[0] = 31;
        },
        (body: Uint8Array) => {
          body[5] = 5;
        },
        (body: Uint8Array) => {
          body[28] = 1;
        },
        (body: Uint8Array) => {
          body[2] = 12;
        },
      ]
    ) {
      await expect(openArj(source(changeHeader(value.bytes, value.headerOffset, change)))).rejects.toMatchObject({
        code: "unsupported-profile",
      });
    }
    const extension = value.bytes.slice();
    extension[value.offset - 2] = 2;
    await expect(openArj(source(extension))).rejects.toMatchObject({ code: "unsupported-profile" });
    await expect(openArj(source(join(value.bytes, Uint8Array.of(0))))).rejects.toMatchObject({
      code: "unsupported-profile",
    });
  });
  it("indexes a known compressed extent but refuses decoding", async () => {
    const value = fixture();
    const compressed = changeHeader(value.bytes, value.headerOffset, (body) => {
      body[5] = 1;
    });
    const archive = await openArj(source(compressed));
    expect(archive.entries[0]?.readable).toBe(false);
    await expect(archive.read(0)).rejects.toMatchObject({ code: "unsupported-profile" });
    expect(() => archive.member(0)).toThrow(ArchiveError);
  });
  it("refuses size mismatches, malformed terminators and non-ASCII default names", async () => {
    const value = fixture();
    await expect(
      openArj(source(changeHeader(value.bytes, value.headerOffset, (_body, fields) => fields.setUint32(16, 99, true)))),
    ).rejects.toMatchObject({ code: "invalid-archive" });
    await expect(openArj(source(changeHeader(value.bytes, value.headerOffset, (body) => {
      body[body.length - 1] = 1;
    })))).rejects.toMatchObject({ code: "invalid-archive" });
    await expect(openArj(source(fixture(undefined, "café").bytes))).rejects.toMatchObject({
      code: "unsupported-profile",
    });
  });
  it("captures source/options/decoder/ledger methods and isolates getters from mutation", async () => {
    const value = fixture();
    let calls = 0;
    const backing = source(value.bytes, () => {
      calls++;
    });
    const ledger = createArchiveLedger();
    const options = { ledger, decodeName: (bytes: Uint8Array) => new TextDecoder().decode(bytes), maxNameBytes: 100 };
    const opened = openArj(backing, options);
    backing.read = async () => {
      throw new Error("mutated source method");
    };
    Object.defineProperty(backing, "size", { value: 0 });
    Object.defineProperty(backing, "identity", { value: "mutated identity" });
    options.decodeName = () => "mutated";
    options.maxNameBytes = 0;
    ledger.reserve = () => {
      throw new Error("mutated ledger method");
    };
    const archive = await opened;
    expect(archive.entries[0]?.name).toBe("tiny.txt");
    archive.entries[0]!.rawName.fill(0);
    archive.entries[0]!.rawComment.fill(255);
    expect(new TextDecoder().decode(archive.entries[0]!.rawName)).toBe("tiny.txt");
    expect((await archive.read(0)).bytes).toEqual(value.payload);
    expect(calls).toBeGreaterThan(0);
  });
  it("copies borrowed header scratch before subsequent reads and reentrant decoders", async () => {
    const value = fixture(), scratch = new Uint8Array(65536);
    const borrowed: ByteSourceType = {
      size: value.bytes.length,
      stability: "caller",
      async read(offset, length) {
        scratch.fill(255);
        scratch.set(value.bytes.subarray(offset, offset + length));
        return scratch.subarray(0, length);
      },
    };
    const archive = await openArj(borrowed, {
      decodeName(bytes) {
        scratch.fill(0);
        return new TextDecoder().decode(bytes);
      },
    });
    expect(archive.entries[0]?.size).toBe(value.payload.length);
    const first = await archive.read(0, { length: 2, verify: false });
    await borrowed.read(0, 4);
    expect(first.bytes).toEqual(value.payload.slice(0, 2));
  });
  it("retains opening ledger and deduplicates it through nested source reads", async () => {
    const value = fixture();
    const ledger = createArchiveLedger();
    const archive = await openArj(source(value.bytes), { ledger });
    const before = ledger.inspect();
    const nested = archive.member(0, { ledger });
    expect(await nested.read(1, 2)).toEqual(value.payload.slice(1, 3));
    const after = ledger.inspect();
    expect(after.sourceBytes - before.sourceBytes).toBe(2);
    expect(after.outputBytes - before.outputBytes).toBe(2);
    expect(after.requests - before.requests).toBe(1);
  });
  it("pre-admits known source/request/output costs before payload IO", async () => {
    const value = fixture();
    let payloadReads = 0;
    const archive = await openArj(source(value.bytes, (at) => {
      if (at >= value.offset) payloadReads++;
    }));
    payloadReads = 0;
    for (const limits of [{ maxSourceBytes: 0 }, { maxRequests: 0 }, { maxOutputBytes: 0 }]) {
      await expect(archive.read(0, { ledger: createArchiveLedger(limits) })).rejects.toMatchObject({
        code: "budget-exceeded",
      });
      expect(payloadReads).toBe(0);
    }
    await expect(archive.read(0, { length: 1, maxSourceBytes: 8 })).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(payloadReads).toBe(0);
  });
  it("retains exhausted opening limits after open, including member wrappers", async () => {
    const value = fixture();
    const probe = await openArj(source(value.bytes));
    const archive = await openArj(source(value.bytes), { maxSourceBytes: probe.work.sourceBytes });
    await expect(archive.read(0, { length: 1, verify: false })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(archive.member(0).read(0, 1)).rejects.toMatchObject({ code: "budget-exceeded" });
  });
  it("retains an exhausted external opening ledger through read and member", async () => {
    const value = fixture();
    const measured = await openArj(source(value.bytes));
    const owner = createArchiveLedger({ maxSourceBytes: measured.work.sourceBytes });
    const archive = await openArj(source(value.bytes), { ledger: owner });
    await expect(archive.read(0, { length: 1, verify: false, ledger: createArchiveLedger() })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    await expect(archive.member(0, { ledger: createArchiveLedger() }).read(0, 1)).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });
  it("retains abort authority and checks foreign ledger abort before IO", async () => {
    const value = fixture(), controller = new AbortController(), reason = new Error("parent stopped");
    const archive = await openArj(source(value.bytes), { signal: controller.signal });
    const nested = archive.member(0);
    controller.abort(reason);
    await expect(archive.read(0, { length: 0 })).rejects.toBe(reason);
    await expect(nested.read(0, 1)).rejects.toBe(reason);
    const another = new AbortController();
    let reads = 0;
    const active = await openArj(source(value.bytes, () => {
      reads++;
    }));
    reads = 0;
    const owner = createArchiveLedger();
    await expect(active.read(0, {
      signal: another.signal,
      ledger: {
        inspect: () => owner.inspect(),
        reserve(kind, count) {
          owner.reserve(kind, count);
          another.abort(reason);
        },
      },
    })).rejects.toBe(reason);
    expect(reads).toBe(0);
  });
  it("preserves duplicate inert names and indexes empty directory records", async () => {
    const payload = Uint8Array.of(7);
    const directory = record("../directory", new Uint8Array());
    const dir = changeHeader(directory, 0, (body) => {
      body[6] = 3;
    });
    const wire = join(
      record("main", new Uint8Array(), true),
      record("../same", payload),
      record("../same", payload),
      dir,
      Uint8Array.of(0x60, 0xea, 0, 0),
    );
    const archive = await openArj(source(wire));
    expect(archive.entries.map((entry) => [entry.id, entry.name])).toEqual([[0, "../same"], [1, "../same"], [
      2,
      "../directory",
    ]]);
    expect(archive.entries[2]?.kind).toBe("directory");
    expect(archive.entries[2]?.readable).toBe(false);
    expect(archive.entries[0]?.headerOffset).not.toBe(archive.entries[1]?.headerOffset);
  });
  it("preserves source failure identity and observes abort at source settlement", async () => {
    const value = fixture(), failure = new Error("provider failed");
    const borrowed = source(value.bytes);
    const reading = borrowed.read;
    let failed = false;
    borrowed.read = async (offset, length, opts) => {
      if (failed) throw failure;
      return reading(offset, length, opts);
    };
    const archive = await openArj(borrowed);
    failed = true;
    await expect(archive.read(0)).rejects.toBe(failure);
    const controller = new AbortController();
    let stopped = false;
    const other = await openArj(
      source(value.bytes, (offset) => {
        if (stopped && offset >= value.offset) controller.abort(failure);
      }),
      { signal: controller.signal },
    );
    stopped = true;
    await expect(other.read(0, { length: 1, verify: false })).rejects.toBe(failure);
  });
  it("checks serialized caps, stable source evidence and requested ranges", async () => {
    const value = fixture();
    for (const limits of [{ maxEntries: 0 }, { maxHeaderBytes: 0 }, { maxEntryHeaderBytes: 0 }, { maxNameBytes: 0 }]) {
      await expect(openArj(source(value.bytes), limits)).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    const unstable = { size: value.bytes.length, read: source(value.bytes).read };
    await expect(openArj(unstable)).rejects.toMatchObject({ code: "unsupported-profile" });
    expect((await openArj(unstable, { allowUnverifiedSource: true })).entries.length).toBe(1);
    const archive = await openArj(source(value.bytes));
    await expect(archive.read(0, { offset: 10 })).rejects.toBeInstanceOf(RangeError);
    await expect(archive.read(0, { offset: NaN })).rejects.toBeInstanceOf(RangeError);
    await expect(archive.read(1)).rejects.toBeInstanceOf(RangeError);
  });
});
