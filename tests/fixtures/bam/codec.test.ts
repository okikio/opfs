/** Runtime admission, not candidate BAM proof: authored frames and independent Node zlib encode/decode. */
import { describe, it } from "node:test";
import { Buffer } from "node:buffer";
import { constants, deflateRawSync, gunzipSync, inflateRawSync } from "node:zlib";
import { expect } from "@std/expect";

/** Independent authored gzip CRC, never imported from a candidate codec. */
function crc(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value >>> 1 ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/** One complete authored BC-marked gzip member; this constructs framing, not DEFLATE expectations. */
function member(raw: Uint8Array, original: Uint8Array): Buffer<ArrayBuffer> {
  const bytes = Buffer.alloc(18 + raw.length + 8);
  expect(bytes.length <= 65536).toBe(true);
  bytes.set([31, 139, 8, 4, 0, 0, 0, 0, 0, 255, 6, 0, 66, 67, 2, 0]);
  bytes.writeUInt16LE(bytes.length - 1, 16);
  bytes.set(raw, 18);
  bytes.writeUInt32LE(crc(original), bytes.length - 8);
  bytes.writeUInt32LE(original.length, bytes.length - 4);
  return bytes;
}

function source(bytes: Uint8Array, chunk: number): ReadableStream<Uint8Array<ArrayBuffer>> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at === bytes.length) return controller.close();
      const end = Math.min(bytes.length, at + chunk);
      controller.enqueue(new Uint8Array(bytes.subarray(at, end)));
      at = end;
    },
  }, { highWaterMark: 0 });
}

/** Both pipe and reader settle before admission returns; output and chunk bounds remain explicit. */
async function decode(bytes: Uint8Array, format: "gzip" | "deflate-raw", chunk: number): Promise<Uint8Array> {
  const codec = new DecompressionStream(format), input = source(bytes, chunk), reader = codec.readable.getReader();
  const piping = input.pipeTo(codec.writable);
  void piping.catch(() => {});
  const output = new Uint8Array(65536);
  let at = 0, chunks = 0;
  const failures: unknown[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (++chunks > 4096 || next.value.length > output.length - at) {
        throw new Error("Admission output budget exceeded.");
      }
      output.set(next.value, at);
      at += next.value.length;
    }
    await piping;
  } catch (reason) {
    failures.push(reason);
  } finally {
    const retired = await Promise.allSettled([reader.cancel(), piping]);
    // A decoder error can reject both views of the same pipeline. This harness observes pass/fail, not an API error aggregate.
    if (failures.length === 0) {
      for (const result of retired) if (result.status === "rejected") failures.push(result.reason);
    }
    reader.releaseLock();
  }
  if (failures.length) throw failures[0];
  return output.slice(0, at);
}

/** Diagnostic admission deliberately fails on permissive runtimes; label the precise refused vector and split. */
async function refuse(bytes: Uint8Array, format: "gzip" | "deflate-raw", chunk: number, label: string): Promise<void> {
  let output: Uint8Array;
  try {
    output = await decode(bytes, format, chunk);
  } catch {
    return;
  }
  throw new Error(
    `Required native refusal: ${format}/${label}, inputBytes=${bytes.length}, chunkBytes=${chunk}; resolved outputBytes=${output.length}, prefix=${
      Array.from(output.subarray(0, 8)).join(",")
    }.`,
  );
}

