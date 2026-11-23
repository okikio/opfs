/** Facade read-stream acquisition owns materialization before publishing a stream. @module */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createFileSystem, FileSystemError } from "../mod.ts";
import type { ReadOptionsType } from "../src/filesystem.ts";
import type { AdapterType } from "../src/adapter/definition.ts";
import { createMemoryAdapter } from "../src/adapter/memory.ts";
import { withFileSystem, within } from "./reliability.ts";

/** Immediately observe actual outcomes, including raw rejection values. */
function settled<Value>(value: Promise<Value>) {
  return value.then(
    (result) => ({ ok: true as const, result }),
    (reason: unknown) => ({ ok: false as const, reason }),
  );
}

/** A complete caller-visible error, rather than an error-message assertion. */
function aborted(reason: unknown, caller: unknown): void {
  expect(reason).toBeInstanceOf(FileSystemError);
  if (!(reason instanceof FileSystemError)) throw new Error("Expected filesystem cancellation.");
  expect(reason.code).toBe("aborted");
  expect(reason.operation).toBe("read");
  expect(reason.path).toBe("/input.bin");
  expect(reason.cause).toBe(caller);
}

/** Each facade borrows a real adapter with only the selected fixture effects replaced. */
function fixture(
  overrides: Partial<AdapterType> = {},
  streamRead = true,
  metrics: "none" | "basic" | "timing" = "basic",
) {
  const base = createMemoryAdapter();
  return createFileSystem({
    name: base.name,
    driver: base.driver,
    capabilities: base.capabilities,
    stat: base.stat.bind(base),
    readFile: base.readFile.bind(base),
    writeFile: base.writeFile.bind(base),
    readDir: base.readDir.bind(base),
    createDir: base.createDir.bind(base),
    remove: base.remove.bind(base),
    ...(base.openReadStream === undefined ? {} : { openReadStream: base.openReadStream.bind(base) }),
    ...overrides,
  }, {
    coordination: "local",
    lockPrefix: `open-stream:${crypto.randomUUID()}`,
    metrics,
    optimizations: { streamRead },
  });
}

/** Consume a complete published stream and release the actual acquired reader. */
async function bytes(stream: ReadableStream<Uint8Array>): Promise<readonly number[]> {
  const reader = stream.getReader(), result: number[] = [];
  try {
    while (true) {
      const value = await reader.read();
      if (value.done) return result;
      result.push(...value.value);
    }
  } finally {
    reader.releaseLock();
  }
}

