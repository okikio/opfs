import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { encodeHex } from "@std/encoding/hex";
import { murmur } from "../src/content/murmur.ts";
import { createArchiveLedger, openUnixfs } from "../src/content/unixfs.ts";
import type { UnixfsBlockReaderType, UnixfsHamtType, UnixfsOptionsType } from "../src/content/unixfs.ts";
import { parseCid } from "../src/content/cid.ts";
import boundary from "./fixtures/unixfs/hamt/authored.json" with { type: "json" };
import native from "./fixtures/unixfs/hamt/independent.json" with { type: "json" };
import hashes from "./fixtures/unixfs/hamt/hash-reference.json" with { type: "json" };

const options = { subtle: crypto.subtle, hamtProfile: "kubo-fanout-256" } as const;
function graph() {
  const blocks = new Map(native.blocks.map((block) => [block.cid, decodeBase64(block.base64)]));
  const calls: string[] = [];
  const read: UnixfsBlockReaderType = async (cid, options) => {
    calls.push(cid);
    const bytes = blocks.get(cid);
    if (!bytes) throw new Error(`Missing ${cid}`);
    if (bytes.length > options.maxBytes) throw new Error("Foreign acquisition cap");
    return bytes;
  };
  return { blocks, calls, read };
}
async function root(read: UnixfsBlockReaderType, extra: Partial<UnixfsOptionsType> = {}): Promise<UnixfsHamtType> {
  const view = await openUnixfs(native.rootCid, read, { ...options, ...extra });
  if (view.kind !== "hamt-directory") throw new Error("Expected HAMT fixture");
  return view;
}
function exact(actual: Uint8Array, expected: Uint8Array): void {
  expect(encodeHex(actual)).toBe(encodeHex(expected));
}

describe("explicit native UnixFS HAMT profile", () => {
  it("matches independently executed original public-domain hash vectors, including every tail length", () => {
    for (const vector of hashes.vectors) expect(encodeHex(murmur(decodeBase64(vector.input)))).toBe(vector.digest);
  });
  it("requires explicit profile admission before exposing a HAMT", async () => {
    const data = graph();
    await expect(openUnixfs(native.rootCid, data.read, { subtle: crypto.subtle })).rejects.toThrow("hamtProfile");
    let calls = 0;
    await expect(openUnixfs(native.rootCid, async () => {
      calls++;
      return new Uint8Array();
    }, {
      ...options,
      hamtProfile: "draft" as "kubo-fanout-256",
    })).rejects.toThrow("named supported");
    expect(calls).toBe(0);
  });
  it("matches all genuine native full files, selected ranges and directory inventories", async () => {
    const data = graph(), view = await root(data.read);
    expect(view.profile).toBe("kubo-fanout-256");
    expect(view.work.hamtShards).toBe(1);
    expect(view.work.nameHashes).toBeGreaterThan(0);
    for (const original of native.files) {
      const parts = original.path.split("/");
      let selected = await view.open(parts[0]!);
      if (parts.length > 1) {
        if (selected.kind !== "hamt-directory") throw new Error("Expected native nested shard directory");
        selected = await selected.open(parts[1]!);
      }
      if (selected.kind !== "file") throw new Error("Expected original file");
      exact((await selected.read()).bytes, decodeBase64(original.base64));
      for (const range of original.ranges) exact((await selected.read(range)).bytes, decodeBase64(range.base64));
      expect((await selected.verify()).scope).toBe("complete-file");
      exact(await selected.source().read(0, selected.size), decodeBase64(original.base64));
    }
    const listed = await view.list();
    expect(listed.entries.map((entry) => entry.name).sort()).toEqual(native.listings[0]!.expectedNames);
    expect(listed.scope).toBe("complete-directory-links");
    expect(listed.work.directoryEntries).toBe(native.listings[0]!.expectedNames.length);
    const nested = await view.open("nested");
    if (nested.kind !== "hamt-directory") throw new Error("Expected nested HAMT");
    expect((await nested.list()).entries.map((entry) => entry.name).sort()).toEqual(native.listings[1]!.expectedNames);
  });
  it("does not acquire file contents during complete directory listing", async () => {
    const data = graph(), view = await root(data.read);
    const shards = new Set(native.shards.map((shard) => shard.cid));
    for (const cid of [...data.blocks.keys()]) if (!shards.has(cid)) data.blocks.delete(cid);
    data.calls.length = 0;
    const listed = await view.list();
    expect(listed.entries.length).toBe(native.listings[0]!.expectedNames.length);
    expect(data.calls.every((cid) => shards.has(cid))).toBe(true);
    await expect(view.open("file-000.txt")).rejects.toThrow("Missing");
  });
});

