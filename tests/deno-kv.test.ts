/// <reference types="deno" />
import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem } from "../mod.ts";
import { createDenoKvAdapter } from "../src/adapter/deno-kv.ts";
import { createDenoKvDriver } from "../src/driver/deno-kv.ts";
import { withReleases } from "./close.ts";
import { expectBytes, fixtureBytes, verifyBytes, verifyPendingAbort } from "./reliability.ts";

describe("Deno KV adapter", () => {
  it("closes real databases and removes roots after body and independent release failures", async () => {
    for (const failRelease of [false, true]) {
      let root = "";
      let database: Deno.Kv | undefined;
      const primary = new Error("owned KV body failed");
      const cleanup = new Error("independent KV release failed");
      const events: string[] = [];
      let failure: unknown;
      try {
        await withReleases(async (releases) => {
          root = await Deno.makeTempDir({ prefix: "opfs-kv-lifetime-" });
          releases.push(async () => {
            await Deno.remove(root, { recursive: true });
            events.push("root");
          });
          const owned = await Deno.openKv(`${root}/test.sqlite`);
          database = owned;
          releases.push(() => {
            owned.close();
            events.push("database");
          });
          await owned.set(["alive"], true);
          expect((await owned.get(["alive"])).value).toBe(true);
          if (failRelease) {
            releases.push(() => {
              events.push("failed-release");
              throw cleanup;
            });
          }
          throw primary;
        });
      } catch (reason) {
        failure = reason;
      }
      if (failRelease) {
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
      } else {
        expect(failure).toBe(primary);
      }
      await expect(Deno.stat(root)).rejects.toBeInstanceOf(Deno.errors.NotFound);
      expect(events).toEqual([...(failRelease ? ["failed-release"] : []), "database", "root"]);
      await expect(Promise.resolve().then(() => database!.get(["alive"]))).rejects.toBeInstanceOf(Error);
    }
  });

  it("preserves boundary byte semantics and pending cancellation through real KV partitions", async () =>
    await withReleases(async (releases) => {
      const database = await Deno.openKv(":memory:");
      releases.push(() => database.close());
      const fileSystem = createFileSystem(createDenoKvAdapter(database), {
        coordination: "local",
        lockPrefix: crypto.randomUUID(),
        disposeAdapter: true,
      });
      releases.push(() => fileSystem.close());
      await verifyBytes(fileSystem);
      await verifyPendingAbort(fileSystem);
    }));

  it("retains an opened immutable generation and bounds physical retirement collection", async () =>
    await withReleases(async (releases) => {
      const database = await Deno.openKv(":memory:");
      releases.push(() => database.close());
      const fileSystem = createFileSystem(createDenoKvAdapter(database), {
        coordination: "none",
        disposeAdapter: true,
      });
      releases.push(() => fileSystem.close());
      const maintenance = createDenoKvDriver(database);
      const original = fixtureBytes(180 * 1024);
      await fileSystem.writeFile("/generation.bin", original);
      const chunks: Uint8Array[] = [];
      await withReleases(async (readerReleases) => {
        const stream = await fileSystem.openReadStream("/generation.bin");
        readerReleases.push(() => stream.locked ? undefined : stream.cancel());
        const reader = stream.getReader();
        readerReleases.push(() => reader.releaseLock());
        readerReleases.push(() => reader.cancel());
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
      });
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
    }));

  it("executes against a real local Deno KV database", async () =>
    await withReleases(async (releases) => {
      const root = await Deno.makeTempDir({ prefix: "okikio-opfs-kv-" });
      releases.push(() => Deno.remove(root, { recursive: true }));
      const path = `${root}/test.sqlite`;
      const database = await Deno.openKv(path);
      releases.push(() => database.close());
      const fileSystem = createFileSystem(createDenoKvAdapter(database), { coordination: "none" });
      releases.push(() => fileSystem.close());
      await fileSystem.writeFile("/kv/value.txt", "deno-kv", { parents: true });
      expect(await fileSystem.readText("/kv/value.txt")).toBe("deno-kv");
      expect((await fileSystem.stat("/kv")).kind).toBe("directory");

      const large = Uint8Array.from({ length: 180 * 1024 }, (_, index) => index % 251);
      await fileSystem.writeFile("/kv/large.bin", large);
      expect(await fileSystem.readFile("/kv/large.bin", { at: 70 * 1024, length: 4096 })).toEqual(
        large.slice(70 * 1024, 74 * 1024),
      );
      expect(await fileSystem.readFile("/kv/large.bin")).toEqual(large);
    }));
});
