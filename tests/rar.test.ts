import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createArchiveLedger, openRar } from "../src/archive/rar.ts";
import originalFixture from "./fixtures/rar/independent.json" with { type: "json" };

const fixture: {
  readonly fixtures: readonly {
    readonly profile: string;
    readonly archive: { readonly base64: string };
    readonly payloads: Readonly<Record<string, { readonly base64: string }>>;
  }[];
} = originalFixture;

const source = (bytes: Uint8Array) => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const native = (profile = "stored") =>
  decodeBase64(fixture.fixtures.find((item) => item.profile === profile)!.archive.base64);
const utf8 = (text: string) => new TextEncoder().encode(text);
function joined(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
function vint(input: number | bigint): Uint8Array {
  let value = BigInt(input);
  const bytes: number[] = [];
  do {
    const next = Number(value & 127n);
    value >>= 7n;
    bytes.push(next | (value ? 128 : 0));
  } while (value);
  return Uint8Array.from(bytes);
}
/** Authored header builder, used only for malformed/profile controls. Native payloads
 * below remain the independent interoperability oracle. */
function crc(bytes: Uint8Array): Uint8Array {
  let remainder = 0xffffffff;
  for (const byte of bytes) {
    for (let bit = 0; bit < 8; bit++) {
      const outgoing = (remainder ^ (byte >>> bit)) & 1;
      remainder >>>= 1;
      if (outgoing) remainder ^= 0xedb88320;
    }
  }
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, (remainder ^ 0xffffffff) >>> 0, true);
  return result;
}
function header(
  type: number,
  flags: number,
  fields: Uint8Array,
  extra: Uint8Array = new Uint8Array(),
  body: Uint8Array = new Uint8Array(),
  padded = false,
): Uint8Array {
  const bytes = joined(
    vint(type),
    vint(flags),
    flags & 1 ? vint(extra.length) : new Uint8Array(),
    flags & 2 ? vint(body.length) : new Uint8Array(),
    fields,
    extra,
  );
  const size = padded ? Uint8Array.from([bytes.length | 128, 0]) : vint(bytes.length);
  return joined(crc(joined(size, bytes)), size, bytes, body);
}
function extra(type: number, body: Uint8Array = new Uint8Array()): Uint8Array {
  const bytes = joined(vint(type), body);
  return joined(vint(bytes.length), bytes);
}
function wire(
  options: {
    name?: string;
    body?: Uint8Array;
    extra?: Uint8Array;
    method?: number;
    fileFlags?: number;
    flags?: number;
    checksum?: boolean;
    size?: number | bigint;
    host?: number;
    attributes?: number;
    padded?: boolean;
  } = {},
): Uint8Array {
  const body = options.body ?? utf8("authored payload");
  const name = utf8(options.name ?? "../inert/duplicate");
  const checksum = options.checksum !== false;
  const fields = joined(
    vint(options.fileFlags ?? (checksum ? 4 : 0)),
    vint(options.size ?? body.length),
    vint(options.attributes ?? 0x81a4),
    checksum ? crc(body) : new Uint8Array(),
    vint(options.method ?? 0),
    vint(options.host ?? 1),
    vint(name.length),
    name,
  );
  return joined(
    Uint8Array.from([82, 97, 114, 33, 26, 7, 1, 0]),
    header(1, 4, vint(0)),
    header(2, options.flags ?? (2 | (options.extra ? 1 : 0)), fields, options.extra, body, options.padded),
    header(5, 4, vint(0)),
  );
}

