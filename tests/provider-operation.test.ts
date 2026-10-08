import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { setImmediate } from "node:timers/promises";
import { isPart, settle } from "./provider-operation.ts";
import { within } from "./gate.ts";

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
