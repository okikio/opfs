import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createFileSystem } from "../mod.ts";
import { createBlobSource } from "../src/source.ts";
import { openTar } from "../src/archive/tar.ts";
import type { TarArchiveType, TarEntryType } from "../src/archive/tar.ts";
import { createTarAdapter } from "../src/view/tar.ts";
import fixtures from "./fixtures/tar/independent.json" with { type: "json" };

/** Public reader replacement, including names a permissive metadata parser may expose. */
function archive(names: readonly string[]): TarArchiveType & { reads: number[] } {
  const reads: number[] = [];
  const entries = names.map((name, id): TarEntryType => ({
    id,
    name,
    size: 5,
    kind: name.endsWith("/") ? "directory" : "file",
    link: "",
  }));
  const work = { sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 };
  return {
    entries,
    reads,
    work,
    source: { stability: "immutable" },
    read(id, options = {}) {
      options.signal?.throwIfAborted();
      reads.push(id);
      return Promise.resolve({
        bytes: new TextEncoder().encode("hello").slice(
          options.offset ?? 0,
          (options.offset ?? 0) + (options.length ?? 5),
        ),
        integrity: "header-checksum-only",
        work,
      });
    },
  };
}

describe("TAR filesystem view", () => {
  it("reads only selected independent producer bytes and preserves borrowed ownership", async () => {
    const fixture = fixtures.pax;
    const source = createBlobSource(new Blob([new Uint8Array(decodeBase64(fixture.archive)).buffer]));
    const calls: { offset: number; length: number }[] = [];
    const indexed = await openTar({
      ...source,
      read(offset, length, signal) {
        calls.push({ offset, length });
        return source.read(offset, length, signal);
      },
    });
    // Explicit application policy selects regular entries from this fixture, which also contains a symlink.
    const selected = { ...indexed, entries: indexed.entries.filter((entry) => entry.kind === "file") };
    calls.length = 0;
    const fs = createFileSystem(createTarAdapter(selected, { maxSourceBytes: 3, maxOutputBytes: 3 }));
    try {
      expect(calls).toEqual([]);
      const entry = selected.entries[0]!;
      const expected = decodeBase64(fixture.entries[0]!.body).slice(1, 4);
      expect(await fs.readFile("/" + entry.name, { at: 1, length: 3 })).toEqual(expected);
      expect(calls.length).toBe(1);
      expect(calls[0]!.length).toBe(3);
      expect((await fs.stat("/café"))?.kind).toBe("directory");
      await expect(fs.readFile("/global.txt")).rejects.toMatchObject({ code: "too-large" });
    } finally {
      await fs.close();
    }
    expect((await indexed.read(1)).bytes).toEqual(decodeBase64(fixture.entries[1]!.body));
    expect(() => createTarAdapter(indexed)).toThrow();
  });

  it("keeps explicit directories, clamped EOF and namespace-only operations local", async () => {
    const input = archive(["dir/file", "dir/"]);
    const fs = createFileSystem(createTarAdapter(input));
    try {
      expect((await Array.fromAsync(fs.readDir("/dir"))).map((entry) => entry.name)).toEqual(["file"]);
      expect(await fs.readFile("/dir/file", { at: 99, length: 3 })).toEqual(new Uint8Array());
      await expect(fs.readFile("/dir")).rejects.toMatchObject({ code: "type-mismatch" });
      await expect(fs.writeFile("/new", "x")).rejects.toMatchObject({ code: "not-supported" });
      expect(input.reads).toEqual([0]);
    } finally {
      await fs.close();
    }
  });

  it("refuses every ambiguous namespace before member acquisition", () => {
    for (
      const names of [
        ["x", "x"],
        ["x", "x/y"],
        ["x/y", "x"],
        ["../x"],
        ["/x"],
        ["x//y"],
        ["C:/x"],
        ["x\\y"],
        ["x/./y"],
        ["x/", "x/"],
      ]
    ) {
      const input = archive(names);
      expect(() => createTarAdapter(input)).toThrow();
      expect(input.reads).toEqual([]);
    }
    for (const kind of ["hard-link", "symbolic-link"] as const) {
      const input = archive(["link"]);
      expect(() => createTarAdapter({ ...input, entries: [{ ...input.entries[0]!, kind }] })).toThrow();
    }
  });

  it("captures descriptor identity and size at construction", async () => {
    const input = archive(["file"]);
    const entry = input.entries[0]! as { id: number; size: number };
    const fs = createFileSystem(createTarAdapter(input));
    entry.id = 100;
    entry.size = 100;
    try {
      expect(await fs.stat("/file")).toMatchObject({ kind: "file", size: 5 });
      expect(new TextDecoder().decode(await fs.readFile("/file"))).toBe("hello");
      expect(input.reads).toEqual([0]);
    } finally {
      await fs.close();
    }
  });

  it("retains abort identity without acquiring a member", async () => {
    const input = archive(["file"]);
    const fs = createFileSystem(createTarAdapter(input));
    const controller = new AbortController();
    const reason = new Error("stop preview");
    controller.abort(reason);
    try {
      await expect(fs.readFile("/file", { signal: controller.signal })).rejects.toMatchObject({
        code: "aborted",
        cause: reason,
      });
      await expect(createTarAdapter(input).readFile("/file", { signal: controller.signal })).rejects.toBe(reason);
      expect(input.reads).toEqual([]);
    } finally {
      await fs.close();
    }
  });
});
