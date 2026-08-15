import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem } from "../mod.ts";
import { createMemoryAdapter } from "../src/adapter/memory.ts";

describe("memory adapter", () => {
  it("provides OPFS-shaped handles over the shared filesystem facade", async () => {
    const fileSystem = createFileSystem(createMemoryAdapter(), {
      coordination: "local",
      lockPrefix: `test:memory:${crypto.randomUUID()}`,
    });

    const directory = await fileSystem.root.getDirectoryHandle("docs", { create: true });
    const file = await directory.getFileHandle("note.txt", { create: true });
    const writable = await file.createWritable();
    await writable.write("hello");
    await writable.close();

    expect(await fileSystem.readText("/docs/note.txt")).toBe("hello");
    expect(await fileSystem.root.resolve(file)).toEqual(["docs", "note.txt"]);
  });

  it("allows independent files to progress concurrently", async () => {
    const fileSystem = createFileSystem(createMemoryAdapter(), {
      coordination: "local",
      lockPrefix: `test:parallel:${crypto.randomUUID()}`,
    });

    await Promise.all([
      fileSystem.writeFile("/parallel/a.txt", "A", { parents: true }),
      fileSystem.writeFile("/parallel/b.txt", "B", { parents: true }),
    ]);

    expect(await fileSystem.readText("/parallel/a.txt")).toBe("A");
    expect(await fileSystem.readText("/parallel/b.txt")).toBe("B");
  });
});
