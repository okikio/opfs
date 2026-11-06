import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { Buffer } from "node:buffer";
import { runInNewContext } from "node:vm";
import { aggregate, close, getPrimary } from "../src/close.ts";
import { isBytes, toRequestBytes, toView } from "../src/bytes.ts";

import { open, split } from "../src/chunk.ts";
import { map } from "../src/pool.ts";
import { within } from "./gate.ts";

describe("byte stream chunking", () => {
  it("cancels a stalled producer and releases its reader after signal abort", async () => {
    const started = Promise.withResolvers<void>();
    const controller = new AbortController();
    let cancelled = 0;
    const source = new ReadableStream<Uint8Array>({
      pull() {
        started.resolve();
      },
      cancel() {
        cancelled += 1;
      },
    }, { highWaterMark: 0 });
    const chunks = split(source, 4, controller.signal);
    const pending = chunks.next();
    void pending.catch(() => {});
    try {
      await within(started.promise, "chunk source begins");
      const reason = new Error("cancel stalled source");
      controller.abort(reason);
      await expect(within(pending, "chunk source abort")).rejects.toBe(reason);
      expect(cancelled).toBe(1);
      expect(source.locked).toBe(false);
    } finally {
      controller.abort("chunk fixture cleanup");
      await within(Promise.allSettled([pending]), "chunk iterator cleanup");
      await within(chunks.return(undefined), "chunk iterator return");
    }
  });

  it("forms fixed chunks from pathological one-byte producer chunks", async () => {
    let value = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (value === 10) {
          controller.close();
          return;
        }
        controller.enqueue(Uint8Array.of(value));
        value += 1;
      },
    });

    const output: number[][] = [];
    for await (const chunk of split(source, 4)) output.push([...chunk]);
    expect(output).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]);
  });

  it("cancels the source when the consumer stops before the stream ends", async () => {
    let cancelled = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled += 1;
      },
    });

    for await (const _chunk of split(source, 4)) break;
    expect(cancelled).toBe(1);
    expect(source.locked).toBe(false);
  });
});

describe("concurrent provider chunks", () => {
  it("preserves an input error after admitted mapper work drains", async () => {
    const reason = new Error("producer failed after first chunk");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let drained = false;
    async function* source() {
      yield 1;
      throw reason;
    }
    const result = Array.fromAsync(map(2, source(), async (value) => {
      entered.resolve();
      await release.promise;
      drained = true;
      return value;
    }));
    void result.catch(() => {});
    try {
      await within(entered.promise, "mapper admission");
      release.resolve();
      await expect(within(result, "failed source mapping")).rejects.toBe(reason);
      expect(drained).toBe(true);
    } finally {
      release.resolve();
      await within(Promise.allSettled([result]), "mapper drain cleanup");
    }
  });

  it("retains independent mapper errors as secondary evidence for an input failure", async () => {
    const reason = new Error("source failure");
    const provider = new Error("provider failure");
    const release = Promise.withResolvers<void>();
    async function* source() {
      yield 1;
      throw reason;
    }
    const result = Array.fromAsync(map(2, source(), async () => {
      await release.promise;
      throw provider;
    }));
    void result.catch(() => {});
    release.resolve();
    await expect(within(result, "source and mapper failure")).rejects.toMatchObject({
      cause: reason,
      errors: [reason, provider],
    });
  });

  for (
    const [label, reason] of [
      ["the same Error instance", new Error("shared source and provider failure")],
      ["undefined", undefined],
    ] as const
  ) {
    it(`retains both failures when source and mapper reject with ${label}`, async () => {
      const failed = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      async function* source() {
        yield 1;
        failed.resolve();
        throw reason;
      }
      const result = Array.fromAsync(map(2, source(), async () => {
        await release.promise;
        throw reason;
      }));
      void result.catch(() => {});
      try {
        await within(failed.promise, "source failure before mapper rejection");
        release.resolve();
        let rejected = false;
        try {
          await within(result, "shared source and mapper failure");
        } catch (error) {
          rejected = true;
          if (!(error instanceof AggregateError)) throw error;
          expect(error.errors).toHaveLength(2);
          expect(error.errors[0]).toBe(reason);
          expect(error.errors[1]).toBe(reason);
          expect(Object.hasOwn(error, "cause")).toBe(true);
          expect(error.cause).toBe(reason);
        }
        expect(rejected).toBe(true);
      } finally {
        release.resolve();
        await within(Promise.allSettled([result]), "shared failure mapper cleanup");
      }
    });
  }

  it("preserves an undefined input rejection rather than treating it as no failure", async () => {
    async function* source(): AsyncGenerator<number> {
      yield 1;
      throw undefined;
    }
    let rejected = false;
    try {
      await within(Array.fromAsync(map(1, source(), async (value) => value)), "undefined source rejection");
    } catch (reason) {
      rejected = true;
      expect(reason).toBeUndefined();
    }
    expect(rejected).toBe(true);
  });

  it("keeps mapper-only failures in the operation-owned aggregate", async () => {
    const provider = new Error("provider-only failure");
    await expect(Array.fromAsync(map(1, [1], () => {
      throw provider;
    }))).rejects.toMatchObject({ errors: [provider] });
  });
});

