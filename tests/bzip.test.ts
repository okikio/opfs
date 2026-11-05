import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createArchiveLedger, createBzipDecoder } from "../src/archive/bzip.ts";
import type { BzipOptionsType } from "../src/archive/bzip.ts";
import fixture from "./fixtures/bzip/independent.json" with { type: "json" };

function source(bytes: Uint8Array) {
  return createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
}
async function decode(bytes: Uint8Array, options: BzipOptionsType = {}) {
  const decoder = createBzipDecoder(source(bytes), options);
  const reader = decoder.stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = await decoder.finished;
  const body = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.length;
  }
  return { body, result };
}

describe("bounded pure BZip2", () => {
  for (const vector of fixture.fixtures) {
    it(`decodes independent ${vector.name} full bytes`, async () => {
      const { body, result } = await decode(decodeBase64(vector.packed));
      const expected = decodeBase64(vector.body);
      expect(body.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        if (body[i] !== expected[i]) throw new Error(`Independent original-byte mismatch at ${i}.`);
      }
      expect(result.status).toBe("complete");
      expect(result.integrity).toBe("checksum-verified");
      expect(result.verifiedBlocks).toBe(result.blocks);
      expect(result.blockBytes).toBe(vector.level * 100000);
      expect(result.memoryBytes).toBeLessThan(8 * 1024 * 1024);
    });
  }
});

