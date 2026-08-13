import { createFileSystem } from "../mod.ts";
import { createMemoryAdapter } from "../src/adapter/memory.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}.`);
  }
}

Deno.test("uses OPFS-shaped handles over the memory adapter", async () => {
  const fileSystem = createFileSystem(createMemoryAdapter(), {
    coordination: "local",
    lockPrefix: "test:deno-memory",
  });

  const directory = await fileSystem.root.getDirectoryHandle("docs", { create: true });
  const file = await directory.getFileHandle("note.txt", { create: true });
  const writable = await file.createWritable();
  await writable.write("hello");
  await writable.close();

  assertEquals(await fileSystem.readText("/docs/note.txt"), "hello");
  assertEquals(await fileSystem.root.resolve(file), ["docs", "note.txt"]);
});

Deno.test("keeps independent file writes separate", async () => {
  const fileSystem = createFileSystem(createMemoryAdapter(), {
    coordination: "local",
    lockPrefix: "test:deno-parallel",
  });

  await Promise.all([
    fileSystem.writeFile("/parallel/a.txt", "A", { parents: true }),
    fileSystem.writeFile("/parallel/b.txt", "B", { parents: true }),
  ]);

  assertEquals(await fileSystem.readText("/parallel/a.txt"), "A");
  assertEquals(await fileSystem.readText("/parallel/b.txt"), "B");
});