describe("owned bounded mapping", () => {
  it("interrupts a pending input read on mapper failure and joins a held sibling", async () => {
    const next = Promise.withResolvers<void>();
    const sibling = Promise.withResolvers<void>();
    const failed = new Error("actual admitted mapper failure");
    let reads = 0;
    let cancels = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ < 2) controller.enqueue(Uint8Array.of(reads));
        else next.resolve();
      },
      cancel() {
        cancels++;
      },
    }, { highWaterMark: 0 });
    const input = open(source, 1);
    let settled = false;
    const result = Array.fromAsync(map(3, input, async (value) => {
      if (value[0] === 1) {
        await next.promise;
        throw failed;
      }
      await sibling.promise;
      return value[0];
    }, { interrupt: () => input.interrupt() })).finally(() => settled = true);
    void result.catch(() => {});
    try {
      await within(next.promise, "owned pool pending read");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(cancels).toBe(1);
      expect(settled).toBe(false);
      sibling.resolve();
      await expect(within(result, "failed mapper join")).rejects.toMatchObject({ errors: [failed] });
      expect(source.locked).toBe(false);
    } finally {
      sibling.resolve();
      await input.interrupt();
      await within(Promise.allSettled([result]), "owned mapping cleanup");
    }
  });

  it("keeps completed results in the same admission bound and yields source order", async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let admitted = 0;
    const pending = Array.fromAsync(map(2, [1, 2, 3, 4], async (value) => {
      admitted++;
      if (value === 1) await first.promise;
      if (value === 2) {
        entered.resolve();
        await second.promise;
      }
      return value;
    }));
    void pending.catch(() => {});
    try {
      await within(entered.promise, "second mapper admission");
      second.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(admitted).toBe(2);
      first.resolve();
      expect(await within(pending, "ordered mapping")).toEqual([1, 2, 3, 4]);
    } finally {
      first.resolve();
      second.resolve();
      await within(Promise.allSettled([pending]), "ordered mapper cleanup");
    }
  });

  it("joins admitted mappings before consumer return retires the input", async () => {
    const held = Promise.withResolvers<void>();
    let cancel = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Uint8Array.of(1));
      },
      cancel() {
        cancel++;
      },
    }, { highWaterMark: 0 });
    const input = open(source, 1);
    let calls = 0;
    const output = map(2, input, async () => {
      if (++calls === 2) await held.promise;
      return calls;
    }, { interrupt: () => input.interrupt() });
    let returning: Promise<IteratorResult<number>> | undefined;
    try {
      expect((await within(output.next(), "first owned mapping")).done).toBe(false);
      let settled = false;
      returning = output.return(undefined).finally(() => settled = true);
      void returning.catch(() => {});
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(cancel).toBe(1);
      held.resolve();
      await within(returning, "consumer return drain");
      expect(source.locked).toBe(false);
      expect(calls).toBe(2);
    } finally {
      held.resolve();
      await input.interrupt();
      await within(returning ?? output.return(undefined), "return cleanup");
    }
  });

  it("retains a borrowed std-like AggregateError and joins its admitted sibling", async () => {
    const failure = new AggregateError(
      [new Error("borrowed")],
      "Cannot complete the mapping as an error was thrown from an item",
    );
    const admitted = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    let settled = false;
    const result = Array.fromAsync(map(2, [1, 2], async (value) => {
      if (value === 1) {
        await admitted.promise;
        throw failure;
      }
      admitted.resolve();
      await held.promise;
      return value;
    })).finally(() => settled = true);
    void result.catch(() => {});
    try {
      await within(admitted.promise, "borrowed error sibling admission");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      held.resolve();
      await expect(within(result, "borrowed aggregate drain")).rejects.toMatchObject({ errors: [failure] });
    } finally {
      held.resolve();
      await within(Promise.allSettled([result]), "borrowed aggregate cleanup");
    }
  });

  it("retains producer and independently equal-valued iterator return failures", async () => {
    const reason = new Error("independent same-valued events");
    const source: AsyncIterableIterator<number> = {
      next: () => Promise.reject(reason),
      return: () => Promise.reject(reason),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    await expect(Array.fromAsync(map(1, source, async (value) => value))).rejects.toMatchObject({
      errors: [reason, reason],
    });
  });
});

