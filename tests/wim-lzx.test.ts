import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { decodeLzx } from "../src/archive/lzx.ts";
import { createArchiveLedger, openWim } from "../src/archive/wim.ts";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import genuine from "./fixtures/wim/lzx-independent.json" with { type: "json" };
import authored from "./fixtures/wim/lzx-authored.json" with { type: "json" };
import tails from "./fixtures/wim/lzx-tail-receipt.json" with { type: "json" };
import rawTails from "./fixtures/wim/lzx-authored-tail.json" with { type: "json" };

const chunks = genuine.nativeResources.flatMap((resource) => resource.chunks.filter((chunk) => chunk.compressed));
const raw = authored.nativeResources.find((resource) => resource.decoded === 200000)!.chunks[0]!;
const source = (bytes: Uint8Array): ByteSourceType => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
/** The oracle contains full original/native bytes, never output from the candidate. */
function exact(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) throw new Error(`Native original-byte mismatch at ${i}.`);
  }
}

/** Authored canonical two-symbol grammar isolates empty-tree use; it is not a native interoperability claim. */
function emptyTree(kind: 1 | 2, second = 66): Uint8Array {
  const bits: number[] = [];
  const field = (value: number, count: number): void => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  field(kind, 3);
  field(0, 1);
  field(1000, 16);
  if (kind === 2) { for (let i = 0; i < 8; i++) field(0, 3); }
  const lengths = (start: number, count: number, main: boolean): void => {
    // Pretree0 and16 are canonical codes0 and1. Delta16 changes initial length0 to1.
    for (let i = 0; i < 20; i++) field(i === 0 || i === 16 ? 1 : 0, 4);
    for (let i = start; i < start + count; i++) field(main && (i === 65 || i === second) ? 1 : 0, 1);
  };
  lengths(0, 256, true);
  lengths(256, 240, true);
  lengths(0, 249, false);
  if (second === 263) {
    field(0, 1);
    field(1, 1);
  } // Match needs the empty length tree.
  else if (second === 320) {
    field(0, 14);
    field(1, 1);
  } // Match needs the empty aligned tree.
  else field(0, 1000); // One thousand literal A bytes never use either empty tree.
  const bytes = new Uint8Array(Math.ceil(bits.length / 16) * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < bits.length; i++) {
    const offset = Math.floor(i / 16) * 2;
    view.setUint16(offset, view.getUint16(offset, true) | (bits[i]! << (15 - (i & 15))), true);
  }
  return bytes;
}