describe("facade read-stream acquisition", () => {
  it("publishes value streams only after actual materialization, preserving empty and ranged bytes", async () => {
    for (const input of [[], [17], [17, 31, 47, 59]]) {
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<Uint8Array>();
      const requests: ReadOptionsType[] = [];
      const fs = fixture({
        async readFile(_path, options = {}) {
          requests.push(options);
          entered.resolve();
          const value = await release.promise;
          return value.slice(
            options.at ?? 0,
            options.length === undefined ? undefined : (options.at ?? 0) + options.length,
          );
        },
      });
      await withFileSystem(fs, async () => {
        let published = false;
        const opening = fs.openReadStream("/input.bin", { at: 1, length: 2 });
        const observed = settled(opening);
        void opening.then(() => published = true, () => undefined);
        try {
          await within(entered.promise, "materialization begins");
          expect(published).toBe(false);
          expect(fs.getMetrics().operations["read-stream"]).toBeUndefined();
          release.resolve(Uint8Array.from(input));
          const result = await within(observed, "materialization settles");
          if (!result.ok) throw result.reason;
          expect(await bytes(result.result)).toEqual(input.slice(1, 3));
          expect(requests).toHaveLength(1);
          expect(requests[0]).toMatchObject({ at: 1, length: 2 });
          expect(fs.getMetrics().operations["read-stream"]).toMatchObject({
            count: 1,
            failures: 0,
            emulated: 1,
            native: 0,
          });
        } finally {
          release.resolve(Uint8Array.from(input));
          const result = await within(observed, "owned materialization cleanup");
          if (result.ok) await result.result.cancel();
        }
      });
    }
  });

  it("refuses already cancelled and invalid range acquisitions before adapter effects", async () => {
    for (const reason of [undefined, null, { stop: true }, new Error("caller stops")]) {
      let calls = 0;
      const fs = fixture({
        async readFile() {
          calls++;
          return Uint8Array.of(17);
        },
      });
      await withFileSystem(fs, async () => {
        const controller = new AbortController();
        controller.abort(reason);
        const result = await settled(fs.openReadStream("/input.bin", { signal: controller.signal }));
        expect(result.ok).toBe(false);
        if (!result.ok) aborted(result.reason, controller.signal.reason);
        expect(calls).toBe(0);
        expect(fs.getMetrics().operations["read-stream"]).toBeUndefined();
        for (const options of [{ at: -1 }, { length: -1 }, { at: NaN }, { length: Infinity }]) {
          const invalid = await settled(fs.openReadStream("/input.bin", options));
          expect(invalid.ok).toBe(false);
          if (!invalid.ok) expect(invalid.reason).toBeInstanceOf(RangeError);
        }
        expect(calls).toBe(0);
      });
    }
  });

  it("captures each setting once and stops option effects when a captured getter aborts", async () => {
    const controller = new AbortController(), caller = { stop: true };
    let signals = 0, positions = 0, lengths = 0, calls = 0;
    const fs = fixture({
      async readFile() {
        calls++;
        return Uint8Array.of(17);
      },
    });
    await withFileSystem(fs, async () => {
      const result = await settled(fs.openReadStream("/input.bin", {
        get signal() {
          signals++;
          return controller.signal;
        },
        get at() {
          positions++;
          controller.abort(caller);
          return 0;
        },
        get length() {
          lengths++;
          return 1;
        },
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) aborted(result.reason, caller);
      expect({ signals, positions, lengths, calls }).toEqual({ signals: 1, positions: 1, lengths: 0, calls: 0 });
    });
  });

  it("refuses a backend method returned by an aborting acquisition getter before invoking it", async () => {
    const controller = new AbortController(), caller = null;
    let calls = 0, captures = 0;
    const fs = fixture();
    Object.defineProperty(fs.adapter, "readFile", {
      configurable: true,
      get() {
        captures++;
        controller.abort(caller);
        return async () => {
          calls++;
          return Uint8Array.of(17);
        };
      },
    });
    await withFileSystem(fs, async () => {
      const result = await settled(fs.openReadStream("/input.bin", { signal: controller.signal }));
      expect(result.ok).toBe(false);
      if (!result.ok) aborted(result.reason, caller);
      expect({ calls, captures }).toEqual({ calls: 0, captures: 1 });
    });
  });

  it("joins held value acquisition before refusing cancellation without starting a second abort actor", async () => {
    for (const caller of [null, { stop: true }, new Error("stop")]) {
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<Uint8Array>();
      const controller = new AbortController();
      let calls = 0, published = false;
      const fs = fixture({
        async readFile(_path, settings) {
          calls++;
          expect(settings?.signal).toBe(controller.signal);
          entered.resolve();
          return await release.promise;
        },
      });
      await withFileSystem(fs, async () => {
        const opening = fs.openReadStream("/input.bin", { signal: controller.signal });
        const observed = settled(opening);
        void opening.then(() => published = true, () => undefined);
        try {
          await within(entered.promise, "held materialization starts");
          controller.abort(caller);
          expect(published).toBe(false);
          release.resolve(Uint8Array.of(17, 31));
          const result = await within(observed, "aborted materialization joins");
          expect(result.ok).toBe(false);
          if (!result.ok) aborted(result.reason, caller);
          expect(calls).toBe(1);
          expect(fs.getMetrics().operations["read-stream"]).toMatchObject({
            count: 1,
            failures: 1,
            emulated: 1,
            native: 0,
          });
        } finally {
          release.resolve(Uint8Array.of(17, 31));
          await within(observed, "actual acquisition completion");
        }
      });
    }
  });

  it("retains actual adapter rejection after abort instead of replacing it with a signal checkpoint", async () => {
    for (const native of [false, true]) {
      const base = createMemoryAdapter(), entered = Promise.withResolvers<void>();
      const completion = Promise.withResolvers<never>(), controller = new AbortController();
      const failure = new Error("actual provider refusal");
      const acquire = async () => {
        entered.resolve();
        return await completion.promise;
      };
      const fs = fixture({
        capabilities: { ...base.capabilities, streamRead: native },
        readFile: acquire,
        openReadStream: acquire,
      });
      await withFileSystem(fs, async () => {
        const opening = settled(fs.openReadStream("/input.bin", { signal: controller.signal }));
        try {
          await within(entered.promise, "provider operation admitted");
          controller.abort(failure);
          completion.reject(failure);
          const result = await within(opening, "provider refusal observed");
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.reason).toBeInstanceOf(FileSystemError);
            if (!(result.reason instanceof FileSystemError)) throw new Error("Expected normalized operation failure.");
            expect(result.reason.code).toBe("unknown");
            expect(result.reason.cause).toBe(failure);
          }
        } finally {
          completion.reject(failure);
          await within(opening, "provider operation joined");
        }
      });
    }
  });

  it("has exactly one post-open cancellation owner on actual memory streams", async () => {
    for (const metrics of ["none", "basic", "timing"] as const) {
      for (const streamRead of [false, true]) {
        const fs = fixture({}, streamRead, metrics), controller = new AbortController();
        await withFileSystem(fs, async () => {
          await fs.writeFile("/input.bin", Uint8Array.of(17, 31), { parents: true });
          const stream = await fs.openReadStream("/input.bin", { signal: controller.signal });
          const reader = stream.getReader(), caller = { stop: true };
          try {
            controller.abort(caller);
            const result = await within(settled(reader.read()), "post-open cancellation");
            expect(result.ok).toBe(false);
            if (!result.ok) aborted(result.reason, caller);
          } finally {
            reader.releaseLock();
          }
          const entry = fs.getMetrics().operations["read-stream"];
          if (metrics === "none") expect(entry).toBeUndefined();
          else expect(entry).toMatchObject({ count: 1, failures: 0, emulated: 1, native: 0 });
        });
      }
    }
  });

  it("respects disabled native-stream optimization and owns only the selected materialized route", async () => {
    const base = createMemoryAdapter();
    let materialized = 0, streamed = 0;
    const fs = fixture({
      capabilities: { ...base.capabilities, streamRead: true },
      async readFile() {
        materialized++;
        return Uint8Array.of(17, 31);
      },
      async openReadStream() {
        streamed++;
        throw new Error("Unselected route must not run.");
      },
    }, false);
    await withFileSystem(fs, async () => {
      expect(await bytes(await fs.openReadStream("/input.bin"))).toEqual([17, 31]);
      expect({ materialized, streamed }).toEqual({ materialized: 1, streamed: 0 });
    });
  });

  it("keeps native successful acquisition incremental and releases its actual source lock at EOF", async () => {
    const base = createMemoryAdapter(), controller = new AbortController();
    let opens = 0, reads = 0, pulls = 0, cancels = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(owner) {
        pulls++;
        owner.enqueue(Uint8Array.of(17, 31));
        owner.close();
      },
      cancel() {
        cancels++;
      },
    }, { highWaterMark: 0 });
    const fs = fixture({
      capabilities: { ...base.capabilities, streamRead: true },
      async openReadStream(_path, settings) {
        opens++;
        expect(settings?.signal).toBe(controller.signal);
        return source;
      },
      async readFile() {
        reads++;
        throw new Error("Native route must not materialize.");
      },
    });
    await withFileSystem(fs, async () => {
      const output = await fs.openReadStream("/input.bin", { signal: controller.signal });
      expect({ opens, reads, pulls, cancels }).toEqual({ opens: 1, reads: 0, pulls: 0, cancels: 0 });
      expect(await bytes(output)).toEqual([17, 31]);
      expect({ opens, reads, pulls, cancels }).toEqual({ opens: 1, reads: 0, pulls: 1, cancels: 0 });
      expect(source.locked).toBe(false);
      expect(fs.getMetrics().operations["read-stream"]).toMatchObject({
        count: 1,
        failures: 0,
        native: 1,
        emulated: 0,
      });
    });
  });

  it("retires a late valid native stream once before cancelled acquisition rejects", async () => {
    const base = createMemoryAdapter(), entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<ReadableStream<Uint8Array>>(), closed = Promise.withResolvers<void>();
    const cancelling = Promise.withResolvers<void>();
    const controller = new AbortController(), caller = { stop: true };
    let pulls = 0, cancels = 0;
    const source = new ReadableStream<Uint8Array>({
      pull() {
        pulls++;
      },
      cancel(reason) {
        cancels++;
        aborted(reason, caller);
        cancelling.resolve();
        return closed.promise;
      },
    }, { highWaterMark: 0 });
    const fs = fixture({
      capabilities: { ...base.capabilities, streamRead: true },
      async openReadStream() {
        entered.resolve();
        return await release.promise;
      },
    });
    await withFileSystem(fs, async () => {
      const opening = settled(fs.openReadStream("/input.bin", { signal: controller.signal }));
      let terminal = false;
      void opening.then(() => terminal = true);
      try {
        await within(entered.promise, "native stream acquisition begins");
        controller.abort(caller);
        release.resolve(source);
        // Exact cancel admission is signaled by its actual callback, not a sleep.
        await within(cancelling.promise, "late resource cancel admitted");
        expect(terminal).toBe(false);
        expect(cancels).toBe(1);
        expect(pulls).toBe(0);
        closed.resolve();
        const result = await within(opening, "late native retirement joined");
        expect(result.ok).toBe(false);
        if (!result.ok) aborted(result.reason, caller);
        expect(source.locked).toBe(false);
        expect(fs.getMetrics().operations["read-stream"]).toMatchObject({
          count: 1,
          failures: 1,
          native: 1,
          emulated: 0,
        });
      } finally {
        release.resolve(source);
        closed.resolve();
        await within(opening, "late native physical completion");
      }
    });
  });

  it("retains an acquired producer failure independently from later cancelled publication", async () => {
    const base = createMemoryAdapter(), controller = new AbortController();
    const producer = new Error("actual producer fault"), caller = { stop: true };
    const source = new ReadableStream<Uint8Array>({
      start(owner) {
        owner.error(producer);
      },
    });
    const fs = fixture({
      capabilities: { ...base.capabilities, streamRead: true },
      async openReadStream() {
        controller.abort(caller);
        return source;
      },
    });
    await withFileSystem(fs, async () => {
      const result = await settled(fs.openReadStream("/input.bin", { signal: controller.signal }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBeInstanceOf(FileSystemError);
        if (!(result.reason instanceof FileSystemError) || !(result.reason.cause instanceof AggregateError)) {
          throw new Error("Expected actual primary and source failure observations.");
        }
        const observations: unknown[] = [...result.reason.cause.errors];
        expect(observations).toHaveLength(2);
        aborted(observations[0], caller);
        expect(observations[1]).toBe(producer);
      }
      expect(source.locked).toBe(false);
    });
  });

  it("retains an independently failing native retirement in the ordered original failure tree", async () => {
    const base = createMemoryAdapter(), controller = new AbortController();
    const caller = null, cleanup = new Error("actual native disposer refusal");
    let cancels = 0;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancels++;
        throw cleanup;
      },
    });
    const fs = fixture({
      capabilities: { ...base.capabilities, streamRead: true },
      async openReadStream() {
        controller.abort(caller);
        return source;
      },
    });
    await withFileSystem(fs, async () => {
      const result = await settled(fs.openReadStream("/input.bin", { signal: controller.signal }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBeInstanceOf(FileSystemError);
        if (!(result.reason instanceof FileSystemError)) throw new Error("Expected owned normalization.");
        expect(result.reason.code).toBe("aborted");
        const retained = result.reason.cause;
        expect(retained).toBeInstanceOf(AggregateError);
        if (!(retained instanceof AggregateError)) throw new Error("Expected ordered failure observations.");
        const events: unknown[] = [...retained.errors];
        expect(events).toHaveLength(2);
        aborted(events[0], caller);
        expect(events[1]).toBe(cleanup);
      }
      expect(cancels).toBe(1);
      expect(source.locked).toBe(false);
    });
  });
});
