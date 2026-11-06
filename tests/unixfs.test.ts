import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { openCar } from "../src/content/car.ts";
import { createBlobSource } from "../src/source.ts";
import { createArchiveLedger, openUnixfs } from "../src/content/unixfs.ts";
import type { UnixfsBlockReaderType, UnixfsNodeType } from "../src/content/unixfs.ts";
import { parseCid } from "../src/content/cid.ts";
import adapted from "./fixtures/unixfs/authored.json" with { type: "json" };
import inlineFailure from "./fixtures/unixfs/inline-failure.json" with { type: "json" };
import fixture from "./fixtures/unixfs/independent.json" with { type: "json" };

function reader(profile: typeof fixture.profiles[number]): UnixfsBlockReaderType {
  const blocks = new Map(profile.blocks.map((block) => [parseCid(block.cid).id, decodeBase64(block.base64)]));
  return async (cid, options) => {
    const bytes = blocks.get(cid);
    if (!bytes) throw new Error(`Missing block ${cid}`);
    if (bytes.length > options.maxBytes) throw new Error("Foreign reader acquisition cap");
    return bytes;
  };
}
/** The oracle is retained original/native output established before the candidate existed. */
function exact(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) throw new Error(`Original-byte mismatch at ${i}`);
  }
}
async function select(root: UnixfsNodeType, path: string): Promise<UnixfsNodeType> {
  for (const name of path.split("/")) {
    if (root.kind !== "directory") throw new Error("Expected directory fixture");
    root = await root.open(name);
  }
  return root;
}

describe("verified UnixFS native composition", () => {
  it("matches every native full file and range across raw/PB leaves and optional metadata", async () => {
    for (const profile of fixture.profiles) {
      const root = await openUnixfs(profile.cid, reader(profile), { subtle: crypto.subtle });
      expect(root.kind).toBe("directory");
      for (const file of profile.files) {
        const selected = await select(root, file.path);
        if (selected.kind !== "file") throw new Error("Expected file fixture");
        exact((await selected.read()).bytes, decodeBase64(file.base64));
        expect((await selected.verify()).scope).toBe("complete-file");
        for (const range of file.ranges) exact((await selected.read(range)).bytes, decodeBase64(range.base64));
        const source = selected.source();
        exact(await source.read(0, source.size), decodeBase64(file.base64));
        if (profile.profile === "metadata") {
          expect(selected.metadata.mode).toBe(416);
          expect(selected.metadata.mtime).toEqual({ seconds: "-12345", nanoseconds: 123456789 });
        }
      }
      const symlink = await select(root, "shortcut");
      expect(symlink.kind).toBe("symlink");
      if (symlink.kind === "symlink") expect(new TextDecoder().decode(symlink.target)).toBe("nested/data.bin");
    }
  });
  it("reads genuine standalone raw and DAG-PB root files", async () => {
    for (const fixtureRoot of fixture.singleRoots) {
      const value = await openUnixfs(fixtureRoot.cid, async () => decodeBase64(fixtureRoot.base64), {
        subtle: crypto.subtle,
      });
      if (value.kind !== "file") throw new Error("Expected single root file");
      exact((await value.read()).bytes, decodeBase64(fixtureRoot.original));
      expect(value.integrity).toBe("sha2-256-block");
    }
  });
});

