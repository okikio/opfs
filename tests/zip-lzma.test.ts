import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createArchiveLedger, openZip } from "../src/archive/zip.ts";
import type { ByteSourceType } from "../src/source.ts";
import fixtures from "./fixtures/zip-lzma/independent.json" with { type: "json" };

function source(bytes: Uint8Array): ByteSourceType & { requests: number; bytes: number } {
  const scratch = new Uint8Array(bytes.length);
  return {
    size: bytes.length,
    stability: "immutable",
    requests: 0,
    bytes: 0,
    async read(at, count, options) {
      options?.signal?.throwIfAborted();
      this.requests++;
      this.bytes += count;
      scratch.fill(0);
      scratch.set(bytes.subarray(at, at + count));
      return scratch.subarray(0, count);
    },
  };
}

/** Independent fixed-header navigation for authored mutations, never candidate private metadata. */
function headers(bytes: Uint8Array, name: string): { central: number; local: number } {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = data.getUint32(bytes.length - 6, true);
  while (data.getUint32(at, true) === 0x02014b50) {
    const length = data.getUint16(at + 28, true),
      extra = data.getUint16(at + 30, true),
      comment = data.getUint16(at + 32, true);
    if (new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + length)) === name) {
      return { central: at, local: data.getUint32(at + 42, true) };
    }
    at += 46 + length + extra + comment;
  }
  throw new Error("Native ZIP fixture member is missing.");
}

const native = fixtures.fixtures.find((item) => item.name === "python")!;
const many = native.members.find((member) => member.name === "many.bin")!;
const original = decodeBase64(many.original.base64);

