import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createArchiveLedger, openAr } from "../src/archive/ar.ts";
import { readCompressedTar } from "../src/archive/compress.ts";
import fixtures from "./fixtures/ar/independent.json" with { type: "json" };

const source = (bytes: Uint8Array) => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
/** Original wire records isolate field parsing and reference boundaries without candidate serialization. */
function wire(records: { name: string; body?: Uint8Array; size?: string; mode?: string }[]): Uint8Array {
  const chunks: Uint8Array[] = [new TextEncoder().encode("!<arch>\n")];
  for (const record of records) {
    const body = record.body ?? new Uint8Array();
    const header = record.name.padEnd(16) + "0".padEnd(12) + "0".padEnd(6) + "0".padEnd(6) +
      (record.mode ?? "100644").padEnd(8) + (record.size ?? String(body.length)).padEnd(10) + "`\n";
    chunks.push(new TextEncoder().encode(header), body);
    if (body.length % 2) chunks.push(new Uint8Array([10]));
  }
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return bytes;
}
const encode = (text: string) => new TextEncoder().encode(text);

/** Backpressure pulls only one bounded member extent; cancellation transfers no source lifetime. */
function stream(source: ByteSourceType): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    async pull(controller) {
      if (at === source.size) {
        controller.close();
        return;
      }
      const count = Math.min(7, source.size - at);
      controller.enqueue(await source.read(at, count));
      at += count;
    },
  });
}

