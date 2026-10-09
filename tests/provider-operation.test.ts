import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { setImmediate } from "node:timers/promises";
import { isCancellation, isPart, settle } from "./provider-operation.ts";
import { within } from "./gate.ts";
import { map } from "../src/pool.ts";
import { RequestMetrics, sendRequest } from "../src/request.ts";
import { createCancellation, getCancellation, retainCancellation } from "../src/abort.ts";
import type { CancellationPrimaryType } from "../src/abort.ts";

/** Captures an actual rejection separately from successful undefined resolution. */
async function reject(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (reason) {
    return reason;
  }
  throw new Error("Expected the operation to reject.");
}

describe("Provider upload operational deadlines", () => {
  it("requires successful actual part admission for the exact scenario key", () => {
    const key = "integration/authored/old.bin";
    const s3 = new URL(`http://provider/bucket/${key}?partNumber=1&uploadId=actual-upload`);
    const azure = new URL(`http://provider/account/container/${key}?comp=block&blockid=actual-block`);
    expect(isPart("s3", key, s3, "PUT", 200)).toBe(true);
    expect(isPart("azure", key, azure, "PUT", 201)).toBe(true);
    for (const [provider, url, status] of [["s3", s3, 200], ["azure", azure, 201]] as const) {
      expect(isPart(provider, key, url, "POST", status)).toBe(false);
      expect(isPart(provider, "integration/different/old.bin", url, "PUT", status)).toBe(false);
      expect(isPart(provider, key, url, "PUT", 503)).toBe(false);
      const seed = new URL(url);
      seed.search = "";
      expect(isPart(provider, key, seed, "PUT", status)).toBe(false);
    }
    expect(isPart("s3", key, new URL(`http://provider/bucket/${key}?uploads`), "POST", 200)).toBe(false);
    expect(isPart("azure", key, new URL(`http://provider/container/${key}?comp=blocklist`), "PUT", 201)).toBe(false);
  });

  for (const reason of [undefined, null, new Error("Authored caller cancellation.")]) {
    it(`recognizes actual raw and sole mapper cancellation without hiding other faults (${String(reason)})`, async () => {
      const actual = await reject(Array.fromAsync(map(1, [1], async () => {
        throw reason;
      })));
      expect(actual).toBeInstanceOf(AggregateError);
      const controller = new AbortController();
      controller.abort(reason);
      // Native abort(undefined) creates its default AbortError, not undefined.
      const expected = controller.signal.reason;
      expect(isCancellation(expected, controller.signal)).toBe(true);
      const mapper = await reject(Array.fromAsync(map(1, [1], async () => {
        throw expected;
      })));
      expect(isCancellation(mapper, controller.signal)).toBe(true);
      expect(isCancellation(actual, controller.signal)).toBe(reason !== undefined);
      const independent = new Error("Authored independent provider failure.");
      for (
        const failure of [
          independent,
          new AggregateError([], "No observed mapper failure."),
          new AggregateError([independent], "Wrong mapper failure."),
          new AggregateError([reason, independent], "Independent fault retained."),
          new AggregateError([reason, reason], "Two separate equal-valued events."),
          new AggregateError([new AggregateError([reason], "Nested mapper failure.")], "Nested fault."),
          new AggregateError([reason], "Independent aggregate cause.", { cause: independent }),
          { errors: [reason] },
        ]
      ) expect(isCancellation(failure, controller.signal)).toBe(false);
    });
  }

  it("refuses an inactive signal even when its default reason matches", () => {
    const controller = new AbortController();
    expect(controller.signal.reason).toBeUndefined();
    expect(isCancellation(undefined, controller.signal)).toBe(false);
    expect(isCancellation(new AggregateError([undefined]), controller.signal)).toBe(false);
  });

  for (const reason of [null, "Caller stopped this request.", new Error("Authored forwarded Fetch abort.")]) {
    it(`recognizes actual Fetch and caller observations without flattening them (${String(reason)})`, async () => {
      const controller = new AbortController();
      let fetches = 0;
      const actual = await reject(sendRequest(async (signal) => ({
        input: "http://provider/part",
        init: { ...(signal === undefined ? {} : { signal }) },
      }), {
        signal: controller.signal,
        replayable: false,
        async fetch(_input, init) {
          fetches++;
          expect(init?.signal).toBe(controller.signal);
          controller.abort(reason);
          throw init!.signal!.reason;
        },
      }));
      const observed = getCancellation(actual);
      expect(observed?.signal).toBe(controller.signal);
      expect(observed?.reason).toBe(reason);
      expect(observed?.primary).toEqual({ kind: "operation", stage: "fetch", reason });
      expect(observed?.extra).toEqual([]);
      expect(actual).toBeInstanceOf(AggregateError);
      if (!(actual instanceof AggregateError)) throw actual;
      expect(actual.errors).toEqual([reason, reason]);
      expect(isCancellation(actual, controller.signal)).toBe(true);
      const mapped = await reject(Array.fromAsync(map(1, [1], async () => {
        throw actual;
      })));
      expect(mapped).toBeInstanceOf(AggregateError);
      if (!(mapped instanceof AggregateError)) throw mapped;
      expect(mapped.errors).toEqual([actual]);
      expect(isCancellation(mapped, controller.signal)).toBe(true);
      expect(isCancellation(new AggregateError([mapped]), controller.signal)).toBe(false);
      const other = new AbortController();
      other.abort(reason);
      expect(isCancellation(actual, other.signal)).toBe(false);
      expect(isCancellation(mapped, other.signal)).toBe(false);
      const borrowed = new AggregateError([reason, reason]);
      Object.assign(borrowed, observed);
      expect(getCancellation(borrowed)).toBeUndefined();
      expect(isCancellation(borrowed, controller.signal)).toBe(false);
      expect(isCancellation(new AggregateError([borrowed]), controller.signal)).toBe(false);
      expect(
        isCancellation({ signal: controller.signal, reason, primary: observed?.primary, extra: [] }, controller.signal),
      )
        .toBe(false);
      expect(
        isCancellation(
          new AggregateError([actual], "Independent envelope cause.", { cause: reason }),
          controller.signal,
        ),
      )
        .toBe(false);
      expect(fetches).toBe(1);
      // Admission is a predicate only; both exact observations stay untouched.
      expect(actual.errors).toEqual([reason, reason]);
    });
  }

  it("refuses private preparation, deadline, different Fetch and extra retirement evidence", () => {
    const controller = new AbortController();
    const reason = new Error("Authored caller abort.");
    const other = new Error("Independent operation fault.");
    controller.abort(reason);
    const primaries: readonly CancellationPrimaryType[] = [
      { kind: "abort" },
      { kind: "deadline", reason },
      { kind: "operation", stage: "prepare", reason },
      { kind: "operation", stage: "fetch", reason: other },
    ];
    // Negative private-owner records exercise provenance/category admission;
    // successful request evidence above comes from actual sendRequest calls.
    for (const primary of primaries) {
      const failure = retainCancellation(
        new AggregateError([reason, reason]),
        createCancellation(
          controller.signal,
          reason,
          primary,
        ),
      );
      expect(isCancellation(failure, controller.signal)).toBe(false);
      expect(isCancellation(new AggregateError([failure]), controller.signal)).toBe(false);
    }
    for (const extra of [reason, undefined, null, other]) {
      const failure = retainCancellation(
        new AggregateError([reason, reason, extra]),
        createCancellation(
          controller.signal,
          reason,
          { kind: "operation", stage: "fetch", reason },
          [extra],
        ),
      );
      expect(isCancellation(failure, controller.signal)).toBe(false);
      expect(isCancellation(new AggregateError([failure]), controller.signal)).toBe(false);
    }
  });

  for (const stage of ["rejected", "failure"] as const) {
    for (const equal of [false, true]) {
      it(`retains an actual ${stage} observer fault even when equal to cancellation ${equal}`, async () => {
        const controller = new AbortController();
        const reason = new Error("Authored caller cancellation.");
        const extra = equal ? reason : new Error("Independent metrics observer fault.");
        class Metrics extends RequestMetrics {
          override rejected(started: number | undefined): void {
            if (stage === "rejected") throw extra;
            super.rejected(started);
          }
          override failure(): void {
            if (stage === "failure") throw extra;
            super.failure();
          }
        }
        const actual = await reject(sendRequest(async (signal) => ({
          input: "http://provider/part",
          init: { ...(signal === undefined ? {} : { signal }) },
        }), {
          signal: controller.signal,
          metrics: new Metrics(),
          replayable: false,
          async fetch(_input, init) {
            expect(init?.signal).toBe(controller.signal);
            controller.abort(reason);
            throw init!.signal!.reason;
          },
        }));
        const observed = getCancellation(actual);
        expect(observed?.signal).toBe(controller.signal);
        expect(observed?.extra).toEqual([extra]);
        expect(isCancellation(actual, controller.signal)).toBe(false);
        expect(isCancellation(new AggregateError([actual]), controller.signal)).toBe(false);
      });
    }
  }

  it("retires a successful operation's alarm without aborting its caller", async () => {
    const controller = new AbortController();
    let retired = 0;
    const value = { receipt: "authored result" };
    expect(await settle(controller, async () => value, () => () => retired++)).toBe(value);
    expect(retired).toBe(1);
    expect(controller.signal.aborted).toBe(false);
  });

  it("preserves real part cancellation and retires its alarm", async () => {
    const controller = new AbortController();
    const reason = new Error("A successful real part was admitted.");
    let retired = 0;
    const observed = await reject(settle(controller, async () => {
      controller.abort(reason);
      throw controller.signal.reason;
    }, () => () => retired++));
    expect(observed).toBe(reason);
    expect(retired).toBe(1);
  });

  it("expiry aborts rather than closing the producer and awaits its actual cleanup", async () => {
    const controller = new AbortController();
    const alarm = Promise.withResolvers<() => void>();
    const acquired = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<unknown>();
    const cleanup = Promise.withResolvers<void>();
    let retired = 0;
    const source = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelled.resolve(reason);
      },
    }, { highWaterMark: 0 });
    let settled = false;
    const pending = settle(controller, async () => {
      const reader = source.getReader();
      const abort = () => {
        void reader.cancel(controller.signal.reason);
      };
      controller.signal.addEventListener("abort", abort, { once: true });
      acquired.resolve();
      try {
        await reader.read();
        await cleanup.promise;
        throw controller.signal.reason;
      } finally {
        controller.signal.removeEventListener("abort", abort);
        reader.releaseLock();
      }
    }, (expire) => {
      alarm.resolve(expire);
      return () => retired++;
    });
    const observed = reject(pending).finally(() => settled = true);
    try {
      await within(acquired.promise, "upload source acquisition");
      (await alarm.promise)();
      expect(await within(cancelled.promise, "producer cancellation")).toBe(controller.signal.reason);
      expect(controller.signal.reason).toBeInstanceOf(Error);
      // Flush reactions while cleanup stays held; an early-return owner must become observable.
      await setImmediate();
      expect(settled).toBe(false);
      expect(source.locked).toBe(true);
    } finally {
      controller.abort(new Error("Control cleanup."));
      cleanup.resolve();
      await within(observed, "owned upload cleanup");
    }
    expect(await observed).toBe(controller.signal.reason);
    expect(source.locked).toBe(false);
    expect(retired).toBe(1);
  });

  it("expiry cannot certify an operation that ignores abort and resolves", async () => {
    const controller = new AbortController();
    let expire = () => {};
    const observed = await reject(settle(controller, async () => {
      expire();
      return "ignored cancellation";
    }, (alarm) => {
      expire = alarm;
      return () => {};
    }));
    expect(observed).toBe(controller.signal.reason);
    expect(observed).toBeInstanceOf(Error);
  });

  for (const reason of [undefined, null, new Error("Authored upload fault.")]) {
    it(`preserves ${reason === undefined ? "undefined" : reason === null ? "null" : "Error"} operation failure`, async () => {
      let retired = 0;
      const observed = await reject(settle(new AbortController(), async () => {
        throw reason;
      }, () => () => retired++));
      expect(observed).toBe(reason);
      expect(retired).toBe(1);
    });
  }

  it("retains expiry, independent upload failure and alarm retirement failure", async () => {
    const controller = new AbortController();
    const operation = new Error("Upload cleanup rejected independently.");
    const retirement = new Error("Alarm retirement rejected independently.");
    let expire = () => {};
    const observed = await reject(settle(controller, async () => {
      expire();
      throw operation;
    }, (alarm) => {
      expire = alarm;
      return () => {
        throw retirement;
      };
    }));
    expect(observed).toBeInstanceOf(AggregateError);
    if (!(observed instanceof AggregateError)) throw new Error("Expected independent failures.");
    expect(observed.errors).toEqual([controller.signal.reason, operation, retirement]);
    expect(observed.cause).toBe(controller.signal.reason);
  });
});
