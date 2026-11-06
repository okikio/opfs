import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { expectBytes } from "./bytes.ts";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { createArchiveLedger, createLzmaDecoder } from "../src/archive/lzma.ts";
import type { LzmaOptionsType } from "../src/archive/lzma.ts";
import fixtures from "./fixtures/lzma/independent.json" with { type: "json" };

const source = (bytes: Uint8Array) => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
function options(fixture: typeof fixtures.cases[number]): LzmaOptionsType {
  if (fixture.profile === "alone") return { format: "alone" };
  if (fixture.profile === "raw-lzma2") {
    return {
      format: "raw-lzma2",
      dictionary: fixture.dictionary!,
      ...(fixture.size === undefined ? {} : { size: fixture.size }),
    };
  }
  return {
    format: "raw-lzma1",
    properties: new Uint8Array(fixture.properties!),
    ...(fixture.size === undefined ? {} : { size: fixture.size }),
    marker: fixture.marker === "required" ? "required" : "optional",
  };
}
/** All native producer bytes are compared; this collector is deliberately test-only. */
async function consume(decoder: ReturnType<typeof createLzmaDecoder>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of decoder.stream) {
    chunks.push(chunk);
    length += chunk.length;
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  await decoder.finished;
  return bytes;
}

describe("bounded pure LZMA codecs", () => {
  for (const fixture of fixtures.cases) {
    it(`decodes independent ${fixture.name} with complete payload evidence`, { timeout: 30000 }, async () => {
      const bytes = decodeBase64(fixture.packed);
      const decoder = createLzmaDecoder(source(bytes), options(fixture));
      expectBytes(await consume(decoder), decodeBase64(fixture.body), fixture.name);
      expect(await decoder.finished).toMatchObject({ status: "complete", integrity: "none" });
    });
  }
});

const fixtureNamed = (name: string) => {
  const fixture = fixtures.cases.find((entry) => entry.name === name);
  if (!fixture) throw new Error(`Missing independent LZMA fixture ${name}`);
  return fixture;
};
const small = fixtures.cases.find((entry) => entry.profile === "alone" && decodeBase64(entry.body).length === 33)!;
const rawSmall = fixtures.cases.find((entry) =>
  entry.profile === "raw-lzma2" && decodeBase64(entry.body).length === 33
)!;

async function refuses(bytes: Uint8Array, policy: LzmaOptionsType): Promise<void> {
  const decoder = createLzmaDecoder(source(bytes), policy);
  await expect(consume(decoder)).rejects.toBeDefined();
  await expect(decoder.finished).rejects.toBeDefined();
}

