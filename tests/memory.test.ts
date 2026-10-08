import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem } from "../mod.ts";
import { createMemoryAdapter } from "../src/adapter/memory.ts";
import { withFileSystem, within } from "./reliability.ts";

describe("filesystem fixture ownership", () => {
  it("closes once and awaits cleanup before completing a successful body", async () => {
    const admitted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let closed = false;
    let closes = 0;
    const completion = withFileSystem({
      async close() {
        closes++;
        admitted.resolve();
        await release.promise;
        closed = true;
      },
    }, async () => {});
    try {
      await within(admitted.promise, "fixture close admission");
      const settled = completion.then(() => expect(closed).toBe(true));
      release.resolve();
      await settled;
      expect(closes).toBe(1);
    } finally {
      release.resolve();
      await within(Promise.allSettled([completion]), "fixture ownership cleanup");
    }
  });

  it("retains an undefined body rejection after closing successfully", async () => {
    let closed = false;
    const result = await withFileSystem({
      async close() {
        closed = true;
      },
    }, async () => {
      throw undefined;
    }).then(() => ({ status: "fulfilled" }), (reason: unknown) => ({ status: "rejected", reason }));
    expect(result).toEqual({ status: "rejected", reason: undefined });
    expect(closed).toBe(true);
  });

  for (const reason of [undefined, new Error("body failed")]) {
    it(`retains ${reason === undefined ? "undefined" : "an Error"} beside an independent close failure`, async () => {
      const cleanup = new Error("close failed");
      const failure = await withFileSystem({
        async close() {
          throw cleanup;
        },
      }, async () => {
        throw reason;
      }).then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error("Missing aggregate fixture failure.");
      expect(failure.errors).toEqual([reason, cleanup]);
      expect(Object.hasOwn(failure, "cause")).toBe(true);
      expect(failure.cause).toBe(reason);
    });
  }

  it("propagates a close-only failure by identity", async () => {
    const cleanup = new Error("close-only failure");
    const failure = await withFileSystem({
      async close() {
        throw cleanup;
      },
    }, async () => {})
      .then(() => undefined, (reason: unknown) => reason);
    expect(failure).toBe(cleanup);
  });
});

describe("memory adapter", () => {
  it("provides OPFS-shaped handles over the shared filesystem facade", async () => {
    const fileSystem = createFileSystem(createMemoryAdapter(), {
      coordination: "local",
      lockPrefix: `test:memory:${crypto.randomUUID()}`,
    });
    await withFileSystem(fileSystem, async () => {
      const directory = await fileSystem.root.getDirectoryHandle("docs", { create: true });
      const file = await directory.getFileHandle("note.txt", { create: true });
      const writable = await file.createWritable();
      await writable.write("hello");
      await writable.close();

      expect(await fileSystem.readText("/docs/note.txt")).toBe("hello");
      expect(await fileSystem.root.resolve(file)).toEqual(["docs", "note.txt"]);
    });
  });

  it("allows independent files to progress concurrently", async () => {
    const fileSystem = createFileSystem(createMemoryAdapter(), {
      coordination: "local",
      lockPrefix: `test:parallel:${crypto.randomUUID()}`,
    });
    await withFileSystem(fileSystem, async () => {
      await Promise.all([
        fileSystem.writeFile("/parallel/a.txt", "A", { parents: true }),
        fileSystem.writeFile("/parallel/b.txt", "B", { parents: true }),
      ]);

      expect(await fileSystem.readText("/parallel/a.txt")).toBe("A");
      expect(await fileSystem.readText("/parallel/b.txt")).toBe("B");
    });
  });
});
