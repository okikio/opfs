import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { runInNewContext } from "node:vm";
import { createByteSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import nativeFixture from "./fixtures/mcap/independent.json" with { type: "json" };
import { createArchiveLedger, openMcap } from "../src/dataset/mcap.ts";
import type { McapOpenOptionsType } from "../src/dataset/mcap.ts";
const utf8 = new TextEncoder();
const join = (...parts: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    result.set(p, at);
    at += p.length;
  }
  return result;
};
const u16 = (n: number) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
};
const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const u64 = (n: number | bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};
const str = (s: string) => {
  const b = utf8.encode(s);
  return join(u32(b.length), b);
};
const rec = (op: number, body: Uint8Array) => join(new Uint8Array([op]), u64(body.length), body);
// Independent test-only bitwise CRC reference; production crc32 is deliberately not imported.
function crc(b: Uint8Array): number {
  let n = 0xffffffff;
  for (const value of b) {
    n ^= value;
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  }
  return (n ^ 0xffffffff) >>> 0;
}
const magic = new Uint8Array([137, 77, 67, 65, 80, 48, 13, 10]);
const schema = (name = "\ufeffschema", data = new Uint8Array([0, 255])) =>
  rec(3, join(u16(1), str(name), str("opaque"), u32(data.length), data));
const channel = (
  topic = "\ufefftopic",
  pairs: readonly [string, string][] = [],
) => (rec(
  4,
  join(
    u16(0),
    u16(1),
    str(topic),
    str("binary"),
    (() => {
      const b = join(...pairs.map(([k, v]) => join(str(k), str(v))));
      return join(u32(b.length), b);
    })(),
  ),
));
const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
const message = (data = payload, time = 0xffffffffffffffffn) =>
  rec(5, join(u16(0), u32(77), u64(time), u64(time - 1n), data));
function file(records: Uint8Array[], summary: Uint8Array[] = []): Uint8Array {
  const data = join(magic, rec(1, join(str("authored"), str("test-builder"))), ...records),
    end = rec(15, u32(crc(data))),
    start = summary.length ? data.length + end.length : 0;
  const summaryBytes = join(...summary), footerPrefix = join(new Uint8Array([2]), u64(20), u64(start), u64(0));
  return join(data, end, summaryBytes, footerPrefix, u32(crc(join(summaryBytes, footerPrefix))), magic);
}
const plain = () => file([schema(), channel(), message()]);
function chunk(records: Uint8Array[], compression = ""): Uint8Array {
  const b = join(...records);
  return rec(6, join(u64(0), u64(0xffffffffffffffffn), u64(b.length), u32(crc(b)), str(compression), u64(b.length), b));
}
const options: McapOpenOptionsType = { profile: "mcap0-uncompressed" };
const open = (bytes = plain(), extra: Partial<McapOpenOptionsType> = {}) =>
  openMcap(createByteSource(bytes, { identity: "authored-mcap" }), { ...options, ...extra });

