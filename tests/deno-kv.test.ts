/// <reference types="deno" />
import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem } from "../mod.ts";
import { createDenoKvAdapter } from "../src/adapter/deno-kv.ts";
import { createDenoKvDriver } from "../src/driver/deno-kv.ts";
import { expectBytes, fixtureBytes, verifyBytes, verifyPendingAbort, withFileSystem } from "./reliability.ts";

describe("Deno KV adapter", () => {
  it("preserves boundary byte semantics and pending cancellation through real KV partitions", async (t) => {
    const database = await Deno.openKv(":memory:");
    t.after(() => database.close());
    const fileSystem = createFileSystem(createDenoKvAdapter(database), {
      coordination: "local",
      lockPrefix: crypto.randomUUID(),
      disposeAdapter: true,
    });
    await withFileSystem(fileSystem, async () => {
      await verifyBytes(fileSystem);
      await verifyPendingAbort(fileSystem);
    });
  });

  it("retains an opened immutable generation and bounds physical retirement collection", async (t) => {
    const database = await Deno.openKv(":memory:");
    t.after(() => database.close());
    const fileSystem = createFileSystem(createDenoKvAdapter(database), {
      coordination: "none",
      disposeAdapter: true,
    });
    await withFileSystem(fileSystem, async () => {
      const maintenance = createDenoKvDriver(database);
      const original = fixtureBytes(180 * 1024);
      await fileSystem.writeFile("/generation.bin", original);
      const reader = (await fileSystem.openReadStream("/generation.bin")).getReader();
      const chunks: Uint8Array[] = [];
      try {
        const first = await reader.read();
        expect(first.done).toBe(false);
        chunks.push(first.value!);
        await fileSystem.writeFile("/generation.bin", "new generation");
        expect((await maintenance.collect({ minAgeMs: 60_000 })).deleted).toBe(0);
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      const bytes = new Uint8Array(original.byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      expectBytes(bytes, original);
      expect(await fileSystem.readText("/generation.bin")).toBe("new generation");
      expect((await maintenance.collect({ minAgeMs: 0, maxDeletes: 1 })).deleted).toBe(1);
      expect((await maintenance.collect({ minAgeMs: 0 })).deleted).toBeGreaterThan(0);
      expect(await fileSystem.readText("/generation.bin")).toBe("new generation");
    });
  });

  it("executes against a real local Deno KV database", async (t) => {
    const root = await Deno.makeTempDir({ prefix: "okikio-opfs-kv-" });
    let database: Deno.Kv | undefined = undefined;
    t.after(async () => {
      try {
        database?.close();
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
    const path = `${root}/test.sqlite`;
    database = await Deno.openKv(path);
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
    }
  });
});