describe("upload byte admission and retirement", () => {
  for (
    const invalid of ["bytes", {}, new Int8Array(1), new DataView(new ArrayBuffer(1)), {
      [Symbol.toStringTag]: "Uint8Array",
      byteLength: 1,
    }]
  ) {
    it(`rejects non-byte chunks (${Object.prototype.toString.call(invalid)}) and retains actual cancellation failure`, async () => {
      const cleanup = new Error("invalid producer cancellation failed");
      let cancels = 0;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          Reflect.apply(controller.enqueue, controller, [invalid]);
        },
        cancel() {
          cancels++;
          throw cleanup;
        },
      });
      const failure = await Array.fromAsync(split(source, 4)).then(() => {
        throw new Error("Expected invalid upload rejection");
      }, (reason: unknown) => reason);
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw failure;
      expect(failure.errors).toHaveLength(2);
      expect(failure.errors[0]).toBeInstanceOf(TypeError);
      expect(failure.errors[1]).toBe(cleanup);
      expect(cancels).toBe(1);
      expect(source.locked).toBe(false);
    });
  }

  it("preserves Uint8Array subclass and offset payload bytes", async () => {
    class Bytes extends Uint8Array {}
    const data = new Bytes([99, 17, 31, 47, 88]);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data.subarray(1, 4));
        controller.close();
      },
    });
    expect((await Array.fromAsync(split(source, 2))).map((part) => [...part])).toEqual([[17, 31], [47]]);
  });

  for (const phase of ["start", "middle"] as const) {
    it(`preserves the actual ${phase} read error without recancelling its stored reason`, async () => {
      const failure = new Error("actual terminal input error");
      let reads = 0;
      let cancels = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (phase === "middle" && reads++ === 0) controller.enqueue(Uint8Array.of(1));
          else controller.error(failure);
        },
        cancel() {
          cancels++;
          throw failure;
        },
      }, { highWaterMark: 0 });
      await expect(Array.fromAsync(split(source, 2))).rejects.toBe(failure);
      expect(cancels).toBe(0);
      expect(source.locked).toBe(false);
    });
  }
});