describe("LZMA framing and ownership controls", () => {
  it("decodes the same full payload across every source request quantum of a short independent stream", async () => {
    const bytes = decodeBase64(small.packed);
    for (let quantum = 1; quantum <= bytes.length; quantum++) {
      const decoder = createLzmaDecoder(source(bytes), { ...options(small), inputChunkBytes: quantum });
      expect(await consume(decoder)).toEqual(decodeBase64(small.body));
    }
  });
  it("refuses every truncated prefix and a trailing packed byte", async () => {
    for (const fixture of [small, rawSmall]) {
      const bytes = decodeBase64(fixture.packed);
      for (let size = 0; size < bytes.length; size++) await refuses(bytes.subarray(0, size), options(fixture));
      const trailing = new Uint8Array(bytes.length + 1);
      trailing.set(bytes);
      await refuses(trailing, options(fixture));
    }
  });
  it("refuses invalid range initialization and unsafe Alone sizes", async () => {
    const bytes = decodeBase64(small.packed);
    const range = bytes.slice();
    range[13] = 1;
    await refuses(range, options(small));
    const size = bytes.slice();
    size.fill(0, 5, 13);
    size[12] = 1;
    await refuses(size, options(small));
    const property = bytes.slice();
    property[0] = 225;
    await refuses(property, options(small));
  });
  it("requires exact declared raw output sizes and terminal framing", async () => {
    const fixture = fixtureNamed("7zip-lzma1");
    const bytes = decodeBase64(fixture.packed);
    for (const size of [decodeBase64(fixture.body).length - 1, decodeBase64(fixture.body).length + 1]) {
      const opts = options(fixture);
      if (opts.format !== "raw-lzma1") throw new Error("Expected raw LZMA1 fixture");
      await refuses(bytes, { ...opts, size });
    }
    for (const control of [2, 3, 127, 128, 160, 192]) {
      await refuses(new Uint8Array([control, 0, 0, 0, 0, 0]), { format: "raw-lzma2", dictionary: 8 });
    }
  });
  it("admits independent dictionary, allocation, CPU, chunk and logical-byte budgets", async () => {
    const bytes = decodeBase64(small.packed);
    for (
      const limit of [
        { maxDictionaryBytes: 4096 },
        { maxMemoryBytes: 90000 },
        { maxDecisions: 0 },
        { maxSteps: 0 },
        { maxSourceBytes: 0 },
        { maxRequests: 0 },
        { maxDecodedBytes: 0 },
        { maxOutputBytes: 0 },
      ]
    ) await refuses(bytes, { ...options(small), ...limit });
    await refuses(decodeBase64(rawSmall.packed), { ...options(rawSmall), maxChunks: 0 });
  });
  it("captures options and raw property bytes before the first asynchronous source read", async () => {
    const fixture = fixtureNamed("properties-3-0-2");
    const opts = options(fixture);
    if (opts.format !== "raw-lzma1") throw new Error("Expected properties");
    const supplied = { ...opts, maxDecodedBytes: 10000 };
    const decoder = createLzmaDecoder(source(decodeBase64(fixture.packed)), supplied);
    supplied.maxDecodedBytes = 0;
    supplied.properties.fill(255);
    expectBytes(await consume(decoder), decodeBase64(fixture.body), fixture.name);
  });
  it("does not read until demand and reports an early preview as pending without closing the borrowed source", async () => {
    const fixture = fixtureNamed("7zip-lzma2");
    const bytes = decodeBase64(fixture.packed);
    let requests = 0;
    const decoder = createLzmaDecoder({
      size: bytes.length,
      stability: "immutable",
      read(offset, length) {
        requests++;
        return Promise.resolve(bytes.subarray(offset, offset + length));
      },
    }, options(fixture));
    await Promise.resolve();
    expect(requests).toBe(0);
    const reader = decoder.stream.getReader();
    const first = await reader.read();
    expect(first.value).toEqual(decodeBase64(fixture.body).subarray(0, first.value!.length));
    await reader.cancel();
    expect(await decoder.finished).toMatchObject({ status: "cancelled", termination: "pending", integrity: "none" });
    reader.releaseLock();
  });
  it("waits for an in-flight borrowed source operation before reporting cancellation", async () => {
    const bytes = decodeBase64(small.packed);
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const decoder = createLzmaDecoder({
      size: bytes.length,
      stability: "immutable",
      async read(offset, length) {
        started();
        await waiting;
        return bytes.subarray(offset, offset + length);
      },
    }, options(small));
    const reader = decoder.stream.getReader();
    const pending = reader.read();
    await entered;
    let settled = false;
    const cancel = reader.cancel().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await cancel;
    await pending;
    expect(await decoder.finished).toMatchObject({ status: "cancelled" });
    reader.releaseLock();
  });
  it("preserves source failures that arrive while cancellation waits", async () => {
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const primary = new Error("Borrowed provider failed independently");
    const decoder = createLzmaDecoder({
      size: 100,
      stability: "immutable",
      async read() {
        started();
        await waiting;
        throw primary;
      },
    }, { format: "alone" });
    const reader = decoder.stream.getReader();
    const pending = reader.read();
    await entered;
    const cancel = reader.cancel();
    release();
    await expect(cancel).rejects.toBe(primary);
    await pending;
    await expect(decoder.finished).rejects.toBe(primary);
    reader.releaseLock();
  });
  it("retains the original abort and scheduling failures", async () => {
    const abort = new AbortController();
    const reason = new Error("Caller stopped preview");
    abort.abort(reason);
    const decoder = createLzmaDecoder(source(decodeBase64(small.packed)), { ...options(small), signal: abort.signal });
    await expect(consume(decoder)).rejects.toBe(reason);
    await expect(decoder.finished).rejects.toBe(reason);
    const fixture = fixtureNamed("7zip-lzma2");
    const failure = new Error("Caller task scheduler failed");
    const scheduled = createLzmaDecoder(source(decodeBase64(fixture.packed)), {
      ...options(fixture),
      yield: () => Promise.reject(failure),
    });
    await expect(consume(scheduled)).rejects.toBe(failure);
    await expect(scheduled.finished).rejects.toBe(failure);
  });
});