describe("bounded original-header RAR5 preview", () => {
  for (const profile of ["stored", "quick-open"]) {
    it(`reads every ${profile} payload against native 7zz/libarchive bytes`, async () => {
      const record = fixture.fixtures.find((item) => item.profile === profile)!;
      const archive = await openRar(source(native(profile)));
      expect(archive.metadata).toBe("header-crc32-verified");
      expect(archive.entries.length).toBe(Object.keys(record.payloads).length);
      expect(archive.services).toBe(profile === "quick-open" ? 2 : 0);
      for (const entry of archive.entries) {
        const original = record.payloads[entry.name as keyof typeof record.payloads];
        expect(original).toBeDefined();
        const expected = decodeBase64(original!.base64);
        const read = await archive.read(entry.id);
        expect(read.bytes).toEqual(expected);
        expect(read.integrity).toBe("crc32-verified");
        expect(read.work.sourceBytes).toBe(expected.length);
        const prefix = await archive.read(entry.id, { length: Math.min(7, entry.size) });
        expect(prefix.bytes).toEqual(expected.subarray(0, 7));
        expect(prefix.work.sourceBytes).toBe(expected.length);
      }
    });
  }

  it("reads an exact selected extent when CRC verification is explicitly deferred", async () => {
    const bytes = native();
    const calls: [number, number][] = [];
    const original = source(bytes);
    const archive = await openRar({
      ...original,
      read: async (at, length, options) => {
        calls.push([at, length]);
        return await original.read(at, length, options);
      },
    });
    const entry = archive.entries.find((item) => item.name === "large.bin")!;
    calls.length = 0;
    const read = await archive.read(entry.id, { offset: 65530, length: 37, verify: false });
    expect(read.integrity).toBe("pending");
    expect(calls).toEqual([[entry.offset + 65530, 37]]);
    expect(read.work).toEqual({ sourceBytes: 37, requests: 1, decodedBytes: 37, outputBytes: 37 });
    expect(read.bytes).toEqual(decodeBase64(fixture.fixtures[0]!.payloads["large.bin"]!.base64).slice(65530, 65567));
  });

  it("verifies unselected suffixes before returning a prefix and bounds decoded work", async () => {
    const bytes = native();
    const good = await openRar(source(bytes));
    const entry = good.entries.find((item) => item.name === "large.bin")!;
    bytes[entry.offset + entry.size - 1] = bytes[entry.offset + entry.size - 1]! ^ 1;
    const damaged = await openRar(source(bytes));
    await expect(damaged.read(entry.id, { length: 3 })).rejects.toMatchObject({ code: "checksum-mismatch" });
    expect((await damaged.read(entry.id, { length: 3, verify: false })).integrity).toBe("pending");
    await expect(good.read(entry.id, { length: 1, maxDecodedBytes: entry.size - 1 })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    await expect(good.read(entry.id, { length: 1, maxRequests: 2 })).rejects.toMatchObject({ code: "budget-exceeded" });
  });

  it("keeps compressed/encrypted/link members visible but refuses their reads", async () => {
    for (const profile of ["compressed", "encrypted", "link"]) {
      const archive = await openRar(source(native(profile)));
      const refused = archive.entries.filter((entry) => !entry.readable);
      expect(refused.length).toBeGreaterThan(0);
      for (const entry of refused) {
        await expect(archive.read(entry.id)).rejects.toMatchObject({ code: "unsupported-profile" });
      }
    }
    for (const profile of ["solid", "header-encrypted", "volume"]) {
      await expect(openRar(source(native(profile)))).rejects.toMatchObject({ code: "unsupported-profile" });
    }
  });

  it("keeps literal traversal names inert and accepts specified overallocated vints", async () => {
    const archive = await openRar(source(wire({ padded: true })));
    expect(archive.entries[0]!.name).toBe("../inert/duplicate");
    expect((await archive.read(archive.entries[0]!.id)).bytes).toEqual(utf8("authored payload"));
    const noCrc = await openRar(source(wire({ checksum: false })));
    expect((await noCrc.read(noCrc.entries[0]!.id, { length: 2 })).integrity).toBe("not-provided");
  });

  it("preserves distinct physical IDs for duplicate names and ignores quick-open payloads", async () => {
    const bytes = wire();
    // Authored main is eight bytes after the signature; end is eight bytes.
    const duplicate = joined(bytes.subarray(0, bytes.length - 8), bytes.subarray(16));
    const archive = await openRar(source(duplicate));
    expect(archive.entries.length).toBe(2);
    expect(archive.entries[0]!.name).toBe(archive.entries[1]!.name);
    expect(archive.entries[0]!.id).not.toBe(archive.entries[1]!.id);
    for (const entry of archive.entries) expect((await archive.read(entry.id)).bytes).toEqual(utf8("authored payload"));
    // The byte immediately preceding the final native end header is cached QO data.
    // Cache-body corruption must not change original-header listing/read authority.
    const cached = native("quick-open");
    cached[cached.length - 9] = cached[cached.length - 9]! ^ 1;
    const ignored = await openRar(source(cached));
    const hello = ignored.entries.find((entry) => entry.name === "hello.txt")!;
    expect((await ignored.read(hello.id)).bytes).toEqual(utf8("RAR5 original stored member\n"));
  });

  it("checks every extra envelope and never grants read authority from unknown extras", async () => {
    for (const record of [extra(1), extra(5), extra(99)]) {
      const archive = await openRar(source(wire({ extra: record })));
      expect(archive.entries[0]!.readable).toBe(false);
    }
    await expect(openRar(source(wire({ extra: joined(extra(1), Uint8Array.from([99, 2])) })))).rejects.toMatchObject({
      code: "invalid-archive",
    });
    await expect(openRar(source(wire({ extra: joined(extra(3), extra(3)) })))).rejects.toMatchObject({
      code: "unsupported-profile",
    });
  });

  it("refuses unknown size, dependency, host, oversized flags and mismatched STORED sizes", async () => {
    for (
      const opts of [
        { fileFlags: 12 },
        { flags: 34 },
        { flags: 10 },
        { size: 99 },
        { method: 64 },
        { method: 2 },
        { host: 3 },
        { attributes: 0xa1ff },
        { attributes: 2 ** 40 },
        { method: 2 ** 40 },
      ]
    ) {
      const archive = await openRar(source(wire(opts)));
      expect(archive.entries[0]!.readable).toBe(false);
    }
    await expect(openRar(source(wire({ fileFlags: 2 ** 40 + 4 })))).rejects.toMatchObject({
      code: "unsupported-profile",
    });
    await expect(openRar(source(wire({ size: 2n ** 63n })))).rejects.toMatchObject({ code: "unsupported-profile" });
  });

  it("rejects CRC damage, truncation, trailing/SFX bytes and header/index/name limits", async () => {
    const bytes = wire();
    const corrupt = bytes.slice();
    corrupt[10] = corrupt[10]! ^ 1;
    await expect(openRar(source(corrupt))).rejects.toMatchObject({ code: "checksum-mismatch" });
    for (const length of [0, 7, 11, bytes.length - 1]) {
      await expect(openRar(source(bytes.slice(0, length)))).rejects.toBeDefined();
    }
    await expect(openRar(source(joined(bytes, new Uint8Array(1))))).rejects.toMatchObject({
      code: "unsupported-profile",
    });
    await expect(openRar(source(joined(new Uint8Array(1), bytes)))).rejects.toMatchObject({
      code: "unsupported-profile",
    });
    for (const opts of [{ maxHeaders: 2 }, { maxHeaderBytes: 2 }, { maxNamesBytes: 1 }, { maxDecodedBytes: 1 }]) {
      await expect(openRar(source(bytes), opts)).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    const huge = joined(bytes.subarray(0, 8), new Uint8Array(4), Uint8Array.from([128, 128, 128]));
    await expect(openRar(source(huge))).rejects.toMatchObject({ code: "invalid-archive" });
  });

  it("retains opening ledgers and admits the full selected source cost before I/O", async () => {
    for (const dimension of ["maxSourceBytes", "maxRequests"] as const) {
      const ledger = createArchiveLedger({ [dimension]: 100000 });
      let calls = 0;
      const original = source(wire());
      const archive = await openRar({
        ...original,
        read: async (at, length, opts) => {
          calls++;
          return await original.read(at, length, opts);
        },
      }, { ledger });
      ledger.reserve(
        dimension === "maxRequests" ? "requests" : "sourceBytes",
        100000 -
          ledger.inspect()[dimension === "maxRequests" ? "requests" : "sourceBytes"],
      );
      calls = 0;
      await expect(archive.read(archive.entries[0]!.id)).rejects.toMatchObject({ code: "budget-exceeded" });
      expect(calls).toBe(0);
    }
    const additional = createArchiveLedger({ maxRequests: 0 });
    const archive = await openRar(source(wire()));
    await expect(archive.read(archive.entries[0]!.id, { ledger: additional })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
  });

  it("captures source/options, validates stability and preserves abort/provider failures", async () => {
    const original = source(wire());
    const options = { maxHeaders: 3 };
    const pending = openRar(original, options);
    options.maxHeaders = 0;
    const archive = await pending;
    for (const stability of ["unknown", false]) {
      await expect(openRar({ ...original, stability } as unknown as ByteSourceType)).rejects.toBeInstanceOf(TypeError);
    }
    await expect(openRar({ ...original, identity: "x".repeat(8193) })).rejects.toBeInstanceOf(TypeError);
    const opening = new AbortController();
    const bound = await openRar(original, { signal: opening.signal });
    const reason = new Error("opening owner stopped");
    opening.abort(reason);
    await expect(bound.read(bound.entries[0]!.id, { length: 0 })).rejects.toBe(reason);
    const active = new AbortController();
    let failing = false;
    const failure = new Error("independent source failed");
    const faulty = await openRar({
      ...original,
      async read(at, length, opts) {
        if (failing) {
          active.abort(reason);
          throw failure;
        }
        return await original.read(at, length, opts);
      },
    });
    failing = true;
    await expect(faulty.read(faulty.entries[0]!.id, { signal: active.signal })).rejects.toBe(failure);
    expect((await archive.read(archive.entries[0]!.id)).integrity).toBe("crc32-verified");
  });
});