describe("owned retirement and byte primitives", () => {
  it("preserves undefined and independently equal-valued release failures in action order", async () => {
    const actions: number[] = [];
    const reason = new Error("equal independently rejected events");
    await expect(close([
      () => {
        actions.push(1);
        throw reason;
      },
      async () => {
        actions.push(2);
        throw reason;
      },
      () => {
        actions.push(3);
      },
    ], [undefined])).rejects.toMatchObject({ errors: [undefined, reason, reason] });
    expect(actions).toEqual([1, 2, 3]);
    let rejected = false;
    try {
      await close([], [undefined]);
    } catch (failure) {
      rejected = true;
      expect(failure).toBeUndefined();
    }
    expect(rejected).toBe(true);
  });

  it("grants immutable primary metadata only to this owner's actual aggregate", () => {
    const owned = aggregate([undefined, new Error("cleanup")], "owned events");
    const primary = getPrimary(owned);
    expect(primary).toEqual({ reason: undefined });
    expect(Object.isFrozen(primary)).toBe(true);
    expect(getPrimary(new AggregateError([undefined], "foreign", { cause: undefined }))).toBeUndefined();
  });

  it("accepts genuine Buffer and cross-realm offset byte views without consulting spoofed tags", async () => {
    const foreign: unknown = runInNewContext("new Uint8Array([99,17,31,47,88]).subarray(1,4)");
    expect(isBytes(foreign)).toBe(true);
    if (!isBytes(foreign)) throw new TypeError("Fixture must contain actual foreign byte view");
    for (const value of [foreign, Buffer.from([99, 17, 31, 47, 88]).subarray(1, 4)]) {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(value);
          controller.close();
        },
      });
      expect((await Array.fromAsync(split(source, 2))).map((part) => [...part])).toEqual([[17, 31], [47]]);
    }
  });
});

describe("actual source-state ownership", () => {
  it("retains source error and caller abort in the same frame without recancelling stored error", async () => {
    let native: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancels = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        native = controller;
      },
      cancel() {
        cancels++;
      },
    }, { highWaterMark: 0 });
    const caller = new AbortController();
    const input = open(source, 1, caller.signal);
    const failed = new Error("actual producer error");
    const aborted = new Error("actual caller cancellation");
    const pending = input.next();
    void pending.catch(() => {});
    native?.error(failed);
    caller.abort(aborted);
    await expect(within(pending, "concurrent source and caller events")).rejects.toMatchObject({
      errors: [failed, aborted],
    });
    await within(input.return(), "concurrent source retirement");
    expect(cancels).toBe(0);
    expect(source.locked).toBe(false);
  });

  it("retains an unread native stream failure during actual input interruption", async () => {
    let native: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancels = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        native = controller;
      },
      cancel() {
        cancels++;
      },
    }, { highWaterMark: 0 });
    const input = open(source, 1);
    native?.error(undefined);
    await input.interrupt();
    let rejected = false;
    try {
      await input.return();
    } catch (reason) {
      rejected = true;
      expect(reason).toBeUndefined();
    }
    expect(rejected).toBe(true);
    expect(cancels).toBe(0);
    expect(source.locked).toBe(false);
  });

  it("retains observed read and independently equal-valued release failures", async () => {
    const reason = new Error("actual separate read and release events");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(reason);
      },
    });
    const acquire = source.getReader.bind(source);
    Object.defineProperty(source, "getReader", {
      value() {
        const reader = acquire();
        const release = reader.releaseLock.bind(reader);
        reader.releaseLock = () => {
          release();
          throw reason;
        };
        return reader;
      },
    });
    await expect(Array.fromAsync(split(source, 1))).rejects.toMatchObject({ errors: [reason, reason] });
    expect(source.locked).toBe(false);
  });
});