describe("LZMA aggregate and chunk boundaries", () => {
  it("counts only data chunks, so the exact chunk allowance accepts the end control", async () => {
    for (const fixture of [fixtureNamed("lzma2-empty"), rawSmall]) {
      const maxChunks = fixture.name === "lzma2-empty" ? 0 : 1;
      const decoder = createLzmaDecoder(source(decodeBase64(fixture.packed)), { ...options(fixture), maxChunks });
      expectBytes(await consume(decoder), decodeBase64(fixture.body), fixture.name);
      expect((await decoder.finished).chunks).toBe(maxChunks);
    }
  });
  it("charges aggregate admission before source I/O or decoded output", async () => {
    const bytes = decodeBase64(small.packed);
    let reads = 0;
    const ledger = createArchiveLedger({ maxSourceBytes: bytes.length - 1 });
    const decoder = createLzmaDecoder({
      size: bytes.length,
      stability: "immutable",
      read(offset, length) {
        reads++;
        return Promise.resolve(bytes.subarray(offset, offset + length));
      },
    }, { ...options(small), ledger });
    await expect(consume(decoder)).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(reads).toBe(0);
    const outputLedger = createArchiveLedger({ maxOutputBytes: 0 });
    const output = createLzmaDecoder(source(bytes), { ...options(small), ledger: outputLedger });
    await expect(consume(output)).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(outputLedger.inspect().outputBytes).toBe(0);
  });
  it("requires LZMA2 state reset after a raw chunk even when properties already exist", async () => {
    const fixture = fixtureNamed("lzma2-reset-composition");
    const bytes = decodeBase64(fixture.packed);
    const reset = bytes.slice();
    reset[55] = 128;
    await refuses(reset, options(fixture));
    const packed = bytes.slice();
    packed[4] = 0;
    await refuses(packed, options(fixture));
  });
});

describe("LZMA foreign callback reentrancy", () => {
  it("joins reentrant reader cancellation with an independent source failure", async () => {
    const primary = new Error("Provider rejection after reentrant cancellation");
    let cancel!: Promise<void>;
    const decoder = createLzmaDecoder({
      size: 100,
      stability: "immutable",
      read() {
        cancel = reader.cancel();
        void cancel.catch(() => {});
        return Promise.reject(primary);
      },
    }, { format: "alone" });
    const reader: ReadableStreamDefaultReader<Uint8Array> = decoder.stream.getReader();
    await reader.read();
    await expect(cancel).rejects.toBe(primary);
    await expect(decoder.finished).rejects.toBe(primary);
    reader.releaseLock();
  });
  it("joins reentrant scheduler cancellation before retaining scheduler failure", async () => {
    const fixture = fixtureNamed("7zip-lzma2");
    const primary = new Error("Scheduler rejection after reentrant cancellation");
    let cancel!: Promise<void>;
    const decoder = createLzmaDecoder(source(decodeBase64(fixture.packed)), {
      ...options(fixture),
      yield() {
        cancel = reader.cancel();
        void cancel.catch(() => {});
        return Promise.reject(primary);
      },
    });
    const reader: ReadableStreamDefaultReader<Uint8Array> = decoder.stream.getReader();
    expect((await reader.read()).value!.length).toBeGreaterThan(0);
    await expect(decoder.finished).rejects.toBe(primary);
    await expect(cancel).rejects.toBe(primary);
    reader.releaseLock();
  });
});
