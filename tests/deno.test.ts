import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { platform } from "node:os";

import { createFileSystem } from "../mod.ts";
import { createDenoAdapter } from "../src/adapter/deno.ts";
import { verifyHost, verifyWindowsNames } from "./host.ts";
import { verifySync } from "./reliability.ts";

describe("Deno adapter", () => {
  it("preserves Windows native filename rejection and remains usable", { skip: platform() !== "win32" }, async (t) => {
    const root = await Deno.makeTempDir({ prefix: "okikio-opfs-windows-" });
    t.after(() => Deno.remove(root, { recursive: true }));
    const fileSystem = createFileSystem(createDenoAdapter({ root }), { coordination: "local" });
    try {
      await verifyWindowsNames(fileSystem);
    } finally {
      await fileSystem.close();
    }
  });

  it("preserves host range, directory removal, and overwrite semantics", async (t) => {
    const root = await Deno.makeTempDir({ prefix: "okikio-opfs-" });
    t.after(() => Deno.remove(root, { recursive: true }));
    const fileSystem = createFileSystem(createDenoAdapter({ root }), { coordination: "local" });
    try {
      await verifyHost(fileSystem);
    } finally {
      await fileSystem.close();
    }
  });

  it("uses real Deno filesystem and synchronous file APIs", async (t) => {
    const root = await Deno.makeTempDir({ prefix: "okikio-opfs-" });
    t.after(() => Deno.remove(root, { recursive: true }));
    const fileSystem = createFileSystem(createDenoAdapter({ root }), { coordination: "local" });
    try {
      await fileSystem.writeFile("/nested/file.txt", "deno", { parents: true });
      expect(await fileSystem.readText("/nested/file.txt")).toBe("deno");
      await verifySync(fileSystem, "/nested/file.txt", "DENO");
    } finally {
      await fileSystem.close();
    }
  });
});
