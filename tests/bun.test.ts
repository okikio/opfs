import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileSystem } from "../mod.ts";
import { createBunAdapter } from "../src/adapter/bun.ts";
import { verifyHost } from "./host.ts";

describe("Bun adapter", () => {
  it("preserves host range, directory removal, and overwrite semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "okikio-opfs-bun-"));
    const fileSystem = createFileSystem(createBunAdapter({ root }), { coordination: "local" });
    try {
      await verifyHost(fileSystem);
    } finally {
      await fileSystem.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses real Bun file and synchronous filesystem APIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "okikio-opfs-bun-"));
    const fileSystem = createFileSystem(createBunAdapter({ root }), { coordination: "local" });
    try {
      await fileSystem.writeFile("/nested/file.txt", "bun", { parents: true });
      expect(await fileSystem.readText("/nested/file.txt")).toBe("bun");
      const sync = await fileSystem.openSyncFile("/nested/file.txt");
      sync.writeAll(new TextEncoder().encode("BUN"), { at: 0 });
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
      await rm(root, { recursive: true, force: true });
    }
  });
});
