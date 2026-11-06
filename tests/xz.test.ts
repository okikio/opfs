import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { createArchiveLedger, openXz } from "../src/archive/xz.ts";
import fixtures from "./fixtures/xz/independent.json" with { type: "json" };

const source = (bytes: Uint8Array) => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const fixture = (name: string) => {
  const value = fixtures.cases.find((item) => item.name === name);
  if (!value) throw new Error(`Missing independent XZ fixture ${name}`);
  return value;
};
/** Bitwise oracle is independent of the candidate's production table-based CRC. */
function crc(bytes: Uint8Array): number {
  let state = 0xffffffff;
  for (const byte of bytes) {
    state ^= byte;
    for (let bit = 0; bit < 8; bit++) state = state >>> 1 ^ ((state & 1) ? 0xedb88320 : 0);
  }
  return (state ^ 0xffffffff) >>> 0;
}
const word = (value: number) => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24];
const withCrc = (bytes: number[]) => [...bytes, ...word(crc(new Uint8Array(bytes)))];
/** Tiny authored framing isolates malformed containers; native fixtures supply interoperability proof separately. */
function wire(
  options: { index?: number[]; flags?: number; block?: number[]; raw?: number[]; decoded?: number; crc64?: string } =
    {},
): Uint8Array {
  const flags = [0, options.flags ?? 1];
  const header = [253, 55, 122, 88, 90, 0, ...withCrc(flags)];
  const block = withCrc(options.block ?? [2, 0, 33, 1, 8, 0, 0, 0]);
  const raw = options.raw ?? [1, 0, 0, 42, 0];
  const check = (options.flags ?? 1) === 1
    ? word(crc(new Uint8Array([42])))
    : options.flags === 4
    ? Array.from({ length: 8 }, (_, index) =>
      Number.parseInt((options.crc64 ?? "0000000000000000").slice(14 - index * 2, 16 - index * 2), 16))
    : [];
  const unpadded = block.length + raw.length + check.length;
  const padding = Array.from({ length: (4 - unpadded % 4) % 4 }, () => 0);
  const index = withCrc(options.index ?? [0, 1, unpadded, options.decoded ?? 1]);
  const footer = [
    ...withCrc([...word(index.length / 4 - 1), ...flags]).slice(-4),
    ...word(index.length / 4 - 1),
    ...flags,
    89,
    90,
  ];
  return new Uint8Array([...header, ...block, ...raw, ...padding, ...check, ...index, ...footer]);
}

describe("bounded indexed XZ", () => {
  for (const value of fixtures.cases) {
    it(`checks independent native ${value.name}`, async () => {
      const bytes = decodeBase64(value.archive);
      if (!value.supported) {
        await expect(openXz(source(bytes))).rejects.toMatchObject({ code: "unsupported-profile" });
        return;
      }
      const archive = await openXz(source(bytes));
      const result = await archive.read();
      expect(result.bytes).toEqual(decodeBase64(value.body));
      expect(archive.size).toBe(result.bytes.length);
      expect(result.checks.every((check) => check.decoding === "complete")).toBe(true);
      expect(
        result.checks.every((check) =>
          check.integrity ===
            (archive.check === "crc32"
              ? "crc32-verified"
              : archive.check === "crc64"
              ? "crc64-verified"
              : "not-provided")
        ),
      ).toBe(true);
      expect(result.work.outputBytes).toBe(result.bytes.length);
    });
  }
  it("seeks across independent blocks without decompressing unrelated blocks", async () => {
    const value = fixture("crc32-blocks");
    const bytes = decodeBase64(value.archive);
    const calls: { offset: number; length: number }[] = [];
    const archive = await openXz({
      size: bytes.length,
      stability: "immutable",
      async read(offset, length) {
        calls.push({ offset, length });
        return bytes.subarray(offset, offset + length);
      },
    });
    expect(archive.blocks.length).toBeGreaterThan(2);
    calls.length = 0;
    const first = archive.blocks[0]!;
    const result = await archive.read({ offset: first.decodedBytes - 1, length: 2 });
    expect(result.bytes).toEqual(decodeBase64(value.body).subarray(first.decodedBytes - 1, first.decodedBytes + 1));
    expect(result.checks.map((check) => check.blockId)).toEqual([0, 1]);
    expect(result.work.outputBytes).toBe(2);
    for (const block of archive.blocks.slice(2)) {
      expect(
        calls.some((call) =>
          call.offset < block.compressedOffset + block.compressedBytes &&
          call.offset + call.length > block.compressedOffset
        ),
      ).toBe(false);
    }
  });
  it("reports a bounded prefix separately from full selected-block verification", async () => {
    const value = fixture("crc32-wrap");
    const archive = await openXz(source(decodeBase64(value.archive)));
    const prefix = await archive.read({ length: 13, verify: false });
    expect(prefix.bytes).toEqual(decodeBase64(value.body).subarray(0, 13));
    expect(prefix.checks[0]).toMatchObject({ decoding: "prefix", integrity: "pending" });
    const complete = await archive.read({ length: 13 });
    expect(complete.checks[0]).toMatchObject({ decoding: "complete", integrity: "crc32-verified" });
    expect(complete.work.decodedBytes).toBeGreaterThanOrEqual(archive.blocks[0]!.decodedBytes);
  });
  it("applies chunk, decision and step limits cumulatively across selected blocks", async () => {
    const archive = await openXz(source(decodeBase64(fixture("crc32-blocks").archive)));
    const first = archive.blocks[0]!;
    const second = archive.blocks[1]!;
    const a = await archive.read({ length: first.decodedBytes });
    const b = await archive.read({ offset: second.decodedOffset, length: second.decodedBytes });
    for (
      const [key, maximum] of [["maxSteps", Math.max(a.steps, b.steps)], ["maxChunks", Math.max(a.chunks, b.chunks)], [
        "maxDecisions",
        Math.max(a.decisions, b.decisions),
      ]] as const
    ) {
      expect(maximum).toBeGreaterThan(0);
      await expect(archive.read({ length: first.decodedBytes + second.decodedBytes, lzma: { [key]: maximum } })).rejects
        .toMatchObject({ code: "budget-exceeded" });
    }
  });
});

