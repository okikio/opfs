import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { split } from "../src/chunk.ts";
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

  it("keeps mapper-only failures in the upstream aggregate", async () => {
    const provider = new Error("provider-only failure");
    await expect(Array.fromAsync(map(1, [1], () => {
      throw provider;
    }))).rejects.toMatchObject({ errors: [provider] });
  });
});