/** These authored wire cases isolate rejection rules; they are not genuine importer output. */
function join(...values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}
function uint(input: number): Uint8Array {
  let value = input;
  const bytes: number[] = [];
  while (value >= 128) {
    bytes.push((value % 128) | 128);
    value = Math.floor(value / 128);
  }
  return new Uint8Array([...bytes, value]);
}
function field(key: number, value: number | Uint8Array): Uint8Array {
  return typeof value === "number"
    ? join(uint(key * 8), uint(value))
    : join(uint(key * 8 + 2), uint(value.length), value);
}
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
async function identity(bytes: Uint8Array, codec = 0x70) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
  const wire = join(uint(1), uint(codec), uint(0x12), uint(32), hash);
  return { bytes, wire, cid: parseCid(wire).id };
}
const route = (name: string): Uint8Array => {
  const digest = hashes.vectors.find((vector) => encodeHex(decodeBase64(vector.input)) === encodeHex(text(name)))
    ?.digest;
  if (!digest) throw new Error("Need independent hash vector");
  return new Uint8Array(digest.match(/../g)!.map((value) => Number.parseInt(value, 16)));
};
const prefix = (bucket: number): string => bucket.toString(16).toUpperCase().padStart(2, "0");
async function authored(
  links: readonly { name: string; wire: Uint8Array }[],
  changes: { bitmap?: Uint8Array; hash?: number; fanout?: number; extra?: Uint8Array } = {},
) {
  const bitmap = new Uint8Array(32);
  for (const link of links) {
    const bucket = Number.parseInt(link.name.slice(0, 2), 16);
    bitmap[31 - (bucket >> 3)]! |= 1 << (bucket & 7);
  }
  const inner = join(
    field(1, 5),
    field(2, changes.bitmap ?? bitmap),
    field(5, changes.hash ?? 0x22),
    field(6, changes.fanout ?? 256),
    changes.extra ?? new Uint8Array(),
  );
  return identity(
    join(...links.map((entry) => field(2, join(field(1, entry.wire), field(2, text(entry.name))))), field(1, inner)),
  );
}
async function openAuthored(item: Awaited<ReturnType<typeof identity>>) {
  return openUnixfs(item.cid, async () => item.bytes, options);
}

