/// <reference types="deno" />
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import {
  createDenoKvDriver,
  type DenoKvAtomicType,
  type DenoKvCheckType,
  type DenoKvEntryType,
  type DenoKvKeyType,
  type DenoKvListOptionsType,
  type DenoKvListSelectorType,
  type DenoKvType,
} from "../src/driver/deno-kv.ts";
import { KvGeneration } from "../src/driver/generation.ts";
import { withReleases } from "./close.ts";
import { within } from "./gate.ts";

/** Real KV engine with a transport boundary that can lose a successful response. */
function transport(db: Deno.Kv) {
  let after: ((keys: DenoKvKeyType[]) => void) | undefined;
  let before: ((keys: DenoKvKeyType[]) => Promise<void>) | undefined;
  const database: DenoKvType = {
    get: db.get.bind(db),
    set: db.set.bind(db),
    delete: db.delete.bind(db),
    list: db.list.bind(db),
    atomic() {
      const native = db.atomic();
      const keys: DenoKvKeyType[] = [];
      const transaction: DenoKvAtomicType = {
        check(...checks: DenoKvCheckType[]) {
          native.check(...checks);
          return transaction;
        },
        set(key, value) {
          keys.push(key);
          native.set(key, value);
          return transaction;
        },
        delete(key) {
          keys.push(key);
          native.delete(key);
          return transaction;
        },
        async commit() {
          await before?.(keys);
          const result = await native.commit();
          if (result.ok) after?.(keys);
          return result;
        },
      };
      return transaction;
    },
  };
  return {
    database,
    after: (action: typeof after) => {
      after = action;
    },
    before: (action: typeof before) => {
      before = action;
    },
  };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const policy = { minAgeMs: 0, maxDeletes: 100, maxScans: 100, maxPinScans: 100, tombstoneAgeMs: 0 };

/** The public driver is exercised through a real local database; injected faults model dispatch receipts only. */
describe("generation fencing and accounting", () => {
  it("rejects pre-aborted maintenance before namespace acquisition even for an empty database", async () => {
    await withReleases(async (releases) => {
      const db = await Deno.openKv(":memory:");
      releases.push(() => db.close());
      const wire = transport(db);
      let calls = 0;
      const get = wire.database.get;
      wire.database.get = <T = unknown>(key: DenoKvKeyType) => {
        calls++;
        return get<T>(key);
      };
      const driver = createDenoKvDriver(wire.database);
      const controller = new AbortController();
      controller.abort("cancel maintenance");
      await expect(driver.collect({ signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
      expect(calls).toBe(0);
      expect((await db.get(["okikio-opfs:v3", "usage"])).value).toBe(null);
    });
  });

  it("protects an active stream writer during zero-grace maintenance", async () => {
    await withReleases(async (releases) => {
      const db = await Deno.openKv(":memory:");
      releases.push(() => db.close());
      const wire = transport(db);
      const driver = createDenoKvDriver(wire.database, { partition: "always", partBytes: 4 });
      const stalled = gate();
      const persisted = gate();
      wire.after((keys) => {
        if (!keys.some((key) => key[1] === "part")) return;
        wire.after(undefined);
        persisted.resolve();
      });
      const owned: { write?: Promise<void> } = {};
      releases.push(async () => {
        stalled.resolve();
        if (owned.write !== undefined) await within(Promise.allSettled([owned.write]), "active KV writer teardown");
      });
      const write = owned.write = driver.writeStream!(
        "/a",
        new ReadableStream({
          async start(c) {
            c.enqueue(new Uint8Array([1, 2, 3, 4]));
            await stalled.promise;
            c.close();
          },
        }),
        { mode: "replace" },
      );
      void write.catch(() => {});
      await within(persisted.promise, "first physical KV writer part commit");
      const physical: unknown[] = [];
      for await (const part of db.list({ prefix: ["okikio-opfs:v3", "part", "/a"] })) physical.push(part.value);
      expect(physical).toEqual([new Uint8Array([1, 2, 3, 4])]);
      expect((await driver.probe()).bytes).toBe(4);
      expect((await driver.collect(policy)).deleted).toBe(0);
      expect((await driver.probe()).bytes).toBe(4);
      stalled.resolve();
      await write;
      expect(await driver.readFile!("/a")).toEqual(new Uint8Array([1, 2, 3, 4]));
    });
  });

  for (const claimed of [false, true]) {
    it(`fences a suspended publication only when collection changes its version (claim=${claimed})`, async () => {
      await withReleases(async (releases) => {
        const db = await Deno.openKv(":memory:");
        releases.push(() => db.close());
        let now = 1;
        const wire = transport(db);
        const entered = gate();
        const release = gate();
        const driver = createDenoKvDriver(wire.database, { partition: "always", writerLeaseMs: 10, clock: () => now });
        wire.before(async (keys) => {
          if (!keys.some((key) => key[1] === "entry")) return;
          wire.before(undefined);
          entered.resolve();
          await release.promise;
        });
        const write = driver.writeFile!("/a", new Uint8Array([7]), { mode: "replace" });
        const settled = write.then(() => true, () => false);
        releases.push(async () => {
          release.resolve();
          await within(Promise.allSettled([write]), "suspended publication teardown");
        });
        await within(entered.promise, "suspended publication dispatch admission");
        now = 20;
        if (claimed) expect((await driver.collect(policy)).deleted).toBe(1);
        release.resolve();
        expect(await settled).toBe(!claimed);
        expect(await driver.get("/a")).toEqual(claimed ? null : expect.objectContaining({ size: 1 }));
      });
    });
  }

  for (const action of ["create", "renew", "release", "prune"] as const) {
    it(`keeps exact present-pin count after an applied ${action} loses its response`, async () => {
      await withReleases(async (releases) => {
        const db = await Deno.openKv(":memory:");
        releases.push(() => db.close());
        let now = 1;
        const wire = transport(db);
        const lifecycle = new KvGeneration(wire.database, "test:v3", { clock: () => now, readerLeaseMs: 10 });
        await lifecycle.part("/a", "generation", 0, new Uint8Array([9]));
        const logical = await db.get(["test:v3", "entry", "/a"]);
        const publish = wire.database.atomic().check(logical).set(logical.key, "visible");
        await lifecycle.publish(publish, "/a", "generation");
        expect((await publish.commit()).ok).toBe(true);
        const visible = await db.get(logical.key);
        let lost = false;
        const inject = () =>
          wire.after((keys) => {
            if (keys.some((key) => key[1] === "pin")) {
              wire.after(undefined);
              lost = true;
              throw new Error("applied but response lost");
            }
          });
        if (action === "create") inject();
        const pin = await lifecycle.pin("/a", "generation", visible);
        if (action === "renew") {
          now = 7;
          inject();
          await pin.check();
        }
        if (action === "prune") {
          const retire = wire.database.atomic().check(visible).delete(visible.key);
          await lifecycle.publish(retire, "/a", undefined, "generation");
          await retire.commit();
          now = 30;
          inject();
          await lifecycle.collect(policy);
        } else {
          if (action === "release") inject();
          await pin.release();
          await pin.release();
        }
        expect(lost).toBe(true);
        const states = [];
        for await (const state of db.list({ prefix: ["test:v3", "generation"] })) states.push(state.value);
        let count = 0;
        for await (const _ of db.list({ prefix: ["test:v3", "pin"] })) count++;
        expect(count).toBe(0);
        for (const state of states) expect(Reflect.get(state as object, "pins")).toBe(count);
        expect((await lifecycle.probe()).pendingReaders).toBe(0);
      });
    });
  }

  it("retains a pin renewed after the collector's expired listing snapshot", async () => {
    await withReleases(async (releases) => {
      const db = await Deno.openKv(":memory:");
      releases.push(() => db.close());
      let now = 1;
      const wire = transport(db);
      const lifecycle = new KvGeneration(wire.database, "test:v3", { clock: () => now, readerLeaseMs: 10 });
      await lifecycle.part("/a", "g", 0, new Uint8Array([9]));
      const entry = await db.get(["test:v3", "entry", "/a"]);
      const publish = wire.database.atomic().set(entry.key, "visible");
      await lifecycle.publish(publish, "/a", "g");
      await publish.commit();
      const visible = await db.get(entry.key);
      const pin = await lifecycle.pin("/a", "g", visible);
      releases.push(() => pin.release());
      const retire = wire.database.atomic().check(visible).delete(visible.key);
      await lifecycle.publish(retire, "/a", undefined, "g");
      await retire.commit();
      const prepared = gate();
      const dispatch = gate();
      wire.before(async (keys) => {
        if (!keys.some((key) => key[1] === "pin")) return;
        wire.before(undefined);
        prepared.resolve();
        await dispatch.promise;
      });
      now = 7;
      const renewal = pin.check(); // Eligibility is checked before expiry; CAS owns late dispatch.
      void renewal.catch(() => {});
      releases.push(async () => {
        dispatch.resolve();
        await within(Promise.allSettled([renewal]), "renewed pin dispatch teardown");
      });
      await within(prepared.promise, "reader renewal prepared dispatch");
      now = 12;
      const originalList = wire.database.list;
      wire.database.list = async function* <T = unknown>(
        selector: DenoKvListSelectorType,
        options?: DenoKvListOptionsType,
      ): AsyncIterableIterator<DenoKvEntryType<T>> {
        for await (const value of originalList<T>(selector, options)) {
          if ("prefix" in selector && selector.prefix[1] === "pin") {
            dispatch.resolve();
            await renewal; // Its deadline is now 17, but the listed snapshot says 11.
          }
          yield value;
        }
      };
      const result = await lifecycle.collect(policy);
      expect(result.prunedPins).toBe(0);
      expect(result.deleted).toBe(0);
      const state = await db.get<{ pins: number }>(["test:v3", "generation", "/a", "g"]);
      expect(state.value?.pins).toBe(1);
      expect((await db.get(["test:v3", "part", "/a", "g", 0])).value).toEqual(new Uint8Array([9]));
      await pin.release();
      expect((await lifecycle.collect(policy)).deleted).toBe(1);
    });
  });

  it("retains unknown pin identity until explicit maintenance reconciles cleanup", async () => {
    await withReleases(async (releases) => {
      const db = await Deno.openKv(":memory:");
      releases.push(() => db.close());
      const wire = transport(db);
      const lifecycle = new KvGeneration(wire.database, "test:v3", {});
      await lifecycle.part("/a", "g", 0, new Uint8Array([1]));
      const logical = await db.get(["test:v3", "entry", "/a"]);
      const tx = wire.database.atomic().set(logical.key, "visible");
      await lifecycle.publish(tx, "/a", "g");
      await tx.commit();
      const realGet = wire.database.get;
      wire.after((keys) => {
        if (keys.some((k) => k[1] === "pin")) {
          wire.after(undefined);
          wire.database.get = async () => {
            throw new Error("connection unavailable");
          };
          throw new Error("response lost");
        }
      });
      await expect(lifecycle.pin("/a", "g", await db.get(logical.key))).rejects.toBeInstanceOf(AggregateError);
      wire.database.get = realGet;
      expect((await lifecycle.probe()).pendingReaders).toBe(1);
      await lifecycle.collect(policy);
      expect((await lifecycle.probe()).pendingReaders).toBe(0);
      expect(Reflect.get((await db.get(["test:v3", "generation", "/a", "g"])).value as object, "pins")).toBe(0);
    });
  });

  it("admits concurrent immutable parts without losing aggregate byte accounting", async () => {
    await withReleases(async (releases) => {
      const db = await Deno.openKv(":memory:");
      releases.push(() => db.close());
      const lifecycle = new KvGeneration(db, "test:v3", { maxRetainedBytes: 32, maxGenerations: 2 });
      await Promise.all(Array.from({ length: 8 }, (_, index) => lifecycle.part("/a", "g", index, new Uint8Array(4))));
      expect((await lifecycle.probe()).bytes).toBe(32);
      await expect(lifecycle.part("/a", "g", 8, new Uint8Array(1))).rejects.toMatchObject({ code: "quota-exceeded" });
      await lifecycle.abort("/a", "g");
      expect((await lifecycle.probe()).bytes).toBe(0);
      await expect(lifecycle.part("/a", "g", 0, new Uint8Array(1))).rejects.toMatchObject({ code: "locked" });
    });
  });
  it("continues bounded scans beyond early published generations", async () => {
    await withReleases(async (releases) => {
      const db = await Deno.openKv(":memory:");
      releases.push(() => db.close());
      const driver = createDenoKvDriver(db, { partition: "always" });
      for (let at = 0; at < 6; at++) await driver.writeFile!(`/a${at}`, new Uint8Array([at]), { mode: "replace" });
      await driver.writeFile!("/z", new Uint8Array([8]), { mode: "replace" });
      await driver.writeFile!("/z", new Uint8Array([9]), { mode: "replace" });
      let cursor: string | undefined;
      let deleted = 0;
      for (let pass = 0; pass < 12; pass++) {
        const result = await driver.collect({ ...policy, maxScans: 2, ...(cursor === undefined ? {} : { cursor }) });
        deleted += result.deleted;
        cursor = result.cursor;
        if (cursor === undefined) break;
      }
      expect(cursor).toBeUndefined();
      expect(deleted).toBe(1);
      expect(await driver.readFile!("/z")).toEqual(new Uint8Array([9]));
    });
  });

  it("rejects expired reader delivery and prunes pins transactionally before collection", async () => {
    await withReleases(async (releases) => {
      const db = await Deno.openKv(":memory:");
      releases.push(() => db.close());
      let now = 1;
      const lifecycle = new KvGeneration(db, "test:v3", { clock: () => now, readerLeaseMs: 10, maxReaders: 1 });
      await lifecycle.part("/a", "g", 0, new Uint8Array([1]));
      const logical = await db.get(["test:v3", "entry", "/a"]);
      const tx = db.atomic().set(logical.key, "visible");
      await lifecycle.publish(tx, "/a", "g");
      await tx.commit();
      const visible = await db.get(logical.key);
      const pin = await lifecycle.pin("/a", "g", visible);
      await expect(lifecycle.pin("/a", "g", visible)).rejects.toMatchObject({ code: "locked" });
      const retire = db.atomic().check(visible).delete(visible.key);
      await lifecycle.publish(retire, "/a", undefined, "g");
      await retire.commit();
      expect((await lifecycle.collect(policy)).deleted).toBe(0);
      now = 20;
      expect((await lifecycle.collect(policy)).prunedPins).toBe(1);
      await expect(pin.check()).rejects.toMatchObject({ code: "locked" });
      await pin.release();
      expect((await lifecycle.probe()).bytes).toBe(0);
    });
  });
});
