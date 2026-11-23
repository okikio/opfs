import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { decodeXpress } from "../src/archive/xpress.ts";
import { createArchiveLedger, openWim } from "../src/archive/wim.ts";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import fixture from "./fixtures/wim/xpress-independent.json" with { type: "json" };
import tails from "./fixtures/wim/xpress-tail-receipt.json" with { type: "json" };

const chunks = fixture.nativeResources.flatMap((resource) => resource.chunks.filter((chunk) => chunk.compressed));
const source = (bytes: Uint8Array): ByteSourceType => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const packed = (): Uint8Array => decodeBase64(fixture.base64);
describe("ordinary WIM XPRESS-Huffman selected writer profile", () => {
  it("matches every complete native resource chunk and its independent framing receipt", () => {
    expect(chunks.length).toBe(13);
    expect(tails.length).toBe(chunks.length);
    for (const chunk of chunks) {
      const expected = decodeBase64(chunk.decoded), output = new Uint8Array(expected.length);
      let steps = 0;
      decodeXpress(decodeBase64(chunk.packed), output, (count) => steps += count);
      expect(output).toEqual(expected);
      expect(steps).toBeLessThan(1048576);
    }
    for (const tail of tails) {
      expect(tail.endSymbol).toBe(256);
      expect(tail.exactExtent).toBe(true);
      expect(tail.remainingZeroBits).toBeGreaterThanOrEqual(16);
      expect(tail.remainingZeroBits).toBeLessThanOrEqual(31);
    }
  });

  it("rejects every truncation, extra bytes and nonzero writer padding", () => {
    const chunk = chunks[0]!, bytes = decodeBase64(chunk.packed);
    for (let length = 0; length < bytes.length; length++) {
      expect(() => decodeXpress(bytes.subarray(0, length), new Uint8Array(chunk.expected), () => {})).toThrow();
    }
    for (const suffix of [new Uint8Array([0]), new Uint8Array([0, 0]), new Uint8Array([1, 2, 3])]) {
      const extra = new Uint8Array(bytes.length + suffix.length);
      extra.set(bytes);
      extra.set(suffix, bytes.length);
      expect(() => decodeXpress(extra, new Uint8Array(chunk.expected), () => {})).toThrow();
    }
    const bad = bytes.slice();
    bad[bad.length - 1] = 1;
    expect(() => decodeXpress(bad, new Uint8Array(chunk.expected), () => {})).toThrow();
  });

  it("rejects incomplete and oversubscribed tables and wrong declared output extents", () => {
    const chunk = chunks[0]!, bytes = decodeBase64(chunk.packed);
    for (const header of [0, 0x11, 0xff]) {
      const bad = bytes.slice();
      bad.fill(header, 0, 256);
      expect(() => decodeXpress(bad, new Uint8Array(chunk.expected), () => {})).toThrow();
    }
    for (const length of [0, chunk.expected - 1, chunk.expected + 1, 32769]) {
      expect(() => decodeXpress(bytes, new Uint8Array(length), () => {})).toThrow();
    }
  });

  it("preserves synchronous cancellation or CPU admission failure before returning plaintext", () => {
    const chunk = chunks[0]!, bytes = decodeBase64(chunk.packed), failure = new Error("caller stopped XPRESS");
    expect(() =>
      decodeXpress(bytes, new Uint8Array(chunk.expected), () => {
        throw failure;
      })
    ).toThrow(failure);
    let steps = 0;
    expect(() =>
      decodeXpress(bytes, new Uint8Array(chunk.expected), (count) => {
        steps += count;
        if (steps > 1000) throw failure;
      })
    ).toThrow(failure);
  });
});