describe("MCAP major0 bounded uncompressed view", () => {
  it("retains literal BOM, uint64 timestamps, writer sequences and owned selected payloads", async () => {
    const recording = await open();
    expect(recording.channels[0]!.topic).toBe("\ufefftopic");
    expect(recording.schemas[0]!.name).toBe("\ufeffschema");
    const page = recording.messages();
    expect(page.messages[0]).toEqual({
      id: 0,
      channelId: 0,
      sequence: 77,
      logTime: 0xffffffffffffffffn,
      publishTime: 0xfffffffffffffffen,
      size: 6,
    });
    const read = await recording.read(0, { offset: 2, length: 3 });
    expect(read.bytes).toEqual(payload.slice(2, 5));
    expect(read.integrity).toEqual({ scope: "data", status: "pending" });
    read.bytes.fill(0);
    expect((await recording.read(0)).bytes).toEqual(payload);
    expect(recording.integrity.status).toBe("verified");
    expect((await recording.verify({ scope: "data" })).integrity.status).toBe("verified");
  });
  it("checks the complete containing chunk for a one-byte selected read", async () => {
    const recording = await open(file([chunk([schema(), channel(), message(), message(new Uint8Array([7]))])]));
    const first = await recording.read(0, { length: 1 });
    expect(first.bytes).toEqual(payload.slice(0, 1));
    expect(first.integrity).toEqual({ scope: "chunk", id: 0, status: "verified" });
    expect(first.work.sourceBytes).toBeGreaterThan(payload.length);
    expect(recording.chunkCount).toBe(1);
  });
  it("makes pending payload sources composable without an implicit CRC promise", async () => {
    const recording = await open();
    const source = recording.source(0);
    expect(source.stability).toBe("immutable");
    expect(JSON.parse(source.identity!)[0]).toBe("mcap0");
    expect(await source.read(1, 3)).toEqual(payload.slice(1, 4));
    await expect(source.read(6, 1)).rejects.toThrow(RangeError);
  });
  it("bounds sparse scan work independently of returned page count", async () => {
    const recording = await open(file([schema(), channel(), message(), message(), message()]));
    const page = recording.messages({ channelId: 8, limit: 1, maxScanned: 2 });
    expect(page).toEqual({ messages: [], scanned: 2, cursor: 2 });
    expect(recording.messages({ cursor: page.cursor!, channelId: 8 }).cursor).toBeUndefined();
    expect(() => recording.messages({ limit: 0 })).toThrow();
    expect(() => recording.messages({ startLogTime: 2n, endLogTime: 1n })).toThrow();
  });
  it("admits identical definitions despite map ordering, but refuses conflicts and duplicate map keys", async () => {
    await open(
      file([schema(), channel("same", [["a", "1"], ["b", "2"]]), channel("same", [["b", "2"], ["a", "1"]]), message()]),
    );
    await expect(open(file([schema(), channel(), channel("different"), message()]))).rejects.toThrow("Conflicting");
    await expect(open(file([schema(), channel("same", [["a", "1"], ["a", "1"]])]))).rejects.toThrow("duplicate map");
    await expect(open(file([channel(), schema(), message()]))).rejects.toThrow("precedes");
    await expect(open(file([schema(), message(), channel()]))).rejects.toThrow("precedes");
  });
  it("checks summary duplicates and refuses newly introduced summary IDs", async () => {
    await open(file([schema(), channel(), message()], [schema(), channel()]));
    await expect(open(file([schema(), channel(), message()], [schema("different")]))).rejects.toThrow("Conflicting");
    const s = schema();
    new DataView(s.buffer).setUint16(9, 2, true);
    await expect(open(file([schema(), channel(), message()], [s]))).rejects.toThrow("absent from");
  });
  it("skips unknown nonzero records by their exact framed extent without using them as message authority", async () => {
    const recording = await open(file([schema(), channel(), rec(0x80, new Uint8Array([1, 2, 3])), message()]));
    expect(recording.messageCount).toBe(1);
    expect(recording.opaque[0]!.opcode).toBe(0x80);
    await expect(open(file([rec(0, new Uint8Array())]))).rejects.toThrow("zero");
  });
  it("refuses compressed or nested chunks rather than presenting an incomplete message view", async () => {
    await expect(open(file([chunk([schema(), channel(), message()], "zstd")]))).rejects.toThrow("Compressed");
    await expect(open(file([chunk([chunk([])])]))).rejects.toThrow("not permitted");
  });
  it("reads opaque attachments with an explicit whole attachment checksum scope", async () => {
    const fields = join(u64(3), u64(4), str("../literal"), str("binary"), u64(payload.length), payload);
    const recording = await open(file([rec(9, join(fields, u32(crc(fields))))]));
    expect(recording.attachments[0]!.name).toBe("../literal");
    const result = await recording.readAttachment(0, { offset: 3, length: 2 });
    expect(result.bytes).toEqual(payload.slice(3, 5));
    expect(result.integrity).toEqual({ scope: "attachment", id: 0, status: "verified" });
    expect(await recording.attachmentSource(0).read(0, 6)).toEqual(payload);
  });
  it("reports absent CRC separately from pending or verified", async () => {
    const b = plain(), footer = b.length - 37;
    new DataView(b.buffer).setUint32(footer + 25, 0, true);
    const recording = await open(b);
    expect(recording.integrity.status).toBe("not-provided");
    expect((await recording.verify({ scope: "summary" })).integrity.status).toBe("not-provided");
  });
  it("detects summary/data/chunk tampering within the requested check scope", async () => {
    const bytes = plain();
    bytes[bytes.length - 12] = bytes[bytes.length - 12]! ^ 1;
    await expect(open(bytes)).rejects.toThrow("CRC mismatch");
    const b = plain(), r = await open(b);
    const raw = r.source(0);
    const offset = JSON.parse(raw.identity!)[2] as number;
    b[offset] = b[offset]! ^ 1;
    const changed = await open(b);
    await expect(changed.verify({ scope: "data" })).rejects.toThrow("CRC mismatch");
    const c = file([chunk([schema(), channel(), message()])]);
    const rc = await open(c);
    const at = JSON.parse(rc.source(0).identity!)[2] as number;
    c[at] = c[at]! ^ 1;
    const changedChunk = await open(c);
    await expect(changedChunk.read(0, { length: 0 })).rejects.toThrow("CRC mismatch");
    expect((await changedChunk.read(0, { length: 1, verify: false })).integrity.status).toBe("pending");
  });
  it("rejects unsafe/truncated framing and missing DataEnd", async () => {
    for (const cut of [0, 7, 30, plain().length - 1]) await expect(open(plain().slice(0, cut))).rejects.toThrow();
    const b = plain();
    new DataView(b.buffer).setBigUint64(9, 0xffffffffffffffffn, true);
    await expect(open(b)).rejects.toThrow("exact");
    const noEnd = join(magic, rec(1, join(str(""), str(""))), rec(2, join(u64(0), u64(0), u32(0))), magic);
    await expect(open(noEnd)).rejects.toThrow("DataEnd");
  });
  it("enforces retained metadata, record, message and return policies before payload I/O", async () => {
    await expect(open(plain(), { maxMessages: 0 })).rejects.toThrow("message count");
    await expect(open(plain(), { maxMetadataBytes: 1 })).rejects.toThrow("metadata");
    await expect(open(plain(), { maxRecords: 1 })).rejects.toThrow("record visits");
    const recording = await open(plain(), { maxReadBytes: 1 });
    await expect(recording.read(0, { length: 2 })).rejects.toThrow("interval");
  });
  it("keeps opening lifetime and external operation ledgers authoritative before payload callbacks", async () => {
    let calls = 0;
    const b = plain();
    const source: ByteSourceType = {
      size: b.length,
      stability: "caller",
      async read(o, n) {
        calls++;
        return b.slice(o, o + n);
      },
    };
    const ledger = createArchiveLedger({ maxSourceBytes: 1 << 20 });
    const recording = await openMcap(source, { ...options, ledger });
    ledger.reserve("sourceBytes", (1 << 20) - ledger.inspect().sourceBytes);
    const before = calls;
    await expect(recording.read(0, { length: 1 })).rejects.toThrow("limit");
    expect(calls).toBe(before);
    const second = await open();
    const external = createArchiveLedger({ maxSourceBytes: 0 });
    await expect(second.read(0, { length: 1, ledger: external })).rejects.toThrow("limit");
  });
  it("observes synchronous abort from the final foreign request reservation before source I/O", async () => {
    const bytes = plain();
    let calls = 0;
    const why = new Error("foreign request reservation aborted");
    const controller = new AbortController();
    const external = {
      reserve(kind: string) {
        if (kind === "requests") controller.abort(why);
      },
      inspect() {
        return { sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 };
      },
    };
    const source: ByteSourceType = {
      size: bytes.length,
      stability: "caller",
      async read(o, n) {
        calls++;
        return bytes.slice(o, o + n);
      },
    };
    await expect(openMcap(source, { ...options, signal: controller.signal, ledger: external })).rejects.toBe(why);
    expect(calls).toBe(0);
    const viewController = new AbortController();
    let active = false;
    const recording = await openMcap(source, options),
      raw = recording.source(0, {
        signal: viewController.signal,
        ledger: {
          ...external,
          reserve(kind) {
            if (active && kind === "requests") viewController.abort(why);
          },
        },
      });
    active = true;
    const before = calls;
    await expect(raw.read(0, 1, { signal: new AbortController().signal })).rejects.toBe(why);
    expect(calls).toBe(before);
  });
  it("admits all materialized stored bytes through decoded budgets before callbacks", async () => {
    let calls = 0;
    const bytes = plain(),
      source: ByteSourceType = {
        size: bytes.length,
        stability: "caller",
        async read(o, n) {
          calls++;
          return bytes.slice(o, o + n);
        },
      };
    await expect(openMcap(source, { ...options, maxDecodedBytes: 0 })).rejects.toThrow("decodedBytes");
    expect(calls).toBe(0);
    const recording = await openMcap(source, options), before = calls;
    await expect(recording.read(0, { length: 1, maxDecodedBytes: 0 })).rejects.toThrow("decodedBytes");
    expect(calls).toBe(before);
    await expect(recording.verify({ scope: "data", maxDecodedBytes: 0 })).rejects.toThrow("decodedBytes");
    expect(calls).toBe(before);
    await expect(recording.source(0, { maxDecodedBytes: 0 }).read(0, 1)).rejects.toThrow("decodedBytes");
    expect(calls).toBe(before);
    const read = await recording.read(0, { length: 1 });
    expect(read.work.decodedBytes).toBe(1);
  });
  it("does not double-charge an identical external ledger passed again by a child", async () => {
    const ledger = createArchiveLedger({ maxSourceBytes: 1 << 20 });
    const recording = await open(plain(), { ledger });
    const before = ledger.inspect().sourceBytes;
    await recording.read(0, { length: 1, ledger });
    expect(ledger.inspect().sourceBytes - before).toBe(1);
  });
  it("preserves opening and view cancellation when a fresh child signal is provided", async () => {
    const parent = new AbortController(), recording = await open(plain(), { signal: parent.signal });
    const source = recording.source(0);
    const why = new Error("parent aborted");
    parent.abort(why);
    await expect(recording.read(0, { signal: new AbortController().signal })).rejects.toBe(why);
    await expect(source.read(0, 1, { signal: new AbortController().signal })).rejects.toBe(why);
    expect(() => recording.messages()).toThrow(why);
    const other = await open(), view = new AbortController(), raw = other.source(0, { signal: view.signal });
    view.abort(why);
    await expect(raw.read(0, 1, { signal: new AbortController().signal })).rejects.toBe(why);
  });
  it("captures descriptor methods and options once before the first source await", async () => {
    const b = plain();
    let first = true, reads = 0;
    const options2 = { ...options };
    const source = {
      size: b.length,
      identity: "captured",
      stability: "caller" as const,
      async read(o: number, n: number) {
        reads++;
        if (first) {
          first = false;
          source.size = 0;
          source.identity = "changed";
          source.read = async () => {
            throw new Error("changed method");
          };
          options2.maxReadBytes = 0;
        }
        return b.slice(o, o + n);
      },
    };
    const recording = await openMcap(source, options2);
    expect((await recording.read(0)).bytes).toEqual(payload);
    expect(reads).toBeGreaterThan(1);
  });
  it("uses native byte extents across realms and refuses shadowed short extents", async () => {
    const b = plain();
    const source: ByteSourceType = {
      size: b.length,
      stability: "caller",
      async read(o, n) {
        return runInNewContext("Uint8Array.from(values)", { values: Array.from(b.slice(o, o + n)) }) as Uint8Array;
      },
    };
    expect((await openMcap(source, options)).messageCount).toBe(1);
    const bad: ByteSourceType = {
      size: b.length,
      stability: "caller",
      async read(_o, n) {
        const value = new Uint8Array(1);
        Object.defineProperty(value, "byteLength", { value: n });
        return value;
      },
    };
    await expect(openMcap(bad, options)).rejects.toThrow("incomplete");
  });
  it("requires explicit stable-source evidence and leaves provider failures intact", async () => {
    const b = plain();
    await expect(openMcap({
      size: b.length,
      async read(o, n) {
        return b.slice(o, o + n);
      },
    }, options)).rejects.toThrow("stable");
    const failure = new Error("borrowed source failed");
    await expect(openMcap({
      size: b.length,
      stability: "caller",
      async read() {
        throw failure;
      },
    }, options)).rejects.toBe(failure);
  });
});

