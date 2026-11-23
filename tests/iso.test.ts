import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { createArchiveLedger, openIso } from "../src/archive/iso.ts";
import fixtures from "./fixtures/iso/independent.json" with { type: "json" };

const source = (bytes: Uint8Array) => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
/** Compare every original byte without allocating deep-equality state for each element. */
function equalBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  for (let at = 0; at < expected.byteLength; at++) {
    if (actual[at] !== expected[at]) throw new Error(`ISO native original-byte mismatch at ${at}.`);
  }
}
/** Independently authored minimal records isolate numeric, extent and traversal defects. */
function image(): Uint8Array {
  const bytes = new Uint8Array(24 * 2048);
  const data = new DataView(bytes.buffer);
  const both = (at: number, value: number, width = 4) => {
    if (width === 2) {
      data.setUint16(at, value, true);
      data.setUint16(at + 2, value);
    } else {
      data.setUint32(at, value, true);
      data.setUint32(at + 4, value);
    }
  };
  const descriptor = (sector: number, type: number) => {
    bytes[sector * 2048] = type;
    bytes.set(new TextEncoder().encode("CD001"), sector * 2048 + 1);
    bytes[sector * 2048 + 6] = 1;
  };
  const record = (at: number, block: number, size: number, name: Uint8Array, directory: boolean) => {
    const length = 33 + name.length + (name.length % 2 === 0 ? 1 : 0);
    bytes[at] = length;
    both(at + 2, block);
    both(at + 10, size);
    bytes[at + 25] = directory ? 2 : 0;
    both(at + 28, 1, 2);
    bytes[at + 32] = name.length;
    bytes.set(name, at + 33);
    return length;
  };
  descriptor(16, 1);
  descriptor(17, 255);
  const pvd = 16 * 2048;
  both(pvd + 80, 24);
  both(pvd + 120, 1, 2);
  both(pvd + 124, 1, 2);
  both(pvd + 128, 2048, 2);
  bytes[pvd + 881] = 1;
  both(pvd + 132, 10);
  data.setUint32(pvd + 140, 18, true);
  data.setUint32(pvd + 148, 19);
  record(pvd + 156, 20, 2048, new Uint8Array([0]), true);
  let at = 20 * 2048;
  at += record(at, 20, 2048, new Uint8Array([0]), true);
  at += record(at, 20, 2048, new Uint8Array([1]), true);
  record(at, 21, 4, new TextEncoder().encode("A.TXT;1"), false);
  bytes.set([1, 2, 3, 4], 21 * 2048);
  return bytes;
}

/** Parent IDs preserve names independently of host extraction conventions. */
function pathOf(entries: readonly { id: number; parentId: number; name: string }[], id: number): string {
  const parts: string[] = [];
  let entry = entries[id]!;
  while (true) {
    parts.unshift(entry.name);
    if (entry.parentId === -1) break;
    entry = entries[entry.parentId]!;
  }
  return "/" + parts.join("/");
}

