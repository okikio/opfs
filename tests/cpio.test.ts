import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createArchiveLedger, openCpio } from "../src/archive/cpio.ts";
import fixtures from "./fixtures/cpio/independent.json" with { type: "json" };
import gnu from "./fixtures/cpio/gnu.json" with { type: "json" };

function source(bytes: Uint8Array): ByteSourceType {
  return createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
}

/** Independent fixture navigation for targeted corruptions, not a candidate serializer. */
function records(bytes: Uint8Array): { at: number; name: string; body: number; size: number }[] {
  const result = [];
  let at = 0;
  const text = new TextDecoder();
  while (at + 110 <= bytes.length) {
    const size = parseInt(text.decode(bytes.subarray(at + 54, at + 62)), 16);
    const nameSize = parseInt(text.decode(bytes.subarray(at + 94, at + 102)), 16);
    const name = text.decode(bytes.subarray(at + 110, at + 110 + nameSize - 1));
    const body = Math.ceil((at + 110 + nameSize) / 4) * 4;
    result.push({ at, name, body, size });
    if (name === "TRAILER!!!") break;
    at = Math.ceil((body + size) / 4) * 4;
  }
  return result;
}

function field(bytes: Uint8Array, at: number, offset: number, value: number): void {
  bytes.set(new TextEncoder().encode(value.toString(16).padStart(8, "0")), at + offset);
}

/** Adversarial CRC adaptation only; genuine producer interoperability is tested separately. */
function crcMutation(input: Uint8Array): Uint8Array {
  const bytes = input.slice();
  for (const record of records(bytes)) {
    bytes[record.at + 5] = 50;
    let sum = 0;
    for (const byte of bytes.subarray(record.body, record.body + record.size)) sum = (sum + byte) >>> 0;
    field(bytes, record.at, 102, sum);
  }
  return bytes;
}

const bytes = decodeBase64(fixtures.newc.archive);

