import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { mkdtemp, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

import { createFileSystem } from "../mod.ts";
import { createBunAdapter } from "../src/adapter/bun.ts";
import { verifyHost, verifyWindowsNames } from "./host.ts";
import { verifySync } from "./reliability.ts";
import { withReleases } from "./close.ts";

describe("Bun adapter", () => {
  it(
    "preserves Windows native filename rejection and remains usable",
    { skip: platform() !== "win32" },
    async () =>
      await withReleases(async (releases) => {
        const root = await mkdtemp(join(tmpdir(), "okikio-opfs-windows-"));
        releases.push(() => rm(root, { recursive: true, force: true }));
        const fileSystem = createFileSystem(createBunAdapter({ root }), { coordination: "local" });
        releases.push(() => fileSystem.close());
        await verifyWindowsNames(fileSystem);
      }),
  );

  it("preserves host range, directory removal, and overwrite semantics", async () =>
    await withReleases(async (releases) => {
      const root = await mkdtemp(join(tmpdir(), "okikio-opfs-bun-"));
      releases.push(() => rm(root, { recursive: true, force: true }));
      const fileSystem = createFileSystem(createBunAdapter({ root }), { coordination: "local" });
      releases.push(() => fileSystem.close());
      await verifyHost(fileSystem);
    }));

  it("uses real Bun file and synchronous filesystem APIs", async () =>
    await withReleases(async (releases) => {
      const root = await mkdtemp(join(tmpdir(), "okikio-opfs-bun-"));
      releases.push(() => rm(root, { recursive: true, force: true }));
      const fileSystem = createFileSystem(createBunAdapter({ root }), { coordination: "local" });
      releases.push(() => fileSystem.close());
      await fileSystem.writeFile("/nested/file.txt", "bun", { parents: true });
      expect(await fileSystem.readText("/nested/file.txt")).toBe("bun");
      await verifySync(fileSystem, "/nested/file.txt", "BUN");
    }));
});
