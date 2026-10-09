import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";

import { createFileSystem, FileSystemError, toFileSystemError } from "../mod.ts";
import { aggregate } from "../src/close.ts";
import { RequestMetrics, sendRequest } from "../src/request.ts";
import { defineAdapter } from "../src/adapter/definition.ts";
import type { AdapterType } from "../src/adapter/definition.ts";
import { createNodeAdapter } from "../src/adapter/node.ts";
import { createNodeDriver } from "../src/driver/node.ts";
import { createMemoryAdapter } from "../src/adapter/memory.ts";
import { createRecordAdapter } from "../src/adapter/record.ts";
import { defineRecordDriver, type RecordBackendType } from "../src/driver/record.ts";
import { withReleases } from "./close.ts";
import { within } from "./gate.ts";

/** Captures actual rejection, including null and undefined, separately from success. */
async function rejected(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (reason) {
    return reason;
  }
  throw new Error("The operation unexpectedly succeeded.");
}

/** Requires the caller-visible category and complete independent fault tree. */
function failures(reason: unknown, code: string): readonly unknown[] {
  expect(reason).toBeInstanceOf(FileSystemError);
  if (!(reason instanceof FileSystemError)) throw reason;
  expect(reason.code).toBe(code);
  expect(reason.cause).toBeInstanceOf(AggregateError);
  if (!(reason.cause instanceof AggregateError)) throw reason.cause;
  return reason.cause.errors;
}

/**
 * Overrides only the fixture boundary while retaining the real adapter receiver.
 *
 * Class methods are inherited and can use private fields. Spreading a backend
 * loses those methods; inheriting them onto a fresh object changes their receiver.
 * Bind delegated methods to the acquired adapter so each test reaches its real
 * storage behavior, while explicit overrides keep their independent fault gates.
 */