describe("bounded selected-tree ISO inspection", () => {
  for (const [name, fixture] of Object.entries(fixtures.images)) {
    for (const [namespace, expected] of Object.entries(fixture.profiles)) {
      it(`reads genuine ${name} ${namespace} payloads independently checked by isoinfo and libarchive`, async () => {
        const bytes = decodeBase64(fixture.archive);
        const calls: { offset: number; length: number }[] = [];
        const archive = await openIso({
          size: bytes.length,
          stability: "immutable",
          async read(offset, length) {
            calls.push({ offset, length });
            return bytes.slice(offset, offset + length);
          },
        }, {
          namespace: namespace as "primary" | "joliet",
          ...(namespace === "joliet" && name === "xorriso-joliet" ? { jolietParent: "ignore-extent" as const } : {}),
        });
        const indexing = calls.slice();
        expect(archive.entries.filter((entry) => entry.kind === "file").length).toBe(expected.length);
        for (const oracle of expected) {
          const entry = archive.entries.find((entry) => pathOf(archive.entries, entry.id) === oracle.name)!;
          expect(entry).toBeDefined();
          const payload = decodeBase64(oracle.body);
          equalBytes((await archive.read(entry.id)).bytes, payload);
          if (payload.length) {
            expect((await archive.read(entry.id, { offset: payload.length - 1, length: 1 })).bytes).toEqual(
              payload.slice(-1),
            );
          }
          expect(
            indexing.some((call) =>
              call.offset < entry.offset + entry.size && call.offset + call.length > entry.offset
            ),
          ).toBe(false);
        }
        expect(archive.work.sourceBytes).toBeLessThan(65536);
      });
    }
  }
  it("requires observable Joliet parent compatibility and still validates its framing and extent bounds", async () => {
    const bytes = decodeBase64(fixtures.images["xorriso-joliet"].archive);
    await expect(openIso(source(bytes), { namespace: "joliet" })).rejects.toMatchObject({ code: "invalid-archive" });
    const archive = await openIso(source(bytes), { namespace: "joliet", jolietParent: "ignore-extent" });
    expect(archive.parents.policy).toBe("ignore-extent");
    expect(archive.parents.mismatches.length).toBe(1);
    const mismatch = archive.parents.mismatches[0]!;
    expect(mismatch.declaredExtent).toBe(24 * 2048);
    expect(mismatch.expectedExtent).toBe(23 * 2048);
    expect(archive.work.outputBytes).toBe(24);
    await expect(openIso(source(bytes), { namespace: "joliet", jolietParent: "ignore-extent", maxOutputBytes: 23 }))
      .rejects.toMatchObject({ code: "budget-exceeded" });
    for (
      const change of [
        (copy: Uint8Array) => {
          copy[mismatch.recordOffset + 33] = 0;
        },
        (copy: Uint8Array) => {
          const data = new DataView(copy.buffer);
          data.setUint32(mismatch.recordOffset + 2, 0xffffffff, true);
          data.setUint32(mismatch.recordOffset + 6, 0xffffffff);
        },
        (copy: Uint8Array) => {
          copy[mismatch.recordOffset + 14] = 1;
        },
      ]
    ) {
      const copy = bytes.slice();
      change(copy);
      await expect(openIso(source(copy), { namespace: "joliet", jolietParent: "ignore-extent" })).rejects.toMatchObject(
        { code: "invalid-archive" },
      );
    }
    await expect(openIso(source(image()), { jolietParent: "ignore-extent" })).rejects.toThrow(TypeError);
  });
  it("preserves literal versions, returns exact owned ranges and borrows a bounded nested source", async () => {
    const archive = await openIso(source(image()));
    expect(archive.entries[0]!.name).toBe("A.TXT;1");
    expect((await archive.read(0, { offset: 1, length: 2 })).bytes).toEqual(new Uint8Array([2, 3]));
    expect((await archive.read(0)).integrity).toBe("none");
    const member = archive.member(0, { maxOutputBytes: 3 });
    expect(await member.read(0, 2)).toEqual(new Uint8Array([1, 2]));
    await expect(member.read(2, 2)).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(archive.read(0, { offset: 4, length: 1 })).rejects.toThrow(RangeError);
  });
  it("refuses malformed directory records, endian disagreement and out-of-volume extents", async () => {
    for (
      const change of [
        (bytes: Uint8Array) => {
          bytes[16 * 2048 + 84] = 1;
        },
        (bytes: Uint8Array) => {
          bytes[20 * 2048 + 68] = 255;
        },
        (bytes: Uint8Array) => {
          bytes[20 * 2048 + 33] = 1;
        },
        (bytes: Uint8Array) => {
          bytes[20 * 2048 + 200] = 1;
        },
        (bytes: Uint8Array) => {
          const data = new DataView(bytes.buffer);
          data.setUint32(20 * 2048 + 68 + 2, 25, true);
          data.setUint32(20 * 2048 + 68 + 6, 25);
        },
      ]
    ) {
      const bytes = image();
      change(bytes);
      await expect(openIso(source(bytes))).rejects.toMatchObject({ code: "invalid-archive" });
    }
  });
  it("refuses unsupported namespaces and extent semantics before reading payload bytes", async () => {
    await expect(openIso(source(image()), { namespace: "rock-ridge" })).rejects.toMatchObject({
      code: "unsupported-profile",
    });
    await expect(openIso(source(image()), { namespace: "joliet" })).rejects.toMatchObject({
      code: "unsupported-profile",
    });
    for (const at of [20 * 2048 + 68 + 1, 20 * 2048 + 68 + 26, 20 * 2048 + 68 + 27]) {
      const bytes = image();
      bytes[at] = 1;
      await expect(openIso(source(bytes))).rejects.toMatchObject({ code: "unsupported-profile" });
    }
  });
  it("keeps duplicate physical file identities and inert unusual names without normalization", async () => {
    const bytes = image();
    const at = 20 * 2048 + 68;
    const length = bytes[at]!;
    bytes.set(bytes.slice(at, at + length), at + length);
    const literal = new TextEncoder().encode("\\A\n.T;1");
    bytes.set(literal, at + length + 33);
    const archive = await openIso(source(bytes));
    expect(archive.entries.map((entry) => entry.name)).toEqual(["A.TXT;1", "\\A\n.T;1"]);
    expect(archive.entries[0]!.offset).toBe(archive.entries[1]!.offset);
    expect(archive.entries[0]!.recordOffset).not.toBe(archive.entries[1]!.recordOffset);
    expect((await archive.read(1)).bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
  it("preserves borrowed source failures and stops admission after an active read is aborted", async () => {
    const failure = new Error("source failed");
    await expect(openIso({
      size: image().length,
      stability: "caller",
      read() {
        return Promise.reject(failure);
      },
    })).rejects.toBe(failure);
    const bytes = image();
    const controller = new AbortController();
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const opening = openIso({
      size: bytes.length,
      stability: "caller",
      async read(offset, length) {
        calls++;
        started();
        await waiting;
        return bytes.slice(offset, offset + length);
      },
    }, { signal: controller.signal });
    await active;
    controller.abort(failure);
    release();
    await expect(opening).rejects.toBe(failure);
    expect(calls).toBe(1);
  });
  it("rejects directory cycles before queueing and retains caller option snapshots", async () => {
    const bytes = image();
    const data = new DataView(bytes.buffer);
    const at = 20 * 2048 + 68;
    bytes[at + 25] = 2;
    data.setUint32(at + 2, 20, true);
    data.setUint32(at + 6, 20);
    data.setUint32(at + 10, 2048, true);
    data.setUint32(at + 14, 2048);
    await expect(openIso(source(bytes))).rejects.toMatchObject({ code: "invalid-archive" });
    const original = image();
    const options = { maxEntries: 1 };
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const opening = openIso({
      size: original.length,
      stability: "immutable",
      async read(offset, length) {
        await barrier;
        return original.slice(offset, offset + length);
      },
    }, options);
    options.maxEntries = 0;
    release();
    expect((await opening).entries.length).toBe(1);
  });
  it("refuses odd Joliet names and surrogate code units without interpreting them as UTF-16", async () => {
    const fixture = fixtures.images["genisoimage-joliet"];
    const original = decodeBase64(fixture.archive);
    const archive = await openIso(source(original), { namespace: "joliet" });
    const file = archive.entries.find((entry) => entry.kind === "file")!;
    for (
      const change of [
        (bytes: Uint8Array) => {
          bytes[file.recordOffset + 32] = 3;
          bytes[file.recordOffset + 36] = 0;
        },
        (bytes: Uint8Array) => {
          bytes[file.recordOffset + 33] = 0xd8;
          bytes[file.recordOffset + 34] = 0;
        },
      ]
    ) {
      const bytes = original.slice();
      change(bytes);
      await expect(openIso(source(bytes), { namespace: "joliet" })).rejects.toMatchObject({ code: "invalid-archive" });
    }
  });
  it("retains opening ledgers and cancellation across direct and nested reads without duplicate reservation", async () => {
    const bytes = image();
    let calls = 0;
    const captured = {
      size: bytes.length,
      stability: "immutable" as const,
      async read(offset: number, length: number) {
        calls++;
        return bytes.slice(offset, offset + length);
      },
    };
    const ledger = createArchiveLedger({ maxSourceBytes: 6144 });
    const archive = await openIso(captured, { ledger });
    expect(calls).toBe(3);
    await expect(archive.read(0)).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(archive.member(0).read(0, 1)).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(calls).toBe(3);
    const exact = createArchiveLedger({ maxSourceBytes: 6148 });
    const second = await openIso(source(bytes), { ledger: exact });
    await second.member(0, { ledger: exact }).read(0, 4);
    expect(exact.inspect().sourceBytes).toBe(6148);
    const controller = new AbortController();
    const third = await openIso(source(bytes), { signal: controller.signal, maxOutputBytes: 3 });
    await third.read(0, { length: 2 });
    await expect(third.member(0).read(0, 2)).rejects.toMatchObject({ code: "budget-exceeded" });
    const stop = new Error("opening lifetime stopped");
    controller.abort(stop);
    await expect(third.read(0, { length: 1, signal: new AbortController().signal })).rejects.toBe(stop);
    await expect(third.member(0).read(0, 1)).rejects.toBe(stop);
  });
  it("validates source descriptor evidence before acquiring bytes", async () => {
    let calls = 0;
    const read = async () => {
      calls++;
      return new Uint8Array();
    };
    await expect(openIso({ size: 0, stability: "wrong" as unknown as "caller", read })).rejects.toThrow(TypeError);
    await expect(openIso({ size: 0, stability: "caller", identity: 3 as unknown as string, read })).rejects.toThrow(
      TypeError,
    );
    await expect(openIso({ size: 0, stability: "caller", identity: "x".repeat(8193), read })).rejects.toThrow(
      TypeError,
    );
    expect(calls).toBe(0);
  });
  it("admits directories, names, output and shared aggregate work before further acquisition", async () => {
    for (
      const options of [{ maxEntries: 0 }, { maxDirectoryBytes: 2047 }, { maxNamesBytes: 1 }, { maxDescriptors: 1 }]
    ) {
      await expect(openIso(source(image()), options)).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    const archive = await openIso(source(image()));
    await expect(archive.read(0, { maxOutputBytes: 3 })).rejects.toMatchObject({ code: "budget-exceeded" });
    const ledger = createArchiveLedger({ maxOutputBytes: 3 });
    await archive.read(0, { length: 2, ledger });
    await expect(archive.read(0, { length: 2, ledger })).rejects.toMatchObject({ code: "budget-exceeded" });
    const controller = new AbortController();
    controller.abort(new Error("stop ISO"));
    await expect(openIso(source(image()), { signal: controller.signal })).rejects.toThrow("stop ISO");
  });
});
