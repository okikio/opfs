import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { openZip } from "../src/archive/zip.ts";
import type { ByteSourceType } from "../src/source.ts";
import legacy from "./fixtures/password/independent.json" with { type: "json" };
import aes from "./fixtures/aes/independent.json" with { type: "json" };

// Independent Python stdlib fixture also used by archive.test.ts: STORED hello,
// DEFLATE 80000 A bytes, duplicate names and a UTF-8 member. No candidate writer.
const fixture =
  "UEsDBBQAAAAAAAAAIVCFEUoNCwAAAAsAAAAJAAAAZmlyc3QudHh0aGVsbG8gd29ybGRQSwMEFAAAAAgAAAAhUHnPp1NfAAAAgDgBAAkAAABsYXJnZS50eHTtwYEAAAAAwyC2+Usd4ApVAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAG1BLAwQUAAAAAAAAACFQG4FHEgkAAAAJAAAACQAAAGZpcnN0LnR4dGR1cGxpY2F0ZVBLAwQUAAAICAAAACFQsymFUwgAAAAGAAAACQAAAGNhZsOpLnR4dEvOT0tLTQUAUEsBAhQDFAAAAAAAAAAhUIURSg0LAAAACwAAAAkAAAAAAAAAAAAAAIABAAAAAGZpcnN0LnR4dFBLAQIUAxQAAAAIAAAAIVB5z6dTXwAAAIA4AQAJAAAAAAAAAAAAAACAATIAAABsYXJnZS50eHRQSwECFAMUAAAAAAAAACFQG4FHEgkAAAAJAAAACQAAAAAAAAAAAAAAgAG4AAAAZmlyc3QudHh0UEsBAhQDFAAACAgAAAAhULMphVMIAAAABgAAAAkAAAAAAAAAAAAAAIAB6AAAAGNhZsOpLnR4dFBLBQYAAAAABAAEANwAAAAXAQAAAAA=";

/** Logical bytes are immutable; only the returned view is borrowed until another source read. */
function scratchSource(bytes: Uint8Array): ByteSourceType {
  const scratch = new Uint8Array(bytes.length);
  return {
    size: bytes.length,
    stability: "immutable",
    async read(at, count, options) {
      options?.signal?.throwIfAborted();
      scratch.fill(0);
      scratch.set(bytes.subarray(at, at + count));
      return scratch.subarray(0, count);
    },
  };
}

describe("ZIP borrowed source buffers", () => {
  it("preserves local fixed fields across scratch-reusing name/extra reads and owns returned STORED prefixes", async () => {
    const input = scratchSource(decodeBase64(fixture)), archive = await openZip(input);
    const preview = await archive.read(0, { length: 5 });
    expect(new TextDecoder().decode(preview.bytes)).toBe("hello");
    const compressed = await archive.read(1);
    expect(compressed.bytes).toEqual(new Uint8Array(80000).fill(65));
    expect(compressed.integrity).toBe("checksum-verified");
    await input.read(0, 1);
    expect(new TextDecoder().decode(preview.bytes)).toBe("hello");
    expect(new TextDecoder().decode((await archive.read(0)).bytes)).toBe("hello world");
  });
  it("preserves the directory when a legacy-name callback initiates another source read", async () => {
    const input = scratchSource(decodeBase64(fixture));
    const pending: Promise<Uint8Array>[] = [];
    const archive = await openZip(input, {
      decodeName(bytes) {
        pending.push(input.read(0, 1));
        return new TextDecoder().decode(bytes);
      },
    });
    await Promise.all(pending);
    expect(archive.entries.map((entry) => entry.name)).toEqual(["first.txt", "large.txt", "first.txt", "café.txt"]);
    expect(new TextDecoder().decode((await archive.read(2)).bytes)).toBe("duplicate");
  });
  it("returns an owned STORED prefix even when only payload views are reused", async () => {
    const borrowed = scratchSource(decodeBase64(fixture));
    const input: ByteSourceType = {
      size: borrowed.size,
      stability: "immutable",
      async read(at, count, options) {
        const bytes = await borrowed.read(at, count, options);
        // Isolate returned-output ownership from the separate fixed-header defect.
        return count === 30 ? bytes.slice() : bytes;
      },
    };
    const archive = await openZip(input), preview = await archive.read(0, { length: 5 });
    await input.read(0, 1);
    expect(new TextDecoder().decode(preview.bytes)).toBe("hello");
  });
  it("keeps ZipCrypto and AES header evidence independent of borrowed payload storage", async () => {
    for (const fixture of [legacy.stored, legacy.deflate, legacy.descriptor]) {
      const archive = await openZip(scratchSource(decodeBase64(fixture.archive)));
      for (const expected of fixture.entries) {
        const id = archive.entries.find((entry) => entry.name === expected.name)!.id;
        const result = await archive.read(id, { password: decodeBase64(fixture.password) });
        expect(result.bytes).toEqual(decodeBase64(expected.body));
      }
    }
    for (const fixture of [aes["aes256-ae2"], aes.deflate, aes["deflate-ae1"]]) {
      const archive = await openZip(scratchSource(decodeBase64(fixture.archive)));
      for (const expected of fixture.entries) {
        const id = archive.entries.find((entry) => entry.name === expected.name)!.id;
        const result = await archive.read(id, {
          password: decodeBase64(fixture.password),
          aes: { subtle: crypto.subtle },
        });
        expect(result.bytes).toEqual(decodeBase64(expected.body));
      }
    }
  });
});