describe("HAMT partial traversal and bounded authority", () => {
  it("ignores an unselected missing shard during lookup but requires it for a complete listing", async () => {
    const data = graph(), view = await root(data.read);
    const local = native.shards.find((item) => item.cid === native.rootCid)!;
    const leaf = local.links.find((link) => link.Name.length > 2)!;
    const unselected = local.links.find((link) => link.Name.length === 2)!;
    data.blocks.delete(unselected.Hash["/"]);
    const selected = await view.open(leaf.Name.slice(2));
    expect(selected.kind).toBe("file");
    await expect(view.list()).rejects.toThrow("Missing");
    await expect(view.open("absent literal name")).rejects.toThrow("absent");
  });
  it("keeps lifetime, operation and identical external ledgers authoritative", async () => {
    const data = graph(),
      ledger = createArchiveLedger({ maxSourceBytes: 1048576, maxRequests: 1000, maxDecodedBytes: 1048576 });
    const view = await root(data.read, { ledger });
    const before = ledger.inspect(), listed = await view.list({ ledger }), after = ledger.inspect();
    for (const key of ["sourceBytes", "requests", "decodedBytes", "outputBytes"] as const) {
      expect(after[key] - before[key]).toBe(listed.work[key]);
    }
    const count = data.calls.length;
    await expect(view.list({ maxRequests: 0 })).rejects.toThrow("requests");
    expect(data.calls.length).toBe(count);
    await expect(view.open("file-000.txt", { maxDecodedBytes: 0 })).rejects.toThrow("decodedBytes");
    expect(data.calls.length).toBe(count);
    const limited = await root(data.read, { maxRequests: 1 });
    const beforeLimited = data.calls.length;
    await expect(limited.list()).rejects.toThrow("requests");
    expect(data.calls.length).toBe(beforeLimited);
  });
  it("enforces directory materialization and name/hash work caps", async () => {
    const data = graph(), view = await root(data.read, { maxDirectoryEntries: 0 });
    await expect(view.list()).rejects.toThrow("directory entries");
    const normal = await root(data.read);
    const count = data.calls.length;
    for (const name of ["", "\ud800", "x".repeat(4095), "\u{1F600}".repeat(1024)]) {
      await expect(normal.open(name)).rejects.toThrow();
    }
    expect(data.calls.length).toBe(count);
    const empty = await authored([], { bitmap: new Uint8Array() });
    const bounded = await openUnixfs(empty.cid, async () => empty.bytes, { ...options, maxSteps: 100 });
    if (bounded.kind !== "hamt-directory") throw new Error("Expected empty HAMT");
    await expect(bounded.open("a".repeat(100))).rejects.toThrow("steps");
  });
  it("retains parent and lookup cancellation even when children provide a fresh signal", async () => {
    const data = graph(), controller = new AbortController();
    const view = await root(data.read, { signal: controller.signal });
    controller.abort(new Error("opening stopped"));
    const count = data.calls.length;
    await expect(view.open("file-000.txt", { signal: new AbortController().signal })).rejects.toThrow(
      "opening stopped",
    );
    await expect(view.list({ signal: new AbortController().signal })).rejects.toThrow("opening stopped");
    expect(data.calls.length).toBe(count);
    const second = await root(data.read), childController = new AbortController();
    const file = await second.open("file-000.txt", { signal: childController.signal });
    if (file.kind !== "file") throw new Error("Expected file");
    childController.abort(new Error("child stopped"));
    await expect(file.read({ signal: new AbortController().signal })).rejects.toThrow("child stopped");
    await expect(file.source().read(0, file.size, { signal: new AbortController().signal })).rejects.toThrow(
      "child stopped",
    );
  });
  it("snapshots the selected profile and options before foreign acquisition", async () => {
    const data = graph();
    const mutable: UnixfsOptionsType & { hamtProfile: "kubo-fanout-256" } = { ...options };
    const view = await openUnixfs(native.rootCid, async (cid, call) => {
      Object.assign(mutable, { hamtProfile: "untrusted", maxDirectoryEntries: 0 });
      return data.read(cid, call);
    }, mutable);
    if (view.kind !== "hamt-directory") throw new Error("Expected HAMT");
    expect((await view.list()).entries.length).toBe(native.listings[0]!.expectedNames.length);
  });
});