describe("bounded normal ar inspection", () => {
  for (const profile of ["gnu", "bsd"] as const) {
    it(`reads genuine ${profile} members checked by an independent ar consumer`, async () => {
      const fixture = fixtures[profile];
      const bytes = decodeBase64(fixture.archive);
      const calls: { offset: number; length: number }[] = [];
      const archive = await openAr({
        size: bytes.length,
        stability: "immutable",
        async read(offset, length) {
          calls.push({ offset, length });
          return bytes.slice(offset, offset + length);
        },
      });
      const indexed = calls.slice();
      expect(archive.entries.filter((entry) => entry.kind === "file").map((entry) => entry.name)).toEqual(
        fixture.entries.map((entry) => entry.name),
      );
      for (const expected of fixture.entries) {
        const entry = archive.entries.find((entry) => entry.name === expected.name)!;
        expect(entry.size).toBe(decodeBase64(expected.body).length);
        expect(
          indexed.some((call) => call.offset < entry.offset + entry.size && call.offset + call.length > entry.offset),
        ).toBe(false);
        const result = await archive.read(entry.id);
        expect(result.bytes).toEqual(decodeBase64(expected.body));
        expect(result.integrity).toBe("none");
        expect(result.work.sourceBytes).toBe(entry.size);
      }
      expect(fixture.independentPayloadVerified).toBe(true);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
      expect(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(fixture.sha256);
    });
  }
  it("returns only requested bytes and bounds member sources by physical identity", async () => {
    const bytes = decodeBase64(fixtures.bsd.archive);
    const archive = await openAr(
      createBlobSource(new Blob([new Uint8Array(bytes).buffer]), { identity: "provider-object" }),
    );
    const entry = archive.entries.find((entry) => entry.name === "large.bin")!;
    const expected = decodeBase64(
      fixtures.bsd.entries.find((entry) => entry.name === "large.bin")!.body,
    );
    const result = await archive.read(entry.id, { offset: 100000, length: 17 });
    expect(result.bytes).toEqual(expected.slice(100000, 100017));
    expect(result.work.sourceBytes).toBe(17);
    const member = archive.member(entry.id, { maxSourceBytes: 20, maxOutputBytes: 20 });
    expect(member.stability).toBe("immutable");
    expect(member.identity).toContain(String(entry.offset));
    expect(await member.read(100000, 17)).toEqual(result.bytes);
    await expect(member.read(0, 4)).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(member.read(entry.size, 1)).rejects.toThrow(RangeError);
    const anonymous = await openAr(source(bytes));
    expect(anonymous.member(entry.id).identity).toBeUndefined();
  });
  it("streams an independently produced nested package control.tar.gz without buffering the ar archive", async () => {
    const archive = await openAr(source(decodeBase64(fixtures.gnu.archive)));
    const entry = archive.entries.find((entry) => entry.name === "control.tar.gz")!;
    const member = archive.member(entry.id, {
      maxSourceBytes: 65536,
      maxRequests: 512,
      maxDecodedBytes: 65536,
      maxOutputBytes: 65536,
    });
    const pieces: Uint8Array[] = [];
    const result = await readCompressedTar(stream(member), "gzip", async (entry, body) => {
      expect(entry.name).toBe("control");
      for await (const chunk of body) pieces.push(chunk);
    }, {
      compression: { maxSourceBytes: 65536, maxRequests: 1024, maxDecodedBytes: 65536, maxOutputBytes: 65536 },
      tar: { maxSourceBytes: 65536, maxDecodedBytes: 65536, maxOutputBytes: 4096 },
    });
    const output = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0));
    let at = 0;
    for (const piece of pieces) {
      output.set(piece, at);
      at += piece.length;
    }
    expect(output).toEqual(decodeBase64(fixtures.gnu.nestedControl));
    expect(result.complete).toBe(true);
    expect(result.compression.integrity).toBe("gzip-crc32");
  });
  it("distinguishes opaque linker/name tables, duplicate file IDs and UTF-8 BSD names", async () => {
    const table = encode("a long name/\n");
    const bytes = wire([
      { name: "/", body: new Uint8Array([1]) },
      { name: "//", body: table },
      { name: "/0", body: encode("one") },
      { name: "/0", body: encode("two") },
      { name: "#1/4", body: new Uint8Array([...encode("é"), 0, 0, 42]) },
    ]);
    const archive = await openAr(source(bytes));
    expect(archive.entries.map((entry) => entry.kind)).toEqual(["symbol-table", "name-table", "file", "file", "file"]);
    expect(archive.entries[2]!.name).toBe(archive.entries[3]!.name);
    expect((await archive.read(2)).bytes).toEqual(encode("one"));
    expect((await archive.read(3)).bytes).toEqual(encode("two"));
    expect(archive.entries[4]!.name).toBe("é");
    expect((await archive.read(4)).bytes).toEqual(new Uint8Array([42]));
    await expect(archive.read(0)).rejects.toMatchObject({ code: "unsupported-profile" });
    expect(() => archive.member(1)).toThrow();
    const empty = await openAr(source(encode("!<arch>\n")));
    expect(empty.entries.length).toBe(0);
  });
  it("refuses thin external references at the signature without looking up any path", async () => {
    let calls = 0;
    await expect(openAr({
      size: 8,
      stability: "caller",
      async read() {
        calls++;
        return encode("!<thin>\n");
      },
    })).rejects.toMatchObject({ code: "unsupported-profile" });
    expect(calls).toBe(1);
  });
  it("rejects malformed numeric fields, BSD names, GNU references and table extents", async () => {
    for (
      const bytes of [
        wire([{ name: "x/", size: "1x" }]),
        wire([{ name: "x/", size: "-1" }]),
        wire([{ name: "x/", mode: "100648" }]),
        wire([{ name: "#1/8", body: encode("short") }]),
        wire([{ name: "#1/3", body: new Uint8Array([120, 0, 121]) }]),
        wire([{ name: "/0", body: encode("x") }]),
        wire([{ name: "//", body: encode("longname/\n") }, { name: "/1" }]),
        wire([{ name: "//", body: encode("no terminator") }]),
        wire([{ name: "//", body: encode("name\x00/\n") }]),
        wire([{ name: "//", body: encode("a/\n") }, { name: "//", body: encode("b/\n") }]),
        wire([{ name: "x/" }, { name: "//", body: encode("a/\n") }]),
      ]
    ) await expect(openAr(source(bytes))).rejects.toThrow();
    const padded = wire([{ name: "x/", body: new Uint8Array([1]) }]);
    padded[padded.length - 1] = 0;
    await expect(openAr(source(padded))).rejects.toMatchObject({ code: "invalid-archive" });
    for (
      const bytes of [
        padded.slice(0, -1),
        wire([{ name: "x/" }]).slice(0, -1),
        new Uint8Array([...wire([{ name: "x/" }]), 0]),
      ]
    ) await expect(openAr(source(bytes))).rejects.toThrow();
  });
  it("admits bounded names, tables, record counts and read work before body reads", async () => {
    const bytes = wire([{ name: "//", body: encode("long name/\n") }, { name: "/0", body: encode("payload") }]);
    for (
      const options of [{ maxEntries: 0 }, { maxNameBytes: 2 }, { maxNamesBytes: 2 }, { maxTableBytes: 1 }, {
        maxRequests: 1,
      }, { maxDecodedBytes: 1 }]
    ) await expect(openAr(source(bytes), options)).rejects.toMatchObject({ code: "budget-exceeded" });
    const archive = await openAr(source(bytes));
    for (const options of [{ maxSourceBytes: 2 }, { maxOutputBytes: 2 }, { maxDecodedBytes: 2 }, { maxRequests: 0 }]) {
      await expect(archive.read(1, options)).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    const ledger = createArchiveLedger({ maxOutputBytes: 3 });
    await archive.read(1, { length: 2, ledger });
    await expect(archive.read(1, { length: 2, ledger })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(openAr(source(wire([{ name: "//", body: encode("a/\nb/\n") }])), { maxEntries: 1 })).rejects
      .toMatchObject({ code: "budget-exceeded" });
  });
  it("captures borrowed snapshot descriptors and enforces both member and per-call cancellation", async () => {
    const bytes = wire([{ name: "x/", body: encode("bytes") }]);
    let calls = 0;
    const custom = {
      size: bytes.length,
      async read(offset: number, length: number) {
        calls++;
        return bytes.slice(offset, offset + length);
      },
    };
    await expect(openAr(custom)).rejects.toMatchObject({ code: "unsupported-profile" });
    expect(calls).toBe(0);
    const archive = await openAr(custom, { allowUnverifiedSource: true });
    custom.size = 0;
    expect((await archive.read(0)).bytes).toEqual(encode("bytes"));
    expect(archive.member(0).stability).toBeUndefined();
    for (const parent of [true, false]) {
      const abort = new AbortController();
      const member = archive.member(0, parent ? { signal: abort.signal } : {});
      abort.abort(new Error("stop"));
      const before = calls;
      await expect(member.read(0, 1, parent ? {} : { signal: abort.signal })).rejects.toThrow("stop");
      expect(calls).toBe(before);
    }
    const entry = archive.entries[0]!;
    expect(Object.isFrozen(entry)).toBe(true);
  });
});
