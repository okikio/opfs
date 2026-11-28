/** Installed filesystem contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import { createFileSystem } from "@okikio/opfs";
import { createMemoryAdapter } from "@okikio/opfs/adapter/memory";
import { normalizePath } from "@okikio/opfs/path";
import { createByteSource } from "@okikio/opfs/source";
import { testByteSource } from "@okikio/opfs/testing/source";
import { assertBytes, bytes } from "../bytes.mjs";
import { finish } from "../finish.mjs";

describe("packed filesystem", () => {
  it("memory writes, copy, move, abort and host imports", async () => {
    const failures = [], releases = [];
    let writer;
    try {
      const fileSystem = createFileSystem(createMemoryAdapter(), { coordination: "local" });
      releases.push(() => fileSystem.close());
      await fileSystem.writeFile("/state/file.bin", bytes, { parents: true });
      assertBytes(await fileSystem.readFile("/state/file.bin"), bytes);
      assertBytes(await fileSystem.readFile("/state/file.bin", { at: 65530, length: 7 }), bytes.slice(65530));
      await fileSystem.copy("/state/file.bin", "/copy.bin");
      await fileSystem.move("/copy.bin", "/moved.bin");
      assertBytes(await fileSystem.readFile("/moved.bin"), bytes);
      if (await fileSystem.exists("/copy.bin")) throw new Error("Move retained the source");
      const handle = await fileSystem.getFileHandle("/moved.bin");
      writer = await handle.createWritable({ keepExistingData: true });
      releases.push(async () => {
        if (writer !== undefined) await writer.abort();
      });
      await writer.write({ type: "write", position: 0, data: new Uint8Array([255]) });
      await writer.abort();
      writer = undefined;
      assertBytes(await fileSystem.readFile("/moved.bin"), bytes);
      const signal = AbortSignal.abort();
      let aborted = false;
      try {
        await fileSystem.writeFile("/aborted.bin", bytes, { signal });
      } catch (error) {
        aborted = error.code === "aborted";
      }
      if (!aborted || await fileSystem.exists("/aborted.bin")) throw new Error("Aborted write published data");
      if (normalizePath("a/../b") !== "/b") throw new Error("npm path smoke failed");
      await import("@okikio/opfs/adapter/node");
      await import("@okikio/opfs/adapter/deno");
      await import("@okikio/opfs/adapter/bun");
    } catch (reason) {
      failures.push(reason);
    } finally {
      await finish(releases, failures);
    }
  });
  it("portable byte-source behavior", async () => {
    await testByteSource(() => ({
      source: createByteSource(new Uint8Array([2, 3, 5, 7])),
      expected: new Uint8Array([2, 3, 5, 7]),
      close() {},
    }));
  });
});
