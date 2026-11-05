import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createFileSystem } from "../mod.ts";
import { createZipAdapter } from "../src/view/zip.ts";
import type { ZipArchiveType, ZipEntryType } from "../src/archive/zip.ts";

/** Structural external reader proves the view does not depend on a private parser class. */
function archive(names: readonly string[]): ZipArchiveType & { reads: number[] } {
  const reads: number[] = [];
  const work = { sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 };
  const entries = names.map((name, id): ZipEntryType => ({
    id,
    name,
    size: 5,
    compressedSize: 5,
    method: 0,
    encrypted: false,
    directory: name.endsWith("/"),
    kind: name.endsWith("/") ? "directory" : "file",
    crc32: 0,
  }));
  return {
    entries,
    reads,
    source: { stability: "immutable" },
    work,
    plan: () => ({
      supported: true,
      access: "direct-range",
      outputBytes: 5,
      decodedBytes: 5,
      sourceBytes: 5,
      headerBytes: "unknown",
      verification: "full-member-crc",
    }),
    read(id, options = {}) {
      options.signal?.throwIfAborted();
      reads.push(id);
      const data = new TextEncoder().encode("hello");
      const bytes = data.slice(options.offset ?? 0, (options.offset ?? 0) + (options.length ?? data.length));
      return Promise.resolve({ bytes, integrity: "checksum-verified", work });
    },
  };
}

describe("ZIP filesystem view", () => {
  it("creates synthetic parents and reads through a public third-party archive contract", async () => {
    const input = archive(["folder/hello.txt", "other.txt"]);
    const fs = createFileSystem(createZipAdapter(input));
    try {
      expect(input.reads).toEqual([]);
      expect((await fs.stat("/folder"))?.kind).toBe("directory");
      expect((await Array.fromAsync(fs.readDir("/"))).map(({ name, kind }) => ({ name, kind }))).toEqual([{
        name: "folder",
        kind: "directory",
      }, {
        name: "other.txt",
        kind: "file",
      }]);
      expect(new TextDecoder().decode(await fs.readFile("/folder/hello.txt", { at: 1, length: 3 }))).toBe("ell");
      expect(input.reads).toEqual([0]);
      expect(fs.inspect().adapter.native.write).toBe(false);
    } finally {
      await fs.close();
    }
    // Closing the view does not dispose or invalidate the borrowed archive.
    expect((await input.read(1)).bytes).toEqual(new TextEncoder().encode("hello"));
  });

  it("rejects writes and directories before consuming producer bytes", async () => {
    const input = archive(["hello.txt"]);
    const fs = createFileSystem(createZipAdapter(input));
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        pulls++;
      },
    }, { highWaterMark: 0 });
    try {
      await expect(fs.writeFile("/new.txt", stream)).rejects.toMatchObject({ code: "not-supported" });
      await expect(fs.mkdir("/new")).rejects.toMatchObject({ code: "not-supported" });
      await expect(fs.remove("/hello.txt")).rejects.toMatchObject({ code: "not-supported" });
      expect(pulls).toBe(0);
      expect(input.reads).toEqual([]);
    } finally {
      await fs.close();
      await stream.cancel();
    }
  });

  it("refuses ambiguous paths and collisions before member acquisition", () => {
    for (
      const names of [["same", "same"], ["same", "same/child"], ["a/../escape"], ["/absolute"], ["a\\b"], ["a//b"], [
        "./a",
      ], ["C:/host"]]
    ) {
      const input = archive(names);
      expect(() => createZipAdapter(input)).toThrow();
      expect(input.reads).toEqual([]);
    }
    const input = archive(["link"]);
    const linked = { ...input, entries: [{ ...input.entries[0]!, kind: "symbolic-link" as const }] };
    expect(() => createZipAdapter(linked)).toThrow();
    expect(input.reads).toEqual([]);
  });
});