function wrap(adapter: AdapterType, overrides: Partial<AdapterType>): AdapterType {
  return defineAdapter(
    new Proxy(adapter, {
      get(target, name, receiver) {
        if (Object.hasOwn(overrides, name)) return Reflect.get(overrides, name, receiver);
        const value: unknown = Reflect.get(target, name, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );
}

describe("filesystem retirement", () => {
  it("retains explicit undefined causes while distinguishing omitted causes", () => {
    const omitted = new FileSystemError("aborted", "write", "/file", "Authored abort.");
    const explicit = new FileSystemError("aborted", "write", "/file", "Authored abort.", undefined);
    expect(Object.hasOwn(omitted, "cause")).toBe(false);
    expect(Object.hasOwn(explicit, "cause")).toBe(true);
    expect(explicit.cause).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(explicit, "cause")?.enumerable).toBe(false);
    const foreign = { name: "FileSystemError", code: "aborted", operation: "write", path: "/file", cause: undefined };
    const normalized = toFileSystemError(foreign, "write", "/file");
    expect(normalized.code).toBe("aborted");
    expect(Object.hasOwn(normalized, "cause")).toBe(true);
    expect(normalized.cause).toBeUndefined();
  });

  it("keeps an owned primary category and equal-valued independent faults", () => {
    const primary = new FileSystemError("aborted", "write", "/file", "Authored abort.", null);
    const owned = aggregate([primary, primary], "Two independently settled events.");
    const normalized = toFileSystemError(owned, "write", "/file");
    expect(normalized.code).toBe("aborted");
    expect(normalized.cause).toBe(owned);
    expect(owned.errors).toHaveLength(2);
    expect(owned.errors[0]).toBe(primary);
    expect(owned.errors[1]).toBe(primary);
    const borrowed = new AggregateError([primary], "Foreign cause is not primary authority.", { cause: primary });
    const foreign = toFileSystemError(borrowed, "write", "/file");
    expect(foreign.code).toBe("unknown");
    expect(foreign.cause).toBe(borrowed);
  });

  for (
    const primary of [
      new FileSystemError("quota-exceeded", "write", "/file", "Actual write quota failure."),
      Object.assign(new Error("Actual native quota failure."), { code: "ENOSPC" }),
      null,
    ]
  ) {
    it(`keeps the operation category beside an equal-valued caller event (${String(primary)})`, async () => {
      const caller = new AbortController();
      const failure = await rejected(
        sendRequest(async () => ({ input: new URL("https://storage.example.test/file") }), {
          signal: caller.signal,
          replayable: false,
          fetch: async () => {
            caller.abort(primary);
            throw primary;
          },
        }),
      );
      const normalized = toFileSystemError(failure, "write", "/file");
      expect(normalized.code).toBe(primary === null ? "unknown" : "quota-exceeded");
      expect(normalized.cause).toBe(failure);
      expect(failure).toMatchObject({ errors: [primary, primary] });
    });
  }

  it("keeps an owned abort winner's category and its independent observer failure", async () => {
    await withReleases(async (releases) => {
      const caller = new AbortController();
      const admitted = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const observer = new Error("Actual terminal observer failure.");
      class Metrics extends RequestMetrics {
        override failure(): void {
          throw observer;
        }
      }
      const pending = rejected(sendRequest(async () => {
        admitted.resolve();
        await finish.promise;
        return { input: new URL("https://storage.example.test/file") };
      }, {
        signal: caller.signal,
        replayable: false,
        metrics: new Metrics(),
        fetch: async () => {
          throw new Error("Aborted preparation cannot dispatch.");
        },
      }));
      releases.push(() => pending);
      releases.push(() => finish.resolve());
      releases.push(() => caller.abort(null));
      await within(admitted.promise, "request preparation admission");
      caller.abort(null);
      const failure = await within(pending, "request abort observation");
      const normalized = toFileSystemError(failure, "write", "/file");
      expect(normalized.code).toBe("aborted");
      expect(normalized.cause).toBe(failure);
      expect(failure).toMatchObject({ errors: [null, observer] });
      const borrowed = new AggregateError([null, observer], "Borrowed cancellation shape", { cause: null });
      expect(toFileSystemError(borrowed, "write", "/file").code).toBe("unknown");
    });
  });

  for (const cleanup of [undefined, null, new Error("Authored source retirement failure.")]) {
    for (const route of ["driver", "adapter"] as const) {
      it(`awaits rejected ${route} input retirement and preserves ${String(cleanup)}`, async () => {
        await withReleases(async (releases) => {
          let calls = 0;
          const backend: RecordBackendType = {
            async get() {
              calls++;
              return null;
            },
            async set() {
              calls++;
            },
            async delete() {
              calls++;
            },
            async *list() {
              calls++;
              yield* [];
            },
            async writeStream() {
              calls++;
            },
          };
          const driver = defineRecordDriver(backend, {
            name: "retirement",
            plan: (input) => ({
              operation: input.operation,
              supported: false,
              support: "unsupported",
              problems: [{
                code: "authored-policy",
                layer: "driver",
                severity: "error",
                message: "Authored policy rejects this write.",
              }],
              actions: [],
            }),
          });
          const adapter = createRecordAdapter(driver);
          const entered = Promise.withResolvers<void>();
          const finish = Promise.withResolvers<void>();
          let cancelledWith: unknown;
          let settled = false;
          const source = new ReadableStream<Uint8Array>({
            async cancel(reason) {
              cancelledWith = reason;
              entered.resolve();
              await finish.promise;
              throw cleanup;
            },
          }, { highWaterMark: 0 });
          const pending = rejected(
            route === "driver"
              ? driver.writeStream!("/file", source, { mode: "replace" })
              : adapter.writeStream!("/file", source, { mode: "replace" }),
          ).finally(() => {
            settled = true;
          });
          releases.push(() => pending);
          releases.push(() => finish.resolve());
          await within(entered.promise, "preflight source cancellation admission");
          await setImmediate();
          expect(settled).toBe(false);
          expect(calls).toBe(0);
          finish.resolve();
          const reason = await within(pending, "preflight source retirement settlement");
          const retained = failures(reason, route === "driver" ? "too-large" : "not-supported");
          expect(retained).toHaveLength(2);
          expect(retained[0]).toBe(cancelledWith);
          expect(retained[1]).toBe(cleanup);
          expect(source.locked).toBe(false);
          expect(calls).toBe(0);
        });
      });
    }
  }

  for (const publication of ["failed", "consumed"] as const) {
    it(`retains copy staging faults and respects ${publication} stage ownership`, async () => {
      await withReleases(async (releases) => {
        const root = await mkdtemp(join(tmpdir(), "opfs-retirement-"));
        releases.push(() => rm(root, { recursive: true, force: true }));
        const native = createNodeAdapter({ root });
        const primary = new Error("Authored move rejection before publication.");
        const cleanup = new Error("Authored stage retirement rejection.");
        let stage: string | undefined;
        let removals = 0;
        const adapter = wrap(native, {
          name: "retirement-copy",
          capabilities: { ...native.capabilities, nativeCopy: false },
          async move(from, to, options) {
            stage = from;
            if (publication === "failed") throw primary;
            await native.move!(from, to, options);
            // This entry has a new owner after the stage was consumed.
            await native.writeFile(from, Uint8Array.of(9), { mode: "replace" });
          },
          async remove(path, options) {
            removals++;
            if (publication === "failed") throw cleanup;
            await native.remove(path, options);
          },
        });
        const fs = createFileSystem(adapter, {
          coordination: "local",
          metrics: "none",
          optimizations: { nativeCopy: false },
        });
        releases.push(() => fs.close());
        await fs.writeFile("/from", Uint8Array.of(1, 2));
        await fs.writeFile("/to", Uint8Array.of(7));
        if (publication === "failed") {
          const retained = failures(await rejected(fs.copy("/from", "/to", { overwrite: true })), "unknown");
          expect(retained).toHaveLength(2);
          expect(retained[0]).toBe(primary);
          expect(retained[1]).toBe(cleanup);
          expect(removals).toBe(1);
          expect(await fs.readFile("/to")).toEqual(Uint8Array.of(7));
        } else {
          await fs.copy("/from", "/to", { overwrite: true });
          expect(removals).toBe(0);
          expect(await fs.readFile("/to")).toEqual(Uint8Array.of(1, 2));
        }
        expect(stage).toBeDefined();
        if (stage === undefined) throw new Error("The preserving stage route was not reached.");
        expect(await native.readFile(stage, {})).toEqual(
          publication === "failed" ? Uint8Array.of(1, 2) : Uint8Array.of(9),
        );
      });
    });
  }

  for (const aborted of [false, true]) {
    it(`joins acquired copy input after destination rejection with abort ${aborted}`, async () => {
      await withReleases(async (releases) => {
        const memory = createMemoryAdapter();
        await memory.writeFile("/from", Uint8Array.of(1), { mode: "replace" });
        const entered = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        const primary = new FileSystemError("not-supported", "copy", "/from", "Authored destination rejection.");
        const cleanup = new Error("Authored copy input retirement rejection.");
        const controller = new AbortController();
        let cancellations = 0;
        const source = new ReadableStream<Uint8Array>({
          async cancel() {
            cancellations++;
            entered.resolve();
            await finish.promise;
            throw cleanup;
          },
        }, { highWaterMark: 0 });
        const adapter = wrap(memory, {
          capabilities: { ...memory.capabilities, nativeCopy: false, streamRead: true, streamWriteModes: ["replace"] },
          async openReadStream() {
            return source;
          },
          async writeStream() {
            if (aborted) controller.abort("Authored caller stop.");
            throw primary;
          },
        });
        const fs = createFileSystem(adapter, { coordination: "local", metrics: "none" });
        releases.push(() => fs.close());
        let settled = false;
        const pending = rejected(fs.copy("/from", "/to", { signal: controller.signal }))
          .finally(() => {
            settled = true;
          });
        releases.push(() => pending);
        releases.push(() => finish.resolve());
        await within(entered.promise, "copy source retirement admission");
        await setImmediate();
        expect(settled).toBe(false);
        finish.resolve();
        const retained = failures(await within(pending, "copy input retirement settlement"), "not-supported");
        expect(retained[0]).toBe(primary);
        const terminal = retained[1];
        if (aborted) {
          expect(terminal).toBeInstanceOf(AggregateError);
          if (!(terminal instanceof AggregateError)) throw terminal;
          expect(terminal.errors[0]).toBeInstanceOf(FileSystemError);
          expect((terminal.errors[0] as FileSystemError).code).toBe("aborted");
          expect(terminal.errors[1]).toBe(cleanup);
        } else expect(terminal).toBe(cleanup);
        expect(cancellations).toBe(1);
        expect(source.locked).toBe(false);
        expect(await memory.stat("/to", {})).toBeNull();
      });
    });
  }

  for (const outcome of ["success", undefined, null, new Error("Authored adapter disposal failure.")]) {
    it(`makes every close caller join physical adapter disposal ${String(outcome)}`, async () => {
      await withReleases(async (releases) => {
        const entered = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        let disposals = 0;
        let settled = 0;
        const adapter = wrap(createMemoryAdapter(), {
          async dispose() {
            disposals++;
            entered.resolve();
            await finish.promise;
            if (outcome !== "success") throw outcome;
          },
        });
        const fs = createFileSystem(adapter, { disposeAdapter: true, metrics: "none", coordination: "local" });
        const observe = (pending: PromiseLike<void>) =>
          Promise.resolve(pending).then(
            () => ({ status: "fulfilled" as const }),
            (reason: unknown) => ({ status: "rejected" as const, reason }),
          ).finally(() => {
            settled++;
          });
        const pending = [observe(fs.close()), observe(fs.close()), observe(fs[Symbol.asyncDispose]())];
        releases.push(() => Promise.all(pending));
        releases.push(() => finish.resolve());
        await within(entered.promise, "adapter disposal admission");
        await setImmediate();
        expect(disposals).toBe(1);
        expect(settled).toBe(0);
        finish.resolve();
        const results = await within(Promise.all(pending), "all facade disposal callers");
        for (const result of [...results, await observe(fs.close())]) {
          if (outcome === "success") expect(result.status).toBe("fulfilled");
          else {
            expect(result.status).toBe("rejected");
            if (result.status === "rejected") expect(result.reason).toBe(outcome);
          }
        }
        expect(disposals).toBe(1);
      });
    });
  }

  for (const route of ["copy", "empty-dir"] as const) {
    for (const reason of [undefined, null, new Error("Equal-valued independent sibling failures.")]) {
      it(`drains ${route} siblings and retains both independently rejected ${String(reason)} events`, async () => {
        await withReleases(async (releases) => {
          const memory = createMemoryAdapter();
          await memory.createDir("/from", {});
          for (const name of ["a", "b", "c"]) {
            await memory.writeFile(`/from/${name}`, Uint8Array.of(1), { mode: "replace" });
          }
          const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
          const finish = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
          let admitted = 0;
          const mutation = async () => {
            const index = admitted++;
            if (index >= 2) throw new Error("Work was admitted after an observed failure.");
            entered[index]!.resolve();
            await finish[index]!.promise;
            throw reason;
          };
          const adapter = wrap(memory, {
            capabilities: { ...memory.capabilities, nativeCopy: true },
            copy: mutation,
            remove: mutation,
          });
          const fs = createFileSystem(adapter, { coordination: "local", metrics: "none" });
          releases.push(() => fs.close());
          let settled = false;
          const pending = rejected(
            route === "copy" ? fs.copy("/from", "/to", { concurrency: 2 }) : fs.emptyDir("/from", { concurrency: 2 }),
          ).finally(() => {
            settled = true;
          });
          releases.push(() => pending);
          releases.push(() => {
            for (const gate of finish) gate.resolve();
          });
          await within(Promise.all(entered.map((gate) => gate.promise)), "two sibling mutations admitted");
          finish[0]!.resolve();
          await setImmediate();
          expect(settled).toBe(false);
          expect(admitted).toBe(2);
          finish[1]!.resolve();
          const retained = failures(await within(pending, "sibling failure drain"), "unknown");
          expect(retained).toHaveLength(2);
          expect(retained[0]).toBe(reason);
          expect(retained[1]).toBe(reason);
          expect(admitted).toBe(2);
        });
      });
    }
  }

  for (const traversal of [undefined, null]) {
    it(`rejects emptyDir after actual ${String(traversal)} traversal failure without admitting removal`, async () => {
      const memory = createMemoryAdapter();
      await memory.createDir("/from", {});
      await memory.writeFile("/from/a", Uint8Array.of(1), { mode: "replace" });
      let removals = 0;
      const adapter = wrap(memory, {
        async *readDir(path, options) {
          yield* memory.readDir(path, options);
          throw traversal;
        },
        async remove() {
          removals++;
        },
      });
      const fs = createFileSystem(adapter, { coordination: "local", metrics: "none" });
      try {
        const reason = await rejected(fs.emptyDir("/from"));
        expect(reason).toBeInstanceOf(FileSystemError);
        if (!(reason instanceof FileSystemError)) throw reason;
        expect(reason.code).toBe("unknown");
        expect(Object.hasOwn(reason, "cause")).toBe(true);
        expect(reason.cause).toBe(traversal);
        expect(removals).toBe(0);
        expect(await memory.readFile("/from/a", {})).toEqual(Uint8Array.of(1));
      } finally {
        await fs.close();
      }
    });

    it(`retains actual ${String(traversal)} traversal rejection while draining admitted copy`, async () => {
      await withReleases(async (releases) => {
        const memory = createMemoryAdapter();
        await memory.createDir("/from", {});
        await memory.writeFile("/from/a", Uint8Array.of(1), { mode: "replace" });
        const entered = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        const child = new Error("Authored admitted copy failure.");
        const adapter = wrap(memory, {
          capabilities: { ...memory.capabilities, nativeCopy: true },
          async *readDir(path, options) {
            yield* memory.readDir(path, options);
            throw traversal;
          },
          async copy() {
            entered.resolve();
            await finish.promise;
            throw child;
          },
        });
        const fs = createFileSystem(adapter, { coordination: "local", metrics: "none" });
        releases.push(() => fs.close());
        let settled = false;
        const pending = rejected(fs.copy("/from", "/to", { concurrency: 2 })).finally(() => {
          settled = true;
        });
        releases.push(() => pending);
        releases.push(() => finish.resolve());
        await within(entered.promise, "copy child admission before traversal failure");
        await setImmediate();
        expect(settled).toBe(false);
        finish.resolve();
        const retained = failures(await within(pending, "traversal and admitted child drain"), "unknown");
        expect(retained).toHaveLength(2);
        expect(retained[0]).toBe(traversal);
        expect(retained[1]).toBe(child);
      });
    });
  }

  for (const metrics of ["none", "basic", "timing"] as const) {
    it(`joins rejected native write input with ${metrics} metrics and retains retirement failure`, async () => {
      await withReleases(async (releases) => {
        const memory = createMemoryAdapter();
        const entered = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        const primary = new FileSystemError(
          "not-supported",
          "write",
          "/file",
          "Authored writer acquisition rejection.",
        );
        const cleanup = new Error("Authored write input retirement failure.");
        let cancellations = 0;
        const source = new ReadableStream<Uint8Array>({
          async cancel() {
            cancellations++;
            entered.resolve();
            await finish.promise;
            throw cleanup;
          },
        }, { highWaterMark: 0 });
        const adapter = wrap(memory, {
          capabilities: { ...memory.capabilities, streamWriteModes: ["replace"] },
          async writeStream() {
            throw primary;
          },
        });
        const fs = createFileSystem(adapter, { metrics, coordination: "local" });
        releases.push(() => fs.close());
        let settled = false;
        const pending = rejected(fs.writeFile("/file", source)).finally(() => {
          settled = true;
        });
        releases.push(() => pending);
        releases.push(() => finish.resolve());
        await within(entered.promise, "native write input cancellation admission");
        await setImmediate();
        expect(settled).toBe(false);
        finish.resolve();
        const retained = failures(await within(pending, "native write exact owner settlement"), "not-supported");
        expect(retained).toEqual([primary, cleanup]);
        expect(cancellations).toBe(1);
        expect(source.locked).toBe(false);
        expect(await memory.stat("/file", {})).toBeNull();
      });
    });
  }

  for (const kind of ["detached", "out-of-bounds", "empty"] as const) {
    it(`distinguishes ${kind} input from valid empty bytes in native host stream replacement`, async () => {
      await withReleases(async (releases) => {
        const root = await mkdtemp(join(tmpdir(), "opfs-byte-lifetime-"));
        releases.push(() => rm(root, { recursive: true, force: true }));
        const driver = createNodeDriver({ root });
        await driver.writeFile("/file", Uint8Array.of(7), { mode: "replace" });
        const buffer = new ArrayBuffer(4, { maxByteLength: 8 });
        const chunk = kind === "empty" ? new Uint8Array() : new Uint8Array(buffer, 2, 2);
        if (kind === "detached") structuredClone(buffer, { transfer: [buffer] });
        if (kind === "out-of-bounds") buffer.resize(1);
        // Each fixture reports zero bytes; that fact alone cannot admit it.
        expect(chunk.byteLength).toBe(0);
        let cancellations = 0;
        const source = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk);
            if (kind === "empty") controller.close();
          },
          cancel() {
            cancellations++;
          },
        }, { highWaterMark: 0 });
        if (kind === "empty") await driver.writeStream!("/file", source, { mode: "replace" });
        else {expect(await rejected(driver.writeStream!("/file", source, { mode: "replace" }))).toBeInstanceOf(
            TypeError,
          );}
        expect(cancellations).toBe(kind === "empty" ? 0 : 1);
        expect(source.locked).toBe(false);
        // Native replacement can truncate before consuming input. Rejection
        // establishes invalid admission, not rollback of the old host bytes.
        expect(await driver.readFile("/file")).toEqual(new Uint8Array());
      });
    });
  }
});