/** Authored protobuf bytes isolate refusal and partial-graph behavior; they are not genuine producer evidence. */
function join(...parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
function uint(input: number | bigint): Uint8Array {
  let value = BigInt(input);
  const bytes: number[] = [];
  while (value >= 128n) {
    bytes.push(Number(value & 127n) | 128);
    value >>= 7n;
  }
  bytes.push(Number(value));
  return new Uint8Array(bytes);
}
function field(key: number, value: number | bigint | Uint8Array): Uint8Array {
  return typeof value === "number" || typeof value === "bigint"
    ? join(uint(key * 8), uint(value))
    : join(uint(key * 8 + 2), uint(value.length), value);
}
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
async function identity(
  bytes: Uint8Array,
  codec = 0x70,
): Promise<{ cid: string; wire: Uint8Array; bytes: Uint8Array }> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
  const wire = join(uint(1), uint(codec), uint(0x12), uint(32), digest);
  return { cid: parseCid(wire).id, wire, bytes };
}
async function graph() {
  const a = await identity(text("aaa"), 0x55),
    b = await identity(text("BBBB"), 0x55),
    empty = await identity(new Uint8Array(), 0x55);
  const links = [a, b, empty].map((item) => field(2, join(field(1, item.wire), field(3, 999999))));
  const inner = join(field(1, 2), field(2, text("H")), field(3, 8), field(4, 3), field(4, 4), field(4, 0));
  const root = await identity(join(...links, field(1, inner)));
  const blocks = new Map([root, a, b, empty].map((item) => [item.cid, item.bytes]));
  let calls = 0;
  const read: UnixfsBlockReaderType = async (cid) => {
    calls++;
    const bytes = blocks.get(cid);
    if (!bytes) throw new Error(`Missing ${cid}`);
    return bytes;
  };
  return { a, b, empty, root, blocks, read, calls: () => calls };
}
async function authored(bytes: Uint8Array) {
  const root = await identity(bytes);
  return openUnixfs(root.cid, async () => bytes, { subtle: crypto.subtle });
}

