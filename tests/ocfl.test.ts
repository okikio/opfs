import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createArchiveLedger, openOcfl } from "../src/archive/ocfl.ts";
import type { OcflInputType } from "../src/archive/ocfl.ts";
import { openMime } from "../src/archive/mime.ts";
import fixture from "./fixtures/ocfl/independent.json" with { type: "json" };
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);
const source = (bytes: Uint8Array): ByteSourceType => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
const file = (path: string, bytes: Uint8Array): OcflInputType => ({ path, source: source(bytes) });
const hash = async (bytes: Uint8Array, algorithm = "SHA-256"): Promise<string> =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest(algorithm, new Uint8Array(bytes).buffer)),
    (value) => value.toString(16).padStart(2, "0"),
  ).join("");
const genuine = (index = 0): OcflInputType[] =>
  fixture.objects[index]!.files.map((entry) => file(entry.path, decodeBase64(entry.base64)));
const authored = () => ({
  id: "urn:example:authored",
  type: "https://ocfl.io/1.1/spec/#inventory",
  digestAlgorithm: "sha256",
  head: "v1",
  manifest: { ["0".repeat(64)]: ["v1/content/a"] },
  versions: { v1: { created: "2026-01-01T00:00:00Z", state: { ["0".repeat(64)]: ["a"] } } },
});
function rawInput(value: string, rest: OcflInputType[] = []): OcflInputType[] {
  return [file("inventory.json", encode(value)), ...rest];
}
const input = (value: unknown, rest: OcflInputType[] = []): OcflInputType[] => rawInput(JSON.stringify(value), rest);