describe("XPRESS WIM public resource and image composition", () => {
  it("matches complete native resources, metadata and every independent 7-Zip file oracle", async () => {
    const archive = await openWim(source(packed()), { subtle: crypto.subtle });
    expect(archive.profile).toBe("xpress-huffman-32k-1.13");
    for (const native of fixture.nativeResources) {
      const resource = archive.resources.find((resource) => resource.sha1 === native.sha1)!;
      expect(resource.size).toBe(native.decoded);
      expect(resource.storedSize).toBe(native.stored);
      expect(resource.compression).toBe(native.flags & 4 ? "xpress-huffman" : "stored");
      const result = await archive.read(resource.id);
      expect(result.bytes).toEqual(decodeBase64(native.body));
      expect(result.integrity).toBe("resource-sha1-verified");
    }
    for (const expected of fixture.images) {
      const image = await archive.image(expected.index);
      expect(image.metadataIntegrity).toBe("resource-sha1-verified");
      expect(image.xpressSteps).toBeGreaterThan(0);
      for (const file of expected.files) {
        const entry = image.entries.find((entry) => entry.path === file.path)!;
        const result = await image.read(entry.id);
        expect(result.bytes).toEqual(decodeBase64(file.base64));
        expect(result.integrity).toBe(entry.size ? "resource-sha1-verified" : "not-provided");
      }
    }
  });

  it("decodes only intersecting chunks for pending ranges and composes logical sources", async () => {
    const archive = await openWim(source(packed()), { subtle: crypto.subtle });
    const native = fixture.nativeResources.find((resource) => resource.decoded === 200000)!;
    const resource = archive.resources.find((resource) => resource.sha1 === native.sha1)!;
    const result = await archive.read(resource.id, { offset: 32766, length: 5, verify: false });
    expect(result.bytes).toEqual(decodeBase64(native.body).slice(32766, 32771));
    expect(result.integrity).toBe("pending");
    expect(result.work.decodedBytes).toBe(24 + 65536);
    expect(result.work.sourceBytes).toBe(
      24 + decodeBase64(native.chunks[0]!.packed).length + decodeBase64(native.chunks[1]!.packed).length,
    );
    expect(result.work.outputBytes).toBe(5);
    const child = archive.source(resource.id, { offset: 32766, length: 5 });
    expect(child.size).toBe(5);
    expect(await child.read(1, 3)).toEqual(result.bytes.slice(1, 4));
    const verified = await archive.read(resource.id, { offset: 32766, length: 5 });
    expect(verified.integrity).toBe("resource-sha1-verified");
    expect(verified.work.decodedBytes).toBe(24 + 400000);
    const empty = await archive.read(resource.id, { offset: resource.size, length: 0, verify: false });
    expect(empty.integrity).toBe("pending");
    expect(empty.work.sourceBytes).toBe(0);
  });

  it("rejects unsupported header codecs, chunk sizes, malformed offsets and corrupted selected tails", async () => {
    for (const [at, value] of [[16, 0x40082], [16, 0x20080], [20, 65536]] as const) {
      const bytes = packed();
      new DataView(bytes.buffer).setUint32(at, value, true);
      await expect(openWim(source(bytes))).rejects.toMatchObject({ code: "unsupported-profile" });
    }
    const empty = packed(), emptyView = new DataView(empty.buffer);
    const table = Number(emptyView.getBigUint64(56, true));
    emptyView.setBigUint64(table + 16, 0n, true);
    await expect(openWim(source(empty))).rejects.toMatchObject({ code: "invalid-archive" });
    const native = fixture.nativeResources.find((resource) => resource.decoded === 200000)!;
    for (const value of [0, native.stored + 1]) {
      const bytes = packed();
      new DataView(bytes.buffer).setUint32(native.offset, value, true);
      const archive = await openWim(source(bytes));
      const resource = archive.resources.find((resource) => resource.sha1 === native.sha1)!;
      await expect(archive.read(resource.id, { length: 3, verify: false })).rejects.toMatchObject({
        code: "invalid-archive",
      });
    }
    const bytes = packed(), first = native.chunks[0]!;
    bytes[native.offset + 24 + decodeBase64(first.packed).length - 1] = 1;
    const archive = await openWim(source(bytes));
    const resource = archive.resources.find((resource) => resource.sha1 === native.sha1)!;
    await expect(archive.read(resource.id, { length: 3, verify: false })).rejects.toMatchObject({
      code: "invalid-archive",
    });
  });

  it("admits full selected work before payload reads and preserves opening lifetime ledgers", async () => {
    const bytes = packed(), native = fixture.nativeResources.find((resource) => resource.decoded === 200000)!;
    let calls = 0;
    const input: ByteSourceType = {
      size: bytes.length,
      stability: "immutable",
      async read(offset, length) {
        calls++;
        return bytes.slice(offset, offset + length);
      },
    };
    const ledger = createArchiveLedger({ maxSourceBytes: 1000000 });
    const archive = await openWim(input, { ledger });
    const resource = archive.resources.find((resource) => resource.sha1 === native.sha1)!;
    const before = calls;
    await expect(archive.read(resource.id, { length: 3, verify: false, maxSourceBytes: 24 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    expect(calls).toBe(before + 1); // Only the bounded chunk table was read.
    const decoded = calls;
    await expect(archive.read(resource.id, { length: 3, verify: false, maxDecodedBytes: 24 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    expect(calls).toBe(decoded + 1); // Full chunk admission precedes payload I/O.
    ledger.reserve("sourceBytes", 1000000 - ledger.inspect().sourceBytes);
    const exhausted = calls;
    await expect(archive.read(resource.id, { length: 3, verify: false })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    expect(calls).toBe(exhausted);
    const blocked = await openWim(source(bytes), { maxChunkTableBytes: 0 });
    await expect(blocked.read(resource.id, { length: 3, verify: false })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    const cpu = await openWim(source(bytes), { maxXpressSteps: 0 });
    await expect(cpu.read(resource.id, { length: 3, verify: false })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });

  it("distinguishes structural chunk admission from a requested whole-resource SHA1 check", async () => {
    const bytes = packed(), view = new DataView(bytes.buffer);
    const original = await openWim(source(bytes));
    const resource = original.resources.find((resource) => resource.size === 200000)!;
    const table = Number(view.getBigUint64(56, true));
    bytes[table + resource.id * 50 + 30] = bytes[table + resource.id * 50 + 30]! ^ 1;
    const archive = await openWim(source(bytes), { subtle: crypto.subtle });
    const pending = await archive.read(resource.id, { length: 3, verify: false });
    expect(pending.bytes).toEqual(new Uint8Array([65, 65, 65]));
    expect(pending.integrity).toBe("pending");
    await expect(archive.read(resource.id, { length: 3 })).rejects.toMatchObject({ code: "checksum-mismatch" });
  });

  it("retains parent abort authority and propagates provider failures", async () => {
    const bytes = packed(), controller = new AbortController();
    const archive = await openWim(source(bytes), { signal: controller.signal });
    const resource = archive.resources.find((resource) => resource.compression === "xpress-huffman")!;
    const child = archive.source(resource.id);
    const failure = new Error("archive closed by caller");
    controller.abort(failure);
    await expect(archive.read(resource.id, { signal: new AbortController().signal, verify: false })).rejects.toBe(
      failure,
    );
    await expect(child.read(0, 1, { signal: new AbortController().signal })).rejects.toBe(failure);
    let fail = false;
    const provider: ByteSourceType = {
      size: bytes.length,
      stability: "immutable",
      async read(offset, length) {
        if (fail) throw failure;
        return bytes.slice(offset, offset + length);
      },
    };
    const other = await openWim(provider);
    fail = true;
    await expect(other.read(resource.id, { length: 1, verify: false })).rejects.toBe(failure);
  });
});
