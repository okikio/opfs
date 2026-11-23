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
import type { KvPinType } from "../src/driver/generation.ts";
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

describe("generation retirement observations", () => {
  it("accepts only acquired missing state as idempotent abort and retains lookup failure", async () => {
    await withReleases(async (releases) => {
      const db = await Deno.openKv(":memory:");
      releases.push(() => db.close());
      const wire = transport(db);
      const lifecycle = new KvGeneration(wire.database, "retirement:v3", {});
      await lifecycle.abort("/value", "absent");
      const get = wire.database.get;
      const admitted = gate();
      const held = gate();
      const reason = new Error("actual state lookup failure");
      wire.database.get = async () => {
        admitted.resolve();
        await held.promise;
        throw reason;
      };
      const pending = lifecycle.abort("/value", "unknown");
      void pending.catch(() => {});
      releases.push(() => Promise.allSettled([pending]));
      releases.push(() => held.resolve());
      await within(admitted.promise, "generation cleanup lookup");
      held.resolve();
      await expect(within(pending, "generation lookup rejection")).rejects.toBe(reason);
      wire.database.get = get;
    });
  });

  it("refuses invalid acquired generation state instead of treating it as absent", async () => {
    await withReleases(async (releases) => {
      const db = await Deno.openKv(":memory:");
      releases.push(() => db.close());
      await db.set(["retirement:v3", "generation", "/value", "invalid"], { invalid: true });
      const lifecycle = new KvGeneration(db, "retirement:v3", {});
      await expect(lifecycle.abort("/value", "invalid")).rejects.toBeInstanceOf(Error);
      expect((await db.get(["retirement:v3", "generation", "/value", "invalid"])).value).toEqual({ invalid: true });
    });
  });

  it("shares one held pin-release result across repeated release calls", async () => {
    await withReleases(async (releases) => {
      const db = await Deno.openKv(":memory:");
      releases.push(() => db.close());
      const wire = transport(db);
      const lifecycle = new KvGeneration(wire.database, "retirement:v3", {});
      await lifecycle.part("/value", "owned", 0, Uint8Array.of(17));
      const logical = await db.get(["retirement:v3", "entry", "/value"]);
      const transaction = wire.database.atomic().set(logical.key, "visible");
      await lifecycle.publish(transaction, "/value", "owned");
      await transaction.commit();
      const pin = await lifecycle.pin("/value", "owned", await db.get(logical.key));
      const get = wire.database.get;
      const admitted = gate();
      const held = gate();
      const reason = new Error("actual pin-release failure");
      let requests = 0;
      wire.database.get = async <T = unknown>(key: DenoKvKeyType) => {
        if (key[1] === "pin") {
          requests++;
          admitted.resolve();
          await held.promise;
          throw reason;
        }
        return await get<T>(key);
      };
      let settled = false;
      const first = pin.release();
      const second = pin.release().finally(() => settled = true);
      void first.catch(() => {});
      void second.catch(() => {});
      releases.push(() => Promise.allSettled([first, second]));
      releases.push(() => held.resolve());
      await within(admitted.promise, "pin release admission");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      held.resolve();
      await expect(within(first, "first pin release")).rejects.toBe(reason);
      await expect(within(second, "repeated pin release")).rejects.toBe(reason);
      expect(requests).toBe(1);
      wire.database.get = get;
      await lifecycle.collect(policy);
      expect((await lifecycle.probe()).pendingReaders).toBe(0);
    });
  });
});