describe("OCFL1.1 selected-version inventory and content evidence", () => {
  it("matches unchanged independent producer objects and every independently extracted logical file", async () => {
    expect(fixture.revision).toBe("a480226d54cf8d03d71ab8c56eb69ae8a78e231d");
    for (const [index, object] of fixture.objects.entries()) {
      expect(object.validated).toBe(true);
      for (const entry of object.files) expect(await hash(decodeBase64(entry.base64))).toBe(entry.sha256);
      const view = await openOcfl(genuine(index));
      expect(view.coverage).toEqual({
        scope: "supplied-object-files",
        issues: [],
        headInventory: "equal",
        historicalInventories: "unexamined",
      });
      const verified = await view.verifyInventory({ subtle: crypto.subtle });
      expect(verified.scope).toBe("inventory-digest");
      expect(verified.work.sourceBytes).toBe(0);
      expect(verified.work.decodedBytes).toBeGreaterThan(0);
      for (const oracle of object.extracts) {
        expect(view.entries(oracle.version).map((entry) => entry.path).sort()).toEqual(
          oracle.files.map((entry) => entry.path).sort(),
        );
        for (const expected of oracle.files) {
          const selected = await view.read(oracle.version, expected.path);
          expect([...selected.bytes]).toEqual([...decodeBase64(expected.base64)]);
          expect(selected.integrity).toBe("none");
          const evidence = await view.verifyContent(oracle.version, expected.path, { subtle: crypto.subtle });
          expect(evidence.scope).toBe("selected-content");
          expect(evidence.version).toBe(oracle.version);
          expect(evidence.logicalPath).toBe(expected.path);
          expect(evidence.work.outputBytes).toBe(0);
        }
      }
      expect(Object.isFrozen(view.inventory.versions)).toBe(true);
    }
  });
  it("composes a preserved version's mail with the MIME reader without fetching anything", async () => {
    const view = await openOcfl(genuine());
    const message = await openMime(view.source("v2", "mail.eml"));
    expect(message.entries.length).toBe(1);
    expect(decode((await message.read(0)).bytes)).toBe("hello\r\n");
  });
  it("separates bad content from a good inventory digest and bad raw inventory from good content", async () => {
    const good = await openOcfl(genuine());
    const entry = good.entries("v1").find((entry) => entry.path === "a.txt")!;
    const modified = genuine().map((item) =>
      item.path === entry.copies[0]!.path ? file(item.path, encode("changed")) : item
    );
    const badContent = await openOcfl(modified);
    await badContent.verifyInventory({ subtle: crypto.subtle });
    await expect(badContent.verifyContent("v1", "a.txt", { subtle: crypto.subtle })).rejects.toThrow(
      "digest does not match",
    );
    const changedRaw = genuine().map((item) =>
      item.path === "inventory.json"
        ? file(
          item.path,
          encode(
            " " +
              decode(decodeBase64(fixture.objects[0]!.files.find((item) => item.path === "inventory.json")!.base64)),
          ),
        )
        : item
    );
    const badInventory = await openOcfl(changedRaw);
    expect(badInventory.coverage.headInventory).toBe("different");
    await badInventory.verifyContent("v1", "a.txt", { subtle: crypto.subtle });
    await expect(badInventory.verifyInventory({ subtle: crypto.subtle })).rejects.toThrow("digest does not match");
  });
  it("checks actual head bytes and reports supplied inventory coverage without opening historical inventories", async () => {
    const initial = await openOcfl(genuine());
    const member = initial.entries("v1")[0]!.copies[0]!.path;
    const files = genuine().filter((item) =>
      item.path !== member && item.path !== "0=ocfl_object_1.1" && item.path !== "inventory.json.sha512" &&
      item.path !== "v3/inventory.json"
    ).map((item) => item.path === "v1/inventory.json" ? file(item.path, encode("not parsed")) : item);
    files.push(file("v2/content/unlisted", encode("extra")));
    const view = await openOcfl(files);
    expect(view.coverage.issues.map((issue) => issue.code).sort()).toEqual(
      ["declaration-missing", "head-inventory-missing", "missing-content", "sidecar-missing", "unlisted-content"]
        .sort(),
    );
    await expect(view.verifyInventory({ subtle: crypto.subtle })).rejects.toThrow("no admitted matching sidecar");
  });
  it("checks declaration bytes literally and refuses a sidecar with an invisible BOM", async () => {
    const bom = new Uint8Array([239, 187, 191]);
    const declaration = encode("ocfl_object_1.1\n");
    const values = genuine().map((entry) =>
      entry.path === "0=ocfl_object_1.1" ? file(entry.path, new Uint8Array([...bom, ...declaration])) : entry
    );
    const view = await openOcfl(values);
    expect(view.coverage.issues.map((issue) => issue.code)).toContain("declaration-mismatch");
    const sidecar = fixture.objects[0]!.files.find((entry) => entry.path === "inventory.json.sha512")!;
    const withBom = genuine().map((entry) =>
      entry.path === sidecar.path ? file(entry.path, new Uint8Array([...bom, ...decodeBase64(sidecar.base64)])) : entry
    );
    const badSidecar = await openOcfl(withBom);
    expect(badSidecar.coverage.issues.map((issue) => issue.code)).toContain("sidecar-mismatch");
    await expect(badSidecar.verifyInventory({ subtle: crypto.subtle })).rejects.toThrow("no admitted matching sidecar");
  });
  it("requires explicit replica selection and never silently falls back from a missing selected copy", async () => {
    const value = authored();
    value.manifest["0".repeat(64)]!.push("v1/content/replica");
    const view = await openOcfl(input(value, [file("v1/content/a", encode("stored"))]));
    expect(() => view.source("v1", "a")).toThrow("contentPath is required");
    expect(decode((await view.read("v1", "a", { contentPath: "v1/content/a" })).bytes)).toBe("stored");
    await expect(view.read("v1", "a", { contentPath: "v1/content/replica" })).rejects.toThrow("source is missing");
    expect(() => view.source("v1", "a", { contentPath: "v1/content/unrelated" })).toThrow("does not belong");
  });
  it("rejects duplicate decoded JSON keys before native JSON.parse can overwrite them", async () => {
    for (const raw of ['{"id":"a","id":"b"}', '{"manifest":{},"man\\u0069fest":{}}', '{"x":{"a":1,"a":2}}']) {
      await expect(openOcfl(rawInput(raw))).rejects.toThrow("Duplicate decoded JSON");
    }
    await expect(openOcfl(rawInput(JSON.stringify(authored()) + " null"))).rejects.toThrow("Trailing JSON");
    await expect(openOcfl(rawInput('{"id":01}'))).rejects.toThrow("Malformed inventory JSON");
  });
  it("bounds JSON tokens, depth, encoded strings and UTF8 before metadata parsing", async () => {
    await expect(openOcfl(input(authored()), { maxJsonTokens: 2 })).rejects.toThrow("JSON tokens");
    await expect(openOcfl(input(authored()), { maxJsonDepth: 1 })).rejects.toThrow("JSON depth");
    await expect(openOcfl(input(authored()), { maxStringBytes: 10 })).rejects.toThrow("string bytes");
    await expect(openOcfl([file("inventory.json", new Uint8Array([0xff]))])).rejects.toThrow("not UTF8");
    await expect(openOcfl([file("inventory.json", new Uint8Array([239, 187, 191, 123, 125]))])).rejects.toThrow("BOM");
  });
  it("enforces continuous version names and matching padding without allocating up to an attacker head", async () => {
    const good = authored();
    const padded = {
      ...good,
      head: "v01",
      manifest: { ["0".repeat(64)]: ["v01/content/a"] },
      versions: { v01: good.versions.v1 },
    };
    expect((await openOcfl(input(padded))).inventory.head).toBe("v01");
    for (
      const value of [{ ...good, head: "v2" }, {
        ...good,
        head: "v999999999999999999999999",
        versions: { v999999999999999999999999: good.versions.v1 },
      }, { ...padded, versions: { v1: good.versions.v1 } }]
    ) await expect(openOcfl(input(value))).rejects.toThrow();
  });
  it("admits100 padded versions when the leading zero survives and rejects padding overflow", async () => {
    const base = authored();
    const versions = (width: number): Record<string, typeof base.versions.v1> =>
      Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => ["v" + String(index + 1).padStart(width, "0"), base.versions.v1]),
      );
    const valid = {
      ...base,
      head: "v0100",
      versions: versions(4),
      manifest: { ["0".repeat(64)]: ["v0001/content/a"] },
    };
    expect((await openOcfl(input(valid))).entries("v0100")[0]!.path).toBe("a");
    await expect(openOcfl(input(valid), { maxVersions: 99 })).rejects.toThrow("versions");
    const mixed = { ...versions(4) };
    delete mixed.v0001;
    mixed.v001 = base.versions.v1;
    await expect(openOcfl(input({ ...valid, versions: mixed }))).rejects.toThrow("padding");
    await expect(
      openOcfl(
        input({ ...valid, head: "v100", versions: versions(3), manifest: { ["0".repeat(64)]: ["v001/content/a"] } }),
      ),
    ).rejects.toThrow("padding");
  });
  it("keeps prototype-like unknown fixity algorithm labels inert", async () => {
    const fixity = Object.fromEntries(
      ["toString", "constructor", "__proto__"].map((name) => [name, { abcdef: ["v1/content/a"] }]),
    );
    const view = await openOcfl(input({ ...authored(), fixity }));
    expect(Object.keys(view.inventory.fixity!).sort()).toEqual(["__proto__", "constructor", "toString"].sort());
    const malformed = Object.fromEntries([["__proto__", 42]]);
    await expect(openOcfl(input({ ...authored(), fixity: malformed }))).rejects.toThrow("fixity algorithm block");
    const reservedDigest = Object.fromEntries([["__proto__", ["v1/content/a"]]]);
    await expect(openOcfl(input({ ...authored(), fixity: { example: reservedDigest } }))).rejects.toThrow(
      "Reserved JSON dictionary key",
    );
  });
  it("rejects digest aliases, orphan manifests, unknown state digests and physical/logical path conflicts", async () => {
    const a = "a".repeat(64);
    const upper = a.toUpperCase();
    const base = authored();
    const cases = [
      { ...base, manifest: { [a]: ["v1/content/a"], [upper]: ["v1/content/b"] } },
      { ...base, manifest: { ...base.manifest, [a]: ["v1/content/orphan"] } },
      { ...base, manifest: { [a]: ["v1/content/a"] } },
      { ...base, manifest: { ["0".repeat(64)]: ["v1/content/a", "v1/content/a-b", "v1/content/a/b"] } },
      { ...base, versions: { v1: { ...base.versions.v1, state: { ["0".repeat(64)]: ["a", "a-b", "a/b"] } } } },
      { ...base, manifest: { ["0".repeat(64)]: ["v2/content/a"] } },
      { ...base, manifest: { ["0".repeat(64)]: ["v1/other/a"] } },
    ];
    for (const value of cases) await expect(openOcfl(input(value))).rejects.toThrow();
  });
  it("preserves literal percent/Unicode names and rejects traversal, surrogate, host and empty components", async () => {
    for (const path of ["../a", "/a", "a//b", "a/./b", "a\\b", "C:a", "a\u0000b", "a\ud800"]) {
      await expect(openOcfl(input(authored(), [file(path, new Uint8Array())]))).rejects.toThrow();
    }
    const base = authored();
    const name = "résumé%2F.txt";
    const value = { ...base, versions: { v1: { ...base.versions.v1, state: { ["0".repeat(64)]: [name] } } } };
    expect((await openOcfl(input(value))).entries("v1")[0]!.path).toBe(name);
    await expect(openOcfl(input(authored()), { maxPathBytes: 3 })).rejects.toThrow("path bytes");
  });
  it("retains unknown fixity declarations inert and refuses malformed timestamp/profile shapes", async () => {
    const value = { ...authored(), fixity: { "example-opaque": { abcdef: ["v1/content/a"] } } };
    const view = await openOcfl(input(value));
    expect(view.inventory.fixity).toEqual(value.fixity);
    for (
      const created of [
        "2026-02-30T00:00:00Z",
        "2026-01-01T00:00Z",
        "2026-01-01T00:00:00+24:00",
        "2026-01-01T00:00:60Z",
      ]
    ) {
      await expect(openOcfl(input({ ...authored(), versions: { v1: { ...authored().versions.v1, created } } }))).rejects
        .toThrow();
    }
    await expect(openOcfl(input({ ...authored(), extra: true }))).rejects.toThrow("strict 1.1");
    await expect(openOcfl(input({ ...authored(), type: "https://ocfl.io/1.0/spec/#inventory" }))).rejects.toThrow(
      "strict 1.1",
    );
  });
  it("admits whole verification before source IO and distinguishes source, decoded and returned budgets", async () => {
    const view = await openOcfl(genuine());
    for (const options of [{ maxVerifyBytes: 0 }, { maxSourceBytes: 0 }, { maxRequests: 0 }, { maxDecodedBytes: 0 }]) {
      await expect(view.verifyContent("v1", "a.txt", { subtle: crypto.subtle, ...options })).rejects.toThrow("limit");
    }
    await expect(view.verifyInventory({ subtle: crypto.subtle, maxDecodedBytes: 0 })).rejects.toThrow("limit");
    await expect(view.verifyInventory({ subtle: crypto.subtle, maxVerifyBytes: 16 * 1024 * 1024 + 1 })).rejects.toThrow(
      "hard ceiling",
    );
    expect((await view.verifyContent("v1", "a.txt", { subtle: crypto.subtle, maxOutputBytes: 0 })).scope).toBe(
      "selected-content",
    );
    await expect(view.read("v1", "a.txt", { maxOutputBytes: 0 })).rejects.toThrow("limit");
    const selected = view.source("v1", "a.txt", { maxSourceBytes: 6 });
    await selected.read(0, 3);
    await selected.read(3, 3);
    await expect(selected.read(0, 1)).rejects.toThrow("limit");
  });
  it("captures borrowed source descriptors and forwards aborts without accepting native extent spoofing", async () => {
    const original = genuine();
    const root = original.find((entry) => entry.path === "inventory.json")!;
    const content = original.find((entry) => entry.path.endsWith("content/a.txt"))!;
    let calls = 0;
    const mutable = {
      size: content.source.size,
      stability: "caller" as const,
      identity: "before",
      async read(offset: number, length: number, options?: { signal?: AbortSignal }) {
        calls++;
        expect(options?.signal?.aborted ?? false).toBe(false);
        return content.source.read(offset, length);
      },
    };
    const view = await openOcfl(
      original.map((entry) => entry === content ? { path: entry.path, source: mutable } : entry),
    );
    mutable.size = 0;
    mutable.identity = "after";
    mutable.read = async () => {
      throw new Error("replaced");
    };
    const selected = view.source("v1", "a.txt");
    expect(selected.identity).toBe("before");
    expect(decode(await selected.read(0, 6))).toBe("first\n");
    expect(calls).toBe(1);
    const abort = new AbortController();
    abort.abort(new Error("stop"));
    await expect(selected.read(0, 1, { signal: abort.signal })).rejects.toThrow("stop");
    const spoof = new Uint8Array(1);
    Object.defineProperty(spoof, "byteLength", { value: root.source.size });
    await expect(
      openOcfl([{
        path: "inventory.json",
        source: {
          size: root.source.size,
          stability: "caller",
          async read() {
            return spoof;
          },
        },
      }], { maxChunkBytes: 65536 }),
    ).rejects.toThrow("incomplete extent");
    await expect(openOcfl([{
      path: "inventory.json",
      source: {
        size: 0,
        async read() {
          return new Uint8Array();
        },
      },
    }])).rejects.toThrow("stable sources");
  });
  it("honors an additional per-operation ledger and cancellation of an in-flight source read", async () => {
    const view = await openOcfl(genuine());
    const extra = createArchiveLedger({ maxOutputBytes: 1 });
    await expect(view.read("v1", "a.txt", { ledger: extra })).rejects.toThrow("limit");
    const controller = new AbortController();
    const original = genuine();
    const content = original.find((entry) => entry.path.endsWith("content/a.txt"))!;
    const modified = original.map((entry) =>
      entry === content
        ? {
          path: entry.path,
          source: {
            size: entry.source.size,
            stability: "caller" as const,
            async read(offset: number, length: number, options?: { signal?: AbortSignal }) {
              controller.abort(new Error("during read"));
              expect(options?.signal?.aborted).toBe(true);
              return entry.source.read(offset, length);
            },
          },
        }
        : entry
    );
    const selected = (await openOcfl(modified)).source("v1", "a.txt", { signal: controller.signal });
    await expect(selected.read(0, 1, { signal: new AbortController().signal })).rejects.toThrow("during read");
    await expect(view.verifyContent("v1", "a.txt", {
      subtle: {
        async digest() {
          controller.abort();
          throw new Error("crypto failed");
        },
      },
    })).rejects.toThrow("crypto failed");
  });
  it("shares an explicit multi-file ledger and checks policy before any impossible buffer acquisition", async () => {
    let reads = 0;
    const huge = {
      size: 1024 * 1024 + 1,
      stability: "caller" as const,
      async read() {
        reads++;
        throw new Error("must not read");
      },
    };
    await expect(openOcfl([{ path: "inventory.json", source: huge }])).rejects.toThrow("metadata file bytes");
    expect(reads).toBe(0);
    const ledger = createArchiveLedger({ maxDecodedBytes: 1 });
    await expect(openOcfl(genuine(), { ledger })).rejects.toThrow("limit");
    await expect(openOcfl(genuine(), { maxReferences: 1 })).rejects.toThrow("references");
    await expect(openOcfl(genuine(), { maxFiles: 1 })).rejects.toThrow("files");
  });
});
