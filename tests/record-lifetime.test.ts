import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createRecordAdapter } from "../src/adapter/record.ts";
import { defineRecordDriver } from "../src/driver/record.ts";
import type { RecordDriverType } from "../src/driver/record.ts";
import type { FileRecordType } from "../src/schema.ts";
import { FileSystemError } from "../src/error.ts";

const record: FileRecordType = {
  version: 1,
  path: "/value",
  parent: "/",
  name: "value",
  kind: "file",
  data: "YWJj",
  size: 3,
  lastModified: 7,
  mediaType: "text/plain",
};
/** A valid driver baseline lets each control isolate one borrowed effect. */
function driver(changes: Partial<RecordDriverType> = {}): RecordDriverType {
  const base = defineRecordDriver({
    get: () => Promise.resolve(record),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    async *list() {},
  }, { name: "lifetime" });
  return { ...base, ...changes };
}
/** Failure presence remains separate from a raw undefined reason. */
async function rejected(operation: () => unknown | PromiseLike<unknown>): Promise<unknown> {
  const terminal = await Promise.resolve().then(operation).then(
    () => ({ ok: true as const }),
    (reason: unknown) => ({ ok: false as const, reason }),
  );
  expect(terminal.ok).toBe(false);
  if (terminal.ok) throw Error("Expected operation to refuse.");
  return terminal.reason;
}
function controller(reason: unknown): AbortController {
  const value = new AbortController();
  if (reason === undefined) Object.defineProperty(value.signal, "reason", { value: undefined });
  return value;
}
function aborted(actual: unknown, reason: unknown): void {
  expect(actual).toBeInstanceOf(FileSystemError);
  if (!(actual instanceof FileSystemError)) throw Error("Expected package cancellation.");
  expect(actual.code).toBe("aborted");
  expect(Object.hasOwn(actual, "cause")).toBe(true);
  expect(actual.cause).toBe(reason);
}