describe("ordinary WIM LZX selected writer kernel", () => {
  it("matches every complete genuine native chunk and separately authored raw/multiblock bytes", () => {
    expect(chunks.length).toBe(19);
    for (const chunk of [...chunks, raw]) {
      const expected = decodeBase64(chunk.decoded), output = new Uint8Array(expected.length);
      let steps = 0, blocks = 0;
      decodeLzx(decodeBase64(chunk.packed), output, (count) => steps += count, () => blocks++);
      exact(output, expected);
      expect(steps).toBeLessThan(1048576);
      expect(blocks).toBe(chunk === raw ? 2 : 1);
    }
    expect(tails.filter((tail) => tail.blocks[0]!.type === 2).length).toBe(2);
    expect(tails.reduce((count, tail) => count + tail.uses.aligned, 0)).toBe(304);
    expect(tails.reduce((count, tail) => count + tail.e8TranslatedPositions.length, 0)).toBe(10);
    expect(rawTails.find((tail) => tail.blocks.length === 2)!.blocks.map((block) => block.type)).toEqual([3, 1]);
  });

  it("rejects every truncation, extra coding words and nonzero final padding", () => {
    const chunk = chunks[0]!, bytes = decodeBase64(chunk.packed);
    for (let length = 0; length < bytes.length; length++) {
      expect(() => decodeLzx(bytes.subarray(0, length), new Uint8Array(chunk.expected), () => {}, () => {})).toThrow();
    }
    const extra = new Uint8Array(bytes.length + 2);
    extra.set(bytes);
    expect(() => decodeLzx(extra, new Uint8Array(chunk.expected), () => {}, () => {})).toThrow();
    const pad = bytes.slice();
    pad[pad.length - 2] = pad[pad.length - 2]! ^ 1;
    expect(() => decodeLzx(pad, new Uint8Array(chunk.expected), () => {}, () => {})).toThrow();
  });

  it("rejects raw alignment, zero repeated offsets, odd padding and invalid block sizes", () => {
    const bytes = decodeBase64(raw.packed);
    for (const at of [2, 4, 21]) {
      const bad = bytes.slice();
      if (at === 4) new DataView(bad.buffer).setUint32(at, 0, true);
      else bad[at] = bad[at]! ^ 1;
      expect(() => decodeLzx(bad, new Uint8Array(32768), () => {}, () => {})).toThrow();
    }
    for (const header of [0, 0x2000, 0x2800]) {
      const bad = new Uint8Array(4);
      new DataView(bad.buffer).setUint16(0, header, true);
      expect(() => decodeLzx(bad, new Uint8Array(32768), () => {}, () => {})).toThrow();
    }
  });

  it("bounds repeated raw-block work and preserves caller CPU/cancellation failure identity", () => {
    const bytes = decodeBase64(raw.packed), failure = new Error("caller stopped LZX");
    expect(() =>
      decodeLzx(bytes, new Uint8Array(32768), () => {
        throw failure;
      }, () => {})
    ).toThrow(failure);
    expect(() =>
      decodeLzx(bytes, new Uint8Array(32768), () => {}, () => {
        throw failure;
      })
    ).toThrow(failure);
    const block = new Uint8Array(18), view = new DataView(block.buffer);
    // Raw explicit-size1 header plus three repeated offsets, one byte and odd pad.
    view.setUint16(0, 0x6000, true);
    view.setUint16(2, 0x1000, true);
    for (const at of [4, 8, 12]) view.setUint32(at, 1, true);
    block[16] = 65;
    const repeated = new Uint8Array(block.length * 257 + bytes.length);
    for (let i = 0; i < 257; i++) repeated.set(block, i * block.length);
    repeated.set(bytes, block.length * 257);
    expect(() => decodeLzx(repeated, new Uint8Array(32768), () => {}, () => {})).toThrow("block ceiling");
  });

  it("keeps empty trees inert but rejects using them for length or aligned symbols", () => {
    for (const kind of [1, 2] as const) {
      const output = new Uint8Array(1000);
      decodeLzx(emptyTree(kind), output, () => {}, () => {});
      exact(output, new Uint8Array(1000).fill(65));
    }
    expect(() => decodeLzx(emptyTree(1, 263), new Uint8Array(1000), () => {}, () => {})).toThrow("empty tree");
    expect(() => decodeLzx(emptyTree(2, 320), new Uint8Array(1000), () => {}, () => {})).toThrow("empty tree");
  });

  it("admits an authored terminal raw block only with exact alignment and odd padding", () => {
    // This structural regression adapts independently produced coding words; it is not a new native fixture claim.
    const original = decodeBase64(authored.nativeSuccessor);
    const bits: number[] = [], view = new DataView(original.buffer, original.byteOffset, original.byteLength);
    for (let offset = 0; offset < original.length; offset += 2) {
      const word = view.getUint16(offset, true);
      for (let bit = 15; bit >= 0; bit--) bits.push((word >>> bit) & 1);
    }
    bits.length -= 6; // Native successor's retained zero-tail measurement.
    for (const [value, count] of [[3, 3], [0, 1], [5, 16]]) {
      for (let bit = count! - 1; bit >= 0; bit--) bits.push((value! >>> bit) & 1);
    }
    const alignment = 16 - bits.length % 16;
    for (let bit = 0; bit < alignment; bit++) bits.push(0);
    const codingBytes = bits.length / 8, packed = new Uint8Array(codingBytes + 18);
    const packedView = new DataView(packed.buffer);
    for (let bit = 0; bit < bits.length; bit++) {
      const offset = Math.floor(bit / 16) * 2;
      packedView.setUint16(offset, packedView.getUint16(offset, true) | bits[bit]! << (15 - (bit & 15)), true);
    }
    for (const offset of [0, 4, 8]) packedView.setUint32(codingBytes + offset, 1, true);
    packed.fill(65, codingBytes + 12, codingBytes + 17);
    const output = new Uint8Array(32768);
    decodeLzx(packed, output, () => {}, () => {});
    exact(output, new Uint8Array(32768).fill(65));
    for (const at of [codingBytes - 2, packed.length - 1]) {
      const bad = packed.slice();
      bad[at] = bad[at]! ^ 1;
      expect(() => decodeLzx(bad, new Uint8Array(32768), () => {}, () => {})).toThrow();
    }
  });

  it("checks caller authority after the complete E8 scan and before returning bytes", () => {
    const failure = new Error("caller stopped after final E8 work");
    expect(() =>
      decodeLzx(emptyTree(1), new Uint8Array(1000), (count) => {
        if (count === 0) throw failure;
      }, () => {})
    ).toThrow(failure);
  });

  it("rejects overlapping buffer aliases and checks raw repeated offsets only when used", () => {
    const packed = decodeBase64(raw.packed), backing = new Uint8Array(32768);
    backing.set(packed);
    expect(() => decodeLzx(backing.subarray(0, packed.length), backing, () => {}, () => {})).toThrow(
      "must not overlap",
    );
    exact(backing.subarray(0, packed.length), packed);
    const unused = packed.slice(), unusedView = new DataView(unused.buffer);
    unusedView.setUint32(8, 0xffffffff, true);
    unusedView.setUint32(12, 0xffffffff, true);
    const output = new Uint8Array(32768);
    decodeLzx(unused, output, () => {}, () => {});
    exact(output, new Uint8Array(32768).fill(65));
    const used = packed.slice();
    new DataView(used.buffer).setUint32(4, 0xffffffff, true);
    expect(() => decodeLzx(used, new Uint8Array(32768), () => {}, () => {})).toThrow("precedes this chunk");
  });
});