describe("mapping terminal entrypoints", () => {
  it("interrupts a held next immediately on consumer return then joins admitted work", async () => {
    const stalled = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let reads = 0;
    let cancels = 0;
    let calls = 0;
    const source = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      pull(value) {
        if (reads++ === 0) value.enqueue(Uint8Array.of(17));
        else stalled.resolve();
      },
      cancel() {
        cancels++;
      },
    }, { highWaterMark: 0 });
    const input = open(source, 1);
    const output = map(2, input, async () => {
      calls++;
      await held.promise;
      return 17;
    }, { interrupt: () => input.interrupt() });
    const pending = output.next();
    void pending.catch(() => {});
    let returning: Promise<IteratorResult<number>> | undefined;
    try {
      await within(stalled.promise, "consumer return pending read");
      let settled = false;
      returning = output.return(undefined).finally(() => settled = true);
      void returning.catch(() => {});
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(cancels).toBe(1);
      expect(settled).toBe(false);
      held.resolve();
      expect((await within(returning, "consumer return input drain")).done).toBe(true);
      expect((await within(pending, "interrupted next outcome")).done).toBe(true);
      expect(calls).toBe(1);
      expect(source.locked).toBe(false);
    } finally {
      held.resolve();
      controller?.error(new Error("terminal-entrypoint fixture teardown"));
      await input.interrupt();
      await within(Promise.allSettled([pending, returning ?? output.return(undefined)]), "terminal-entrypoint cleanup");
    }
  });

  it("retains consumer throw and independent input retirement while next is pending", async () => {
    const entered = Promise.withResolvers<void>();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const primary = new Error("actual consumer throw");
    const cleanup = new Error("actual input cleanup");
    const source = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      pull() {
        entered.resolve();
      },
      cancel() {
        throw cleanup;
      },
    }, { highWaterMark: 0 });
    const input = open(source, 1);
    const output = map(1, input, async (value) => value, { interrupt: () => input.interrupt() });
    const pending = output.next();
    void pending.catch(() => {});
    let thrown: Promise<IteratorResult<Uint8Array>> | undefined;
    try {
      await within(entered.promise, "consumer throw native input");
      thrown = output.throw(primary);
      void thrown.catch(() => {});
      await expect(within(thrown, "consumer throw joins input")).rejects.toMatchObject({ errors: [primary, cleanup] });
      await expect(within(pending, "consumer throw active next")).rejects.toMatchObject({ errors: [primary, cleanup] });
      expect(source.locked).toBe(false);
    } finally {
      controller?.error(new Error("consumer throw fixture teardown"));
      await input.interrupt();
      await within(Promise.allSettled([pending, thrown ?? output.return(undefined)]), "consumer throw cleanup");
    }
  });
});

describe("mapping terminal authority", () => {
  it("a later throw cannot rewrite the first held shutdown's primary", async () => {
    const entered = Promise.withResolvers<void>();
    const cancelling = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const firstReason = new Error("first actual terminal request");
    const secondReason = new Error("second independent terminal request");
    const cleanup = new Error("actual physical close failure");
    const source = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      pull() {
        entered.resolve();
      },
      async cancel() {
        cancelling.resolve();
        await held.promise;
        throw cleanup;
      },
    }, { highWaterMark: 0 });
    const input = open(source, 1);
    const output = map(1, input, async (value) => value, { interrupt: () => input.interrupt() });
    const pending = output.next();
    void pending.catch(() => {});
    let first: Promise<IteratorResult<Uint8Array>> | undefined;
    let second: Promise<IteratorResult<Uint8Array>> | undefined;
    try {
      await within(entered.promise, "first shutdown input admission");
      first = output.throw(firstReason);
      void first.catch(() => {});
      await within(cancelling.promise, "held physical shutdown");
      second = output.throw(secondReason);
      void second.catch(() => {});
      held.resolve();
      const observed = await first.then(() => {
        throw new Error("Expected first shutdown failure");
      }, (reason: unknown) => reason);
      expect(observed).toMatchObject({ errors: [firstReason, cleanup] });
      await expect(within(second, "second shutdown observation")).rejects.toMatchObject({
        errors: [observed, secondReason],
      });
      await expect(within(pending, "first shutdown active input")).rejects.toBe(observed);
      expect(source.locked).toBe(false);
    } finally {
      held.resolve();
      controller?.error(new Error("terminal authority fixture teardown"));
      await input.interrupt();
      await within(Promise.allSettled([pending, first, second]), "terminal authority cleanup");
    }
  });
});

