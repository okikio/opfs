import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createFileSystem } from "../mod.ts";
import { createMemoryAdapter } from "../src/adapter/memory.ts";
import { FileSystemError } from "../src/error.ts";
import { drain, stalled } from "./provider/stalled.ts";
import { within } from "./gate.ts";
import { withReleases } from "./close.ts";

/** Capture terminal outcome without turning rejection of undefined into success. */
function observed(pending: Promise<unknown>) {
  return pending.then(
    () => ({ status: "fulfilled" as const }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

describe("Stalled mounted-write scenario ownership", () => {
  it("retires a real facade reader and permits exact same-path reuse", async () => {
    await withReleases(async (releases) => {
      const filesystem = createFileSystem(createMemoryAdapter(), { coordination: "local" });
      releases.push(() => filesystem.close());
      const retired: string[] = [];
      await stalled((source, signal) => filesystem.writeFile("/aborted.bin", source, { signal }), (phase) => () => {
        retired.push(phase);
      });
      expect(retired).toEqual(["admission", "cancellation"]);
      await filesystem.writeFile("/aborted.bin", new Uint8Array([1, 2, 3]));
      expect(await filesystem.readFile("/aborted.bin")).toEqual(new Uint8Array([1, 2, 3]));
    });
  });

  it("refuses a writer that resolves without admitting its producer", async () => {
    let source: ReadableStream<Uint8Array> | undefined;
    const result = await observed(stalled(async (input) => {
      source = input;
      return "invented cancellation";
    }, () => () => {}));
    expect(result.status).toBe("rejected");
    expect(source?.locked).toBe(false);
  });

  it("alarm-retirement failure still retires the real facade write and path lock", async () => {
    await withReleases(async (releases) => {
      const filesystem = createFileSystem(createMemoryAdapter(), { coordination: "local" });
      releases.push(() => filesystem.close());
      const failure = new Error("Admission alarm retirement failed.");
      const result = await observed(
        stalled((source, signal) => filesystem.writeFile("/owned.bin", source, { signal }), () => () => {
          throw failure;
        }),
      );
      expect(result).toEqual({ status: "rejected", reason: failure });
      await filesystem.writeFile("/owned.bin", new Uint8Array([9, 8]));
      expect(await filesystem.readFile("/owned.bin")).toEqual(new Uint8Array([9, 8]));
    });
  });

  it("awaits every batch sibling and preserves both actual failure reasons", async () => {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const first = new Error("First actual create failed.");
    const last = new Error("Last actual create failed.");
    let settled = false;
    const result = observed(drain([
      Promise.reject(first),
      (async () => {
        entered.resolve();
        await release.promise;
        throw last;
      })(),
    ])).finally(() => settled = true);
    try {
      await within(entered.promise, "owned concurrent sibling admission");
      // Consume runnable promise reactions while the sibling retirement gate remains closed.
      await nextTurn();
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await within(result, "all started batch siblings");
    }
    const failure = await result;
    if (failure.status !== "rejected" || !(failure.reason instanceof AggregateError)) {
      throw new Error("Batch failures were not retained independently.");
    }
    expect(failure.reason.errors).toEqual([first, last]);
    expect(failure.reason.cause).toBe(first);
  });

  it("reports an independently leaked reader without replacing the actual operation failure", async () => {
    const operation = new Error("Writer failed with a reader still borrowed.");
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const result = observed(stalled(async (source) => {
      reader = source.getReader();
      throw operation;
    }, () => () => {}));
    try {
      const failure = await result;
      if (failure.status !== "rejected" || !(failure.reason instanceof AggregateError)) {
        throw new Error("Operation and leaked-reader failures were not retained.");
      }
      expect(failure.reason.errors[0]).toBe(operation);
      expect(failure.reason.cause).toBe(operation);
      expect(failure.reason.errors).toHaveLength(2);
    } finally {
      if (reader) {
        await reader.cancel();
        reader.releaseLock();
      }
      await within(result, "leaked-reader refusal observation");
    }
  });

  for (const phase of ["admission", "cancellation"] as const) {
    it(`${phase} refusal awaits actual write retirement before returning`, async () => {
      const acquired = Promise.withResolvers<void>();
      const canceled = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const armed = Promise.withResolvers<() => void>();
      let signal: AbortSignal | undefined;
      let source: ReadableStream<Uint8Array> | undefined;
      let settled = false;
      let retired = 0;
      const pending = stalled(async (input, cancellation) => {
        signal = cancellation;
        source = input;
        if (phase === "admission") {
          acquired.resolve();
          await release.promise;
        } else {
          const reader = input.getReader();
          const abort = () => {
            void reader.cancel(cancellation.reason).then(() => canceled.resolve());
          };
          cancellation.addEventListener("abort", abort, { once: true });
          acquired.resolve();
          try {
            await reader.read();
            await release.promise;
          } finally {
            cancellation.removeEventListener("abort", abort);
            reader.releaseLock();
          }
        }
        throw new FileSystemError("aborted", "write", "/owned", "Authored cancellation.", cancellation.reason);
      }, (current, expire) => {
        if (current === phase) armed.resolve(expire);
        return () => retired++;
      });
      const result = observed(pending).finally(() => settled = true);
      try {
        await within(acquired.promise, "owned writer acquisition");
        const expire = await within(armed.promise, "owned alarm acquisition");
        if (phase === "cancellation") await within(canceled.promise, "source cancellation");
        expire();
        expect(signal?.aborted).toBe(true);
        // Consume runnable promise reactions while the sibling retirement gate remains closed.
        await nextTurn();
        expect(settled).toBe(false);
        if (phase === "cancellation") expect(source?.locked).toBe(true);
      } finally {
        release.resolve();
        await within(result, "actual pending-write retirement");
      }
      const failure = await result;
      expect(failure.status).toBe("rejected");
      if (failure.status !== "rejected") throw new Error("Scenario refusal was not retained.");
      expect(failure.reason).toBeInstanceOf(Error);
      if (phase === "admission") expect(failure.reason).toBe(signal?.reason);
      expect(source?.locked).toBe(false);
      expect(retired).toBe(phase === "admission" ? 1 : 2);
    });
  }

  it("retains the admission refusal beside an independent late operation failure", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const armed = Promise.withResolvers<() => void>();
    const independent = new Error("Actual retirement failed.");
    let signal: AbortSignal | undefined;
    const result = observed(stalled(async (_source, cancellation) => {
      signal = cancellation;
      started.resolve();
      await release.promise;
      throw independent;
    }, (_phase, expire) => {
      armed.resolve(expire);
      return () => {};
    }));
    try {
      await within(started.promise, "held writer acquisition");
      (await armed.promise)();
    } finally {
      release.resolve();
      await within(result, "independent pending-write failure");
    }
    const failure = await result;
    if (failure.status !== "rejected" || !(failure.reason instanceof AggregateError)) {
      throw new Error("Independent refusal and operation evidence were not retained.");
    }
    expect(failure.reason.errors).toEqual([signal?.reason, independent]);
    expect(failure.reason.cause).toBe(signal?.reason);
  });

  for (const reason of [undefined, null, new Error("Authored write fault.")]) {
    it(`preserves early ${reason === undefined ? "undefined" : reason === null ? "null" : "Error"} rejection`, async () => {
      let retired = 0;
      const failure = await observed(stalled(async () => {
        throw reason;
      }, () => () => retired++));
      expect(failure).toEqual({ status: "rejected", reason });
      expect(retired).toBe(1);
    });
  }

  it("alarm acquisition failure aborts and drains already admitted native work", async () => {
    const release = Promise.withResolvers<void>();
    const called = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const failure = new Error("Alarm acquisition rejected.");
    let signal: AbortSignal | undefined;
    let settled = false;
    const result = observed(stalled(async (_source, cancellation) => {
      signal = cancellation;
      if (cancellation.aborted) aborted.resolve();
      else cancellation.addEventListener("abort", () => aborted.resolve(), { once: true });
      called.resolve();
      await release.promise;
      throw new FileSystemError("aborted", "write", "/owned", "Authored cancellation.", cancellation.reason);
    }, () => {
      throw failure;
    })).finally(() => settled = true);
    try {
      await within(called.promise, "deferred writer acquisition");
      await within(aborted.promise, "actual alarm-fault cancellation");
      expect(signal?.aborted).toBe(true);
      // Consume runnable promise reactions while the sibling retirement gate remains closed.
      await nextTurn();
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await within(result, "alarm-fault pending retirement");
    }
    expect(await result).toEqual({ status: "rejected", reason: failure });
  });
});