describe("bounded CPIO inspection", () => {
  for (const profile of ["newc", "crc"] as const) {
    it(`reads every GNU cpio ${profile} payload and resolves its last-data hard links`, async () => {
      const fixture = gnu[profile];
      const input = decodeBase64(fixture.archive);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(input).buffer));
      expect(Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("")).toBe(fixture.sha256);
      const archive = await openCpio(source(input));
      expect(archive.entries.map(({ name, kind }) => ({ name, kind }))).toEqual(
        fixture.entries.map(({ name, kind }) => ({ name, kind })),
      );
      for (const entry of archive.entries) {
        if (entry.kind !== "file") continue;
        const result = await archive.read(entry.id);
        expect(result.bytes).toEqual(decodeBase64(fixture.entries[entry.id]!.body));
        expect(result.integrity).toBe(profile === "crc" ? "byte-sum-verified" : "none");
      }
      const first = archive.entries.find((entry) => entry.name === "alias-first")!;
      const last = archive.entries.find((entry) => entry.name === "alias-last")!;
      expect(first.storedSize).toBe(0);
      expect(last.storedSize).toBe(first.size);
      expect(first.dataEntryId).toBe(last.id);
      if (profile === "crc") {
        // Alias headers have no content authentication: the reported sum scope belongs to dataEntryId only.
        const aliasChecksum = input.slice();
        field(aliasChecksum, records(input)[first.id]!.at, 102, 123);
        const changed = await openCpio(source(aliasChecksum));
        expect((await changed.read(first.id, { length: 3 })).integrity).toBe("byte-sum-verified");
        const ownerDamage = input.slice();
        const owner = records(input)[last.id]!;
        ownerDamage[owner.body + owner.size - 1] = ownerDamage[owner.body + owner.size - 1]! ^ 1;
        await expect((await openCpio(source(ownerDamage))).read(first.id, { length: 3 })).rejects.toMatchObject({
          code: "checksum-mismatch",
        });
      }
    });
  }
  it("indexes independent bsdcpio newc and reads complete input payloads, including hard-link aliases", async () => {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
    expect(Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("")).toBe(fixtures.newc.sha256);
    const archive = await openCpio(source(bytes));
    expect(archive.entries.map(({ name, kind }) => ({ name, kind }))).toEqual(
      fixtures.newc.entries.map(({ name, kind }) => ({ name, kind })),
    );
    for (const entry of archive.entries) {
      const expected = fixtures.newc.entries[entry.id]!;
      if (entry.kind !== "file") {
        await expect(archive.read(entry.id)).rejects.toMatchObject({ code: "unsupported-profile" });
        continue;
      }
      const result = await archive.read(entry.id);
      expect(result.bytes).toEqual(decodeBase64(expected.body));
      expect(result.integrity).toBe("none");
      expect(Object.isFrozen(entry)).toBe(true);
    }
    const links = archive.entries.filter((entry) => entry.name.startsWith("alias-"));
    expect(links[0]!.size).toBe(links[1]!.size);
    expect(links[0]!.dataEntryId).toBe(links[1]!.dataEntryId);
    expect(links.reduce((sum, entry) => sum + entry.storedSize, 0)).toBe(links[0]!.size);
    expect(Object.isFrozen(archive.entries)).toBe(true);
  });

  it("skips unrelated payloads during indexing and exact unverified member reads", async () => {
    const calls: { offset: number; length: number }[] = [];
    const archive = await openCpio({
      size: bytes.length,
      stability: "immutable",
      async read(offset, length) {
        calls.push({ offset, length });
        return bytes.slice(offset, offset + length);
      },
    });
    const large = records(bytes).find((entry) => entry.name === "large.bin")!;
    expect(calls.some(({ offset, length }) => offset < large.body + large.size && offset + length > large.body)).toBe(
      false,
    );
    expect(archive.work.sourceBytes).toBeLessThan(4096);
    calls.length = 0;
    const file = archive.entries.find((entry) => entry.name === "folder/data.bin")!;
    const result = await archive.read(file.id, {
      offset: 10,
      length: 7,
      maxSourceBytes: 7,
      maxDecodedBytes: 7,
      maxOutputBytes: 7,
    });
    expect(result.bytes).toEqual(decodeBase64(fixtures.newc.entries[file.id]!.body).subarray(10, 17));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.length).toBe(7);
  });

  it("verifies complete CRC owner payload while returning a bounded range, or reports pending explicitly", async () => {
    const crc = crcMutation(bytes);
    const archive = await openCpio(source(crc));
    const alias = archive.entries.find((entry) => entry.name === "alias-first")!;
    const result = await archive.read(alias.id, { offset: 2, length: 3, maxOutputBytes: 3 });
    expect(result.integrity).toBe("byte-sum-verified");
    expect(result.work.sourceBytes).toBe(alias.size);
    expect(result.work.outputBytes).toBe(3);
    expect(result.bytes).toEqual(new Uint8Array([2, 3, 4]));
    expect((await archive.read(alias.id, { length: 3, verify: false, maxSourceBytes: 3 })).integrity).toBe("pending");
    await expect(archive.read(alias.id, { length: 1, maxDecodedBytes: 1 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    const owner = records(crc)[alias.dataEntryId!]!;
    crc[owner.body + owner.size - 1] = crc[owner.body + owner.size - 1]! ^ 1;
    const damaged = await openCpio(source(crc));
    await expect(damaged.read(alias.id, { length: 1 })).rejects.toMatchObject({ code: "checksum-mismatch" });
    expect((await damaged.read(alias.id, { length: 1, verify: false })).bytes).toEqual(new Uint8Array([0]));
  });

  it("bounds names, metadata, entry count, source work and aggregate open/read work before payload allocation", async () => {
    for (
      const options of [
        { maxNameBytes: 2 },
        { maxMetadataBytes: 5 },
        { maxEntries: 1 },
        { maxSourceBytes: 109 },
        { maxRequests: 0 },
        { maxDecodedBytes: 109 },
      ]
    ) await expect(openCpio(source(bytes), options)).rejects.toMatchObject({ code: "budget-exceeded" });
    const archive = await openCpio(source(bytes));
    const file = archive.entries.find((entry) => entry.name === "folder/data.bin")!;
    const ledger = createArchiveLedger({ maxOutputBytes: 3 });
    await archive.read(file.id, { length: 2, ledger });
    await expect(archive.read(file.id, { length: 2, ledger })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(archive.read(file.id, { length: 1, maxOutputBytes: 0 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });

  it("requires stable source evidence and observes cancellation before source reads and empty member output", async () => {
    let calls = 0;
    const borrowed = {
      size: bytes.length,
      async read(offset: number, length: number) {
        calls++;
        return bytes.slice(offset, offset + length);
      },
    };
    await expect(openCpio(borrowed)).rejects.toMatchObject({ code: "unsupported-profile" });
    expect(calls).toBe(0);
    const archive = await openCpio(borrowed, { allowUnverifiedSource: true });
    expect(archive.source.stability).toBe("unverified");
    const controller = new AbortController();
    const reason = new Error("cancel preview");
    controller.abort(reason);
    const previous = calls;
    await expect(openCpio(borrowed, { allowUnverifiedSource: true, signal: controller.signal })).rejects.toBe(reason);
    await expect(
      archive.read(archive.entries.find((entry) => entry.name === "empty")!.id, { signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(calls).toBe(previous);
  });

  it("rejects corrupt fixed fields, missing terminators, nonzero padding, truncation and concatenation", async () => {
    const list = records(bytes);
    const file = list.find((entry) => entry.name === "folder/data.bin")!;
    const trailer = list.at(-1)!;
    const numeric = bytes.slice();
    numeric[6] = 71;
    const name = bytes.slice();
    name[110 + 6] = 65;
    const padding = bytes.slice();
    padding[117] = 1;
    const trailerData = bytes.slice();
    field(trailerData, trailer.at, 54, 1);
    const tail = bytes.slice();
    tail[tail.length - 1] = 1;
    const concatenated = new Uint8Array(bytes.length * 2);
    concatenated.set(bytes);
    concatenated.set(bytes, bytes.length);
    for (
      const bad of [
        numeric,
        name,
        padding,
        trailerData,
        tail,
        concatenated,
        bytes.subarray(0, 109),
        bytes.subarray(0, file.body + file.size - 1),
        bytes.subarray(0, trailer.at),
      ]
    ) {
      await expect(openCpio(source(bad))).rejects.toBeInstanceOf(Error);
    }
  });

  it("refuses conflicting hard-link metadata and multiple data-bearing copies instead of choosing a payload", async () => {
    const links = records(bytes).filter((entry) => entry.name.startsWith("alias-"));
    const metadata = bytes.slice();
    field(metadata, links[1]!.at, 38, 3);
    await expect(openCpio(source(metadata))).rejects.toMatchObject({ code: "unsupported-profile" });
    // Give another independent nonempty file the alias inode/device identity, retaining its own valid extent.
    const duplicate = bytes.slice();
    const file = records(bytes).find((entry) => entry.name === "folder/data.bin")!;
    for (const offset of [6, 38, 62, 70]) {
      duplicate.set(bytes.subarray(links[0]!.at + offset, links[0]!.at + offset + 8), file.at + offset);
    }
    await expect(openCpio(source(duplicate))).rejects.toMatchObject({ code: "unsupported-profile" });
  });

  it("preserves duplicate names and accepts extra terminal name NULs without normalizing raw identities", async () => {
    const duplicate = bytes.slice();
    // The seven-byte first name field can encode empty plus two NULs without changing any extent.
    duplicate.set(new TextEncoder().encode("empty\0\0"), 110);
    const archive = await openCpio(source(duplicate));
    const entries = archive.entries.filter((entry) => entry.name === "empty");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.id).not.toBe(entries[1]!.id);
    expect(entries.map((entry) => entry.kind)).toEqual(["directory", "file"]);
    const invalidUtf8 = bytes.slice();
    invalidUtf8[110] = 255;
    await expect(openCpio(source(invalidUtf8))).rejects.toMatchObject({ code: "unsupported-profile" });
  });

  it("permits archived subsets of hard links and all-empty hard-link groups", async () => {
    const subset = bytes.slice();
    const links = records(bytes).filter((entry) => entry.name.startsWith("alias-"));
    for (const entry of links) field(subset, entry.at, 38, 10);
    const archive = await openCpio(source(subset));
    const link = archive.entries.find((entry) => entry.name === "alias-last")!;
    expect((await archive.read(link.id)).bytes).toEqual(decodeBase64(fixtures.newc.entries[link.id]!.body));
    // Remove the physical owner data and its padding, retaining both zero-size headers.
    const owner = links.find((entry) => entry.size > 0)!;
    const padded = Math.ceil(owner.size / 4) * 4;
    const empty = new Uint8Array(bytes.length - padded);
    empty.set(bytes.subarray(0, owner.body));
    empty.set(bytes.subarray(owner.body + padded), owner.body);
    field(empty, owner.at, 54, 0);
    const emptyArchive = await openCpio(source(empty));
    for (const entry of emptyArchive.entries.filter((entry) => entry.name.startsWith("alias-"))) {
      expect(entry.size).toBe(0);
      expect((await emptyArchive.read(entry.id)).bytes).toEqual(new Uint8Array());
    }
  });

  it("keeps cancellation/source failures and rejects inexact extents", async () => {
    const reason = new Error("source failed");
    await expect(openCpio({
      size: bytes.length,
      stability: "caller",
      read() {
        return Promise.reject(reason);
      },
    })).rejects.toBe(reason);
    await expect(openCpio({
      size: bytes.length,
      stability: "caller",
      async read() {
        return new Uint8Array(109);
      },
    })).rejects.toMatchObject({ code: "invalid-archive" });
    const controller = new AbortController();
    await expect(openCpio({
      size: bytes.length,
      stability: "caller",
      async read(offset, length) {
        controller.abort(reason);
        return bytes.slice(offset, offset + length);
      },
    }, { signal: controller.signal })).rejects.toBe(reason);
  });
});
