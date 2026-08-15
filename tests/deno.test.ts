import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem } from "../mod.ts";
import { createDenoAdapter } from "../src/adapter/deno.ts";

describe("Deno adapter", () => {
  it("uses real Deno filesystem and synchronous file APIs", async () => {
    const root = await Deno.makeTempDir({ prefix: "okikio-opfs-" });
    const fileSystem = createFileSystem(createDenoAdapter({ root }), { coordination: "local" });
    try {
      await fileSystem.writeFile("/nested/file.txt", "deno", { parents: true });
      expect(await fileSystem.readText("/nested/file.txt")).toBe("deno");
      const sync = await fileSystem.openSyncFile("/nested/file.txt");
      sync.writeAll(new TextEncoder().encode("DENO"), { at: 0 });
      sync.flush();
      let queued = false;
      const write = fileSystem.writeFile("/nested/file.txt", "after-sync").then(() => {
        queued = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(queued).toBe(false);
      sync.close();
      await write;
      expect(await fileSystem.readText("/nested/file.txt")).toBe("after-sync");
    } finally {
      await fileSystem.close();
      await Deno.remove(root, { recursive: true });
    }
  });
});
