import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { createArchiveLedger, openZip } from "../src/archive/zip.ts";
import fixtures from "./fixtures/password/independent.json" with { type: "json" };

const source = (bytes: Uint8Array) => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const password = decodeBase64(fixtures.stored.password);
/** Independent ZIP fixed-header navigation; no candidate private records are consulted. */
function directory(bytes: Uint8Array): number {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = bytes.length - 22; at >= 0; at--) {
    if (data.getUint32(at, true) === 0x06054b50) return data.getUint32(at + 16, true);
  }
  throw new Error("Independent fixture has no ZIP end record.");
}
function local(bytes: Uint8Array, id: number): number {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = directory(bytes);
  for (let index = 0; index < id; index++) {
    at += 46 + data.getUint16(at + 28, true) + data.getUint16(at + 30, true) + data.getUint16(at + 32, true);
  }
  return data.getUint32(at + 42, true);
}
function payload(bytes: Uint8Array, id: number): number {
  const at = local(bytes, id);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return at + 30 + data.getUint16(at + 26, true) + data.getUint16(at + 28, true);
}

describe("explicit legacy ZipCrypto preview", () => {
  for (const profile of ["stored", "deflate", "descriptor"] as const) {
    it(`decrypts genuine ${profile === "descriptor" ? "InfoZIP" : "7-Zip"} ${profile} bytes independently checked by Python zipfile`, async () => {
      const fixture = fixtures[profile];
      const bytes = decodeBase64(fixture.archive);
      const archive = await openZip(source(bytes));
      for (const expected of fixture.entries) {
        const entry = archive.entries.find((entry) => entry.name === expected.name)!;
        const result = await archive.read(entry.id, { password });
        expect(result.bytes).toEqual(decodeBase64(expected.body));
        expect(result.integrity).toBe("checksum-verified");
        if (entry.encrypted) {
          expect(entry.encryption).toBe("zipcrypto");
          expect(result.encryption).toEqual({ kind: "zipcrypto", authentication: "none" });
        }
      }
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
      expect(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(fixture.sha256);
      expect(fixture.independentPayloadVerified).toBe(true);
    });
  }
  it("uses descriptor timestamp verification for an actual native bit3 member", async () => {
    expect(fixtures.descriptor.flags["-"] & 8).toBe(8);
    const archive = await openZip(source(decodeBase64(fixtures.descriptor.archive)));
    expect((await archive.read(0, { password, offset: 1, length: 7, verify: true })).integrity).toBe(
      "checksum-verified",
    );
  });
  it("decrypts from the start for stored late ranges and leaves prefix CRC pending", async () => {
    const bytes = decodeBase64(fixtures.stored.archive);
    const archive = await openZip(source(bytes));
    const entry = archive.entries.find((entry) => entry.name === "large.bin")!;
    const expected = decodeBase64(fixtures.stored.entries.find((entry) => entry.name === "large.bin")!.body);
    const plan = archive.plan(entry.id, { password, offset: 100000, length: 13 });
    expect(plan.access).toBe("decode-from-start");
    expect(plan.sourceBytes).toBe(100025);
    expect(plan.decodedBytes).toBe(100025);
    const partial = await archive.read(entry.id, { password, offset: 100000, length: 13 });
    expect(partial.bytes).toEqual(expected.slice(100000, 100013));
    expect(partial.integrity).toBe("checksum-pending");
    expect(partial.encryption?.authentication).toBe("none");
    const full = await archive.read(entry.id, { password, offset: 100000, length: 13, verify: true });
    expect(full.bytes).toEqual(partial.bytes);
    expect(full.integrity).toBe("checksum-verified");
    expect(full.work.sourceBytes).toBeGreaterThan(partial.work.sourceBytes);
    expect(full.work.decodedBytes).toBe(entry.size + 12);
  });
  it("reports DEFLATE prefix checksum pending while full verification checks all decoded bytes", async () => {
    const archive = await openZip(source(decodeBase64(fixtures.deflate.archive)));
    const entry = archive.entries.find((entry) => entry.name === "large.bin")!;
    const partial = await archive.read(entry.id, { password, offset: 100, length: 11 });
    expect(partial.integrity).toBe("checksum-pending");
    const full = await archive.read(entry.id, { password, offset: 100, length: 11, verify: true });
    expect(full.bytes).toEqual(partial.bytes);
    expect(full.integrity).toBe("checksum-verified");
    expect(full.work.decodedBytes).toBe(entry.size + entry.compressedSize);
  });
  it("refuses missing passwords and unsupported strong profiles without member I/O", async () => {
    const bytes = decodeBase64(fixtures.stored.archive);
    let calls = 0;
    const archive = await openZip({
      size: bytes.length,
      stability: "immutable",
      async read(offset, length) {
        calls++;
        return bytes.slice(offset, offset + length);
      },
    });
    const entry = archive.entries.find((entry) => entry.encrypted)!;
    const before = calls;
    expect(archive.plan(entry.id).supported).toBe(false);
    await expect(archive.read(entry.id)).rejects.toMatchObject({ code: "unsupported-profile" });
    expect(calls).toBe(before);
    for (const flag of [0x40, 0x2000]) {
      const altered = bytes.slice();
      const data = new DataView(altered.buffer);
      const at = directory(altered);
      data.setUint16(at + 8, data.getUint16(at + 8, true) | flag, true);
      const protectedArchive = await openZip(source(altered));
      expect(protectedArchive.entries[0]!.encryption).toBe("unsupported");
      await expect(protectedArchive.read(0, { password })).rejects.toMatchObject({ code: "unsupported-profile" });
    }
  });
  it("rejects wrong passwords, later payload tampering and local/central disagreements", async () => {
    const bytes = decodeBase64(fixtures.stored.archive);
    const archive = await openZip(source(bytes));
    const entry = archive.entries.find((entry) => entry.name === "large.bin")!;
    await expect(archive.read(entry.id, { password: new TextEncoder().encode("wrong-password") })).rejects
      .toMatchObject({ code: "checksum-mismatch" });
    const tampered = bytes.slice();
    const at = payload(tampered, entry.id) + 12 + 100000;
    tampered[at] = tampered[at]! ^ 1;
    const corrupt = await openZip(source(tampered));
    await expect(corrupt.read(entry.id, { password, length: 3, verify: true })).rejects.toMatchObject({
      code: "checksum-mismatch",
    });
    // An unverified prefix can succeed even though later bytes are corrupt: CRC is not authentication.
    expect((await corrupt.read(entry.id, { password, length: 3 })).integrity).toBe("checksum-pending");
    const conflict = bytes.slice();
    const where = local(conflict, entry.id) + 10;
    conflict[where] = conflict[where]! ^ 1;
    await expect((await openZip(source(conflict))).read(entry.id, { password })).rejects.toMatchObject({
      code: "invalid-archive",
    });
    await expect(openZip(source(bytes.slice(0, -1)))).rejects.toThrow();
  });
  it("never interprets AES or malformed/duplicate encryption extras as legacy cipher bytes", async () => {
    const original = decodeBase64(fixtures.descriptor.archive);
    for (const form of ["aes", "trailing", "duplicate"] as const) {
      const bytes = original.slice();
      const data = new DataView(bytes.buffer);
      const start = 30 + data.getUint16(26, true);
      data.setUint16(start, 0x9901, true);
      if (form === "trailing") data.setUint16(start + 2, 15, true);
      if (form === "duplicate") {
        bytes.fill(0, start, start + 20);
        data.setUint16(start, 0x9901, true);
        data.setUint16(start + 4, 0x9901, true);
        data.setUint16(start + 10, 8, true);
      }
      const archive = await openZip(source(bytes));
      await expect(archive.read(0, { password })).rejects.toMatchObject({
        code: form === "aes" ? "unsupported-profile" : "invalid-archive",
      });
    }
    const bytes = decodeBase64(fixtures.stored.archive);
    const data = new DataView(bytes.buffer);
    const at = directory(bytes);
    const extra = at + 46 + data.getUint16(at + 28, true);
    data.setUint16(extra, 0x9901, true);
    const archive = await openZip(source(bytes));
    expect(archive.entries[0]!.encryption).toBe("unsupported");
    await expect(archive.read(0, { password })).rejects.toMatchObject({ code: "unsupported-profile" });
  });
  it("bounds passwords, sequential-decrypt work and aggregate output without changing caller bytes", async () => {
    const archive = await openZip(source(decodeBase64(fixtures.stored.archive)));
    const entry = archive.entries.find((entry) => entry.name === "large.bin")!;
    const original = password.slice();
    await expect(archive.read(entry.id, { password, maxPasswordBytes: 1 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    expect(password).toEqual(original);
    for (
      const options of [{ maxSourceBytes: 100 }, { maxDecodedBytes: 100 }, { maxOutputBytes: 0 }, { maxRequests: 0 }]
    ) {
      await expect(archive.read(entry.id, { password, offset: 10000, length: 1, ...options })).rejects.toMatchObject({
        code: "budget-exceeded",
      });
    }
    const ledger = createArchiveLedger({ maxOutputBytes: 3 });
    await archive.read(entry.id, { password, length: 2, ledger });
    await expect(archive.read(entry.id, { password, length: 2, ledger })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    const deflated = await openZip(source(decodeBase64(fixtures.deflate.archive)));
    const compressed = deflated.entries.find((entry) => entry.name === "large.bin")!;
    await expect(
      deflated.read(compressed.id, {
        password,
        verify: true,
        maxDecodedBytes: compressed.size + compressed.compressedSize - 1,
      }),
    ).rejects.toMatchObject({ code: "budget-exceeded" });
  });
  it("copies password bytes before awaiting a source and reaches cancellation without source disposal", async () => {
    const bytes = decodeBase64(fixtures.stored.archive);
    const caller = password.slice();
    let mutate = false;
    let calls = 0;
    const archive = await openZip({
      size: bytes.length,
      stability: "immutable",
      async read(offset, length) {
        calls++;
        if (mutate) caller.fill(0);
        return bytes.slice(offset, offset + length);
      },
    });
    const entry = archive.entries.find((entry) => entry.name === "first.bin")!;
    mutate = true;
    expect((await archive.read(entry.id, { password: caller })).bytes).toEqual(
      decodeBase64(fixtures.stored.entries.find((entry) => entry.name === "first.bin")!.body),
    );
    expect(caller.every((byte) => byte === 0)).toBe(true);
    const abort = new AbortController();
    abort.abort(new Error("stop"));
    const before = calls;
    await expect(archive.read(entry.id, { password, signal: abort.signal })).rejects.toThrow("stop");
    expect(calls).toBe(before);
  });
});
