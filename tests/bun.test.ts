import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileSystem } from "../mod.ts";
import { createBunAdapter } from "../src/adapter/bun.ts";
import { verifyHost } from "./host.ts";
import { verifySync } from "./reliability.ts";

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
      await verifySync(fileSystem, "/nested/file.txt", "BUN");
    } finally {
      await fileSystem.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
