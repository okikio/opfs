import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createArchiveLedger, createLz4Decoder } from "../src/archive/lz4.ts";
import fixtures from "./fixtures/lz4/independent.json" with { type: "json" };

/** Independent producer bytes are split without using candidate token/header helpers. */
function chunks(bytes: Uint8Array, size = 65536): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at === bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, at + size);
      controller.enqueue(bytes.slice(at, end));
      at = end;
    },
  }, { highWaterMark: 0 });
}
function join(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
function word(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return join(parts);
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}
/** Frame fixed-field layout from the independent producer; only the block sequence boundaries are read. */
function layout(bytes: Uint8Array) {
  const flags = bytes[4]!;
  const header = 7 + (flags & 8 ? 8 : 0) + (flags & 1 ? 4 : 0);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = header;
  const blocks: { start: number; body: number; size: number; raw: boolean; checksum: number }[] = [];
  while (true) {
    const encoded = data.getUint32(at, true);
    if (!encoded) break;
    const size = encoded & 0x7fffffff;
    const body = at + 4;
    blocks.push({ start: at, body, size, raw: Boolean(encoded & 0x80000000), checksum: body + size });
    at = body + size + (flags & 16 ? 4 : 0);
  }
  return { header, blocks, end: at, flags };
}

describe("bounded LZ4 frame streaming", () => {
  for (const [profile, fixture] of Object.entries(fixtures.frames)) {
    it(`decodes native ${profile} bytes checked through independent liblz4`, async () => {
      expect(fixture.independentPayloadVerified).toBe(true);
      const bytes = decodeBase64(fixture.archive);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
      expect(Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(fixture.sha256);
      const decoder = createLz4Decoder(chunks(bytes, 117), { outputChunkBytes: 257 });
      expect(await collect(decoder.stream)).toEqual(decodeBase64(fixture.body));
      const result = await decoder.finished;
      expect(result.status).toBe("complete");
      if (profile === "block5") expect(result.header?.blockBytes).toBe(262144);
      if (profile === "block6") expect(result.header?.blockBytes).toBe(1048576);
      if (profile === "block7") expect(result.header?.blockBytes).toBe(4194304);
      expect(result.integrity).toBe(layout(bytes).flags & 4 ? "checksum-verified" : "not-provided");
      expect(result.work.decodedBytes).toBe(decodeBase64(fixture.body).length);
      expect(result.work.outputBytes).toBe(result.work.decodedBytes);
      expect(result.work.sourceBytes).toBe(bytes.length);
      expect(result.verifiedBlocks).toBe(layout(bytes).flags & 16 ? result.blocks : 0);
    });
  }
  it("uses actual compressed cross-block history and validates incremental content-hash tails", async () => {
    const bytes = decodeBase64(fixtures.frames.dependent.archive);
    const frame = layout(bytes);
    expect(frame.flags & 32).toBe(0);
    const second = frame.blocks[1]!;
    expect(second.raw).toBe(false);
    let at = second.body;
    const token = bytes[at++]!;
    let literals = token >>> 4;
    if (literals === 15) {
      let extra = 255;
      while (extra === 255) {
        extra = bytes[at++]!;
        literals += extra;
      }
    }
    at += literals;
    const distance = bytes[at]! | bytes[at + 1]! << 8;
    expect(distance).toBeGreaterThan(literals); // This first match needs bytes from a preceding decoded block.
    const overlap = layout(decodeBase64(fixtures.frames.overlap.archive));
    expect(overlap.blocks.some((block) => !block.raw)).toBe(true);
    const original = decodeBase64(fixtures.frames["content-only"].archive);
    const body = decodeBase64(fixtures.frames["content-only"].body);
    expect(layout(original).flags & 0x1d).toBe(4);
    for (let split = 1; split < body.length; split++) {
      const parts = [body.slice(0, split), body.slice(split)];
      const adapted = join([
        original.slice(0, 7),
        ...parts.flatMap((part) => [word(0x80000000 + part.length), part]),
        word(0),
        original.slice(-4),
      ]);
      const decoder = createLz4Decoder(chunks(adapted, 1));
      expect(await collect(decoder.stream)).toEqual(body);
      expect((await decoder.finished).integrity).toBe("checksum-verified");
    }
  });
  it("refuses independently checksummed dictionary and unsafe size controls, and validates declared content size", async () => {
    for (const [name, encoded] of Object.entries(fixtures.controls)) {
      const decoder = createLz4Decoder(chunks(decodeBase64(encoded)));
      const code = name === "dictionary-zero" ? "unsupported-profile" : "invalid-archive";
      await expect(collect(decoder.stream)).rejects.toMatchObject({ code });
      await expect(decoder.finished).rejects.toMatchObject({ code });
    }
  });
  it("accepts every input split boundary and native xxhsum32 length-boundary vectors", async () => {
    const bytes = decodeBase64(fixtures.frames["no-checksum"].archive);
    for (let split = 0; split <= bytes.length; split++) {
      const input = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, split));
          controller.enqueue(bytes.slice(split));
          controller.close();
        },
      });
      const decoder = createLz4Decoder(input);
      expect(await collect(decoder.stream)).toEqual(decodeBase64(fixtures.frames["no-checksum"].body));
      expect((await decoder.finished).status).toBe("complete");
    }
    const original = decodeBase64(fixtures.frames.raw.archive);
    expect(layout(original).flags & 0x1d).toBe(0x14);
    for (const vector of fixtures.hashes) {
      const body = decodeBase64(vector.body);
      const checksum = word(parseInt(vector.xxh32, 16));
      const frame = join([original.slice(0, 7), word(0x80000000 + body.length), body, checksum, word(0), checksum]);
      const decoder = createLz4Decoder(chunks(frame, 1), { maxRequests: 10000 });
      expect(await collect(decoder.stream)).toEqual(body);
      expect((await decoder.finished).integrity).toBe("checksum-verified");
    }
  });
  it("rejects header and block corruption before releasing that block, and keeps footer failure distinct", async () => {
    const original = decodeBase64(fixtures.frames.raw.archive);
    for (const location of [6, layout(original).blocks[0]!.body, layout(original).blocks[0]!.checksum]) {
      const bytes = original.slice();
      bytes[location] = bytes[location]! ^ 1;
      const decoder = createLz4Decoder(chunks(bytes));
      await expect(decoder.stream.getReader().read()).rejects.toMatchObject({ code: "checksum-mismatch" });
      await expect(decoder.finished).rejects.toMatchObject({ code: "checksum-mismatch" });
    }
    const bytes = original.slice();
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    const decoder = createLz4Decoder(chunks(bytes));
    const reader = decoder.stream.getReader();
    expect((await reader.read()).value).toEqual(decodeBase64(fixtures.frames.raw.body));
    await expect(reader.read()).rejects.toMatchObject({ code: "checksum-mismatch" });
    await expect(decoder.finished).rejects.toMatchObject({ code: "checksum-mismatch" });
    reader.releaseLock();
  });
  it("refuses malformed tokens, zero/history offsets, terminal constraints and truncated frames", async () => {
    // No-checksum native descriptor permits structural mutation controls without a candidate checksum implementation.
    const original = decodeBase64(fixtures.frames["no-checksum"].archive);
    for (
      const token of [
        new Uint8Array([0, 0, 0]),
        new Uint8Array([0, 1, 0]),
        new Uint8Array([0xf0, 255]),
        new Uint8Array([0x10, 65, 1, 0]),
        new Uint8Array([0x10, 65, 1, 0, 0x40, 1, 2, 3, 4]),
      ]
    ) {
      const frame = join([original.slice(0, 7), word(token.length), token, word(0)]);
      const decoder = createLz4Decoder(chunks(frame));
      await expect(collect(decoder.stream)).rejects.toMatchObject({ code: "invalid-archive" });
      await expect(decoder.finished).rejects.toMatchObject({ code: "invalid-archive" });
    }
    for (let end = 0; end < original.length; end++) {
      const decoder = createLz4Decoder(chunks(original.slice(0, end)));
      await expect(collect(decoder.stream)).rejects.toBeInstanceOf(Error);
      await expect(decoder.finished).rejects.toBeInstanceOf(Error);
    }
  });
  it("bounds input, block size/count, expanded work and aggregate output before expansion or copying", async () => {
    const original = decodeBase64(fixtures.frames.dependent.archive);
    for (
      const options of [
        { maxSourceBytes: 1 },
        { maxRequests: 0 },
        { maxDecodedBytes: 1 },
        { maxOutputBytes: 1 },
        { maxBlockBytes: 1 },
        { maxBlocks: 0 },
        { maxInputChunkBytes: 1 },
      ]
    ) {
      const decoder = createLz4Decoder(chunks(original), options);
      await expect(collect(decoder.stream)).rejects.toMatchObject({ code: "budget-exceeded" });
      await expect(decoder.finished).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    expect(() => createLz4Decoder(chunks(original), { maxBlockBytes: 4194305 })).toThrow(RangeError);
    const small = decodeBase64(fixtures.frames["no-checksum"].archive);
    const body = decodeBase64(fixtures.frames["no-checksum"].body);
    const ledger = createArchiveLedger({ maxOutputBytes: body.length });
    const first = createLz4Decoder(chunks(small), { ledger });
    await collect(first.stream);
    await first.finished;
    const second = createLz4Decoder(chunks(small), { ledger });
    await expect(collect(second.stream)).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(second.finished).rejects.toMatchObject({ code: "budget-exceeded" });
    const oversized = join([small.slice(0, 7), word(65537), word(0)]);
    const decoder = createLz4Decoder(chunks(oversized));
    await expect(collect(decoder.stream)).rejects.toMatchObject({ code: "invalid-archive" });
    await expect(decoder.finished).rejects.toMatchObject({ code: "invalid-archive" });
  });
  it("snapshots policy owners and refuses an impossible block extent before another producer acquisition", async () => {
    const bytes = decodeBase64(fixtures.frames.independent.archive);
    const header = layout(bytes).header;
    const original = createArchiveLedger();
    const replacement = createArchiveLedger();
    const options = { maxDecodedBytes: 1, ledger: original };
    let pulls = 0;
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        options.maxDecodedBytes = 64 * 1024 * 1024;
        options.ledger = replacement;
        if (pulls === 1) controller.enqueue(bytes.slice(0, header));
        else controller.error(new Error("body must not be acquired"));
      },
    }, { highWaterMark: 0 });
    const decoder = createLz4Decoder(input, options);
    await expect(collect(decoder.stream)).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(decoder.finished).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(pulls).toBe(1);
    expect(original.inspect().sourceBytes).toBe(header);
    expect(replacement.inspect().sourceBytes).toBe(0);
    const large = decodeBase64(fixtures.frames.block7.archive);
    const prefix = join([
      large.slice(0, layout(large).header),
      word(0x80000000 + [65536, 262144, 1048576, 4194304][(large[5]! >>> 4) - 4]!),
    ]);
    let acquisitions = 0;
    const bounded = createLz4Decoder(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          acquisitions++;
          if (acquisitions === 1) controller.enqueue(prefix);
          else controller.error(new Error("oversized block body must not be acquired"));
        },
      }, { highWaterMark: 0 }),
      { maxSourceBytes: 1024 },
    );
    await expect(collect(bounded.stream)).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(bounded.finished).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(acquisitions).toBe(1);
  });
  it("preserves an already errored producer reason without attempting a second cancellation", async () => {
    const failure = new Error("source failed");
    let cancellations = 0;
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(failure);
      },
      cancel() {
        cancellations++;
      },
    }, { highWaterMark: 0 });
    const decoder = createLz4Decoder(input);
    await expect(collect(decoder.stream)).rejects.toBe(failure);
    await expect(decoder.finished).rejects.toBe(failure);
    expect(cancellations).toBe(0);
    expect(input.locked).toBe(false);
  });
  it("refuses concatenation, skippable frames, legacy magic and trailing bytes", async () => {
    const original = decodeBase64(fixtures.frames["no-checksum"].archive);
    for (
      const bytes of [
        join([original, original]),
        join([original, new Uint8Array([0])]),
        join([word(0x184d2a50), word(0)]),
        word(0x184c2102),
      ]
    ) {
      const decoder = createLz4Decoder(chunks(bytes));
      await expect(collect(decoder.stream)).rejects.toMatchObject({ code: "unsupported-profile" });
      await expect(decoder.finished).rejects.toMatchObject({ code: "unsupported-profile" });
    }
  });
  it("acquires lazily, follows backpressure and leaves early cancellation pending", async () => {
    const bytes = decodeBase64(fixtures.frames.dependent.archive);
    let pulls = 0;
    let cancellations = 0;
    const origin = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(bytes);
      },
      cancel() {
        cancellations++;
      },
    }, { highWaterMark: 0 });
    const decoder = createLz4Decoder(origin, { maxInputChunkBytes: bytes.length, outputChunkBytes: 17 });
    expect(origin.locked).toBe(false);
    expect(pulls).toBe(0);
    const reader = decoder.stream.getReader();
    expect((await reader.read()).value!.length).toBe(17);
    expect(pulls).toBe(1);
    await reader.cancel("prefix complete");
    reader.releaseLock();
    const result = await decoder.finished;
    expect(result.status).toBe("cancelled");
    expect(result.integrity).toBe("checksum-pending");
    expect(cancellations).toBe(1);
    expect(origin.locked).toBe(false);
  });
  it("cancels a pending source on abort and preserves independent source/cancel failures", async () => {
    let cancel = 0;
    const abort = new AbortController();
    const origin = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancel++;
      },
    }, { highWaterMark: 0 });
    const decoder = createLz4Decoder(origin, { signal: abort.signal });
    const reader = decoder.stream.getReader();
    const pending = reader.read();
    await Promise.resolve();
    abort.abort(new Error("stop-lz4"));
    await expect(pending).rejects.toThrow("stop-lz4");
    await expect(decoder.finished).rejects.toThrow("stop-lz4");
    expect(cancel).toBe(1);
    expect(origin.locked).toBe(false);
    reader.releaseLock();
    const failure = new Error("cancel failure");
    const bad = createLz4Decoder(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 0, 0, 0]));
        },
        cancel() {
          throw failure;
        },
      }),
    );
    await expect(collect(bad.stream)).rejects.toBeInstanceOf(AggregateError);
    await expect(bad.finished).rejects.toMatchObject({
      errors: [expect.objectContaining({ code: "unsupported-profile" }), failure],
    });
  });
});