describe("BZip2 evidence and admission", () => {
  it("captures source descriptors and policy once and refuses invented snapshot evidence", async () => {
    const packed = decodeBase64(fixture.fixtures[1]!.packed);
    const counters = { size: 0, identity: 0, stability: 0, read: 0 };
    const options = { maxOutputBytes: 0 };
    const input = {
      get size() {
        counters.size++;
        return packed.length;
      },
      get identity() {
        counters.identity++;
        return "captured";
      },
      get stability(): "immutable" {
        counters.stability++;
        return "immutable";
      },
      get read() {
        counters.read++;
        return async (offset: number, length: number): Promise<Uint8Array> => {
          options.maxOutputBytes = 100000;
          return packed.slice(offset, offset + length);
        };
      },
    };
    const decoder = createBzipDecoder(input, options);
    const reader = decoder.stream.getReader();
    await expect(reader.read()).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(decoder.finished).rejects.toMatchObject({ code: "budget-exceeded" });
    reader.releaseLock();
    expect(counters).toEqual({ size: 1, identity: 1, stability: 1, read: 1 });
    for (const overrides of [{ stability: "truthy" }, { identity: 42 }, { identity: "x".repeat(8193) }]) {
      expect(() =>
        createBzipDecoder({ ...source(packed), ...overrides } as unknown as ByteSourceType, {
          allowUnverifiedSource: true,
        })
      ).toThrow();
    }
    expect(() =>
      createBzipDecoder({
        size: packed.length,
        async read(offset, length) {
          return packed.slice(offset, offset + length);
        },
      })
    ).toThrow();
  });

  it("rejects malformed selector authority, code lengths, oversubscribed trees and overflowing RUNA", async () => {
    // Authored packed fields follow the pinned libbzip2 framing, independent of candidate tables.
    const packed = (fields: readonly (readonly [number, number])[]): Uint8Array => {
      const bits: number[] = [];
      for (const [value, count] of fields) {
        for (let i = count - 1; i >= 0; i--) bits.push(Math.floor(value / 2 ** i) & 1);
      }
      const out = new Uint8Array(Math.ceil(bits.length / 8) + 16);
      for (let i = 0; i < bits.length; i++) out[i >>> 3]! |= bits[i]! << (7 - (i & 7));
      return out;
    };
    const base = [[0x425a6831, 32], [0x314159, 24], [0x265359, 24], [0, 32], [0, 1], [0, 24], [0x8000, 16], [
      0x8000,
      16,
    ]] as const;
    for (
      const suffix of [
        [[1, 3], [1, 15]], // fewer than two tables
        [[2, 3], [0, 15]], // no selector
        [[2, 3], [1, 15], [3, 2]], // unary MTF index2 with only2 tables
        [[2, 3], [1, 15], [0, 1], [21, 5]], // code length21
        [[2, 3], [1, 15], [0, 1], [1, 5], [0, 3]], // three length1 symbols oversubscribe
      ] as const
    ) await expect(decode(packed([...base, ...suffix]))).rejects.toMatchObject({ code: "invalid-archive" });
    const coding = [[1, 5], [0, 1], [1, 1], [0, 1], [0, 1], [0, 1]] as const; // lengths1,2,2
    await expect(decode(packed([...base, [2, 3], [1, 15], [0, 1], ...coding, ...coding, [0, 17], [3, 2]]))).rejects
      .toMatchObject({ code: "invalid-archive" });
  });

  it("cancels lazily without source I/O and settles idle external abort", async () => {
    let calls = 0;
    const input = {
      size: 14,
      stability: "immutable" as const,
      async read() {
        calls++;
        return new Uint8Array();
      },
    };
    const idle = createBzipDecoder(input);
    await idle.stream.cancel();
    expect((await idle.finished).status).toBe("cancelled");
    expect(calls).toBe(0);
    const abort = new AbortController();
    const reason = new Error("external stop");
    const decoder = createBzipDecoder(input, { signal: abort.signal });
    abort.abort(reason);
    const reader = decoder.stream.getReader();
    await expect(reader.read()).rejects.toBe(reason);
    await expect(decoder.finished).rejects.toBe(reason);
    reader.releaseLock();
    expect(calls).toBe(0);
  });

  it("joins reentrant source cancellation and preserves a later provider failure", async () => {
    const packed = decodeBase64(fixture.fixtures[1]!.packed);
    for (const lateFailure of [undefined, new Error("late provider failure")]) {
      let joined = false;
      const decoder = createBzipDecoder({
        size: packed.length,
        stability: "immutable",
        async read(offset, length) {
          await reader.cancel();
          expect(joined).toBe(false);
          if (lateFailure) throw lateFailure;
          return packed.slice(offset, offset + length);
        },
      });
      void decoder.finished.then(() => {
        joined = true;
      }, () => {
        joined = true;
      });
      const reader = decoder.stream.getReader();
      expect((await reader.read()).done).toBe(true);
      if (lateFailure) await expect(decoder.finished).rejects.toBe(lateFailure);
      else expect((await decoder.finished).status).toBe("cancelled");
      reader.releaseLock();
    }
  });

  it("allows a scheduler to await cancellation without a join cycle or plaintext emission", async () => {
    const packed = decodeBase64(fixture.fixtures[1]!.packed);
    let called = 0;
    const decoder = createBzipDecoder(source(packed), {
      async yield() {
        called++;
        await reader.cancel();
      },
    });
    const reader = decoder.stream.getReader();
    expect((await reader.read()).done).toBe(true);
    const result = await decoder.finished;
    reader.releaseLock();
    expect(called).toBe(1);
    expect(result.status).toBe("cancelled");
    expect(result.work.outputBytes).toBe(0);
  });

  it("waits for a borrowed source after external abort before settling both terminal observations", async () => {
    let enter!: () => void;
    const entered = new Promise<void>((yes) => {
      enter = yes;
    });
    let release!: () => void;
    const gate = new Promise<void>((yes) => {
      release = yes;
    });
    const packed = decodeBase64(fixture.fixtures[1]!.packed);
    const abort = new AbortController();
    const reason = new Error("abort while reading");
    let joined = false;
    const decoder = createBzipDecoder({
      size: packed.length,
      stability: "immutable",
      async read(offset, length) {
        enter();
        await gate;
        return packed.slice(offset, offset + length);
      },
    }, { signal: abort.signal });
    void decoder.finished.then(() => {
      joined = true;
    }, () => {
      joined = true;
    });
    const reader = decoder.stream.getReader();
    const pending = reader.read();
    await entered;
    abort.abort(reason);
    await Promise.resolve();
    expect(joined).toBe(false);
    release();
    await expect(pending).rejects.toBe(reason);
    await expect(decoder.finished).rejects.toBe(reason);
    reader.releaseLock();
  });
  it("releases only block-verified prefixes and leaves whole-stream evidence pending on cancel", async () => {
    const vector = fixture.fixtures.find((value) => value.name === "long-run")!;
    const decoder = createBzipDecoder(source(decodeBase64(vector.packed)), { outputChunkBytes: 17 });
    const reader = decoder.stream.getReader();
    const first = await reader.read();
    expect(first.value).toEqual(new Uint8Array(17).fill(65));
    await reader.cancel();
    const result = await decoder.finished;
    reader.releaseLock();
    expect(result.status).toBe("cancelled");
    expect(result.integrity).toBe("checksum-pending");
    expect(result.verifiedBlocks).toBe(1);
    expect(result.work.outputBytes).toBe(17);
    expect(result.work.decodedBytes).toBeGreaterThan(2000000);
  });

  it("rejects block corruption before releasing plaintext and retains identical terminal failure", async () => {
    const vector = fixture.fixtures.find((value) => value.name === "binary")!;
    const packed = decodeBase64(vector.packed);
    packed[10] = packed[10]! ^ 1;
    const decoder = createBzipDecoder(source(packed));
    const reader = decoder.stream.getReader();
    let failure: unknown;
    try {
      await reader.read();
    } catch (reason) {
      failure = reason;
    }
    expect(failure).toMatchObject({ code: "checksum-mismatch" });
    await expect(decoder.finished).rejects.toBe(failure);
    reader.releaseLock();
  });

  it("distinguishes combined CRC, final padding, trailing extent and randomized-profile failures", async () => {
    const vector = fixture.fixtures.find((value) => value.name === "binary")!;
    const packed = decodeBase64(vector.packed);
    const bits = Array.from(packed, (byte) => byte.toString(2).padStart(8, "0")).join("");
    const footer = bits.lastIndexOf((0x177245385090).toString(2).padStart(48, "0"));
    const corrupted = packed.slice();
    const at = footer + 48;
    corrupted[at >>> 3] = corrupted[at >>> 3]! ^ (1 << (7 - (at & 7)));
    await expect(decode(corrupted)).rejects.toMatchObject({ code: "checksum-mismatch" });
    const trailing = new Uint8Array(packed.length + 1);
    trailing.set(packed);
    await expect(decode(trailing)).rejects.toMatchObject({ code: "unsupported-profile" });
    const concatenated = new Uint8Array(packed.length * 2);
    concatenated.set(packed);
    concatenated.set(packed, packed.length);
    await expect(decode(concatenated)).rejects.toMatchObject({ code: "unsupported-profile" });
    const random = packed.slice();
    random[14] = random[14]! | 128;
    await expect(decode(random)).rejects.toMatchObject({ code: "unsupported-profile" });
    for (const diagnostic of fixture.diagnostics) {
      expect(diagnostic.nativeExit).toBe(0);
      expect(diagnostic.sevenExit).not.toBe(0);
      await expect(decode(decodeBase64(diagnostic.packed))).rejects.toMatchObject({ code: "unsupported-profile" });
    }
  });

  it("rejects every small-fixture truncation and invalid block origins", async () => {
    const small = decodeBase64(fixture.fixtures.find((value) => value.name === "level-1")!.packed);
    for (let cut = 0; cut < small.length; cut++) {
      await expect(decode(small.subarray(0, cut))).rejects.toBeInstanceOf(Error);
    }
    const invalid = small.slice();
    invalid[14] = invalid[14]! | 127;
    invalid[15] = 255;
    invalid[16] = 255;
    invalid[17] = invalid[17]! | 128;
    await expect(decode(invalid)).rejects.toMatchObject({ code: "invalid-archive" });
  });

  it("enforces separate input, transformed memory, decoded, returned, block and CPU policies", async () => {
    const packed = decodeBase64(fixture.fixtures.find((value) => value.name === "binary")!.packed);
    for (
      const options of [
        { maxSourceBytes: 1 },
        { maxRequests: 0 },
        { maxDecodedBytes: 1 },
        { maxOutputBytes: 0 },
        { maxBlockBytes: 100000 },
        { maxMemoryBytes: 300000 },
        { maxBlocks: 0 },
        { maxSteps: 10 },
      ]
    ) {
      await expect(decode(packed, options)).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    const ledger = createArchiveLedger({ maxOutputBytes: 0 });
    await expect(decode(packed, { ledger })).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(() => createBzipDecoder(source(packed), { maxMemoryBytes: 0 })).toThrow();
    for (
      const options of [
        { inputChunkBytes: 65537 },
        { outputChunkBytes: 0 },
        { maxBlockBytes: 900001 },
        { maxMemoryBytes: 16777217 },
        { maxBlocks: 65537 },
        { maxSteps: 1073741825 },
      ]
    ) expect(() => createBzipDecoder(source(packed), options)).toThrow();
  });

  it("decodes across every one-byte packed refill without retaining caller buffers", async () => {
    const vector = fixture.fixtures.find((value) => value.name === "level-1")!;
    const packed = decodeBase64(vector.packed);
    const reused = new Uint8Array(1);
    const decoder = createBzipDecoder({
      size: packed.length,
      stability: "immutable",
      async read(offset, length) {
        expect(length).toBe(1);
        reused[0] = packed[offset]!;
        return reused;
      },
    }, { inputChunkBytes: 1, outputChunkBytes: 1 });
    const body = new Uint8Array(await new Response(decoder.stream).arrayBuffer());
    expect(body).toEqual(decodeBase64(vector.body));
    expect((await decoder.finished).integrity).toBe("checksum-verified");
  });
});
