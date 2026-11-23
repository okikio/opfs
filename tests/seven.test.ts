import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { createArchiveLedger, openSeven } from "../src/archive/seven.ts";
import fixtures from "./fixtures/seven/independent.json" with { type: "json" };

const source = (bytes: Uint8Array) => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const original = decodeBase64(fixtures.copy.archive);
/** Independent bitwise reference CRC for repairing headers in malformed-format tests. */
function crc(bytes: Uint8Array): number {
  let state = 0xffffffff;
  for (const byte of bytes) {
    state ^= byte;
    for (let bit = 0; bit < 8; bit++) state = state >>> 1 ^ ((state & 1) ? 0xedb88320 : 0);
  }
  return (state ^ 0xffffffff) >>> 0;
}
function repair(bytes: Uint8Array): void {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = 32 + Number(data.getBigUint64(12, true));
  data.setUint32(28, crc(bytes.subarray(at)), true);
  data.setUint32(8, crc(bytes.subarray(12, 32)), true);
}

/** Original small wire fixtures isolate graph and CRC scopes without relying on parser serialization. */
function wire(header: number[], payload = new Uint8Array([42])): Uint8Array {
  const bytes = new Uint8Array(32 + payload.length + header.length);
  bytes.set([55, 122, 188, 175, 39, 28, 0, 4]);
  bytes.set(payload, 32);
  bytes.set(header, 32 + payload.length);
  const data = new DataView(bytes.buffer);
  data.setBigUint64(12, BigInt(payload.length), true);
  data.setBigUint64(20, BigInt(header.length), true);
  repair(bytes);
  return bytes;
}
const file = [5, 1, 17, 5, 0, 120, 0, 0, 0, 0, 0]; // Inline UTF-16LE "x", FilesInfo end, Header end.
const word = (value: number): number[] => [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24];