describe("record adapter operation ownership", () => {
  for (const reason of [undefined, null, Error("caller cancellation")]) {
    for (const lane of ["read", "stat", "append", "replace", "mkdir"] as const) {
      it(`refuses ${lane} publication or mutation after metadata wait: ${String(reason)}`, async () => {
        const pending = Promise.withResolvers<FileRecordType | null>(),
          entered = Promise.withResolvers<void>(),
          signal = controller(reason);
        let mutations = 0;
        const get = () => {
          entered.resolve();
          return pending.promise;
        };
        const adapter = createRecordAdapter(driver({
          get,
          stat: get,
          set: () => {
            mutations++;
            return Promise.resolve();
          },
        }));
        const work = lane === "read"
          ? () => adapter.readFile("/value", { signal: signal.signal })
          : lane === "stat"
          ? () => adapter.stat("/value", { signal: signal.signal })
          : lane === "mkdir"
          ? () => adapter.createDir("/value", { signal: signal.signal })
          : () =>
            adapter.writeFile("/value", new Uint8Array([100]), {
              mode: lane === "append" ? "append" : "replace",
              signal: signal.signal,
            });
        const terminal = rejected(work);
        await entered.promise;
        signal.abort(reason);
        pending.resolve(lane === "mkdir" ? null : record);
        aborted(await terminal, reason);
        expect(mutations).toBe(0);
      });
    }
    it(`checks preabort before write/range settings: ${String(reason)}`, async () => {
      const signal = controller(reason);
      signal.abort(reason);
      let settings = 0, effects = 0;
      const adapter = createRecordAdapter(driver({
        get: () => {
          effects++;
          return Promise.resolve(record);
        },
      }));
      aborted(
        await rejected(() =>
          adapter.readFile("/value", {
            signal: signal.signal,
            get at() {
              settings++;
              return 0;
            },
          })
        ),
        reason,
      );
      aborted(
        await rejected(() =>
          adapter.writeFile("/value", new Uint8Array(), {
            signal: signal.signal,
            get mode(): "replace" {
              settings++;
              return "replace";
            },
          })
        ),
        reason,
      );
      expect([settings, effects]).toEqual([0, 0]);
    });
    it(`retires a late unpublished stream and joins cancellation: ${String(reason)}`, async () => {
      const acquired = Promise.withResolvers<ReadableStream<Uint8Array>>(),
        entered = Promise.withResolvers<void>(),
        closing = Promise.withResolvers<void>(),
        retired = Promise.withResolvers<unknown>(),
        signal = controller(reason);
      const base = driver();
      const adapter = createRecordAdapter(
        driver({
          capabilities: { ...base.capabilities, streamRead: true },
          openReadStream: () => {
            entered.resolve();
            return acquired.promise;
          },
        }),
      );
      let settled = false;
      const terminal = rejected(() => adapter.openReadStream!("/value", { signal: signal.signal })).then((value) => {
        settled = true;
        return value;
      });
      try {
        await entered.promise;
        signal.abort(reason);
        acquired.resolve(
          new ReadableStream({
            cancel(value) {
              retired.resolve(value);
              return closing.promise;
            },
          }),
        );
        const cancellation = await retired.promise;
        aborted(cancellation, reason);
        expect(settled).toBe(false);
      } finally {
        closing.resolve();
      }
      aborted(await terminal, reason);
    });
  }
  it("preserves a rejected store operation even when cancellation also arrived", async () => {
    const pending = Promise.withResolvers<FileRecordType>(),
      entered = Promise.withResolvers<void>(),
      signal = new AbortController(),
      fault = Error("actual store failure");
    const adapter = createRecordAdapter(driver({
      get: () => {
        entered.resolve();
        return pending.promise;
      },
    }));
    const terminal = rejected(() => adapter.readFile("/value", { signal: signal.signal }));
    await entered.promise;
    signal.abort(null);
    pending.reject(fault);
    expect(await terminal).toBe(fault);
  });
  it("captures changing write settings once and preserves already-dispatched acknowledgement", async () => {
    const pending = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>(),
      signal = new AbortController();
    let modes = 0, signals = 0;
    let saved: FileRecordType | undefined;
    const adapter = createRecordAdapter(driver({
      set: (value) => {
        if (value.kind !== "file") throw Error("Expected file");
        saved = value;
        entered.resolve();
        return pending.promise;
      },
    }));
    const terminal = adapter.writeFile("/value", new Uint8Array([100]), {
      get mode(): "append" | "replace" {
        return ++modes === 1 ? "append" : "replace";
      },
      get signal() {
        signals++;
        return signal.signal;
      },
    });
    await entered.promise;
    signal.abort(null);
    pending.resolve();
    await terminal;
    expect([modes, signals]).toEqual([1, 1]);
    expect(saved).toMatchObject({ data: "YWJjZA==", size: 4 });
  });
  it("retains an unpublished stream cancellation fault independently of the abort reason", async () => {
    const signal = new AbortController(), base = driver();
    const adapter = createRecordAdapter(
      driver({
        capabilities: { ...base.capabilities, streamRead: true },
        openReadStream: () => {
          signal.abort(null);
          return Promise.resolve(
            new ReadableStream({
              cancel() {
                throw undefined;
              },
            }),
          );
        },
      }),
    );
    const actual = await rejected(() => adapter.openReadStream!("/value", { signal: signal.signal }));
    expect(actual).toBeInstanceOf(AggregateError);
    if (!(actual instanceof AggregateError)) throw Error("Expected independent cleanup fault.");
    expect(actual.errors.length).toBe(2);
    aborted(actual.errors[0], null);
    expect(actual.errors[1]).toBeUndefined();
  });
  it("joins malformed child admission with an independently failed iterator return", async () => {
    let returned = 0;
    const iterator: AsyncIterableIterator<FileRecordType> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => Promise.resolve({ done: false, value: { ...record, parent: "/elsewhere" } }),
      return() {
        returned++;
        throw undefined;
      },
    };
    const adapter = createRecordAdapter(driver({ list: () => iterator }));
    const actual = await rejected(() => Array.fromAsync(adapter.readDir("/")));
    expect(actual).toBeInstanceOf(AggregateError);
    if (!(actual instanceof AggregateError)) throw Error("Expected child/return aggregate.");
    expect(actual.errors.length).toBe(2);
    expect(actual.errors[0]).toBeInstanceOf(Error);
    expect(actual.errors[1]).toBeUndefined();
    expect(returned).toBe(1);
  });
  it("observes cancellation from completed EOF without closing a completed iterator", async () => {
    const signal = new AbortController();
    let returned = 0;
    const iterator: AsyncIterableIterator<FileRecordType> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () =>
        Promise.resolve({
          get done(): true {
            signal.abort(null);
            return true;
          },
          value: undefined,
        }),
      return() {
        returned++;
        return Promise.resolve({ done: true, value: undefined });
      },
    };
    const adapter = createRecordAdapter(driver({ list: () => iterator }));
    aborted(await rejected(() => Array.fromAsync(adapter.readDir("/", { signal: signal.signal }))), null);
    expect(returned).toBe(0);
  });
  for (const reason of [undefined, null, Error("independent return fault")]) {
    it(`preserves malformed native backend rows and independent retirement through every record layer: ${String(reason)}`, async () => {
      let returned = 0;
      const driver = defineRecordDriver({
        get: () => Promise.resolve(record),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        list: () => ({
          [Symbol.asyncIterator]() {
            return this;
          },
          next: () => Promise.resolve({ done: false, value: { ...record, parent: "/elsewhere" } }),
          return() {
            returned++;
            throw reason;
          },
        }),
      }, { name: "projection" });
      for (const layer of ["driver", "adapter"] as const) {
        const actual = await rejected(() =>
          Array.fromAsync(layer === "driver" ? driver.list("/") : createRecordAdapter(driver).readDir("/"))
        );
        expect(actual).toBeInstanceOf(AggregateError);
        if (!(actual instanceof AggregateError)) throw Error("Expected original row/return aggregate.");
        expect(actual.errors.length).toBe(2);
        expect(actual.errors[0]).toBeInstanceOf(Error);
        expect(actual.errors[1]).toBe(reason);
      }
      expect(returned).toBe(2);
    });
  }
});
