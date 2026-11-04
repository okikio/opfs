// Upstream Node, Deno and Bun scenarios, MIT licensed. See provenance.json and licenses/.
import { expect } from "@std/expect";
import type { FileSystemType } from "../../mod.ts";
import { withReleases } from "../close.ts";

/** API adaptation is explicit: these are facade scenarios, not runtime overload conformance. */
export interface RuntimeCaseType {
  readonly name: string;
  readonly project: "node" | "deno" | "bun";
  readonly source: string;
  readonly identity: string;
  readonly sync?: boolean;
  run(fileSystem: FileSystemType): Promise<void>;
}

/** Original payloads and byte oracles survive the runtime API translation. */
export const runtimeCases: readonly RuntimeCaseType[] = [
  {
    name: "Node buffer write preserves the selected byte view",
    project: "node",
    source: "test/parallel/test-fs-write-buffer.js",
    identity: "fs.write with a buffer, without the length parameter",
    async run(fileSystem) {
      // Node's offset=3 overload becomes the facade's explicit byte view.
      const expected = new TextEncoder().encode("hello");
      await fileSystem.writeFile("/write2.txt", expected.subarray(3));
      expect(await fileSystem.readText("/write2.txt")).toBe("lo");
      const stat = await fileSystem.stat("/write2.txt");
      if (stat.kind !== "file") throw new Error("Written byte view must be a file.");
      expect(stat.size).toBe(2);
    },
  },
  {
    name: "Node DataView write preserves bytes outside a nonzero view offset",
    project: "node",
    source: "test/parallel/test-fs-write-buffer.js",
    identity: "fs.write with a DataView, without the offset and length parameters",
    async run(fileSystem) {
      // The upstream DataView payload is hello. Sentinel bytes strengthen the view oracle.
      const buffer = new TextEncoder().encode("!hello?").buffer;
      await fileSystem.writeFile("/view.txt", new DataView(buffer, 1, 5));
      expect(await fileSystem.readText("/view.txt")).toBe("hello");
      const stat = await fileSystem.stat("/view.txt");
      if (stat.kind !== "file") throw new Error("Written DataView must be a file.");
      expect(stat.size).toBe(5);
    },
  },
  {
    name: "Node ftruncate shrinks a 16 KiB file to 1024 and then zero bytes",
    project: "node",
    source: "test/parallel/test-fs-truncate.js",
    identity: "ftruncateSync length 1024 then 0",
    sync: true,
    async run(fileSystem) {
      await fileSystem.writeFile("/truncate.bin", new Uint8Array(16 * 1024).fill(120));
      await withReleases(async (releases) => {
        const file = await fileSystem.openSyncFile("/truncate.bin");
        releases.push(() => file.close());
        file.truncate(1024);
        expect(file.getSize()).toBe(1024);
        const bytes = new Uint8Array(1024);
        expect(file.read(bytes, { at: 0 })).toBe(1024);
        expect(bytes).toEqual(new Uint8Array(1024).fill(120));
        file.truncate(0);
        expect(file.getSize()).toBe(0);
      });
      expect(await fileSystem.readFile("/truncate.bin")).toEqual(new Uint8Array());
    },
  },
  {
    name: "Deno ftruncateSyncSuccess grows to 20 bytes and shrinks to five",
    project: "deno",
    source: "tests/unit/truncate_test.ts",
    identity: "ftruncateSyncSuccess / positive lengths",
    sync: true,
    async run(fileSystem) {
      const filename = "/test_ftruncateSync.txt";
      await fileSystem.writeFile(filename, new Uint8Array());
      await withReleases(async (releases) => {
        const file = await fileSystem.openSyncFile(filename);
        releases.push(() => file.close());
        file.truncate(20);
        expect(file.getSize()).toBe(20);
        const bytes = new Uint8Array(20).fill(255);
        expect(file.read(bytes, { at: 0 })).toBe(20);
        expect(bytes).toEqual(new Uint8Array(20));
        file.truncate(5);
        expect(file.getSize()).toBe(5);
      });
      expect(await fileSystem.readFile(filename)).toEqual(new Uint8Array(5));
      // Deno clamps negative lengths to zero. The facade rejects them instead.
    },
  },
  {
    name: "Deno writeFileAppend appends once, then replacement and default writes truncate",
    project: "deno",
    source: "tests/unit/write_file_test.ts",
    identity: "writeFileAppend",
    async run(fileSystem) {
      const enc = new TextEncoder();
      const data = enc.encode("Hello");
      const filename = "/test.txt";
      await fileSystem.writeFile(filename, data);
      await fileSystem.writeFile(filename, data, { mode: "append" });
      const dec = new TextDecoder("utf-8");
      expect(dec.decode(await fileSystem.readFile(filename))).toBe("HelloHello");
      await fileSystem.writeFile(filename, data, { mode: "replace" });
      expect(dec.decode(await fileSystem.readFile(filename))).toBe("Hello");
      await fileSystem.writeFile(filename, data);
      expect(dec.decode(await fileSystem.readFile(filename))).toBe("Hello");
    },
  },
  {
    name: "Deno overwriteFileWithStream removes the old trailing bytes",
    project: "deno",
    source: "tests/unit/write_file_test.ts",
    identity: "overwriteFileWithStream",
    async run(fileSystem) {
      await fileSystem.writeFile("/test.txt", new Uint8Array([1, 2, 3, 4]));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.close();
        },
      });
      await fileSystem.writeFile("/test.txt", stream);
      expect(await fileSystem.readFile("/test.txt")).toEqual(new Uint8Array([1, 2]));
    },
  },
  {
    name: "Bun fs.promises.writeFile async iterator concatenates byte chunks",
    project: "bun",
    source: "test/js/node/fs/fs-promises-writeFile-async-iterator.test.ts",
    identity: "fs.promises.writeFile async iterator / bufStream",
    async run(fileSystem) {
      const bufStream = async function* () {
        yield new TextEncoder().encode("2 ");
        yield new TextEncoder().encode("Hello, ");
        yield new TextEncoder().encode("world!");
      };
      await fileSystem.writeFile("/file2.txt", bufStream());
      expect(await fileSystem.readText("/file2.txt")).toBe("2 Hello, world!");
    },
  },
  {
    name: "Bun async iterator producer failure preserves the original reason",
    project: "bun",
    source: "test/js/node/fs/fs-promises-writeFile-async-iterator.test.ts",
    identity: "fs.promises.writeFile async iterator throws on invalid input / Error(good)",
    async run(fileSystem) {
      const reason = new Error("good");
      const source = (async function* () {
        yield new TextEncoder().encode("once");
        throw reason;
      })();
      // The facade rejects asynchronously and normalizes its error; native writes may be partial.
      await expect(fileSystem.writeFile("/file3.txt", source)).rejects.toMatchObject({ cause: reason });
      await fileSystem.writeFile("/file3.txt", "recovered");
      expect(await fileSystem.readText("/file3.txt")).toBe("recovered");
    },
  },
];
