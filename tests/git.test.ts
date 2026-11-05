import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { createByteSource, createSourceBudget } from "../src/source.ts";
import { encodeGitTree, openGitObject } from "../src/content/git.ts";
import type { GitAlgorithmType, GitModeType } from "../src/content/git.ts";

const fixture = async (file: string): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await readFile(new URL(`./fixtures/git/${file}`, import.meta.url)));
const hex = (bytes: Uint8Array): string => Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
const unhex = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(value.match(/../g) ?? [], (part) => parseInt(part, 16));
interface RecordType {
  algorithm: GitAlgorithmType;
  label: string;
  kind: string;
  oid: string;
  size: number;
  payload: string;
  loose: string;
  entries?: { mode: GitModeType; oid: string; nameHex: string }[];
}
const manifest = async (): Promise<{ objects: RecordType[]; sha256: Record<string, string> }> =>
  JSON.parse(new TextDecoder().decode(await fixture("manifest.json")));
async function synthetic(
  bytes: Uint8Array,
): Promise<{ source: ReturnType<typeof createByteSource>; oid: string; algorithm: "sha256"; subtle: SubtleCrypto }> {
  const owned = new Uint8Array(bytes);
  return {
    source: createByteSource(new Uint8Array(deflateSync(owned))),
    oid: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", owned))),
    algorithm: "sha256",
    subtle: crypto.subtle,
  };
}

