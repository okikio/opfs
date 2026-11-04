import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { platform } from "node:os";

import { createFileSystem } from "../mod.ts";
import { createDenoAdapter } from "../src/adapter/deno.ts";
import { verifyFileAdmission, verifyHost, verifyWindowsNames } from "./host.ts";
import { verifySync } from "./reliability.ts";
import { withReleases } from "./close.ts";

describe("Deno adapter", () => {
  it(
    "preserves Windows native filename rejection and remains usable",
    { skip: platform() !== "win32" },
    async () =>
      await withReleases(async (releases) => {
        const root = await Deno.makeTempDir({ prefix: "okikio-opfs-windows-" });
        releases.push(() => Deno.remove(root, { recursive: true }));
        const fileSystem = createFileSystem(createDenoAdapter({ root }), { coordination: "local" });
        releases.push(() => fileSystem.close());
        await verifyWindowsNames(fileSystem);
      }),
  );

  for (const appeared of ["directory", "file"] as const) {
    it(`classifies a native ${appeared} that appears after the initial absence`, async () =>
      await withReleases(async (releases) => {
        const root = await Deno.makeTempDir({ prefix: "okikio-opfs-admission-" });
        releases.push(() => Deno.remove(root, { recursive: true }));
        await verifyFileAdmission(createDenoAdapter({ root }), root, appeared);
      }));
  }

  it("preserves host range, directory removal, and overwrite semantics", async () =>
    await withReleases(async (releases) => {
      const root = await Deno.makeTempDir({ prefix: "okikio-opfs-" });
      releases.push(() => Deno.remove(root, { recursive: true }));
      const fileSystem = createFileSystem(createDenoAdapter({ root }), { coordination: "local" });
      releases.push(() => fileSystem.close());
      await verifyHost(fileSystem);
    }));

  it("uses real Deno filesystem and synchronous file APIs", async () =>
    await withReleases(async (releases) => {
      const root = await Deno.makeTempDir({ prefix: "okikio-opfs-" });
      releases.push(() => Deno.remove(root, { recursive: true }));
      const fileSystem = createFileSystem(createDenoAdapter({ root }), { coordination: "local" });
      releases.push(() => fileSystem.close());
      await fileSystem.writeFile("/nested/file.txt", "deno", { parents: true });
      expect(await fileSystem.readText("/nested/file.txt")).toBe("deno");
      await verifySync(fileSystem, "/nested/file.txt", "DENO");
    }));
});