describe("XZ framing controls", () => {
  it("accepts a hand-authored single block with independently calculated CRC scopes", async () => {
    const archive = await openXz(source(wire()));
    expect(archive.blocks[0]).toMatchObject({ compressedBytes: 5, decodedBytes: 1, paddingBytes: 3 });
    expect((await archive.read()).bytes).toEqual(new Uint8Array([42]));
  });
  it("rejects every truncated prefix, concatenation and invalid trailing padding", async () => {
    const bytes = decodeBase64(fixture("crc32-literal").archive);
    for (let length = 0; length < bytes.length; length++) {
      await expect(openXz(source(bytes.subarray(0, length)))).rejects.toBeDefined();
    }
    for (const extra of [new Uint8Array([0]), new Uint8Array([0, 0, 0, 1]), bytes]) {
      const combined = new Uint8Array(bytes.length + extra.length);
      combined.set(bytes);
      combined.set(extra, bytes.length);
      await expect(openXz(source(combined))).rejects.toBeDefined();
    }
  });
  it("refuses noncanonical/truncated/oversized VLIs, extra Index padding and impossible block geometry", async () => {
    for (
      const index of [
        [0, 0x81, 0, 21, 1, 0, 0, 0], // Zero-extended record count.
        [0, 1, 0x95, 0, 1, 0, 0, 0], // Zero-extended unpadded size.
        [0, 1, 0, 1], // No physical block can have unpadded size zero.
        [0, 0, 0, 0], // Orphan physical block.
        [0, 1, 125, 1], // Block crosses its Index.
        [0, 1, 21, 1, 0, 0, 0, 0], // Excess Index padding.
        [0, 1, 128, 128], // Truncated VLI.
        [0, 1, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0],
      ]
    ) await expect(openXz(source(wire({ index })))).rejects.toBeDefined();
  });
  it("checks block flags, filter properties, optional sizes and reserved header padding after its CRC", async () => {
    for (
      const block of [
        [2, 4, 33, 1, 8, 0, 0, 0],
        [2, 0, 33, 1, 41, 0, 0, 0],
        [2, 0, 33, 2, 8, 0, 0, 0],
        [2, 0, 33, 1, 8, 1, 0, 0],
        [2, 64, 4, 33, 1, 8, 0, 0],
        [2, 128, 2, 33, 1, 8, 0, 0],
      ]
    ) await expect(openXz(source(wire({ block })))).rejects.toBeDefined();
  });
  it("keeps payload CRC corruption separate from verified metadata", async () => {
    const bytes = wire();
    const archive = await openXz(source(bytes));
    const corrupt = bytes.slice();
    corrupt[archive.blocks[0]!.checkOffset] = corrupt[archive.blocks[0]!.checkOffset]! ^ 1;
    const checked = await openXz(source(corrupt));
    expect(checked.metadata.index).toBe("crc32-verified");
    await expect(checked.read()).rejects.toMatchObject({ code: "checksum-mismatch" });
    expect((await checked.read({ verify: false })).checks[0]!.integrity).toBe("pending");
    const padded = bytes.slice();
    const block = archive.blocks[0]!;
    padded[block.compressedOffset + block.compressedBytes] = 1;
    await expect(openXz(source(padded))).rejects.toMatchObject({ code: "invalid-archive" });
  });
  it("refuses declared decoded-size mismatch during actual block decode", async () => {
    const archive = await openXz(source(wire({ decoded: 2 })));
    await expect(archive.read()).rejects.toMatchObject({ code: "invalid-archive" });
    const zero = await openXz(source(wire({ decoded: 0 })));
    await expect(zero.read()).rejects.toMatchObject({ code: "invalid-archive" });
  });
  it("retains opening budgets/signals and pre-admits selected output", async () => {
    const ledger = createArchiveLedger({ maxOutputBytes: 0 });
    const archive = await openXz(source(wire()), { ledger });
    await expect(archive.read()).rejects.toMatchObject({ code: "budget-exceeded" });
    const abort = new AbortController();
    const active = await openXz(source(wire()), { signal: abort.signal });
    const reason = new Error("Opening lifetime ended");
    abort.abort(reason);
    await expect(active.read()).rejects.toBe(reason);
    for (const limit of [{ maxIndexBytes: 0 }, { maxBlocks: 0 }, { maxDecodedBytes: 0 }, { maxSourceBytes: 0 }]) {
      await expect(openXz(source(wire()), limit)).rejects.toMatchObject({ code: "budget-exceeded" });
    }
  });
});