describe("bounded 7z inspection", () => {
  for (const profile of ["copy", "lzma2", "solid", "encrypted"] as const) {
    it(`indexes genuine 7-Zip ${profile} without reading packed bodies`, async () => {
      const fixture = fixtures[profile];
      const bytes = decodeBase64(fixture.archive);
      const calls: { offset: number; length: number }[] = [];
      const archive = await openSeven({
        size: bytes.length,
        stability: "immutable",
        async read(offset, length) {
          calls.push({ offset, length });
          return bytes.slice(offset, offset + length);
        },
      });
      const indexCalls = calls.slice();
      expect(archive.entries.length).toBe(fixture.entries.length);
      for (const expected of fixture.entries) {
        const entry = archive.entries.find((entry) => entry.name === expected.name)!;
        expect(entry).toBeDefined();
        expect(entry.kind).toBe(expected.kind);
        expect(entry.size).toBe(decodeBase64(expected.body).length);
        if (profile === "copy" && entry.kind === "file") {
          expect((await archive.read(entry.id)).bytes).toEqual(decodeBase64(expected.body));
        } else if (entry.size > 0) {
          expect(entry.readable).toBe(false);
          await expect(archive.read(entry.id)).rejects.toMatchObject({ code: "unsupported-profile" });
        }
      }
      for (const pack of archive.packs) {
        expect(
          indexCalls.some((call) => call.offset < pack.offset + pack.size && call.offset + call.length > pack.offset),
        )
          .toBe(false);
      }
      if (profile === "solid") expect(archive.folders.some((folder) => folder.solid)).toBe(true);
      if (profile === "encrypted") expect(archive.folders.every((folder) => folder.encrypted)).toBe(true);
    });
  }
  it("preserves independent producer hashes and full independent consumer proof", async () => {
    for (const [profile, fixture] of Object.entries(fixtures)) {
      const digest = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new Uint8Array(decodeBase64(fixture.archive)).buffer),
      );
      expect(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(fixture.sha256);
      expect(fixture.independentPayloadVerified).toBe(!profile.startsWith("encrypted"));
    }
  });
  for (const profile of ["encoded", "encrypted-header"] as const) {
    it(`refuses ${profile} names after checking next-header CRC`, async () => {
      const bytes = decodeBase64(fixtures[profile].archive);
      await expect(openSeven(source(bytes))).rejects.toMatchObject({ code: "unsupported-profile" });
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      await expect(openSeven(source(bytes))).rejects.toMatchObject({ code: "checksum-mismatch" });
    });
  }
  it("checks the whole selected COPY file while returning only the requested range", async () => {
    const archive = await openSeven(source(original));
    const entry = archive.entries.find((entry) => entry.name === "large.bin")!;
    const full = decodeBase64(
      fixtures.copy.entries.find((entry) => entry.name === "large.bin")!.body,
    );
    const checked = await archive.read(entry.id, { offset: 100000, length: 13 });
    expect(checked.bytes).toEqual(full.slice(100000, 100013));
    expect(checked.integrity).toBe("crc32-verified");
    expect(checked.work.sourceBytes).toBe(entry.size);
    const partial = await archive.read(entry.id, { offset: 100000, length: 13, verify: false });
    expect(partial.bytes).toEqual(checked.bytes);
    expect(partial.work.sourceBytes).toBe(13);
    expect(partial.integrity).toBe("pending");
    const bytes = original.slice();
    const corruptAt = archive.packs[archive.folders[entry.folderId!]!.packId]!.offset + 5;
    bytes[corruptAt] = bytes[corruptAt]! ^ 1;
    const corrupt = await openSeven(source(bytes));
    await expect(corrupt.read(entry.id, { offset: 100000, length: 13 })).rejects.toMatchObject({
      code: "checksum-mismatch",
    });
  });
  it("refuses truncation, trailing bytes, signature and header corruption", async () => {
    for (const bytes of [original.slice(0, 20), original.slice(0, -1), new Uint8Array([...original, 0])]) {
      await expect(openSeven(source(bytes))).rejects.toThrow();
    }
    for (const at of [0, 12, original.length - 1]) {
      const bytes = original.slice();
      bytes[at] = bytes[at]! ^ 1;
      await expect(openSeven(source(bytes))).rejects.toThrow();
    }
    const bytes = original.slice();
    new DataView(bytes.buffer).setBigUint64(12, 1n << 63n, true);
    new DataView(bytes.buffer).setUint32(8, crc(bytes.subarray(12, 32)), true);
    await expect(openSeven(source(bytes))).rejects.toMatchObject({ code: "unsupported-profile" });
  });
  it("preflights metadata and selected-work limits and aggregate accounting", async () => {
    for (
      const options of [
        { maxHeaderBytes: 32 },
        { maxEntries: 1 },
        { maxFolders: 0 },
        { maxCoders: 0 },
        { maxStreams: 0 },
        { maxProperties: 0 },
        { maxNameBytes: 2 },
        { maxRequests: 1 },
      ]
    ) await expect(openSeven(source(original), options)).rejects.toMatchObject({ code: "budget-exceeded" });
    const archive = await openSeven(source(original));
    const entry = archive.entries.find((entry) => entry.name === "large.bin")!;
    for (const options of [{ maxSourceBytes: 1 }, { maxDecodedBytes: 1 }, { maxOutputBytes: 0 }, { maxRequests: 1 }]) {
      await expect(archive.read(entry.id, { length: 1, ...options })).rejects.toMatchObject({
        code: "budget-exceeded",
      });
    }
    const ledger = createArchiveLedger({ maxOutputBytes: 2 });
    await archive.read(entry.id, { length: 2, verify: false, ledger });
    await expect(archive.read(entry.id, { length: 1, verify: false, ledger })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });
  it("requires declared source stability and observes cancellation without body I/O", async () => {
    let calls = 0;
    const custom = {
      size: original.length,
      async read(offset: number, length: number) {
        calls++;
        return original.slice(offset, offset + length);
      },
    };
    await expect(openSeven(custom)).rejects.toMatchObject({ code: "unsupported-profile" });
    expect(calls).toBe(0);
    const archive = await openSeven(custom, { allowUnverifiedSource: true });
    expect(archive.source.stability).toBe("unverified");
    const control = new AbortController();
    control.abort(new Error("stop"));
    const before = calls;
    await expect(archive.read(archive.entries.find((entry) => entry.size > 0)!.id, { signal: control.signal })).rejects
      .toThrow("stop");
    expect(calls).toBe(before);
  });
  it("distinguishes absent, pack, folder and substream CRC scopes", async () => {
    const digest = word(crc(new Uint8Array([42])));
    for (const scope of ["none", "pack", "folder", "substream"] as const) {
      const header = [
        1,
        4,
        6,
        0,
        1,
        9,
        1,
        ...(scope === "pack" ? [10, 1, ...digest] : []),
        0,
        7,
        11,
        1,
        0,
        1,
        1,
        0,
        12,
        1,
        ...(scope === "folder" ? [10, 1, ...digest] : []),
        0,
        ...(scope === "substream" ? [8, 10, 1, ...digest, 0] : []),
        0,
        ...file,
      ];
      const archive = await openSeven(source(wire(header)));
      const result = await archive.read(0);
      expect(result.bytes).toEqual(new Uint8Array([42]));
      expect(result.integrity).toBe(scope === "none" ? "none" : "crc32-verified");
      expect(result.checks.map((check) => check.scope)).toEqual(scope === "none" ? [] : [scope]);
      if (scope === "folder") expect(archive.entries[0]!.crcSource).toBe("folder");
    }
  });
  it("rejects disconnected, cyclic, repeated and out-of-range graph bindings", async () => {
    for (const bindings of [[0, 0, 1, 1], [0, 1, 1, 0], [0, 1, 0, 2], [3, 0, 1, 2]]) {
      const header = [
        1,
        4,
        6,
        0,
        1,
        9,
        1,
        0,
        7,
        11,
        1,
        0,
        3,
        1,
        0,
        1,
        0,
        1,
        0,
        ...bindings,
        12,
        1,
        1,
        1,
        0,
        0,
        ...file,
      ];
      await expect(openSeven(source(wire(header)))).rejects.toMatchObject({ code: "invalid-archive" });
    }
    const complex = [1, 4, 6, 0, 1, 9, 1, 0, 7, 11, 1, 0, 1, 0x11, 0, 2, 1];
    await expect(openSeven(source(wire(complex)))).rejects.toMatchObject({ code: "unsupported-profile" });
    const huge = [1, 4, 6, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    await expect(openSeven(source(wire(huge)))).rejects.toMatchObject({ code: "unsupported-profile" });
  });
  it("bounds file properties and names and preserves empty-file versus directory semantics", async () => {
    const emptyHeader = (
      name: number[],
      extra: number[] = [],
    ) => [1, 5, 1, 14, 1, 128, 15, 1, 128, ...extra, 17, name.length, ...name, 0, 0];
    const empty = await openSeven(source(wire(emptyHeader([0, 120, 0, 0, 0]), new Uint8Array())));
    expect(empty.entries[0]!.kind).toBe("file");
    expect((await empty.read(0)).bytes.length).toBe(0);
    expect((await empty.read(0)).integrity).toBe("none");
    const directoryHeader = [1, 5, 1, 14, 1, 128, 17, 5, 0, 120, 0, 0, 0, 0, 0];
    const directory = await openSeven(source(wire(directoryHeader, new Uint8Array())));
    expect(directory.entries[0]!.kind).toBe("directory");
    await expect(directory.read(0)).rejects.toMatchObject({ code: "unsupported-profile" });
    for (
      const header of [
        emptyHeader([0, 0, 216, 0, 0]),
        emptyHeader([0, 120, 0]),
        emptyHeader([1, 120, 0, 0, 0]),
        emptyHeader([0, 120, 0, 0, 0], [14, 1, 128]),
        emptyHeader([0, 120, 0, 0, 0], [25, 1, 1]),
      ]
    ) {
      await expect(openSeven(source(wire(header, new Uint8Array())))).rejects.toThrow();
    }
    const overrun = [1, 4, 6, 0, 1, 9, 2, 0, 7, 11, 1, 0, 1, 1, 0, 12, 2, 0, 0, ...file];
    await expect(openSeven(source(wire(overrun)))).rejects.toMatchObject({ code: "invalid-archive" });
  });
  it("refuses CRC-repaired unsupported file properties", async () => {
    const bytes = original.slice();
    const at = 32 + Number(new DataView(bytes.buffer).getBigUint64(12, true));
    // Replace the mandatory top-level Header marker, leaving a valid CRC envelope.
    bytes[at] = 3;
    repair(bytes);
    await expect(openSeven(source(bytes))).rejects.toMatchObject({ code: "unsupported-profile" });
  });
});