/** Actual applied transactions remain the authority; only their receipt/inspection is faulted. */
describe("generation uncertain-commit inspection ownership", () => {
  const phases = ["namespace", "begin", "part", "pin", "renew", "release", "reclaim", "tombstone"] as const;
  for (const phase of phases) {
    for (const faults of ["undefined", "null", "equal"] as const) {
      it(`retains ${phase} commit and held ${faults} inspection failures as two events`, async () => {
        await withReleases(async (releases) => {
          const db = await Deno.openKv(":memory:");
          releases.push(() => db.close());
          const wire = transport(db);
          let now = 1;
          const lifecycle = new KvGeneration(wire.database, "inspection:v3", {
            clock: () => now,
            writerLeaseMs: 10,
            readerLeaseMs: 10,
            maxRetries: 3,
          });
          let pin: KvPinType | undefined;
          const physicalGet = wire.database.get;
          releases.push(async () => {
            wire.after(undefined);
            wire.database.get = physicalGet;
            await pin?.release();
            lifecycle.finish("owned");
          });
          let invoke: () => Promise<unknown>;
          if (phase === "namespace") invoke = () => lifecycle.open();
          else {
            await lifecycle.open();
            if (phase === "begin") invoke = () => lifecycle.part("/value", "owned", 0, Uint8Array.of(17));
            else {
              await lifecycle.part("/value", "owned", 0, Uint8Array.of(17));
              if (phase === "part") invoke = () => lifecycle.part("/value", "owned", 1, Uint8Array.of(31));
              else if (phase === "reclaim") {
                now = 100;
                invoke = () => lifecycle.collect(policy);
              } else if (phase === "tombstone") {
                await lifecycle.abort("/value", "owned");
                invoke = () => lifecycle.collect(policy);
              } else {
                const logical = await db.get(["inspection:v3", "entry", "/value"]);
                const transaction = wire.database.atomic().set(logical.key, "visible");
                await lifecycle.publish(transaction, "/value", "owned");
                await transaction.commit();
                const visible = await db.get(logical.key);
                if (phase === "pin") {
                  invoke = async () => {
                    pin = await lifecycle.pin("/value", "owned", visible);
                  };
                } else {
                  pin = await lifecycle.pin("/value", "owned", visible);
                  if (phase === "renew") {
                    now = 7;
                    invoke = () => pin!.check();
                  } else invoke = () => pin!.release();
                }
              }
            }
          }
          const same = new Error("equal independently observed commit and inspection failures");
          const primary = faults === "undefined" ? undefined : faults === "null" ? null : same;
          const inspection = faults === "undefined" ? undefined : faults === "null" ? null : same;
          const entered = gate();
          const held = gate();
          let selected: DenoKvKeyType | undefined;
          let commits = 0;
          let inspections = 0;
          const kind = phase === "namespace"
            ? "usage"
            : ["part", "reclaim"].includes(phase)
            ? "part"
            : ["pin", "renew", "release"].includes(phase)
            ? "pin"
            : "generation";
          wire.after((keys) => {
            const key = keys.find((key) => key[1] === kind);
            if (key === undefined) return;
            wire.after(undefined);
            commits++;
            selected = key;
            throw primary;
          });
          wire.database.get = async <T = unknown>(key: DenoKvKeyType) => {
            if (
              selected !== undefined && key.length === selected.length &&
              key.every((value, index) => value === selected?.[index])
            ) {
              inspections++;
              entered.resolve();
              await held.promise;
              throw inspection;
            }
            return await physicalGet<T>(key);
          };
          const pending = invoke();
          let settled = false;
          const observed = pending.then(
            () => {
              settled = true;
              throw new Error("Expected commit and inspection failures");
            },
            (reason: unknown) => {
              settled = true;
              return reason;
            },
          );
          void observed.catch(() => {});
          releases.push(() => within(Promise.allSettled([observed]), "uncertain generation fixture drain"));
          releases.push(() => {
            held.resolve();
            wire.database.get = physicalGet;
          });
          await within(entered.promise, "actual uncertain commit inspection admission");
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          expect(settled).toBe(false);
          expect(commits).toBe(1);
          held.resolve();
          const failure = await within(observed, "uncertain generation inspection outcome");
          expect(failure).toBeInstanceOf(AggregateError);
          if (!(failure instanceof AggregateError)) throw failure;
          expect(failure.errors).toHaveLength(2);
          expect(failure.errors[0]).toBe(primary);
          expect(failure.errors[1]).toBe(inspection);
          expect(inspections).toBe(1);
          if (phase === "release") pin = undefined; // The caller already observed this cached physical outcome.
        });
      });
    }

    it(`reconciles applied ${phase} receipt loss without reporting a false failure`, async () => {
      await withReleases(async (releases) => {
        const db = await Deno.openKv(":memory:");
        releases.push(() => db.close());
        const wire = transport(db);
        let now = 1;
        const lifecycle = new KvGeneration(wire.database, "reconciled:v3", {
          clock: () => now,
          writerLeaseMs: 10,
          readerLeaseMs: 10,
          maxRetries: 3,
        });
        let pin: KvPinType | undefined;
        releases.push(async () => {
          wire.after(undefined);
          await pin?.release();
          lifecycle.finish("owned");
        });
        let invoke: () => Promise<unknown>;
        if (phase === "namespace") invoke = () => lifecycle.open();
        else {
          await lifecycle.open();
          if (phase === "begin") invoke = () => lifecycle.part("/value", "owned", 0, Uint8Array.of(17));
          else {
            await lifecycle.part("/value", "owned", 0, Uint8Array.of(17));
            if (phase === "part") invoke = () => lifecycle.part("/value", "owned", 1, Uint8Array.of(31));
            else if (phase === "reclaim") {
              now = 100;
              invoke = () => lifecycle.collect(policy);
            } else if (phase === "tombstone") {
              await lifecycle.abort("/value", "owned");
              invoke = () => lifecycle.collect(policy);
            } else {
              const logical = await db.get(["reconciled:v3", "entry", "/value"]);
              const tx = wire.database.atomic().set(logical.key, "visible");
              await lifecycle.publish(tx, "/value", "owned");
              await tx.commit();
              const visible = await db.get(logical.key);
              if (phase === "pin") {
                invoke = async () => {
                  pin = await lifecycle.pin("/value", "owned", visible);
                };
              } else {
                pin = await lifecycle.pin("/value", "owned", visible);
                if (phase === "renew") {
                  now = 7;
                  invoke = () => pin!.check();
                } else invoke = () => pin!.release();
              }
            }
          }
        }
        const kind = phase === "namespace"
          ? "usage"
          : ["part", "reclaim"].includes(phase)
          ? "part"
          : ["pin", "renew", "release"].includes(phase)
          ? "pin"
          : "generation";
        let lost = 0;
        let selected: DenoKvKeyType | undefined;
        wire.after((keys) => {
          const key = keys.find((key) => key[1] === kind);
          if (key === undefined) return;
          selected = key;
          wire.after(undefined);
          lost++;
          throw undefined;
        });
        await within(invoke(), "actual applied generation reconciliation");
        expect(lost).toBe(1);
        if (selected === undefined) throw new Error("Actual applied transaction was not observed");
        const applied = await db.get(selected);
        if (["release", "reclaim", "tombstone"].includes(phase)) {
          expect(applied.value).toBe(null);
          expect(applied.versionstamp).toBe(null);
        } else if (phase === "part") expect(applied.value).toEqual(Uint8Array.of(31));
        else if (phase === "begin") {
          expect(applied.value).toMatchObject({ state: "writing", path: "/value", generation: "owned" });
        } else if (phase === "namespace") expect(applied.value).toMatchObject({ version: 3, bytes: 0, generations: 0 });
        else if (phase === "renew") expect(applied.value).toMatchObject({ deadline: 17 });
        else expect(applied.value).toMatchObject({ deadline: 11 });
        const usage = await lifecycle.probe();
        expect(usage.bytes).toBe(["reclaim", "tombstone", "namespace"].includes(phase) ? 0 : phase === "part" ? 2 : 1);
        expect(usage.generations).toBe(["tombstone", "namespace"].includes(phase) ? 0 : 1);
      });
    });
  }

  it("keeps the explicit namespace attempt limit and all exhausted commit faults", async () => {
    await withReleases(async (releases) => {
      const db = await Deno.openKv(":memory:");
      releases.push(() => db.close());
      const wire = transport(db);
      let attempts = 0;
      wire.before(async () => {
        attempts++;
        throw undefined;
      });
      const lifecycle = new KvGeneration(wire.database, "budget:v3", { maxRetries: 2 });
      const failure = await lifecycle.open().then(
        () => {
          throw new Error("Expected bounded namespace admission failure");
        },
        (reason: unknown) => reason,
      );
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw failure;
      expect(failure.errors).toHaveLength(3);
      expect(failure.errors[0]).toMatchObject({ code: "locked" });
      expect(failure.errors.slice(1)).toEqual([undefined, undefined]);
      expect(attempts).toBe(2);
      expect((await db.get(["budget:v3", "usage"])).value).toBe(null);
    });
  });
});
