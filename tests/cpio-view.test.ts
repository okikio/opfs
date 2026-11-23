import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createFileSystem } from "../mod.ts";
import { createBlobSource } from "../src/source.ts";
import { openCpio } from "../src/archive/cpio.ts";
import type { CpioArchiveType, CpioEntryType } from "../src/archive/cpio.ts";
import { createCpioAdapter } from "../src/view/cpio.ts";
import fixture from "./fixtures/cpio/gnu.json" with { type: "json" };

async function archive(bytes = decodeBase64(fixture.crc.archive)): Promise<CpioArchiveType> {
  const parsed = await openCpio(createBlobSource(new Blob([new Uint8Array(bytes).buffer])));
  // This test explicitly selects a namespace without the producer's known symlink.
  // createCpioAdapter itself never silently drops unsupported entries.
  return { ...parsed, entries: parsed.entries.filter((entry) => entry.kind !== "symbolic-link") };
}

describe("CPIO filesystem view", () => {
  it("lists directories and resolves GNU last-data aliases through the public filesystem", async () => {
    const input = await archive();
    const fs = createFileSystem(createCpioAdapter(input));
    try {
      expect((await fs.stat("/folder"))?.kind).toBe("directory");
      const first = await fs.readFile("/alias-first", { at: 2, length: 3 });
      const last = await fs.readFile("/alias-last", { at: 2, length: 3 });
      expect(first).toEqual(new Uint8Array([2, 3, 4]));
      expect(last).toEqual(first);
      expect((await Array.fromAsync(fs.readDir("/folder"))).map(({ name }) => name)).toEqual(["data.bin"]);
      expect(await fs.readFile("/alias-first", { at: 1000000, length: 3 })).toEqual(new Uint8Array());
      expect(fs.inspect().adapter.native.write).toBe(false);
    } finally {
      await fs.close();
    }
    const alias = input.entries.find((entry) => entry.name === "alias-first")!;
    expect((await input.read(alias.id, { length: 3 })).bytes).toEqual(new Uint8Array([0, 1, 2]));
  });

  it("keeps CRC verification enabled for small prefixes and forwards explicit unchecked/budget policies", async () => {
    const bytes = decodeBase64(fixture.crc.archive);
    const input = await archive(bytes);
    const alias = input.entries.find((entry) => entry.name === "alias-first")!;
    // Walk producer headers independently to change the final byte in the physical data owner's extent.
    let at = 0;
    const text = new TextDecoder();
    for (let id = 0; id <= alias.dataEntryId!; id++) {
      const size = parseInt(text.decode(bytes.subarray(at + 54, at + 62)), 16);
      const names = parseInt(text.decode(bytes.subarray(at + 94, at + 102)), 16);
      const body = Math.ceil((at + 110 + names) / 4) * 4;
      if (id === alias.dataEntryId) bytes[body + size - 1] = bytes[body + size - 1]! ^ 1;
      at = Math.ceil((body + size) / 4) * 4;
    }
    const damaged = await archive(bytes);
    const checked = createFileSystem(createCpioAdapter(damaged));
    const unchecked = createFileSystem(
      createCpioAdapter(damaged, { verify: false, maxOutputBytes: 3, maxSourceBytes: 3 }),
    );
    const bounded = createFileSystem(createCpioAdapter(input, { maxDecodedBytes: 3 }));
    try {
      await expect(checked.readFile("/alias-first", { length: 3 })).rejects.toMatchObject({
        cause: { code: "checksum-mismatch" },
      });
      expect(await unchecked.readFile("/alias-first", { length: 3 })).toEqual(new Uint8Array([0, 1, 2]));
      await expect(unchecked.readFile("/alias-first", { length: 4 })).rejects.toMatchObject({ code: "too-large" });
      await expect(bounded.readFile("/alias-first", { length: 3 })).rejects.toMatchObject({ code: "too-large" });
    } finally {
      await checked.close();
      await unchecked.close();
      await bounded.close();
    }
  });

  it("refuses symlinks, special entries and unsafe namespaces before reading payloads", async () => {
    const original = await openCpio(
      createBlobSource(new Blob([new Uint8Array(decodeBase64(fixture.crc.archive)).buffer])),
    );
    expect(() => createCpioAdapter(original)).toThrow();
    const file = original.entries.find((entry) => entry.kind === "file")!;
    let reads = 0;
    const input = (entries: readonly CpioEntryType[]): CpioArchiveType => ({
      ...original,
      entries,
      read() {
        reads++;
        return Promise.reject(new Error("unexpected member read"));
      },
    });
    for (const name of ["../escape", "/absolute", "a//b", "C:/host", "a\\b"]) {
      expect(() => createCpioAdapter(input([{ ...file, name }]))).toThrow();
    }
    expect(() => createCpioAdapter(input([{ ...file, name: "same" }, { ...file, id: 999, name: "same" }]))).toThrow();
    expect(() => createCpioAdapter(input([{ ...file, name: "same" }, { ...file, id: 999, name: "same/child" }])))
      .toThrow();
    for (const kind of ["device", "fifo", "socket", "symbolic-link"] as const) {
      expect(() => createCpioAdapter(input([{ ...file, kind }]))).toThrow();
    }
    expect(reads).toBe(0);
  });

  it("refuses mutations before consuming input and forwards cancellation", async () => {
    const input = await archive();
    const fs = createFileSystem(createCpioAdapter(input));
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        pulls++;
      },
    }, { highWaterMark: 0 });
    try {
      await expect(fs.writeFile("/new", stream)).rejects.toMatchObject({ code: "not-supported" });
      await expect(fs.remove("/alias-first")).rejects.toMatchObject({ code: "not-supported" });
      await expect(fs.mkdir("/new")).rejects.toMatchObject({ code: "not-supported" });
      expect(pulls).toBe(0);
      const controller = new AbortController();
      const reason = new Error("stop preview");
      controller.abort(reason);
      await expect(fs.readFile("/alias-first", { length: 3, signal: controller.signal })).rejects.toMatchObject({
        code: "aborted",
        cause: reason,
      });
    } finally {
      await fs.close();
      await stream.cancel();
    }
  });
});