describe("verified Git loose objects", () => {
  it("matches native Git SHA-1/SHA-256 cat-file bytes and native tree ordering", async () => {
    const { objects, sha256 } = await manifest();
    for (const [file, digest] of Object.entries(sha256)) {
      expect(hex(new Uint8Array(await crypto.subtle.digest("SHA-256", await fixture(file))))).toBe(digest);
    }
    for (const record of objects) {
      const object = await openGitObject(createByteSource(await fixture(record.loose)), {
        algorithm: record.algorithm,
        oid: record.oid,
        subtle: crypto.subtle,
      });
      expect(object.kind).toBe(record.kind);
      expect(object.size).toBe(record.size);
      expect(await object.read()).toEqual(await fixture(record.payload));
      expect(object.source.stability).toBe("immutable");
      if (record.entries) {
        expect(object.entries().map((entry) => ({ mode: entry.mode, oid: entry.oid, nameHex: hex(entry.nameBytes) })))
          .toEqual(record.entries);
        const encoded = encodeGitTree(
          record.entries.slice().reverse().map((entry) => ({
            mode: entry.mode,
            oid: entry.oid,
            nameBytes: unhex(entry.nameHex),
          })),
          { algorithm: record.algorithm },
        );
        expect(encoded).toEqual(await fixture(record.payload));
        const invalidUtf8 = object.entries().find((entry) => hex(entry.nameBytes) === "62696e6172792dff");
        expect(invalidUtf8?.name).toBeUndefined();
        expect(object.entries().find((entry) => entry.kind === "gitlink")?.oid.length).toBe(
          record.algorithm === "sha1" ? 40 : 64,
        );
      } else if (record.kind !== "tree") expect(() => object.entries()).toThrow("not a tree");
    }
  });
  it("copies returned payload and tree names without changing verified interpretation", async () => {
    const record = (await manifest()).objects.find((record) =>
      record.label === "tree" && record.algorithm === "sha256"
    )!;
    const object = await openGitObject(createByteSource(await fixture(record.loose)), {
      ...record,
      subtle: crypto.subtle,
    });
    const expected = await fixture(record.payload);
    const bytes = await object.read();
    bytes.fill(0);
    const entries = object.entries();
    const original = hex(entries[0]!.nameBytes);
    entries[0]!.nameBytes.fill(0);
    expect(hex(object.entries()[0]!.nameBytes)).toBe(original);
    expect(await object.read()).toEqual(expected);
    expect(await object.source.read(1, 3)).toEqual(expected.slice(1, 4));
    await expect(object.source.read(object.size, 1)).rejects.toThrow();
  });
  it("rejects mismatched IDs, truncated zlib and corrupt Adler before exposing bytes", async () => {
    const record = (await manifest()).objects[0]!;
    const compressed = await fixture(record.loose);
    const options = { algorithm: record.algorithm, oid: record.oid, subtle: crypto.subtle };
    await expect(openGitObject(createByteSource(compressed), { ...options, oid: "0".repeat(record.oid.length) }))
      .rejects.toThrow("hash");
    await expect(openGitObject(createByteSource(compressed.slice(0, -1)), options)).rejects.toThrow();
    const corrupt = compressed.slice();
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    await expect(openGitObject(createByteSource(corrupt), options)).rejects.toThrow();
  });
  it("validates canonical decoded headers and declared extents before hashing", async () => {
    for (
      const header of ["blob 01\0x", "blob -1\0", "other 0\0", "blob 2\0x", "blob 0\0x", "blob 9007199254740992\0"]
    ) {
      const input = await synthetic(new TextEncoder().encode(header));
      await expect(openGitObject(input.source, input)).rejects.toThrow();
    }
    const input = await synthetic(new TextEncoder().encode("blob 999999\0"));
    await expect(openGitObject(input.source, { ...input, maxObjectBytes: 100 })).rejects.toThrow("decoded");
  });
  it("enforces preflight limits before source IO and preserves failed reservations", async () => {
    let reads = 0;
    const source = {
      size: 20,
      async read(): Promise<Uint8Array> {
        reads++;
        throw new Error("source failed");
      },
    };
    const options = { algorithm: "sha256" as const, oid: "0".repeat(64), subtle: crypto.subtle };
    await expect(openGitObject(source, { ...options, maxCompressedBytes: 19 })).rejects.toThrow("compressed");
    expect(reads).toBe(0);
    const budget = createSourceBudget({ maxBytes: 20, maxRequests: 1 });
    await expect(openGitObject(source, { ...options, budget })).rejects.toThrow("source failed");
    await expect(openGitObject(source, { ...options, budget })).rejects.toThrow();
    expect(reads).toBe(1);
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(openGitObject(source, { ...options, signal: controller.signal })).rejects.toThrow("stop");
    expect(reads).toBe(1);
  });
  it("captures source methods and options before an awaited source read", async () => {
    const record = (await manifest()).objects.find((item) => item.label === "blob" && item.algorithm === "sha256")!;
    const compressed = await fixture(record.loose);
    const options = { algorithm: record.algorithm, oid: record.oid, subtle: crypto.subtle };
    const source = {
      size: compressed.length,
      async read(offset: number, length: number): Promise<Uint8Array> {
        options.oid = "0".repeat(64);
        source.read = async () => {
          throw new Error("changed method");
        };
        return compressed.slice(offset, offset + length);
      },
    };
    expect((await openGitObject(source, options)).oid).toBe(record.oid);
  });
  it("captures the physical source reader across multiple extents", async () => {
    const payload = new Uint8Array(160000);
    // Deterministic incompressible-ish bytes ensure several 64 KiB physical reads.
    let state = 17;
    for (let at = 0; at < payload.length; at++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      payload[at] = state & 255;
    }
    const header = new TextEncoder().encode(`blob ${payload.length}\0`),
      decoded = new Uint8Array(header.length + payload.length);
    decoded.set(header);
    decoded.set(payload, header.length);
    const compressed = new Uint8Array(deflateSync(decoded));
    expect(compressed.length).toBeGreaterThan(65536);
    let reads = 0;
    const source = {
      size: compressed.length,
      async read(offset: number, length: number): Promise<Uint8Array> {
        reads++;
        source.read = async () => {
          throw new Error("replaced method");
        };
        return compressed.slice(offset, offset + length);
      },
    };
    const oid = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", decoded)));
    const object = await openGitObject(source, { algorithm: "sha256", oid, subtle: crypto.subtle });
    expect(reads).toBeGreaterThan(1);
    expect(await object.read()).toEqual(payload);
  });
  it("propagates cancellation during borrowed IO without reaching the digest", async () => {
    const controller = new AbortController();
    let cancelled = false, digests = 0;
    const source = {
      size: 10,
      read(_offset: number, _length: number, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
        return new Promise((_resolve, reject) => {
          options.signal!.addEventListener("abort", () => {
            cancelled = true;
            reject(options.signal!.reason);
          }, { once: true });
          queueMicrotask(() => controller.abort(new Error("cancel borrowed IO")));
        });
      },
    };
    const subtle: Pick<SubtleCrypto, "digest"> = {
      async digest() {
        digests++;
        return new ArrayBuffer(32);
      },
    };
    await expect(openGitObject(source, { algorithm: "sha256", oid: "0".repeat(64), subtle, signal: controller.signal }))
      .rejects.toThrow("cancel borrowed IO");
    expect(cancelled).toBe(true);
    expect(digests).toBe(0);
  });
  it("rejects tree ambiguity and keeps raw names inert", async () => {
    const oid = "0".repeat(64), nameBytes = new TextEncoder().encode("name");
    const input = { mode: "100644" as const, oid, nameBytes };
    expect(() => encodeGitTree([input, { ...input, mode: "40000" }], { algorithm: "sha256" })).toThrow("Duplicate");
    for (const value of ["", ".", "..", "a/b", "a\0b"]) {
      expect(() => encodeGitTree([{ ...input, nameBytes: new TextEncoder().encode(value) }], { algorithm: "sha256" }))
        .toThrow();
    }
    expect(() => encodeGitTree([input], { algorithm: "sha256", maxEntries: 0 })).toThrow();
    expect(() => encodeGitTree([input], { algorithm: "sha256", maxNameBytes: 1 })).toThrow();
    expect(() => encodeGitTree([{ ...input, oid: "0".repeat(40) }], { algorithm: "sha256" })).toThrow();
    const payload = encodeGitTree([{ ...input, nameBytes: new Uint8Array([255, 10, 92]) }], { algorithm: "sha256" });
    const header = new TextEncoder().encode(`tree ${payload.length}\0`),
      full = new Uint8Array(header.length + payload.length);
    full.set(header);
    full.set(payload, header.length);
    const syntheticTree = await synthetic(full);
    const object = await openGitObject(syntheticTree.source, syntheticTree);
    expect(object.entries()[0]!.nameBytes).toEqual(new Uint8Array([255, 10, 92]));
    expect(object.entries()[0]!.name).toBeUndefined();
    for (const bad of [payload.slice(0, -1), new Uint8Array([...payload, ...payload])]) {
      const prefix = new TextEncoder().encode(`tree ${bad.length}\0`),
        decoded = new Uint8Array(prefix.length + bad.length);
      decoded.set(prefix);
      decoded.set(bad, prefix.length);
      const input = await synthetic(decoded);
      await expect(openGitObject(input.source, input)).rejects.toThrow();
    }
  });
});
