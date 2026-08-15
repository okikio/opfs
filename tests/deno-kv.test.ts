/// <reference lib="deno.unstable" />

import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem } from "../mod.ts";
import { createDenoKvAdapter } from "../src/adapter/deno-kv.ts";

describe("Deno KV adapter", () => {
  it("executes against a real local Deno KV database", async () => {
    const path = await Deno.makeTempFile({ prefix: "okikio-opfs-kv-" });
    await Deno.remove(path);
    const database = await Deno.openKv(path);
    const fileSystem = createFileSystem(createDenoKvAdapter(database), { coordination: "none" });
    try {
      await fileSystem.writeFile("/kv/value.txt", "deno-kv", { parents: true });
      expect(await fileSystem.readText("/kv/value.txt")).toBe("deno-kv");
      expect((await fileSystem.stat("/kv")).kind).toBe("directory");

      const large = Uint8Array.from({ length: 180 * 1024 }, (_, index) => index % 251);
      await fileSystem.writeFile("/kv/large.bin", large);
      expect(await fileSystem.readFile("/kv/large.bin", { at: 70 * 1024, length: 4096 })).toEqual(
        large.slice(70 * 1024, 74 * 1024),
      );
      expect(await fileSystem.readFile("/kv/large.bin")).toEqual(large);
    } finally {
      await fileSystem.close();
      database.close();
      await Deno.remove(path).catch(() => undefined);
    }
  });
});