describe("first mapping terminal request", () => {
  it("keeps a winning return's cleanup failure when a later throw arrives", async () => {
    const entered = Promise.withResolvers<void>();
    const cancelling = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    let native: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cleanup = new Error("actual return-owned close failure");
    const later = new Error("later caller throw");
    const source = new ReadableStream<Uint8Array>({
      start(value) {
        native = value;
      },
      pull() {
        entered.resolve();
      },
      async cancel() {
        cancelling.resolve();
        await held.promise;
        throw cleanup;
      },
    }, { highWaterMark: 0 });
    const input = open(source, 1);
    const output = map(1, input, async (value) => value, { interrupt: () => input.interrupt() });
    const pending = output.next();
    void pending.catch(() => {});
    let returned: Promise<IteratorResult<Uint8Array>> | undefined;
    let thrown: Promise<IteratorResult<Uint8Array>> | undefined;
    try {
      await within(entered.promise, "first return input admission");
      returned = output.return(undefined);
      void returned.catch(() => {});
      await within(cancelling.promise, "return-owned physical shutdown");
      thrown = output.throw(later);
      void thrown.catch(() => {});
      held.resolve();
      await expect(within(returned, "winning return failure")).rejects.toBe(cleanup);
      await expect(within(thrown, "later throw evidence")).rejects.toMatchObject({ errors: [cleanup, later] });
      expect(await within(output.return(undefined), "completed iterator return")).toEqual({
        done: true,
        value: undefined,
      });
      expect(source.locked).toBe(false);
    } finally {
      held.resolve();
      native?.error(new Error("first return fixture teardown"));
      await input.interrupt();
      await within(Promise.allSettled([pending, returned, thrown]), "first return cleanup");
    }
  });

  it("delivers failed terminal next once then follows completed native return protocol", async () => {
    const reason = new Error("actual terminal producer failure");
    // Native generator first-next failure is the protocol event under test; no value is emitted.
    // deno-lint-ignore require-yield
    async function* source(): AsyncGenerator<number> {
      throw reason;
    }
    const output = map(1, source(), async (value) => value);
    await expect(output.next()).rejects.toBe(reason);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(await output.return(undefined)).toEqual({ done: true, value: undefined });
    expect(await output.return(Promise.resolve(31))).toEqual({ done: true, value: 31 });
    await expect(output.return(Promise.reject(null))).rejects.toBe(null);
    await expect(output.throw(reason)).rejects.toBe(reason);
  });
});

describe("readable byte backing admission", () => {
  it("refuses a genuinely detached view rather than publishing empty bytes", async () => {
    const bytes = Uint8Array.of(17, 31);
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    expect(bytes.byteLength).toBe(0);
    expect(isBytes(bytes)).toBe(false);
    let cancelled = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled++;
      },
    }, { highWaterMark: 0 });
    await expect(Array.fromAsync(split(source, 1))).rejects.toBeInstanceOf(TypeError);
    expect(cancelled).toBe(1);
    expect(source.locked).toBe(false);
    expect(isBytes(new Uint8Array(0))).toBe(true);
    expect(isBytes(new Uint8Array(new SharedArrayBuffer(0)))).toBe(true);
  });

  it("refuses a resizable fixed view outside backing bounds but accepts readable empty views", async () => {
    const backing = new ArrayBuffer(4, { maxByteLength: 8 });
    const fixed = new Uint8Array(backing, 2, 2);
    const tracking = new Uint8Array(backing);
    fixed.set([17, 31]);
    expect(isBytes(fixed)).toBe(true);
    backing.resize(1);
    expect(fixed.byteLength).toBe(0);
    expect(isBytes(fixed)).toBe(false);
    expect(isBytes(tracking)).toBe(true);
    let cancelled = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(fixed);
      },
      cancel() {
        cancelled++;
      },
    }, { highWaterMark: 0 });
    await expect(Array.fromAsync(split(source, 1))).rejects.toBeInstanceOf(TypeError);
    expect(cancelled).toBe(1);
    expect(source.locked).toBe(false);
    backing.resize(0);
    expect(isBytes(tracking)).toBe(true);
    backing.resize(4);
    expect(isBytes(fixed)).toBe(true);
  });
});