describe("XZ read lifetime and capability capture", () => {
  it("joins an aborted packed read before retaining an independent provider failure", async () => {
    const bytes = wire();
    let payload = false;
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const primary = new Error("Packed provider failed independently");
    const archive = await openXz({
      size: bytes.length,
      stability: "immutable",
      async read(offset, length) {
        if (payload) {
          entered();
          await wait;
          throw primary;
        }
        return bytes.subarray(offset, offset + length);
      },
    });
    payload = true;
    const abort = new AbortController();
    const operation = archive.read({ signal: abort.signal });
    await ready;
    abort.abort(new Error("Caller stopped while provider pending"));
    release();
    await expect(operation).rejects.toBe(primary);
  });
  it("retains inherited codec policy snapshots and counts a repeated ledger only once", async () => {
    const bytes = wire();
    const lzma = { maxChunks: 0 };
    const ledger = createArchiveLedger({ maxOutputBytes: 2 });
    const pending = openXz(source(bytes), { lzma, ledger });
    lzma.maxChunks = 100;
    const archive = await pending;
    await expect(archive.read()).rejects.toMatchObject({ code: "budget-exceeded" });
    // Failed reads retain their prior selected-output admission; no refund hides attempted work.
    expect(ledger.inspect().outputBytes).toBe(1);
    const result = await archive.read({ lzma: { maxChunks: 1 }, ledger });
    expect(result.bytes).toEqual(new Uint8Array([42]));
    expect(ledger.inspect().outputBytes).toBe(2);
  });
  it("admits a distinct operation ledger before packed reads and output allocation", async () => {
    const bytes = wire();
    let reads = 0;
    const archive = await openXz({
      size: bytes.length,
      stability: "immutable",
      async read(offset, length) {
        reads++;
        return bytes.subarray(offset, offset + length);
      },
    });
    reads = 0;
    const ledger = createArchiveLedger({ maxOutputBytes: 0 });
    await expect(archive.read({ ledger })).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(reads).toBe(0);
  });
  it("enforces exact source evidence and bounded trailing-padding policies", async () => {
    const bytes = wire();
    for (const bad of ["made-up", 1, null]) {
      await expect(openXz({ ...source(bytes), stability: bad } as unknown as Parameters<typeof openXz>[0])).rejects
        .toBeInstanceOf(TypeError);
    }
    const unverified = {
      size: bytes.length,
      read: async (offset: number, length: number) => bytes.subarray(offset, offset + length),
    };
    await expect(openXz(unverified)).rejects.toMatchObject({ code: "unsupported-profile" });
    expect((await openXz(unverified, { allowUnverifiedSource: true })).source.stability).toBe("unverified");
    const padded = decodeBase64(fixture("crc32-padded").archive);
    await expect(openXz(source(padded), { maxPaddingBytes: 19 })).rejects.toMatchObject({ code: "budget-exceeded" });
    expect((await openXz(source(padded), { maxPaddingBytes: 20 })).paddingBytes).toBe(20);
    expect((await openXz(source(padded), { maxPaddingBytes: 21 })).paddingBytes).toBe(20);
  });
});

