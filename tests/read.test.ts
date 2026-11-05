import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createFileSystem } from "../mod.ts";
import { defineReadAdapter } from "../src/adapter/read.ts";
import { defineDriver } from "../src/driver/definition.ts";

describe("read-only admission", () => {
  it("refuses all mutations before metadata or source acquisition", async () => {
    let reads = 0;
    let pulls = 0;
    const adapter = defineReadAdapter({
      name: "read-fixture",
      driver: defineDriver({ name: "read-fixture", kind: "file", provides: ["stat", "read", "list"] }),
      capabilities: { streamRead: false, rangeRead: true },
      stat: (path) => {
        reads++;
        return Promise.resolve(
          path === "/" ? { kind: "directory" } : { kind: "file", size: 1, lastModified: 0, mediaType: "" },
        );
      },
      readFile: () => {
        reads++;
        return Promise.resolve(new Uint8Array([7]));
      },
      async *readDir() {
        reads++;
        yield { name: "one", kind: "file" };
      },
    });
    const fileSystem = createFileSystem(adapter, { coordination: "none" });
    expect(fileSystem.inspect().support.write).toBe("unsupported");
    expect(fileSystem.plan({ operation: "write", path: "/one", source: "bytes" }).supported).toBe(false);
    const source = {
      async *[Symbol.asyncIterator]() {
        pulls++;
        yield new Uint8Array([1]);
      },
    };
    for (
      const mutate of [
        () => fileSystem.writeFile("/one", source),
        () => fileSystem.mkdir("/new"),
        () => fileSystem.ensureDir("/new"),
        () => fileSystem.ensureFile("/new"),
        () => fileSystem.remove("/one"),
        () => fileSystem.emptyDir(),
        () => fileSystem.copy("/one", "/two"),
        () => fileSystem.move("/one", "/two"),
      ]
    ) {
      await expect(mutate()).rejects.toMatchObject({ code: "not-supported" });
    }
    expect(reads).toBe(0);
    expect(pulls).toBe(0);
    const handle = await fileSystem.getFileHandle("/one");
    const before = reads;
    await expect(handle.createWritable({ keepExistingData: true })).rejects.toMatchObject({ code: "not-supported" });
    expect(reads).toBe(before);
    expect(await fileSystem.readFile("/one")).toEqual(new Uint8Array([7]));
    let acquisitions = 0;
    const contradictory = createFileSystem({
      ...adapter,
      capabilities: { ...adapter.capabilities, positionalWrite: true, syncAccess: true },
      openWritableFile() {
        acquisitions++;
        throw new Error("Must not acquire");
      },
      openSyncFile() {
        acquisitions++;
        throw new Error("Must not acquire");
      },
    }, { coordination: "none" });
    expect(contradictory.inspect().support.positionalWrite).toBe("unsupported");
    await expect(contradictory.openWritableFile("/one")).rejects.toMatchObject({ code: "not-supported" });
    await expect(contradictory.openSyncFile("/one")).rejects.toMatchObject({ code: "not-supported" });
    expect(acquisitions).toBe(0);
    await contradictory[Symbol.asyncDispose]();
    await fileSystem[Symbol.asyncDispose]();
  });
});