describe("completed mapping iterator protocol", () => {
  for (const consumer of ["Array.fromAsync", "for-await"] as const) {
    it(`${consumer} observes full initial failure with bounded protocol close`, async () => {
      const consume = async (input: AsyncIterable<number>): Promise<number[]> => {
        if (consumer === "Array.fromAsync") return await Array.fromAsync(input);
        const values: number[] = [];
        for await (const value of input) values.push(value);
        return values;
      };
      const nativeFailure = new Error("Native consumer reference failure.");
      let nativeCloses = 0;
      const reference: AsyncIterableIterator<number> = {
        next: () => Promise.reject(nativeFailure),
        return: async () => {
          nativeCloses++;
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      // Native consumers differ in whether they close a rejected next. Measure
      // that consumer separately from map's physical input retirement, which
      // must happen exactly once.
      await expect(within(consume(reference), "native consumer reference")).rejects.toBe(nativeFailure);
      const primary = new Error("actual input failure");
      const cleanup = new Error("actual input return failure");
      let inputReturns = 0;
      const source: AsyncIterableIterator<number> = {
        next: () => Promise.reject(primary),
        return: () => {
          inputReturns++;
          return Promise.reject(cleanup);
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      const output = map(1, source, async (value) => value);
      const ownedReturn = output.return.bind(output);
      let protocolCloses = 0;
      // A defective consumer/runtime can retry close when close rejects. Bound
      // the discriminator itself without hiding its count or initial fault.
      output.return = async (value) => {
        if (++protocolCloses > 1) return { done: true, value: await value };
        return await ownedReturn(value);
      };
      const pending = consume(output);
      await expect(within(pending, "bounded native mapping consumer")).rejects.toMatchObject({
        errors: [primary, cleanup],
      });
      expect(inputReturns).toBe(1);
      expect(protocolCloses).toBe(nativeCloses);
      expect(await ownedReturn(undefined)).toEqual({ done: true, value: undefined });
    });
  }

  for (const kind of ["undefined", "null", "equal Error"] as const) {
    it(`joins simultaneous terminal callers and retains independent ${kind} events only in the owned outcome`, async () => {
      const reason = kind === "undefined"
        ? undefined
        : kind === "null"
        ? null
        : new Error("equal independent caller and cleanup events");
      const entered = Promise.withResolvers<void>();
      const cancelling = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let cancels = 0;
      const source = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
        pull() {
          entered.resolve();
        },
        async cancel() {
          cancels++;
          cancelling.resolve();
          await held.promise;
          throw reason;
        },
      }, { highWaterMark: 0 });
      const input = open(source, 1);
      const output = map(1, input, async (value) => value, { interrupt: () => input.interrupt() });
      const pending = output.next();
      void pending.catch(() => {});
      let thrown: Promise<IteratorResult<Uint8Array>> | undefined;
      let returned: Promise<IteratorResult<Uint8Array>> | undefined;
      try {
        await within(entered.promise, "terminal event input admission");
        thrown = output.throw(reason);
        void thrown.catch(() => {});
        await within(cancelling.promise, "terminal event held cleanup");
        let settled = false;
        returned = output.return(undefined).finally(() => settled = true);
        void returned.catch(() => {});
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(false);
        held.resolve();
        const outcome = await within(
          thrown.then(
            () => {
              throw new Error("Expected joined terminal failure");
            },
            (failure: unknown) => failure,
          ),
          "terminal event primary result",
        );
        expect(outcome).toBeInstanceOf(AggregateError);
        if (!(outcome instanceof AggregateError)) throw outcome;
        expect(outcome.errors).toHaveLength(2);
        expect(outcome.errors[0]).toBe(reason);
        expect(outcome.errors[1]).toBe(reason);
        await expect(within(returned, "concurrent terminal result")).rejects.toBe(outcome);
        await expect(within(pending, "concurrent native next result")).rejects.toBe(outcome);
        expect(await output.return(Promise.resolve(47))).toEqual({ done: true, value: 47 });
        await expect(output.return(Promise.reject(reason))).rejects.toBe(reason);
        expect(cancels).toBe(1);
        expect(source.locked).toBe(false);
      } finally {
        held.resolve();
        controller?.error(new Error("completed protocol fixture teardown"));
        await input.interrupt();
        await within(Promise.allSettled([pending, thrown, returned]), "completed protocol fixture drain");
      }
    });
  }

  it("awaits each concurrent return value without skipping active physical retirement", async () => {
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const firstValue = Promise.withResolvers<number>();
    let native: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cleanup = new Error("actual held physical retirement");
    const argument = new Error("independent later return Await fault");
    const source = new ReadableStream<Uint8Array>({
      start(value) {
        native = value;
      },
      pull() {
        entered.resolve();
      },
      async cancel() {
        await held.promise;
        throw cleanup;
      },
    }, { highWaterMark: 0 });
    const input = open(source, 1);
    const output = map(1, input, async (value) => value, { interrupt: () => input.interrupt() });
    const pending = output.next();
    void pending.catch(() => {});
    let first: Promise<IteratorResult<Uint8Array>> | undefined;
    let second: Promise<IteratorResult<Uint8Array>> | undefined;
    try {
      await within(entered.promise, "concurrent return input admission");
      first = output.return(firstValue.promise);
      void first.catch(() => {});
      second = output.return(Promise.reject(argument));
      void second.catch(() => {});
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      held.resolve();
      firstValue.resolve(17);
      await expect(within(first, "first return physical result")).rejects.toBe(cleanup);
      await expect(within(second, "later return value result")).rejects.toMatchObject({ errors: [cleanup, argument] });
      expect(source.locked).toBe(false);
    } finally {
      held.resolve();
      firstValue.resolve(17);
      native?.error(new Error("concurrent return fixture teardown"));
      await input.interrupt();
      await within(Promise.allSettled([pending, first, second]), "concurrent return fixture drain");
    }
  });
});

it("rejected active return Await still enters physical finally and joins admitted work", async () => {
  const held = Promise.withResolvers<void>();
  const admitted = Promise.withResolvers<void>();
  const argument = new Error("first active return Await failure");
  const cleanup = new Error("actual input retirement failure");
  let calls = 0;
  let cancels = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(Uint8Array.of(17));
    },
    cancel() {
      cancels++;
      throw cleanup;
    },
  }, { highWaterMark: 0 });
  const input = open(source, 1);
  const output = map(2, input, async () => {
    if (++calls === 2) {
      admitted.resolve();
      await held.promise;
    }
    return 17;
  }, { interrupt: () => input.interrupt() });
  let returning: Promise<IteratorResult<number>> | undefined;
  try {
    expect((await within(output.next(), "active return first yield")).done).toBe(false);
    await within(admitted.promise, "active return held mapper");
    let settled = false;
    returning = output.return(Promise.reject(argument)).finally(() => settled = true);
    void returning.catch(() => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(cancels).toBe(1);
    held.resolve();
    await expect(within(returning, "active return Await and retirement")).rejects.toMatchObject({
      errors: [argument, cleanup],
    });
    expect(source.locked).toBe(false);
    expect(await output.return(undefined)).toEqual({ done: true, value: undefined });
  } finally {
    held.resolve();
    await input.interrupt();
    await within(Promise.allSettled([returning ?? output.return(undefined)]), "active return Await fixture drain");
  }
});