describe("LZX WIM public resource and image composition", () => {
  it("matches complete native resources, metadata and every independent 7-Zip file oracle", async () => {
    const archive = await openWim(source(decodeBase64(genuine.base64)), { subtle: crypto.subtle });
    expect(archive.profile).toBe("lzx-32k-1.13");
    for (const native of genuine.nativeResources) {
      const resource = archive.resources.find((resource) => resource.sha1 === native.sha1)!;
      expect(resource.size).toBe(native.decoded);
      expect(resource.storedSize).toBe(native.stored);
      expect(resource.compression).toBe(native.flags & 4 ? "lzx" : "stored");
      const result = await archive.read(resource.id);
      expect(result.bytes).toEqual(decodeBase64(native.body));
      expect(result.integrity).toBe("resource-sha1-verified");
    }
    for (const expected of genuine.images) {
      const image = await archive.image(expected.index);
      expect(image.metadataIntegrity).toBe("resource-sha1-verified");
      expect(image.lzxSteps).toBeGreaterThan(0);
      for (const file of expected.files) {
        const entry = image.entries.find((entry) => entry.path === file.path)!;
        const result = await image.read(entry.id);
        expect(result.bytes).toEqual(decodeBase64(file.base64));
        expect(result.integrity).toBe(entry.size ? "resource-sha1-verified" : "not-provided");
      }
    }
  });

  it("decodes only intersecting chunks for pending ranges and composes logical sources", async () => {
    const archive = await openWim(source(decodeBase64(genuine.base64)), { subtle: crypto.subtle });
    const native = genuine.nativeResources.find((resource) => resource.decoded === 200000)!;
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

  it("selects transformed E8 bytes and returns independent logical source buffers", async () => {
    const archive = await openWim(source(decodeBase64(genuine.base64)), { subtle: crypto.subtle });
    const file = genuine.images[0]!.files.find((file) => file.path === "calls.bin")!;
    const expected = decodeBase64(file.base64), resource = archive.resources.find((item) => item.sha1 === file.sha1)!;
    for (const offset of [5, 15, 100, 301, 32756, 32768 + 5, 65536 + 15]) {
      const result = await archive.read(resource.id, { offset, length: 5, verify: false });
      exact(result.bytes, expected.slice(offset, offset + 5));
      expect(result.integrity).toBe("pending");
      expect(result.lzxSteps).toBeGreaterThan(0);
      expect(result.xpressSteps).toBe(0);
    }
    const child = archive.source(resource.id, { offset: 5, length: 5 });
    const first = await child.read(0, 5);
    first.fill(0);
    exact(await child.read(0, 5), expected.slice(5, 10));
    await expect(child.read(6, 0)).rejects.toThrow();
  });

  it("rejects unsupported header codecs, chunk sizes, malformed offsets and corrupted selected tails", async () => {
    for (const [at, value] of [[16, 0x80082], [16, 0x60082], [20, 65536]] as const) {
      const bytes = decodeBase64(genuine.base64);
      new DataView(bytes.buffer).setUint32(at, value, true);
      await expect(openWim(source(bytes))).rejects.toMatchObject({ code: "unsupported-profile" });
    }
    const empty = decodeBase64(genuine.base64), emptyView = new DataView(empty.buffer);
    const table = Number(emptyView.getBigUint64(56, true));
    emptyView.setBigUint64(table + 16, 0n, true);
    await expect(openWim(source(empty))).rejects.toMatchObject({ code: "invalid-archive" });
    const native = genuine.nativeResources.find((resource) => resource.decoded === 200000)!;
    for (const value of [0, native.stored + 1]) {
      const bytes = decodeBase64(genuine.base64);
      new DataView(bytes.buffer).setUint32(native.offset, value, true);
      const archive = await openWim(source(bytes));
      const resource = archive.resources.find((resource) => resource.sha1 === native.sha1)!;
      await expect(archive.read(resource.id, { length: 3, verify: false })).rejects.toMatchObject({
        code: "invalid-archive",
      });
    }
    const bytes = decodeBase64(genuine.base64), first = native.chunks[0]!;
    bytes[native.offset + 24 + decodeBase64(first.packed).length - 1] = 1;
    const archive = await openWim(source(bytes));
    const resource = archive.resources.find((resource) => resource.sha1 === native.sha1)!;
    await expect(archive.read(resource.id, { length: 3, verify: false })).rejects.toMatchObject({
      code: "invalid-archive",
    });
  });

  it("admits full selected work before payload reads and preserves opening lifetime ledgers", async () => {
    const bytes = decodeBase64(genuine.base64),
      native = genuine.nativeResources.find((resource) => resource.decoded === 200000)!;
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
    const cpu = await openWim(source(bytes), { maxLzxSteps: 0 });
    await expect(cpu.read(resource.id, { length: 3, verify: false })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });

  it("distinguishes structural chunk admission from a requested whole-resource SHA1 check", async () => {
    const bytes = decodeBase64(genuine.base64), view = new DataView(bytes.buffer);
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
    const bytes = decodeBase64(genuine.base64), controller = new AbortController();
    const archive = await openWim(source(bytes), { signal: controller.signal });
    const resource = archive.resources.find((resource) => resource.compression === "lzx")!;
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

describe("LZX authored raw-block public composition", () => {
  it("matches all native-accepted adapted resources and original files", async () => {
    const archive = await openWim(source(decodeBase64(authored.base64)), { subtle: crypto.subtle });
    for (const native of authored.nativeResources) {
      const resource = archive.resources.find((item) => item.sha1 === native.sha1)!;
      exact((await archive.read(resource.id)).bytes, decodeBase64(native.body));
    }
    for (const expected of authored.images) {
      const image = await archive.image(expected.index);
      for (const file of expected.files) {
        const entry = image.entries.find((item) => item.path === file.path)!;
        exact((await image.read(entry.id)).bytes, decodeBase64(file.base64));
      }
    }
    const item = archive.resources.find((item) => item.size === 200000)!;
    expect((await archive.read(item.id, { length: 1, verify: false })).lzxBlocks).toBe(2);
    const limited = await openWim(source(decodeBase64(authored.base64)), { maxLzxBlocks: 1 });
    await expect(limited.read(item.id, { length: 1, verify: false })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    const genuineArchive = await openWim(source(decodeBase64(genuine.base64)), { maxLzxBlocks: 1 });
    const genuineItem = genuineArchive.resources.find((item) => item.size === 200000)!;
    await expect(genuineArchive.read(genuineItem.id, { offset: 32766, length: 5, verify: false })).rejects
      .toMatchObject({ code: "budget-exceeded" });
  });
});
