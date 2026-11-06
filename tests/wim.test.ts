import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createArchiveLedger, openWim } from "../src/archive/wim.ts";
import type { WimOpenOptionsType } from "../src/archive/wim.ts";
import fixture from "./fixtures/wim/independent.json" with { type: "json" };
const source = (bytes: Uint8Array): ByteSourceType => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const bytesOf = (): Uint8Array => decodeBase64(fixture.base64);
const open = (bytes: Uint8Array, options: WimOpenOptionsType = {}) =>
  openWim(source(bytes), { subtle: crypto.subtle, ...options });
const hash = async (bytes: Uint8Array): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
const viewOf = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
/** Edge fixtures mutate retained genuine bytes, with verification deliberately pending for malformed metadata tests. */
async function layout() {
  const bytes = bytesOf(), archive = await open(bytes);
  const metadata = archive.resources[archive.images[0]!.metadata]!;
  const view = viewOf(bytes), root = metadata.offset + Math.ceil(view.getUint32(metadata.offset, true) / 8) * 8;
  const first = metadata.offset + Number(view.getBigUint64(root + 16, true));
  return { bytes, view, archive, metadata, root, first };
}
describe("ordinary uncompressed WIM resource and image preview", () => {
  it("matches two genuine images and independent7-Zip full-byte oracles", async () => {
    const bytes = bytesOf();
    expect(await hash(bytes)).toBe(fixture.sha256);
    expect(fixture.producer).toContain("1.13.5");
    expect(fixture.consumer).toContain("26.02");
    expect(fixture.verify.exitCode).toBe(0);
    const archive = await open(bytes);
    expect(archive.images.map((image) => image.name)).toEqual(["Image1", "Image2"]);
    for (const image of fixture.images) {
      const tree = await archive.image(image.index);
      expect(tree.metadataIntegrity).toBe("resource-sha1-verified");
      for (const file of image.files) {
        const entry = tree.entries.find((entry) => entry.path === file.path)!;
        const read = await tree.read(entry.id);
        expect([...read.bytes]).toEqual([...decodeBase64(file.base64)]);
        expect(read.integrity).toBe(entry.size ? "resource-sha1-verified" : "not-provided");
        expect(fixture.consumers.find((receipt) => receipt.image === image.index && receipt.path === file.path)?.exact)
          .toBe(true);
      }
    }
  });
  it("shares deduplicated content without confusing filenames or image identity", async () => {
    const archive = await open(bytesOf()), first = await archive.image(1), second = await archive.image(2);
    const duplicate = first.entries.find((entry) => entry.path === "duplicate.bin")!;
    expect(first.entries.find((entry) => entry.path === "nested/data.bin")!.resource).toBe(duplicate.resource);
    expect(second.entries.find((entry) => entry.path === "shared.bin")!.resource).toBe(duplicate.resource);
    const one = first.entries.find((entry) => entry.path === "hello.txt")!,
      two = second.entries.find((entry) => entry.path === "hello.txt")!;
    expect(one.resource).not.toBe(two.resource);
    expect(first.entries.find((entry) => entry.path === "unicode/café.txt")!.size).toBe(22);
  });
  it("bounds selected stored range work and labels complete versus pending resource checks", async () => {
    const archive = await open(bytesOf()),
      tree = await archive.image(1),
      entry = tree.entries.find((entry) => entry.path === "duplicate.bin")!;
    const pending = await tree.read(entry.id, { offset: 250, length: 9, verify: false });
    expect([...pending.bytes]).toEqual([250, 251, 252, 253, 254, 255, 0, 1, 2]);
    expect(pending.integrity).toBe("pending");
    expect(pending.work.sourceBytes).toBe(9);
    const checked = await tree.read(entry.id, { offset: 250, length: 9 });
    expect(checked.integrity).toBe("resource-sha1-verified");
    expect(checked.work.sourceBytes).toBe(768);
    const empty = await tree.read(entry.id, { offset: entry.size, length: 0, verify: false });
    expect(empty.integrity).toBe("pending");
    expect(empty.work.sourceBytes).toBe(0);
  });
  it("provides exact physical resource sources with cumulative limits and captured snapshot descriptors", async () => {
    const bytes = bytesOf(),
      original = source(bytes),
      mutable = { ...original, identity: "first", read: original.read.bind(original) };
    const archive = await openWim(mutable, { subtle: crypto.subtle });
    mutable.identity = "changed";
    mutable.read = async () => {
      throw Error("mutated");
    };
    const tree = await archive.image(1), entry = tree.entries.find((entry) => entry.path === "hello.txt")!;
    const selected = tree.source(entry.id, { maxOutputBytes: 3 });
    expect(JSON.parse(selected.identity!)[0]).toBe("first");
    expect(new TextDecoder().decode(await selected.read(0, 3))).toBe("aut");
    await expect(selected.read(0, 1)).rejects.toThrow("outputBytes");
  });
  it("rejects header, compression, split, solid and writing variants before table IO", async () => {
    for (const [field, value] of [[8, 209], [12, 0xe00], [16, 2], [16, 64], [20, 32768]]) {
      const bytes = bytesOf();
      viewOf(bytes).setUint32(field!, value!, true);
      await expect(open(bytes)).rejects.toThrow("supported");
    }
    const bytes = bytesOf();
    viewOf(bytes).setUint16(42, 2, true);
    await expect(open(bytes)).rejects.toThrow("Split");
    bytes[0] = 0;
    await expect(open(bytes)).rejects.toThrow("signature");
  });
  it("checks table lengths, exact integer extents, resource flags and image count", async () => {
    const bytes = bytesOf(), view = viewOf(bytes), table = Number(view.getBigUint64(56, true));
    const badTable = bytes.slice();
    viewOf(badTable).setBigUint64(48, view.getBigUint64(48, true) + 1n, true);
    await expect(open(badTable)).rejects.toThrow();
    const overflow = bytes.slice();
    viewOf(overflow).setBigUint64(56, 2n ** 60n, true);
    await expect(open(overflow)).rejects.toThrow("exact JavaScript");
    const flags = bytes.slice();
    flags[table + 7] = 4;
    await expect(open(flags)).rejects.toMatchObject({ code: "unsupported-profile" });
    const count = bytes.slice();
    viewOf(count).setUint32(44, 3, true);
    await expect(open(count)).rejects.toThrow("image count");
    const boot = bytes.slice();
    viewOf(boot).setUint32(120, 1, true);
    await expect(open(boot)).rejects.toThrow("boot metadata");
  });
  it("refuses duplicate data hashes and wrong-part resource references", async () => {
    const bytes = bytesOf(), view = viewOf(bytes), table = Number(view.getBigUint64(56, true));
    const archive = await open(bytes), resources = archive.resources.filter((entry) => entry.kind === "data");
    const first = table + resources[0]!.id * 50, second = table + resources[1]!.id * 50;
    const duplicate = bytes.slice();
    duplicate.set(bytes.subarray(first + 30, first + 50), second + 30);
    await expect(open(duplicate)).rejects.toThrow("duplicate WIM data hash");
    view.setUint16(first + 24, 2, true);
    await expect(open(bytes)).rejects.toThrow("another part");
  });
  it("preflights resource and image metadata policies with distinct root/index accounting", async () => {
    await expect(open(bytesOf(), { maxResources: 0 })).rejects.toThrow("resources");
    await expect(open(bytesOf(), { maxResourceIndexBytes: 1 })).rejects.toThrow("index bytes");
    await expect(open(bytesOf(), { maxXmlBytes: 0 })).rejects.toThrow("XML bytes");
    const archive = await open(bytesOf());
    await expect(archive.image(1, { maxMetadataBytes: 0 })).rejects.toThrow("image metadata bytes");
    await expect(archive.image(1, { maxIndexBytes: 0 })).rejects.toThrow("retained index");
    await expect(archive.image(1, { maxEntries: 1 })).rejects.toThrow("entries");
    await expect(archive.image(1, { maxDepth: 0 })).rejects.toThrow("directory depth");
    await expect(archive.image(1, { maxNameBytes: 2 })).rejects.toThrow("name bytes");
    await expect(archive.image(1, { maxPathLength: 2 })).rejects.toThrow("path length");
  });
  it("validates security block extents and references without repairing metadata", async () => {
    const item = await layout();
    item.view.setUint32(item.metadata.offset, 0xfffffff8, true);
    await expect((await open(item.bytes)).image(1, { verify: false })).rejects.toThrow();
    const second = await layout();
    second.view.setUint32(second.first + 12, 99, true);
    await expect((await open(second.bytes)).image(1, { verify: false })).rejects.toThrow("security descriptor index");
  });
  it("rejects cyclic/overlapping directory lists and malformed aligned dentry lengths", async () => {
    const item = await layout();
    item.view.setBigUint64(item.root + 16, BigInt(item.root - item.metadata.offset), true);
    await expect((await open(item.bytes)).image(1, { verify: false })).rejects.toThrow("overlap or form a cycle");
    const bad = await layout();
    bad.view.setBigUint64(bad.first, 103n, true);
    await expect((await open(bad.bytes)).image(1, { verify: false })).rejects.toThrow("length");
  });
  it("checks UTF16 names, terminators and exact paths before following child directories", async () => {
    const item = await layout();
    item.view.setUint16(item.first + 100, 3, true);
    await expect((await open(item.bytes)).image(1, { verify: false })).rejects.toThrow("UTF16");
    const nul = await layout();
    const length = nul.view.getUint16(nul.first + 100, true);
    nul.view.setUint16(nul.first + 102 + length, 1, true);
    await expect((await open(nul.bytes)).image(1, { verify: false })).rejects.toThrow("terminator");
    const slash = await layout();
    slash.view.setUint16(slash.first + 102, 47, true);
    await expect((await open(slash.bytes)).image(1, { verify: false })).rejects.toThrow("path component");
  });
  it("keeps reparse and encrypted entry metadata visible while refusing ordinary file reads", async () => {
    for (const flag of [0x400, 0x4000]) {
      const item = await layout();
      item.view.setUint32(item.first + 8, flag, true);
      const tree = await (await open(item.bytes)).image(1, { verify: false });
      await expect(tree.read(1)).rejects.toThrow("ordinary WIM files");
      expect(() => tree.source(1)).toThrow("ordinary WIM files");
    }
  });
  it("retains bounded extra streams but refuses implicit default-file interpretation", async () => {
    const item = await layout();
    item.view.setUint16(item.first + 96, 1, true);
    // The following native sibling has a zeroed stream hash/name prefix and a valid aligned length.
    const tree = await (await open(item.bytes)).image(1, { verify: false });
    expect(tree.entries[1]!.streams).toEqual([{ name: "", sha1: "0".repeat(40) }]);
    await expect(tree.read(1)).rejects.toThrow("without extra streams");
    expect(() => tree.source(1)).toThrow("without extra streams");
    await expect((await open(item.bytes)).image(1, { verify: false, maxStreams: 0 })).rejects.toThrow("extra streams");
  });
  it("rejects duplicate exact paths without normalizing case or silently discarding entries", async () => {
    const item = await layout(), next = item.first + Number(item.view.getBigUint64(item.first, true));
    for (const at of [item.first, next]) {
      item.view.setUint16(at + 100, 8, true);
      for (let index = 0; index < 4; index++) item.view.setUint16(at + 102 + index * 2, "same".charCodeAt(index), true);
      item.view.setUint16(at + 110, 0, true);
    }
    await expect((await open(item.bytes)).image(1, { verify: false })).rejects.toThrow("Duplicate WIM exact");
  });
  it("refuses XML authority ambiguity and declarations without external resolution", async () => {
    const original = bytesOf(),
      header = viewOf(original),
      xmlOffset = Number(header.getBigUint64(80, true)),
      xmlSize = Number(header.getBigUint64(88, true));
    const xml = new TextDecoder("utf-16le").decode(original.subarray(xmlOffset, xmlOffset + xmlSize));
    for (
      const changed of [
        xml.replace('INDEX="2"', 'INDEX="1"'),
        xml.replace("<WIM>", '<WIM xmlns="urn:alien">'),
        xml.replace("<WIM>", "<!DOCTYPE WIM><WIM>"),
      ]
    ) {
      const encoded = new Uint8Array(changed.length * 2);
      const words = viewOf(encoded);
      for (let at = 0; at < changed.length; at++) words.setUint16(at * 2, changed.charCodeAt(at), true);
      const bytes = new Uint8Array(original.length + encoded.length);
      bytes.set(original);
      bytes.set(encoded, original.length);
      const view = viewOf(bytes);
      view.setBigUint64(72, (2n << 56n) | BigInt(encoded.length), true);
      view.setBigUint64(80, BigInt(original.length), true);
      view.setBigUint64(88, BigInt(encoded.length), true);
      await expect(open(bytes)).rejects.toThrow();
    }
  });
  it("distinguishes explicit crypto capability, bounded complete verification and selected corruption", async () => {
    const archive = await openWim(source(bytesOf()));
    await expect(archive.image(1)).rejects.toThrow("caller-supplied SubtleCrypto");
    expect((await archive.image(1, { verify: false })).metadataIntegrity).toBe("pending");
    const limited = await open(bytesOf(), { maxVerifyBytes: 1 });
    await expect(limited.image(1)).rejects.toThrow("verification bytes");
    const bytes = bytesOf(),
      good = await open(bytes),
      tree = await good.image(1),
      entry = tree.entries.find((entry) => entry.path === "hello.txt")!;
    const corruptedOffset = good.resources[entry.resource!]!.offset;
    bytes[corruptedOffset] = bytes[corruptedOffset]! ^ 1;
    await expect((await (await open(bytes)).image(1)).read(entry.id)).rejects.toThrow("SHA1 mismatch");
  });
  it("preserves independent aggregate and per-image budgets across subsequent reads", async () => {
    const archive = await open(bytesOf()),
      ledger = createArchiveLedger({ maxOutputBytes: 2 }),
      tree = await archive.image(1),
      entry = tree.entries.find((entry) => entry.path === "hello.txt")!;
    await tree.read(entry.id, { length: 2, verify: false, ledger });
    await expect(tree.read(entry.id, { length: 1, verify: false, ledger })).rejects.toThrow("outputBytes");
    const bounded = await archive.image(1, { maxOutputBytes: 2 });
    expect(bounded.work.outputBytes).toBe(0);
    const id = bounded.entries.find((entry) => entry.path === "hello.txt")!.id;
    await bounded.read(id, { length: 2, verify: false });
    await expect(bounded.read(id, { length: 1, verify: false })).rejects.toThrow("outputBytes");
  });
  it("retains parent cancellation through asynchronous digest completion and binds crypto before source IO", async () => {
    const controller = new AbortController(),
      stop = Error("digest stopped archive"),
      digest = crypto.subtle.digest.bind(crypto.subtle);
    const capability = {
      digest: async (algorithm: AlgorithmIdentifier, bytes: BufferSource): Promise<ArrayBuffer> => {
        const result = await digest(algorithm, bytes);
        controller.abort(stop);
        return result;
      },
    } as SubtleCrypto;
    const original = source(bytesOf());
    const archive = await openWim({
      ...original,
      read: async (offset, length, options) => {
        capability.digest = async () => {
          throw Error("mutated crypto");
        };
        return await original.read(offset, length, options);
      },
    }, { subtle: capability, signal: controller.signal });
    const resource = archive.resources.find((entry) => entry.kind === "data")!;
    await expect(archive.read(resource.id, { signal: new AbortController().signal, length: 1 })).rejects.toBe(stop);
  });
  it("propagates captured and per-read aborts and rejects spoofed source byte lengths", async () => {
    const signal = new AbortController(),
      archive = await open(bytesOf(), { signal: signal.signal }),
      tree = await archive.image(1),
      entry = tree.entries.find((entry) => entry.path === "hello.txt")!;
    const member = tree.source(entry.id);
    signal.abort(Error("stop"));
    await expect(member.read(0, 1, { signal: new AbortController().signal })).rejects.toThrow("stop");
    const resource = archive.resources.find((resource) => resource.kind === "data")!;
    await expect(archive.read(resource.id, { signal: new AbortController().signal, length: 1 })).rejects.toThrow(
      "stop",
    );
    await expect(tree.read(entry.id, { signal: new AbortController().signal, length: 1 })).rejects.toThrow("stop");
    const imageAbort = new AbortController(), independent = await open(bytesOf());
    const image = await independent.image(1, { signal: imageAbort.signal });
    const empty = image.entries.find((entry) => entry.path === "empty")!;
    imageAbort.abort(Error("image stop"));
    await expect(image.read(empty.id, { signal: new AbortController().signal })).rejects.toThrow("image stop");
    const regular = image.entries.find((entry) => entry.path === "hello.txt")!;
    await expect(image.read(regular.id, { signal: new AbortController().signal })).rejects.toThrow("image stop");
    expect(() => image.source(regular.id, { signal: new AbortController().signal })).toThrow("image stop");
    expect(() => image.source(empty.id)).toThrow("image stop");
    const spoof = new Uint8Array(1);
    Object.defineProperty(spoof, "byteLength", { value: 208 });
    await expect(openWim({ size: 1000, stability: "caller", read: async () => spoof })).rejects.toThrow(
      "incomplete extent",
    );
    await expect(openWim({ size: 1000, read: async () => new Uint8Array() })).rejects.toThrow("stable source");
  });
});