it("chunks the intrinsic two-byte range without borrowed length or subarray authority", async () => {
  class Bytes extends Uint8Array {
    override subarray(): never {
      throw new Error("Borrowed slicing was consulted.");
    }
  }
  const bytes = new Bytes([7, 8]);
  Object.defineProperty(bytes, "byteLength", { value: 0 });
  Object.defineProperty(bytes, Symbol.iterator, {
    get() {
      throw new Error("Borrowed iteration was consulted.");
    },
  });
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const output: number[][] = [];
  for await (const chunk of split(source, 1)) output.push([...chunk]);
  expect(output).toEqual([[7], [8]]);
  expect(source.locked).toBe(false);
});

it("normalizes native byte metadata without copying ordinary fixed backing", () => {
  const backing = new ArrayBuffer(4);
  const bytes = new Uint8Array(backing, 1, 2);
  bytes.set([7, 8]);
  for (const name of ["buffer", "byteOffset", "byteLength"]) {
    Object.defineProperty(bytes, name, {
      get() {
        throw new Error("Borrowed range getter was consulted.");
      },
    });
  }
  const view = toView(bytes);
  const wire = toRequestBytes(bytes);
  expect(view.buffer).toBe(backing);
  expect(wire.buffer).toBe(backing);
  expect(view.byteOffset).toBe(1);
  expect(view.byteLength).toBe(2);
  new Uint8Array(backing)[1] = 23;
  expect([...view]).toEqual([23, 8]);
  expect([...wire]).toEqual([23, 8]);
});