describe("BAM native Web codec admission (not production support)", () => {
  it("fully decodes authored stored/fixed and native-zlib dynamic BGZF members across chunk boundaries", async () => {
    const small = Buffer.from("A");
    // RFC1951 final stored block and final fixed-Huffman block, both spelling the authored byte A.
    const stored = Buffer.from([1, 1, 0, 254, 255, 65]), fixed = Buffer.from([0x73, 0x04, 0x00]);
    expect(inflateRawSync(stored)).toEqual(small);
    expect(inflateRawSync(fixed)).toEqual(small);
    const original = Buffer.from("aaaaaaaaaaaaaaaaabbbbcccdde0123456789".repeat(900));
    const dynamic = deflateRawSync(original, { level: 6, strategy: constants.Z_DEFAULT_STRATEGY });
    expect((dynamic[0]! >>> 1) & 3).toBe(2); // Fail fixture admission rather than mislabel a native fixed block as dynamic.
    for (const [raw, expected] of [[stored, small], [fixed, small], [dynamic, original]] as const) {
      const gzip = member(raw, expected);
      expect(gunzipSync(gzip)).toEqual(expected);
      for (const chunk of [1, 7, 65536]) {
        expect(await decode(raw, "deflate-raw", chunk)).toEqual(new Uint8Array(expected));
        expect(await decode(gzip, "gzip", chunk)).toEqual(new Uint8Array(expected));
      }
    }
  });

  it("rejects gzip CRC/ISIZE errors, every fixed-member truncation and an overlong gzip extra field", async () => {
    const gzip = member(Buffer.from([0x73, 0x04, 0x00]), Buffer.from("A"));
    const badCrc = Buffer.from(gzip);
    badCrc[badCrc.length - 8] = badCrc[badCrc.length - 8]! ^ 1;
    const badSize = Buffer.from(gzip);
    badSize[badSize.length - 4] = badSize[badSize.length - 4]! ^ 1;
    // Generic gzip ignores BC semantics, but it must reject an extra-field length extending past the member.
    const extra = Buffer.from(gzip);
    extra.writeUInt16LE(65535, 10);
    for (
      const [label, bad] of [
        ["crc32", badCrc],
        ["isize", badSize],
        ["overlong-extra", extra],
        ...Array.from(
          { length: gzip.length },
          (_, length) => [`truncated-at-${length}`, gzip.subarray(0, length)] as const,
        ),
      ] as const
    ) {
      for (const chunk of [1, 65536]) await refuse(bad, "gzip", chunk, label);
    }
  });

  it("refuses trailing garbage, zero padding and extra members, including empty members with unchanged output", async () => {
    const raw = Buffer.from([0x73, 0x04, 0x00]), gzip = member(raw, Buffer.from("A"));
    const empty = member(Buffer.from([3, 0]), new Uint8Array());
    expect(gunzipSync(empty).length).toBe(0);
    for (
      const [label, suffix] of [["trailing-ff", Buffer.from([255])], ["trailing-zero", Buffer.from([0])], [
        "trailing-empty-member",
        empty,
      ], ["trailing-nonempty-member", gzip]] as const
    ) {
      const bad = Buffer.concat([gzip, suffix]);
      for (const chunk of [1, gzip.length, 65536]) await refuse(bad, "gzip", chunk, label);
    }
    // Leading empty gzip leaves both aggregate output and the final trailer unchanged; own CRC/ISIZE cannot detect it.
    for (const chunk of [1, empty.length, 65536]) {
      await refuse(Buffer.concat([empty, gzip]), "gzip", chunk, "leading-empty-member");
    }
    // Native gunzip accepts concatenation; it is explicitly NOT the oracle for WHATWG's one-member restriction.
    expect(gunzipSync(Buffer.concat([gzip, empty]))).toEqual(Buffer.from("A"));
    for (
      const [label, suffix] of [["trailing-ff", Buffer.from([255])], ["trailing-zero", Buffer.from([0])], [
        "trailing-empty-stream",
        Buffer.from([3, 0]),
      ], ["trailing-nonempty-stream", raw]] as const
    ) {
      for (const chunk of [1, raw.length, 65536]) {
        await refuse(Buffer.concat([raw, suffix]), "deflate-raw", chunk, label);
      }
    }
  });

  it("rejects raw truncation and an extra empty DEFLATE stream hidden before a correct gzip trailer", async () => {
    const raw = Buffer.from([0x73, 0x04, 0x00]), original = Buffer.from("A");
    for (const bad of [new Uint8Array(), raw.subarray(0, 1), raw.subarray(0, 2)]) {
      for (const chunk of [1, 65536]) await refuse(bad, "deflate-raw", chunk, `truncated-at-${bad.length}`);
    }
    // CRC and ISIZE still match A; only complete compressed-input termination can reject this payload.
    const extra = member(Buffer.concat([raw, Buffer.from([3, 0])]), original);
    for (const chunk of [1, 65536]) await refuse(extra, "gzip", chunk, "extra-empty-raw-stream-before-correct-trailer");
  });

  it("joins an aborted native pipeline and releases its input lock with the original cancellation reason", async () => {
    const codec = new DecompressionStream("gzip"),
      abort = new AbortController(),
      reason = new Error("authored admission abort");
    const reasons: unknown[] = [];
    const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
      cancel(value) {
        reasons.push(value);
      },
    }, { highWaterMark: 0 });
    const reader = codec.readable.getReader(), piping = input.pipeTo(codec.writable, { signal: abort.signal });
    void piping.catch(() => {});
    const pending = reader.read();
    void pending.catch(() => {});
    abort.abort(reason);
    const results = await Promise.allSettled([piping, pending]);
    reader.releaseLock();
    expect(results.every((result) => result.status === "rejected" && result.reason === reason)).toBe(true);
    expect(reasons).toEqual([reason]);
    expect(input.locked).toBe(false);
    expect(codec.readable.locked).toBe(false);
  });

  it("joins consumer cancellation without leaving the producer or native reader locked", async () => {
    const codec = new DecompressionStream("gzip"), reasons: unknown[] = [], reason = { consumer: "stopped" };
    const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
      cancel(value) {
        reasons.push(value);
      },
    }, { highWaterMark: 0 });
    const reader = codec.readable.getReader(), piping = input.pipeTo(codec.writable);
    void piping.catch(() => {});
    await reader.cancel(reason);
    const result = await Promise.allSettled([piping]);
    reader.releaseLock();
    expect(result[0]?.status).toBe("rejected");
    expect(reasons).toEqual([reason]);
    expect(input.locked).toBe(false);
  });
});