describe("HAMT structural and routing refusals", () => {
  it("rejects bitmap length/count/occupancy, duplicate or unordered buckets, and lowercase prefixes", async () => {
    const leaf = await identity(text("authored leaf"), 0x55), name = "file-000.txt", bucket = route(name)[0]!;
    const link = { name: prefix(bucket) + name, wire: leaf.wire };
    const bitmap = new Uint8Array(32);
    bitmap[31 - (bucket >> 3)] = 1 << (bucket & 7);
    for (
      const item of [
        await authored([link], { bitmap: new Uint8Array(33) }),
        await authored([link], { bitmap: new Uint8Array(32) }),
        await authored([link], { bitmap: bitmap.toReversed() }),
        await authored([link, link]),
        await authored([{ ...link, name: "ABfirst" }, { ...link, name: "10second" }]),
        await authored([{ ...link, name: "abname" }]),
      ]
    ) await expect(openAuthored(item)).rejects.toThrow();
  });
  it("rejects unsupported hash/fanout, duplicate authority and names routed under the wrong bucket", async () => {
    const leaf = await identity(text("authored leaf"), 0x55), name = "file-000.txt", bucket = route(name)[0]!;
    const link = { name: prefix(bucket) + name, wire: leaf.wire };
    for (
      const item of [
        await authored([link], { hash: 0x12 }),
        await authored([link], { fanout: 512 }),
        await authored([link], { extra: field(5, 0x22) }),
        await authored([{ ...link, name: prefix(bucket ^ 1) + name }]),
      ]
    ) await expect(openAuthored(item)).rejects.toThrow();
  });
  it("rejects wrong descendant routing and non-shard targets without claiming complete inventory", async () => {
    const leaf = await identity(text("authored leaf"), 0x55), name = "file-000.txt", hash = route(name);
    const child = await authored([{ name: prefix(hash[1]! ^ 1) + name, wire: leaf.wire }]);
    const parent = await authored([{ name: prefix(hash[0]!), wire: child.wire }]);
    const blocks = new Map([parent, child, leaf].map((item) => [item.cid, item.bytes]));
    const read: UnixfsBlockReaderType = async (cid) => blocks.get(cid)!;
    const view = await openUnixfs(parent.cid, read, options);
    if (view.kind !== "hamt-directory") throw new Error("Expected authored HAMT");
    await expect(view.open(name)).rejects.toThrow("complete hash route");
    await expect(view.list()).rejects.toThrow("complete hash route");
    const wrong = await authored([{ name: prefix(hash[0]!), wire: leaf.wire }]);
    blocks.set(wrong.cid, wrong.bytes);
    const other = await openUnixfs(wrong.cid, read, options);
    if (other.kind !== "hamt-directory") throw new Error("Expected authored HAMT");
    await expect(other.open(name)).rejects.toThrow("different node type");
    await expect(other.list()).rejects.toThrow("different node type");
  });
});

describe("independently consumed HAMT hash-depth boundary", () => {
  it("matches native eight-level trimmed/padded originals and refuses a ninth hash level", async () => {
    for (const variant of boundary.variants) {
      const blocks = new Map(variant.blocks.map((block) => [block.cid, decodeBase64(block.base64)]));
      const calls: string[] = [];
      const read: UnixfsBlockReaderType = async (cid) => {
        calls.push(cid);
        const bytes = blocks.get(cid);
        if (!bytes) throw new Error("Missing boundary block");
        return bytes;
      };
      const directory = await openUnixfs(variant.rootCid, read, options);
      if (directory.kind !== "hamt-directory") throw new Error("Expected boundary HAMT");
      if (variant.levels === 9) {
        expect(variant.nativeExitCode).toBe(1);
        expect(variant.nativeStderr).toContain("sharded directory too deep");
        calls.length = 0;
        await expect(directory.open(variant.lookupName)).rejects.toThrow("64-bit hash");
        expect(calls.length).toBe(7); // The eighth shard refuses its internal edge before acquiring a ninth.
        calls.length = 0;
        await expect(directory.list()).rejects.toThrow("64-bit hash");
        expect(calls.length).toBe(7);
      } else {
        expect(variant.nativeExitCode).toBe(0);
        const file = await directory.open(variant.lookupName);
        if (file.kind !== "file") throw new Error("Expected boundary file");
        exact((await file.read()).bytes, decodeBase64(variant.original));
        exact((await file.read({ offset: 5, length: 13 })).bytes, decodeBase64(variant.original).subarray(5, 18));
        expect((await directory.list()).entries.map((entry) => entry.name)).toEqual([variant.lookupName]);
        const limited = await openUnixfs(variant.rootCid, read, { ...options, maxDepth: 7 });
        if (limited.kind !== "hamt-directory") throw new Error("Expected boundary HAMT");
        expect((await limited.list()).scope).toBe("complete-directory-links");
        const before = calls.length;
        await expect(limited.open(variant.lookupName)).rejects.toThrow("depth");
        expect(calls.length - before).toBe(7); // File depth8 fails before its callback; directory shards fit depth7.
      }
    }
  });
});