describe("XZ terminal abort admission", () => {
  it("refuses a none-check payload when the opening lifetime aborts during terminal settlement", async () => {
    const abort = new AbortController();
    const reason = new Error("Opening lifetime ended at decoded-block settlement");
    let armed = false;
    let decoded = 0;
    const ledger = {
      reserve(kind: string, count: number) {
        if (!armed || kind !== "decodedBytes") return;
        decoded += count;
        if (decoded === 5) {
          // One raw byte plus LZMA2's four framing bytes have now been accounted.
          // Defer through terminal promise reactions, rather than aborting inside
          // the earlier codec decision loop. No timer or runtime scheduler is used.
          let turns = 6;
          const later = (): void => {
            if (--turns === 0) abort.abort(reason);
            else queueMicrotask(later);
          };
          queueMicrotask(later);
        }
      },
      inspect: () => ({ sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 }),
    };
    const archive = await openXz(source(wire({ flags: 0 })), { ledger, signal: abort.signal });
    armed = true;
    await expect(archive.read()).rejects.toBe(reason);
  });
  it("observes an opening abort even for an empty selected range", async () => {
    const abort = new AbortController();
    const archive = await openXz(source(wire({ flags: 0 })), { signal: abort.signal });
    const reason = new Error("Opening lifetime ended before empty selection");
    abort.abort(reason);
    await expect(archive.read({ length: 0 })).rejects.toBe(reason);
  });
});

describe("XZ streaming CRC64 evidence", () => {
  it("matches the independent CRC64/XZ check vector and preserves every stored bit", async () => {
    const body = new TextEncoder().encode("123456789");
    const bytes = wire({
      flags: 4,
      raw: [1, 0, body.length - 1, ...body, 0],
      decoded: body.length,
      crc64: "995dc9bbdf1939fa",
    });
    const archive = await openXz(source(bytes));
    const result = await archive.read();
    expect(result.bytes).toEqual(body);
    expect(result.checks[0]).toMatchObject({ integrity: "crc64-verified", crc64: "995dc9bbdf1939fa" });
    expect(result.checks[0]!.crc).toBeUndefined();
    const empty = await openXz(source(wire({ flags: 4, raw: [0], decoded: 0, crc64: "0000000000000000" })));
    expect((await empty.read()).checks[0]).toMatchObject({ integrity: "crc64-verified", crc64: "0000000000000000" });
    for (const wrong of ["fa3919dfbbc95d99", "6c40df5f0b497347", "0000000000000000"]) {
      const bad = await openXz(
        source(wire({ flags: 4, raw: [1, 0, body.length - 1, ...body, 0], decoded: body.length, crc64: wrong })),
      );
      await expect(bad.read()).rejects.toMatchObject({ code: "checksum-mismatch" });
    }
  });
  it("matches genuine native block CRC64 oracles across output quanta and resets", async () => {
    for (const name of ["crc64-wrap", "crc64-default-threaded"]) {
      const value = fixture(name);
      const archive = await openXz(source(decodeBase64(value.archive)));
      const result = await archive.read();
      expect(result.bytes).toEqual(decodeBase64(value.body));
      expect(result.checks.map((check) => check.crc64)).toEqual(value.crc64Checks!.map((check) => check.hex));
      expect(result.checks.every((check) => check.integrity === "crc64-verified")).toBe(true);
      expect(value.nativeChecksumCorruptionFailures!.every((failure) => failure.exitCode !== 0)).toBe(true);
    }
  });
  it("is independent of source request boundaries for a genuine native check vector", async () => {
    const value = fixture("crc64-vector");
    const bytes = decodeBase64(value.archive);
    const archive = await openXz(source(bytes));
    for (let inputChunkBytes = 1; inputChunkBytes <= archive.blocks[0]!.compressedBytes; inputChunkBytes++) {
      const result = await archive.read({ lzma: { inputChunkBytes } });
      expect(result.checks[0]!.crc64).toBe("995dc9bbdf1939fa");
      expect(result.bytes).toEqual(new TextEncoder().encode("123456789"));
    }
  });
  it("checks every stored CRC64 byte while keeping prefix evidence pending", async () => {
    const value = fixture("crc64-wrap");
    const bytes = decodeBase64(value.archive);
    const archive = await openXz(source(bytes));
    const prefix = await archive.read({ length: 1, verify: false });
    expect(prefix.checks[0]).toMatchObject({ decoding: "prefix", integrity: "pending" });
    for (let index = 0; index < 8; index++) {
      const bad = bytes.slice();
      const offset = archive.blocks[0]!.checkOffset + index;
      bad[offset] = bad[offset]! ^ 1;
      const corrupt = await openXz(source(bad));
      await expect(corrupt.read({ length: 1 })).rejects.toMatchObject({ code: "checksum-mismatch" });
    }
  });
});