describe("ZIP method 14 EOS-required LZMA", () => {
  it("matches every native original through Python/7-Zip wire profiles, descriptors and dictionary wrap", async () => {
    let lzma = 0;
    for (const fixture of fixtures.fixtures) {
      const archive = await openZip(source(decodeBase64(fixture.archive.base64)));
      for (const member of fixture.members) {
        const entry = archive.entries.find((item) => item.name === member.name)!;
        const result = await archive.read(entry.id);
        expect(result.bytes).toEqual(decodeBase64(member.original.base64));
        expect(result.integrity).toBe("checksum-verified");
        if (member.method === 14) {
          lzma++;
          if (result.codec?.kind !== "lzma") throw new Error("Method 14 must report LZMA termination evidence.");
          expect(result.codec.integrity).toBe("none");
          expect(result.codec.termination).toBe("end-marker");
          expect(result.codec.dictionaryBytes).toBe(member.wire!.dictionaryBytes);
          if (fixture.name === "seven-64k" && member.name === "many.bin") {
            expect(result.bytes.length).toBeGreaterThan(result.codec.dictionaryBytes);
          }
        }
      }
    }
    expect(lzma).toBeGreaterThanOrEqual(10);
  });
  it("returns selected prefixes with separate structural evidence and exact source/output accounting", async () => {
    const input = source(decodeBase64(native.archive.base64));
    const ledger = createArchiveLedger({ maxOutputBytes: 32 });
    const archive = await openZip(input, { ledger });
    const id = archive.entries.find((entry) => entry.name === many.name)!.id;
    input.requests = 0;
    input.bytes = 0;
    const prefix = await archive.read(id, { length: 7, ledger });
    expect(prefix.bytes).toEqual(original.slice(0, 7));
    expect(prefix.integrity).toBe("checksum-pending");
    if (prefix.codec?.kind !== "lzma") throw new Error("LZMA evidence missing.");
    expect(prefix.codec.termination).toBe("pending");
    expect(prefix.codec.integrity).toBe("none");
    expect(prefix.work.sourceBytes).toBe(input.bytes);
    expect(prefix.work.requests).toBe(input.requests);
    expect(prefix.work.outputBytes).toBe(7);
    expect(ledger.inspect().outputBytes).toBe(7);
    expect(prefix.work.decodedBytes).toBeGreaterThan(7);
    const late = await archive.read(id, { offset: 100023, length: 7 });
    expect(late.bytes).toEqual(original.slice(100023, 100030));
    const verified = await archive.read(id, { offset: 100023, length: 7, verify: true });
    expect(verified.bytes).toEqual(late.bytes);
    expect(verified.integrity).toBe("checksum-verified");
    if (verified.codec?.kind !== "lzma") throw new Error("LZMA evidence missing.");
    expect(verified.codec.termination).toBe("end-marker");
    const empty = await archive.read(id, { length: 0 });
    expect(empty.bytes.length).toBe(0);
    expect(empty.integrity).toBe("checksum-pending");
  });
  it("refuses incompatible property framing, versions, EOS policy, corrupt range state and truncated extents", async () => {
    const raw = decodeBase64(native.archive.base64), h = headers(raw, many.name);
    for (
      const edit of [
        "property-length",
        "property-value",
        "dictionary",
        "central-version",
        "local-version",
        "eos-flag",
        "encrypted",
        "range",
        "truncate",
        "size",
        "crc",
      ] as const
    ) {
      const bytes = raw.slice(), data = new DataView(bytes.buffer);
      let code = "invalid-archive";
      if (edit === "property-length") {
        data.setUint16(many.offset + 2, 6, true);
        code = "unsupported-profile";
      } else if (edit === "property-value") bytes[many.offset + 4] = 225;
      else if (edit === "dictionary") {
        data.setUint32(many.offset + 5, 0xffffffff, true);
        code = "budget-exceeded";
      } else if (edit === "central-version") {
        data.setUint16(h.central + 6, 62, true);
        code = "unsupported-profile";
      } else if (edit === "local-version") {
        data.setUint16(h.local + 4, 62, true);
        code = "unsupported-profile";
      } else if (edit === "eos-flag") {
        data.setUint16(h.central + 8, many.flags & ~2, true);
        data.setUint16(h.local + 6, many.flags & ~2, true);
        code = "unsupported-profile";
      } else if (edit === "encrypted") {
        data.setUint16(h.central + 8, many.flags | 1, true);
        data.setUint16(h.local + 6, many.flags | 1, true);
        code = "unsupported-profile";
      } else if (edit === "range") bytes[many.offset + 9] = 1;
      else if (edit === "truncate") {
        data.setUint32(h.central + 20, many.compressedSize - 1, true);
        data.setUint32(h.local + 18, many.compressedSize - 1, true);
      } else if (edit === "size") {
        data.setUint32(h.central + 24, original.length - 1, true);
        data.setUint32(h.local + 22, original.length - 1, true);
      } else {
        data.setUint32(h.central + 16, many.crc32 ^ 1, true);
        data.setUint32(h.local + 14, many.crc32 ^ 1, true);
        code = "checksum-mismatch";
      }
      const archive = await openZip(source(bytes));
      const id = archive.entries.find((entry) => entry.name === many.name)!.id;
      await expect(archive.read(id)).rejects.toMatchObject({ code });
    }
  });
  it("retains opening/kernel/additional budgets while excluding internal codec chunks from caller output", async () => {
    const bytes = decodeBase64(native.archive.base64);
    for (const lzma of [{ maxDictionaryBytes: 1 }, { maxMemoryBytes: 1 }, { maxDecisions: 1 }, { maxSteps: 1 }]) {
      const archive = await openZip(source(bytes));
      const id = archive.entries.find((entry) => entry.name === many.name)!.id;
      await expect(archive.read(id, { length: 1, lzma })).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    const ledger = createArchiveLedger({ maxOutputBytes: 1 }), archive = await openZip(source(bytes), { ledger });
    const id = archive.entries.find((entry) => entry.name === many.name)!.id;
    expect((await archive.read(id, { length: 1 })).work.outputBytes).toBe(1);
    expect(ledger.inspect().outputBytes).toBe(1);
    await expect(archive.read(id, { length: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
    const limited = await openZip(source(bytes), { maxDecodedBytes: 1000 });
    await expect(limited.read(id, { length: 1, maxDecodedBytes: 999999 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });
  it("rejects trailing raw bytes and a packed extent too short for the property prefix", async () => {
    const raw = decodeBase64(native.archive.base64), h = headers(raw, many.name);
    const end = many.offset + many.compressedSize;
    const bytes = new Uint8Array(raw.length + 1);
    bytes.set(raw.subarray(0, end));
    bytes.set(raw.subarray(end), end + 1);
    const data = new DataView(bytes.buffer), directory = new DataView(raw.buffer).getUint32(raw.length - 6, true);
    data.setUint32(bytes.length - 6, directory + 1, true);
    data.setUint32(h.central + 1 + 20, many.compressedSize + 1, true);
    data.setUint32(h.local + 18, many.compressedSize + 1, true);
    const archive = await openZip(source(bytes)), id = archive.entries.find((entry) => entry.name === many.name)!.id;
    await expect(archive.read(id)).rejects.toMatchObject({ code: "invalid-archive" });
    const short = raw.slice(), metadata = new DataView(short.buffer);
    metadata.setUint32(h.central + 20, 8, true);
    metadata.setUint32(h.local + 18, 8, true);
    await expect((await openZip(source(short))).read(id)).rejects.toMatchObject({ code: "invalid-archive" });
  });
  it("joins cancellation and provider/yield failures without replacing the original error", async () => {
    const bytes = decodeBase64(native.archive.base64), stop = new AbortController();
    const archive = await openZip(source(bytes), { signal: stop.signal });
    const id = archive.entries.find((entry) => entry.name === many.name)!.id;
    const reason = new Error("stop LZMA prefix");
    await expect(archive.read(id, { length: 1, lzma: { yield: async () => stop.abort(reason) } })).rejects.toBe(reason);
    const failure = new Error("LZMA provider failure");
    let fail = false;
    const provider: ByteSourceType = {
      size: bytes.length,
      stability: "immutable",
      async read(at, n) {
        if (fail && at >= many.offset + 9 && at < many.offset + many.compressedSize) throw failure;
        return bytes.slice(at, at + n);
      },
    };
    const second = await openZip(provider);
    fail = true;
    await expect(second.read(id, { length: 1 })).rejects.toBe(failure);
    const third = await openZip(source(bytes));
    await expect(third.read(id, {
      length: 1,
      lzma: {
        yield: async () => {
          throw failure;
        },
      },
    })).rejects.toBe(failure);
  });
  it("retains an output-admission failure beside one decoder scheduling failure", async () => {
    const bytes = decodeBase64(native.archive.base64), scheduler = new Error("independent scheduling failure");
    const ledger = createArchiveLedger({ maxOutputBytes: 0 });
    const archive = await openZip(source(bytes), { ledger });
    const id = archive.entries.find((entry) => entry.name === many.name)!.id;
    let observed: unknown;
    try {
      await archive.read(id, {
        length: 1,
        lzma: {
          yield: async () => {
            throw scheduler;
          },
        },
      });
    } catch (reason) {
      observed = reason;
    }
    expect(observed).toBeInstanceOf(AggregateError);
    const errors = (observed as AggregateError).errors;
    expect(errors.length).toBe(2);
    expect(errors[0]).toMatchObject({ code: "budget-exceeded" });
    expect(errors[1]).toBe(scheduler);
  });
  it("captures kernel policy before source await and handles byte-at-a-time raw input", async () => {
    const bytes = decodeBase64(native.archive.base64), actual = source(bytes);
    let pause = false, release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: ByteSourceType = {
      size: bytes.length,
      stability: "immutable",
      async read(at, count, options) {
        if (pause) await gate;
        return actual.read(at, count, options);
      },
    };
    const archive = await openZip(provider), id = archive.entries.find((entry) => entry.name === "odd.bin")!.id;
    const options = { lzma: { inputChunkBytes: 1 } };
    pause = true;
    const pending = archive.read(id, options);
    options.lzma.inputChunkBytes = 0;
    release();
    const result = await pending;
    expect(result.bytes).toEqual(
      decodeBase64(native.members.find((member) => member.name === "odd.bin")!.original.base64),
    );
    expect(result.integrity).toBe("checksum-verified");
  });
});