describe("UnixFS selected-range evidence and graph admission", () => {
  it("keeps unselected missing blocks unexamined but fails selected and complete traversals", async () => {
    const data = await graph(), root = await openUnixfs(data.root.cid, data.read, { subtle: crypto.subtle });
    if (root.kind !== "file") throw new Error("Expected authored file");
    data.blocks.delete(data.b.cid);
    const prefix = await root.read({ length: 4 });
    exact(prefix.bytes, text("Haaa"));
    expect(prefix.scope).toBe("selected-file-range");
    await expect(root.read({ offset: 4, length: 4 })).rejects.toThrow("Missing");
    await expect(root.verify()).rejects.toThrow("Missing");
    data.blocks.set(data.b.cid, data.b.bytes);
    data.blocks.delete(data.empty.cid);
    exact((await root.read()).bytes, text("HaaaBBBB")); // A full-length range still skips zero-length children.
    await expect(root.verify()).rejects.toThrow("Missing");
    const before = data.calls();
    expect((await root.read({ offset: 8, length: 0 })).scope).toBe("selected-file-range");
    expect(data.calls()).toBe(before);
    await expect(root.read({ offset: 9, length: 0 })).rejects.toThrow();
  });

  it("checks actual child logical sizes and never substitutes Tsize for file sizes", async () => {
    const data = await graph();
    const inner = join(field(1, 2), field(3, 2), field(4, 2));
    const block = join(field(2, field(1, data.a.wire)), field(1, inner));
    const id = await identity(block);
    data.blocks.set(id.cid, block);
    const value = await openUnixfs(id.cid, data.read, { subtle: crypto.subtle });
    if (value.kind !== "file") throw new Error("Expected authored file");
    expect(value.size).toBe(2);
    await expect(value.read()).rejects.toThrow("logical size");
    const original = await openUnixfs(data.root.cid, data.read, { subtle: crypto.subtle });
    if (original.kind !== "file") throw new Error("Expected authored file");
    exact((await original.read()).bytes, text("HaaaBBBB"));
  });

  it("counts repeated edges and bounded cache hits without treating shared blocks as missing data", async () => {
    const profile = fixture.profiles[0]!,
      root = await openUnixfs(profile.cid, reader(profile), { subtle: crypto.subtle });
    const file = await select(root, "repeat.bin");
    if (file.kind !== "file") throw new Error("Expected file");
    const cached = await file.verify();
    expect(cached.work.cacheHits).toBeGreaterThan(0);
    expect(cached.work.edges).toBeGreaterThan(cached.work.requests);
    const uncachedRoot = await openUnixfs(profile.cid, reader(profile), { subtle: crypto.subtle, maxCacheBytes: 0 });
    const uncached = await select(uncachedRoot, "repeat.bin");
    if (uncached.kind !== "file") throw new Error("Expected file");
    const result = await uncached.verify();
    expect(result.work.cacheHits).toBe(0);
    expect(result.work.cacheBytes).toBe(0);
    expect(result.work.requests).toBeGreaterThan(cached.work.requests);
  });

  it("enforces ancestor request/output ledgers for child handles and repeated source reads", async () => {
    const data = await graph();
    const root = await openUnixfs(data.root.cid, data.read, { subtle: crypto.subtle, maxRequests: 2 });
    if (root.kind !== "file") throw new Error("Expected file");
    const source = root.source({ maxRequests: 1 });
    exact(await source.read(1, 1), text("a"));
    const calls = data.calls();
    await expect(source.read(1, 1)).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(data.calls()).toBe(calls);
    await expect(root.read({ length: 1, maxOutputBytes: 0 })).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(data.calls()).toBe(calls);
    const profile = fixture.profiles[0]!,
      directory = await openUnixfs(profile.cid, reader(profile), { subtle: crypto.subtle });
    if (directory.kind !== "directory") throw new Error("Expected directory");
    const child = await directory.open("repeat.bin", { maxRequests: 1 });
    if (child.kind !== "file") throw new Error("Expected file");
    await expect(child.read({ length: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
  });

  it("preflights depth, requests, parser, index, links and returned-byte allocation separately", async () => {
    const data = await graph();
    let calls = 0;
    for (const options of [{ maxRequests: 0 }, { maxNodes: 0 }, { maxSteps: 0 }]) {
      await expect(openUnixfs(data.root.cid, async () => {
        calls++;
        return data.root.bytes;
      }, { subtle: crypto.subtle, ...options })).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    expect(calls).toBe(0);
    for (const options of [{ maxLinks: 0 }, { maxIndexBytes: 0 }, { maxDecodedBytes: 0 }, { maxSourceBytes: 0 }]) {
      await expect(openUnixfs(data.root.cid, data.read, { subtle: crypto.subtle, ...options })).rejects.toMatchObject({
        code: "budget-exceeded",
      });
    }
    const flat = await openUnixfs(data.root.cid, data.read, { subtle: crypto.subtle, maxDepth: 0 });
    if (flat.kind !== "file") throw new Error("Expected file");
    exact((await flat.read({ length: 1 })).bytes, text("H"));
    const before = data.calls();
    await expect(flat.read({ offset: 1, length: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(data.calls()).toBe(before);
    for (
      const options of [{ maxBlockBytes: 8388609 }, { maxDepth: 129 }, { maxSteps: Number.NaN }, { maxCacheBytes: -1 }]
    ) {
      await expect(openUnixfs(data.root.cid, data.read, { subtle: crypto.subtle, ...options })).rejects.toThrow();
    }
  });
});

describe("UnixFS strict protobuf and namespace profile", () => {
  it("rejects ambiguous authority fields, unknown wires, invalid tree sizes and unsupported node types", async () => {
    const data = await graph(), child = field(2, field(1, data.a.wire));
    const emptyFile = field(1, join(field(1, 2), field(3, 0)));
    const bad = [
      join(emptyFile, emptyFile), // Duplicate PBNode.Data.
      field(9, 0),
      field(1, join(field(1, 2), field(1, 2), field(3, 0))),
      field(1, join(field(1, 2), field(2, text("missing filesize")))),
      join(child, field(1, join(field(1, 2), field(3, 3)))), // Missing blocksizes.
      join(child, emptyFile, child), // Interleaved Links/Data/Links.
      join(field(2, join(field(2, text("x")), field(1, data.a.wire))), field(1, field(1, 1))),
      join(field(2, join(field(1, data.a.wire), field(1, data.a.wire))), field(1, field(1, 1))),
      join(
        field(2, join(field(1, data.a.wire), field(2, text("named")))),
        field(1, join(field(1, 2), field(3, 3), field(4, 3))),
      ),
      field(1, join(field(1, 2), field(3, 9007199254740992n))),
      field(1, new Uint8Array([8, 0x82, 0, 24, 0])), // Overlong Type varint.
      field(1, join(field(1, 2), field(3, 0), field(9, 0))),
      ...[0, 3, 5, 6].map((type) => field(1, field(1, type))),
      join(child, field(1, join(field(1, 4), field(2, text("target"))))),
    ];
    for (const bytes of bad) await expect(authored(bytes)).rejects.toThrow();
  });

  it("keeps literal names and original ordering while rejecting duplicate and invalid UTF8 names", async () => {
    const child = await identity(text("child"), 0x55);
    const names = ["z", "a/b", ".", "..", "%2F", "\ufeffa", "a"];
    const links = names.map((name) => field(2, join(field(1, child.wire), field(2, text(name)))));
    const bytes = join(...links, field(1, field(1, 1))), root = await identity(bytes);
    const view = await openUnixfs(root.cid, async (cid) => cid === root.cid ? bytes : child.bytes, {
      subtle: crypto.subtle,
    });
    if (view.kind !== "directory") throw new Error("Expected directory");
    expect(view.entries.map((entry) => entry.name)).toEqual(names);
    for (const name of names) {
      const file = await view.open(name);
      if (file.kind !== "file") throw new Error("Expected file");
      exact((await file.read()).bytes, text("child"));
    }
    await expect(view.open("a%2Fb")).rejects.toThrow("absent");
    await expect(view.open("\ud800")).rejects.toThrow("well-formed");
    await expect(view.open("x".repeat(4097))).rejects.toThrow("bounded");
    await expect(authored(join(links[0]!, links[0]!, field(1, field(1, 1))))).rejects.toThrow(
      "duplicate directory name",
    );
    await expect(
      authored(
        join(field(2, join(field(1, child.wire), field(2, new Uint8Array([0xed, 0xa0, 0x80])))), field(1, field(1, 1))),
      ),
    ).rejects.toThrow();
  });

  it("preserves uint32 metadata without applying reserved mode bits or inventing absent time", async () => {
    const bytes = field(1, join(field(1, 2), field(3, 0), field(7, 0x800001ff)));
    const file = await authored(bytes);
    expect(file.metadata).toEqual({ modeRaw: 0x800001ff, mode: 0x1ff });
    for (const nanos of [0, 1000000000]) {
      const fixed = new Uint8Array(4);
      new DataView(fixed.buffer).setUint32(0, nanos, true);
      await expect(authored(field(1, join(field(1, 2), field(3, 0), field(8, join(field(1, 0), uint(21), fixed))))))
        .rejects.toThrow("fractional");
    }
    await expect(authored(field(1, join(field(1, 2), field(3, 0), field(7, 0x100000000n))))).rejects.toThrow("uint32");
    const missing = await authored(field(1, field(1, 2)));
    expect(missing.metadata).toEqual({});
    if (missing.kind !== "file") throw new Error("Expected file");
    expect(missing.size).toBe(0);
    expect((await missing.verify()).scope).toBe("complete-file");
  });
});

describe("UnixFS borrowed capabilities and cancellation", () => {
  it("rejects corrupted blocks and unsupported hashes before trusting parser results", async () => {
    const data = await graph(), corrupt = data.root.bytes.slice();
    corrupt[0] = corrupt[0]! ^ 1;
    await expect(openUnixfs(data.root.cid, async () => corrupt, { subtle: crypto.subtle })).rejects.toThrow(
      "digest mismatch",
    );
    let calls = 0;
    const unknown = parseCid(new Uint8Array([1, 0x55, 0, 1, 65])).id;
    await expect(openUnixfs(unknown, async () => {
      calls++;
      return text("A");
    }, { subtle: crypto.subtle })).rejects.toThrow("SHA2-256");
    expect(calls).toBe(0);
    await expect(
      openUnixfs(data.root.cid, async () => data.root.bytes, { subtle: { digest: async () => new ArrayBuffer(0) } }),
    ).rejects.toThrow("digest mismatch");
  });

  it("snapshots native extents and caller buffers before asynchronous hashing", async () => {
    const original = text("owned snapshot"), id = await identity(original, 0x55), incoming = original.slice();
    Object.defineProperty(incoming, "byteLength", {
      get() {
        throw new Error("shadow byteLength must not run");
      },
    });
    Object.defineProperty(incoming, "length", {
      get() {
        throw new Error("shadow length must not run");
      },
    });
    const value = await openUnixfs(id.cid, async () => incoming, {
      subtle: {
        async digest(algorithm, bytes) {
          incoming.fill(0);
          return await crypto.subtle.digest(algorithm, bytes);
        },
      },
    });
    if (value.kind !== "file") throw new Error("Expected file");
    exact((await value.read()).bytes, original);
    const first = await value.read();
    first.bytes.fill(0);
    exact((await value.read()).bytes, original);
  });

  it("retains opening, directory and source cancellation when fresh local signals are supplied", async () => {
    const data = await graph(), controller = new AbortController(), failure = new Error("parent closed");
    const file = await openUnixfs(data.root.cid, data.read, { subtle: crypto.subtle, signal: controller.signal });
    if (file.kind !== "file") throw new Error("Expected file");
    const source = file.source();
    controller.abort(failure);
    await expect(file.read({ length: 1, signal: new AbortController().signal })).rejects.toBe(failure);
    await expect(source.read(0, 1, { signal: new AbortController().signal })).rejects.toBe(failure);
    const local = new AbortController(), profile = fixture.profiles[0]!;
    const root = await openUnixfs(profile.cid, reader(profile), { subtle: crypto.subtle });
    if (root.kind !== "directory") throw new Error("Expected directory");
    const child = await root.open("repeat.bin", { signal: local.signal });
    if (child.kind !== "file") throw new Error("Expected file");
    local.abort(failure);
    await expect(child.read({ length: 1, signal: new AbortController().signal })).rejects.toBe(failure);
    await expect(child.source().read(0, 1, { signal: new AbortController().signal })).rejects.toBe(failure);
  });

  it("checks authority after borrowed acquisition and uninterruptible digest work", async () => {
    const data = await graph(), failure = new Error("borrowed work stopped"), first = new AbortController();
    let hashes = 0;
    await expect(openUnixfs(data.root.cid, async () => {
      first.abort(failure);
      return data.root.bytes;
    }, {
      signal: first.signal,
      subtle: {
        async digest(algorithm, bytes) {
          hashes++;
          return await crypto.subtle.digest(algorithm, bytes);
        },
      },
    })).rejects.toBe(failure);
    expect(hashes).toBe(0);
    const second = new AbortController();
    await expect(openUnixfs(data.root.cid, data.read, {
      signal: second.signal,
      subtle: {
        async digest(algorithm, bytes) {
          const result = await crypto.subtle.digest(algorithm, bytes);
          second.abort(failure);
          return result;
        },
      },
    })).rejects.toBe(failure);
    await expect(openUnixfs(data.root.cid, async () => {
      throw failure;
    }, { subtle: crypto.subtle })).rejects.toBe(failure);
    await expect(openUnixfs(data.root.cid, data.read, {
      subtle: {
        async digest() {
          throw failure;
        },
      },
    })).rejects.toBe(failure);
  });
});

describe("UnixFS composed block sources and aggregate owners", () => {
  it("composes an independently verified CAR block reader without changing its declared roots", async () => {
    const profile = fixture.profiles[0]!;
    const car = await openCar(createBlobSource(new Blob([new Uint8Array(decodeBase64(profile.car)).buffer])));
    const root = await openUnixfs(profile.cid, async (cid, options) => (await car.read(cid, options)).bytes, {
      subtle: crypto.subtle,
    });
    const file = await select(root, "nested/data.bin");
    if (file.kind !== "file") throw new Error("Expected file");
    const expected = decodeBase64(profile.files.find((item) => item.path === "nested/data.bin")!.base64);
    exact((await file.read({ offset: 61, length: 13 })).bytes, expected.slice(61, 74));
    expect(car.roots).toEqual([parseCid(profile.cid).id]);
  });

  it("charges the same external ledger once and refuses exhausted request owners before acquisition", async () => {
    const data = await graph(), ledger = createArchiveLedger();
    const value = await openUnixfs(data.root.cid, data.read, { subtle: crypto.subtle, ledger });
    if (value.kind !== "file") throw new Error("Expected file");
    const before = ledger.inspect(),
      result = await value.read({ offset: 1, length: 1, ledger }),
      after = ledger.inspect();
    for (const key of ["requests", "sourceBytes", "decodedBytes", "outputBytes"] as const) {
      expect(after[key] - before[key]).toBe(result.work[key]);
    }
    const exhausted = createArchiveLedger({ maxRequests: 0 }), calls = data.calls();
    await expect(value.read({ offset: 1, length: 1, ledger: exhausted })).rejects.toMatchObject({
      code: "budget-exceeded",
    });
    expect(data.calls()).toBe(calls);
  });

  it("binds digest once and rejects oversized native extents before invoking it", async () => {
    const data = await graph();
    let hashes = 0;
    const capability = {
      digest: async (algorithm: AlgorithmIdentifier, bytes: BufferSource): Promise<ArrayBuffer> => {
        hashes++;
        return await crypto.subtle.digest(algorithm, bytes);
      },
    };
    const file = await openUnixfs(data.root.cid, data.read, { subtle: capability });
    if (file.kind !== "file") throw new Error("Expected file");
    capability.digest = async () => {
      throw new Error("changed capability must not be discovered");
    };
    exact((await file.read({ offset: 1, length: 1 })).bytes, text("a"));
    expect(hashes).toBe(2);
    const oversized = new Uint8Array(2);
    Object.defineProperty(oversized, "byteLength", { value: 0 });
    const count = hashes;
    await expect(openUnixfs(data.root.cid, async (_cid, options) => {
      expect(options.maxBytes).toBe(1);
      return oversized;
    }, {
      subtle: {
        async digest(algorithm, bytes) {
          hashes++;
          return await crypto.subtle.digest(algorithm, bytes);
        },
      },
      maxBlockBytes: 1,
    })).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(hashes).toBe(count);
  });
});

describe("UnixFS independently consumed wire variants and explicit native differences", () => {
  it("matches native no-inline Data-first/Links-first and expanded/packed/mixed size variants", async () => {
    for (const variant of adapted.variants) {
      expect(variant.nativeCompleteExact).toBe(true);
      expect(variant.nativeRangeExact).toBe(true);
      const blocks = new Map(variant.blocks.map((item) => [item.cid, decodeBase64(item.base64)]));
      const view = await openUnixfs(variant.cid, async (cid) => {
        const bytes = blocks.get(cid);
        if (!bytes) throw new Error("Native adapted block missing");
        return bytes;
      }, { subtle: crypto.subtle });
      if (view.kind !== "file") throw new Error("Expected file");
      exact((await view.read()).bytes, decodeBase64(variant.original));
      exact((await view.read({ offset: 5, length: 13 })).bytes, decodeBase64(variant.original).slice(5, 18));
      expect((await view.verify()).scope).toBe("complete-file");
    }
  });

  it("follows primary inline-before-links semantics while retaining Kubo's different native bytes", async () => {
    const blocks = new Map(inlineFailure.blocks.map((item) => [item.cid, decodeBase64(item.base64)]));
    const value = await openUnixfs(inlineFailure.cid, async (cid) => {
      const bytes = blocks.get(cid);
      if (!bytes) throw new Error("Inline fixture block absent");
      return bytes;
    }, { subtle: crypto.subtle });
    if (value.kind !== "file") throw new Error("Expected file");
    const result = await value.read();
    exact(result.bytes, decodeBase64(inlineFailure.expectedPrimaryBase64));
    expect(result.bytes.length).toBe(25);
    expect(decodeBase64(inlineFailure.nativeActualBase64).length).toBe(18);
    expect(inlineFailure.evidenceProfile).toContain("mismatch");
  });

  it("returns exact bytes for every small range and rejects every truncated native DAG-PB header", async () => {
    const data = await graph(), value = await openUnixfs(data.root.cid, data.read, { subtle: crypto.subtle });
    if (value.kind !== "file") throw new Error("Expected file");
    const expected = text("HaaaBBBB");
    for (let offset = 0; offset <= 8; offset++) {
      for (let length = 0; length <= 8 - offset; length++) {
        exact((await value.read({ offset, length })).bytes, expected.slice(offset, offset + length));
      }
    }
    const root = decodeBase64(fixture.profiles[0]!.blocks[0]!.base64);
    for (let length = 0; length < root.length; length++) {
      await expect(authored(root.slice(0, length))).rejects.toThrow();
    }
  });
});
