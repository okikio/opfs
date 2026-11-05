import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createFileSystem } from "../mod.ts";
import { openZip } from "../src/archive/zip.ts";
import { createZipAdapter } from "../src/view/zip.ts";
import bzip from "./fixtures/zip-bzip/independent.json" with { type: "json" };
import lzma from "./fixtures/zip-lzma/independent.json" with { type: "json" };

/** Memory owner exposes disposal evidence; the archive and filesystem only borrow it. */
function source(bytes: Uint8Array) {
  let closed = false;
  return {
    size: bytes.length,
    stability: "immutable" as const,
    reads: 0,
    disposals: 0,
    async read(at: number, count: number, options?: { signal?: AbortSignal }) {
      options?.signal?.throwIfAborted();
      if (closed) throw new Error("Source owner already disposed.");
      this.reads++;
      return bytes.slice(at, at + count);
    },
    async [Symbol.asyncDispose]() {
      this.disposals++;
      closed = true;
    },
  };
}

/** Change only genuine member CRC metadata; the original compressed codec stream stays valid. */
function wrongCrc(raw: Uint8Array, name: string): Uint8Array {
  const bytes = raw.slice(), data = new DataView(bytes.buffer);
  let at = data.getUint32(bytes.length - 6, true);
  while (data.getUint32(at, true) === 0x02014b50) {
    const length = data.getUint16(at + 28, true),
      extra = data.getUint16(at + 30, true),
      comment = data.getUint16(at + 32, true);
    if (new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + length)) === name) {
      const local = data.getUint32(at + 42, true), crc = data.getUint32(at + 16, true) ^ 1;
      data.setUint32(at + 16, crc, true);
      data.setUint32(local + 14, crc, true);
      return bytes;
    }
    at += 46 + length + extra + comment;
  }
  throw new Error("Independent fixture member missing.");
}

for (
  const [kind, fixture] of [
    ["bzip", bzip.fixtures.find((item) => item.name === "python-1")!],
    ["lzma", lzma.fixtures.find((item) => item.name === "python")!],
  ] as const
) {
  const member = fixture.members.find((item) => item.name === "many.bin")!;
  const original = decodeBase64(member.original.base64), raw = decodeBase64(fixture.archive.base64);
  describe(`native ${kind} ZIP through the filesystem view`, () => {
    it("reads exact selected bytes, rejects output beyond its cap before source I/O and borrows its archive/source", async () => {
      const input = source(raw), archive = await openZip(input);
      const policy = { maxOutputBytes: 16 };
      const fs = createFileSystem(createZipAdapter(archive, policy));
      policy.maxOutputBytes = 999999;
      try {
        expect((await fs.stat("/many.bin"))?.kind).toBe("file");
        expect(await fs.readFile("/many.bin", { at: 100023, length: 7 })).toEqual(original.slice(100023, 100030));
        input.reads = 0;
        await expect(fs.readFile("/many.bin", { length: 17 })).rejects.toMatchObject({ code: "too-large" });
        expect(input.reads).toBe(0);
        const stop = new AbortController(), reason = new Error("caller stops filesystem preview");
        stop.abort(reason);
        await expect(fs.readFile("/many.bin", { length: 1, signal: stop.signal })).rejects.toMatchObject({
          code: "aborted",
          cause: reason,
        });
        expect(input.reads).toBe(0);
      } finally {
        await fs.close();
      }
      expect(input.disposals).toBe(0);
      const id = archive.entries.find((entry) => entry.name === member.name)!.id;
      expect((await archive.read(id, { length: 3 })).bytes).toEqual(original.slice(0, 3));
      await input[Symbol.asyncDispose]();
      expect(input.disposals).toBe(1);
    });
    it("keeps complete ZIP CRC verification by default and captures explicit prefix/kernel policy", async () => {
      const archive = await openZip(source(wrongCrc(raw, member.name)));
      const checked = createFileSystem(createZipAdapter(archive));
      try {
        await expect(checked.readFile("/many.bin", { length: 1 })).rejects.toMatchObject({
          cause: { code: "checksum-mismatch" },
        });
      } finally {
        await checked.close();
      }
      const policy = { verify: false };
      const prefix = createFileSystem(createZipAdapter(archive, policy));
      policy.verify = true;
      try {
        expect(await prefix.readFile("/many.bin", { length: 3 })).toEqual(original.slice(0, 3));
        await expect(prefix.readFile("/many.bin")).rejects.toMatchObject({ cause: { code: "checksum-mismatch" } });
      } finally {
        await prefix.close();
      }
      const kernel = { maxSteps: 1 };
      const bounded = createFileSystem(createZipAdapter(await openZip(source(raw)), {
        verify: false,
        ...(kind === "bzip" ? { bzip: kernel } : { lzma: kernel }),
      }));
      kernel.maxSteps = 99999999;
      try {
        await expect(bounded.readFile("/many.bin", { length: 1 })).rejects.toMatchObject({ code: "too-large" });
      } finally {
        await bounded.close();
      }
    });
    it("retains the opening abort authority across the facade", async () => {
      const stop = new AbortController(), input = source(raw);
      const archive = await openZip(input, { signal: stop.signal });
      const fs = createFileSystem(createZipAdapter(archive));
      input.reads = 0;
      stop.abort(new Error("archive owner stops all previews"));
      try {
        await expect(fs.readFile("/many.bin", { length: 1 })).rejects.toThrow();
        expect(input.reads).toBe(0);
      } finally {
        await fs.close();
        await input[Symbol.asyncDispose]();
      }
    });
  });
}
