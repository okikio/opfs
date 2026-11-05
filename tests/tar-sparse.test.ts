import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createArchiveLedger, openTar } from "../src/archive/tar.ts";
import { readTarStream } from "../src/archive/stream.ts";
import { createTarAdapter } from "../src/view/tar.ts";
import { createFileSystem } from "../src/filesystem.ts";
import ordinary from "./fixtures/tar/independent.json" with { type: "json" };
import nativeFixture from "./fixtures/tar-sparse/independent.json" with { type: "json" };

const fixtures: {
  readonly fixtures: readonly {
    readonly profile: string;
    readonly archive: { readonly base64: string };
    readonly payloads: Readonly<Record<string, { readonly base64: string }>>;
  }[];
} = nativeFixture;
const utf8 = (text: string) => new TextEncoder().encode(text);
const source = (bytes: Uint8Array) => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
function equal(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  for (let at = 0; at < actual.length; at++) {
    if (actual[at] !== expected[at]) throw new Error(`TAR logical byte differs at ${at}.`);
  }
}
/** Authored corruption controls reuse a native header, never the project writer. */
function wire(
  map = "2\n8\n4\n32\n3\n",
  payload: Uint8Array = utf8("ABCDxyz"),
  logical = "64",
  additional: readonly [string, string][] = [],
): Uint8Array {
  const records: [string, string][] = [
    ["GNU.sparse.major", "1"],
    ["GNU.sparse.minor", "0"],
    ["GNU.sparse.name", "sparse.bin"],
    ["GNU.sparse.realsize", logical],
    ...additional,
  ];
  const metadata = utf8(
    records.map(([key, value]) => {
      const body = `${key}=${value}\n`;
      let length = utf8(body).length + 3;
      while (length !== utf8(body).length + String(length).length + 1) {
        length = utf8(body).length + String(length).length + 1;
      }
      return `${length} ${body}`;
    }).join(""),
  );
  const mapBytes = utf8(map);
  const padded = Math.ceil(mapBytes.length / 512) * 512;
  const storedSize = padded + payload.length;
  const template = decodeBase64(ordinary.pax.archive).subarray(2048, 2560);
  function header(size: number, type: number): Uint8Array {
    const bytes = template.slice();
    bytes[156] = type;
    bytes.set(utf8(`${size.toString(8).padStart(11, "0")}\0`), 124);
    bytes.fill(32, 148, 156);
    const sum = bytes.reduce((sum, byte) => sum + byte, 0);
    bytes.set(utf8(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
    return bytes;
  }
  const member = 512 + Math.ceil(metadata.length / 512) * 512;
  const bytes = new Uint8Array(member + 512 + Math.ceil(storedSize / 512) * 512 + 1024);
  bytes.set(header(metadata.length, 120));
  bytes.set(metadata, 512);
  bytes.set(header(storedSize, 48), member);
  bytes.set(mapBytes, member + 512);
  bytes.set(payload, member + 512 + padded);
  return bytes;
}

describe("indexed GNU PAX sparse 1.0", () => {
  it("reconstructs genuine GNU originals independently consumed by Python/libarchive", async () => {
    const fixture = fixtures.fixtures.find((item) => item.profile === "1.0")!;
    const archive = await openTar(source(decodeBase64(fixture.archive.base64)));
    expect(archive.entries.length).toBe(Object.keys(fixture.payloads).length);
    let mapSpanned = false;
    for (const entry of archive.entries) {
      const original = decodeBase64(fixture.payloads[entry.name]!.base64);
      equal((await archive.read(entry.id)).bytes, original);
      expect(entry.size).toBe(original.length);
      if (entry.sparse) {
        expect(entry.sparse.profile).toBe("gnu-pax-1.0");
        expect(entry.sparse.storedSize).toBeLessThan(entry.size);
        if (entry.sparse.mapBytes > 512) mapSpanned = true;
      }
    }
    expect(mapSpanned).toBe(true);
    for (const fixture of fixtures.fixtures.filter((item) => item.profile !== "1.0")) {
      await expect(openTar(source(decodeBase64(fixture.archive.base64)))).rejects.toMatchObject({
        code: "unsupported-profile",
      });
    }
  });

  it("reads only recorded intersections and returns holes without source I/O", async () => {
    const calls: [number, number][] = [];
    const original = source(wire());
    const archive = await openTar({
      ...original,
      async read(at, length, opts) {
        calls.push([at, length]);
        return await original.read(at, length, opts);
      },
    });
    const entry = archive.entries[0]!;
    expect(entry.sparse!.extents).toEqual([{ offset: 8, length: 4, storedOffset: 0 }, {
      offset: 32,
      length: 3,
      storedOffset: 4,
    }]);
    calls.length = 0;
    const hole = await archive.read(entry.id, { offset: 12, length: 20, maxRequests: 0, maxSourceBytes: 0 });
    equal(hole.bytes, new Uint8Array(20));
    expect(hole.work).toEqual({ sourceBytes: 0, requests: 0, decodedBytes: 20, outputBytes: 20 });
    expect(calls.length).toBe(0);
    const selected = await archive.read(entry.id, { offset: 10, length: 24 });
    expect(calls.map((call) => call[1])).toEqual([2, 2]);
    const expected = new Uint8Array(24);
    expected.set(utf8("CD"));
    expected.set(utf8("xy"), 22);
    equal(selected.bytes, expected);
    expect(selected.work).toEqual({ sourceBytes: 4, requests: 2, decodedBytes: 24, outputBytes: 24 });
    calls.length = 0;
    await expect(archive.read(entry.id, { maxSourceBytes: 6 })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(archive.read(entry.id, { maxRequests: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(archive.read(entry.id, { maxOutputBytes: 63 })).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(calls.length).toBe(0);
  });

  it("rejects malformed maps, unsafe arithmetic, overlaps and physical-size mismatches", async () => {
    for (
      const map of [
        "-1\n",
        "2\n8\n4\n9\n3\n",
        "1\n63\n7\n",
        "1\n9007199254740992\n7\n",
        "1\n0\n8\n",
        "2\n8\n4\n32\n2\n",
        "1\n0\n7\nnonzero",
        "999999999999999999999\n",
        "1\n0\n",
      ]
    ) {
      await expect(openTar(source(wire(map)))).rejects.toBeDefined();
    }
    for (const logical of ["-1", "9007199254740992", ""]) {
      await expect(openTar(source(wire(undefined, undefined, logical)))).rejects.toBeDefined();
    }
    await expect(openTar(source(wire(undefined, undefined, undefined, [["GNU.sparse.major", "1"]])))).rejects
      .toMatchObject({ code: "invalid-archive" });
    const bytes = wire();
    // The final map newline is inside the first map block; nonzero padding must fail.
    bytes[1536 + 40] = 1;
    await expect(openTar(source(bytes))).rejects.toMatchObject({ code: "invalid-archive" });
  });

  it("bounds declared sparse logical bytes, map bytes, extent counts and output expansion", async () => {
    for (const opts of [{ maxSparseBytes: 63 }, { maxSparseExtents: 1 }, { maxMetadataBytes: 511 }]) {
      await expect(openTar(source(wire()), opts)).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    const emptyMap = await openTar(source(wire("0\n", new Uint8Array(), "1000000")));
    expect(emptyMap.entries[0]!.sparse!.extents.length).toBe(0);
    await expect(emptyMap.read(0, { maxDecodedBytes: 999999 })).rejects.toMatchObject({ code: "budget-exceeded" });
    const empty = await emptyMap.read(0, { offset: 999999, length: 1, maxRequests: 0 });
    equal(empty.bytes, new Uint8Array(1));
  });

  it("keeps one-shot readers refusing sparse before any visitor sees condensed bytes", async () => {
    let visited = false;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(wire());
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readTarStream(stream, () => {
      visited = true;
    })).rejects.toMatchObject({ code: "unsupported-profile" });
    expect(visited).toBe(false);
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it("retains opening/additional ledgers and joins opening/read cancellation for holes", async () => {
    for (const kind of ["sourceBytes", "requests"] as const) {
      const ledger = createArchiveLedger({ maxSourceBytes: 100000, maxRequests: 100000 });
      let calls = 0;
      const original = source(wire());
      const archive = await openTar({
        ...original,
        async read(at, length, opts) {
          calls++;
          return await original.read(at, length, opts);
        },
      }, { ledger });
      ledger.reserve(kind, 100000 - ledger.inspect()[kind]);
      calls = 0;
      await expect(archive.read(0)).rejects.toMatchObject({ code: "budget-exceeded" });
      expect(calls).toBe(0);
    }
    const additional = createArchiveLedger({ maxOutputBytes: 0 });
    const archive = await openTar(source(wire()));
    await expect(archive.read(0, { ledger: additional })).rejects.toMatchObject({ code: "budget-exceeded" });
    const local = await openTar(source(wire()), { maxRequests: archive.work.requests });
    await expect(local.read(0)).rejects.toMatchObject({ code: "budget-exceeded" });
    const owner = new AbortController();
    const bound = await openTar(source(wire()), { signal: owner.signal });
    const reason = new Error("opening owner aborted");
    owner.abort(reason);
    await expect(bound.read(0, { offset: 12, length: 1 })).rejects.toBe(reason);
    const aborted = AbortSignal.abort(reason);
    await expect(archive.read(0, { offset: 12, length: 0, signal: aborted })).rejects.toBe(reason);
  });

  it("captures the borrowed source/options before awaits and validates evidence", async () => {
    const original = source(wire());
    const mutable = { ...original };
    const options = { maxSparseExtents: 2 };
    const pending = openTar(mutable, options);
    mutable.read = async () => {
      throw new Error("replaced source");
    };
    mutable.size = 0;
    mutable.identity = "changed after open began";
    mutable.stability = "caller";
    options.maxSparseExtents = 0;
    const archive = await pending;
    expect(archive.source.stability).toBe("immutable");
    expect(archive.source.identity).not.toBe("changed after open began");
    equal((await archive.read(0, { offset: 8, length: 4 })).bytes, utf8("ABCD"));
    await expect(openTar({ ...original, stability: "unknown" } as unknown as ByteSourceType)).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(openTar({ ...original, identity: "x".repeat(8193) })).rejects.toBeInstanceOf(TypeError);
  });

  it("repairs ordinary TAR lifetime authority without double-charging the same ledger", async () => {
    const ledger = createArchiveLedger();
    const owner = new AbortController();
    const archive = await openTar(source(decodeBase64(ordinary.pax.archive)), { ledger, signal: owner.signal });
    const entry = archive.entries.find((entry) => entry.kind === "file")!;
    const before = ledger.inspect();
    const result = await archive.read(entry.id, { length: 3, ledger });
    const after = ledger.inspect();
    expect(after.sourceBytes - before.sourceBytes).toBe(3);
    expect(after.requests - before.requests).toBe(1);
    expect(after.decodedBytes - before.decodedBytes).toBe(3);
    expect(after.outputBytes - before.outputBytes).toBe(3);
    expect(result.work.sourceBytes).toBe(3);
    const reason = new Error("ordinary opening scope stopped");
    owner.abort(reason);
    await expect(archive.read(entry.id, { length: 0 })).rejects.toBe(reason);
  });

  it("retains a provider error during abort and observes hole-only terminal aborts", async () => {
    const original = source(wire());
    const signal = new AbortController();
    const provider = new Error("physical extent failed");
    let fail = false;
    const archive = await openTar({
      ...original,
      async read(at, length, options) {
        if (fail) {
          signal.abort(new Error("simultaneous abort"));
          throw provider;
        }
        return await original.read(at, length, options);
      },
    });
    fail = true;
    await expect(archive.read(0, { signal: signal.signal })).rejects.toBe(provider);
    const terminal = new AbortController();
    const reason = new Error("logical-hole admission aborted");
    const plain = await openTar(source(wire()));
    await expect(plain.read(0, {
      offset: 12,
      length: 1,
      signal: terminal.signal,
      ledger: {
        reserve(kind) {
          if (kind === "decodedBytes") terminal.abort(reason);
        },
        inspect: () => ({ sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 }),
      },
    })).rejects.toBe(reason);
  });

  it("projects logical sparse bytes through the existing read-only TAR view", async () => {
    const archive = await openTar(source(wire()));
    const filesystem = createFileSystem(createTarAdapter(archive));
    try {
      const bytes = await filesystem.readFile("/sparse.bin");
      expect(bytes.length).toBe(64);
      equal(bytes.subarray(8, 12), utf8("ABCD"));
      equal(bytes.subarray(12, 32), new Uint8Array(20));
    } finally {
      await filesystem.close();
    }
  });
});