const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
describe("native Python MCAP1.6.0 NONE fixtures", () => {
  for (const fixture of nativeFixture.fixtures) {
    it(`reads all original bytes and exact timestamps from ${fixture.name}`, async () => {
      const raw = decode(fixture.data), recording = await open(raw);
      expect(recording.messageCount).toBe(fixture.messages.length);
      expect(recording.integrity).toEqual({ scope: "summary", status: "verified" });
      expect((await recording.verify({ scope: "data" })).integrity.status).toBe("verified");
      expect(fixture.footer.crc).toBe(fixture.footer.independentCrc);
      const page = recording.messages();
      for (let id = 0; id < fixture.messages.length; id++) {
        const authored = fixture.messages[id]!, d = page.messages[id]!;
        expect(d.logTime).toBe(BigInt(authored.logTime));
        expect(d.publishTime).toBe(BigInt(authored.publishTime));
        expect(d.sequence).toBe(authored.sequence);
        expect(d.channelId).toBe(authored.channelId);
        const expected = decode(authored.data), read = await recording.read(id);
        expect(read.bytes).toEqual(expected);
        const n = Math.min(5, expected.length);
        expect((await recording.read(id, { offset: expected.length - n, length: n })).bytes).toEqual(
          expected.slice(expected.length - n),
        );
        expect(await recording.source(id).read(0, expected.length)).toEqual(expected);
        if (fixture.name === "chunked") expect(read.integrity.status).toBe("verified");
      }
      if (fixture.messages.length) {
        expect(recording.schemas[0]!.data).toEqual(new Uint8Array([0, 115, 99, 104, 101, 109, 97, 255]));
        expect(recording.channels[0]!.topic).toBe("topic/\ufeffliteral");
        expect(recording.channels[0]!.metadata).toEqual({ owner: "caller", name: "e\u0301" });
        expect((await recording.readAttachment(0)).bytes).toEqual(
          new Uint8Array([0, ...utf8.encode("native attachment"), 255]),
        );
        expect((await recording.readAttachment(0)).integrity.status).toBe("verified");
        expect(recording.metadata[0]).toEqual({ name: "metadata", values: { a: "one", b: "two" } });
      }
    });
  }
});
