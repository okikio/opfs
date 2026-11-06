import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { FileSystemError } from "../src/error.ts";
import { observeBytes, openBytes, retire, toByteStream, withAbortSignal } from "../src/stream.ts";
import { within } from "./gate.ts";

/** Preserves rejected undefined as a failure rather than a successful void result. */
async function rejected(pending: Promise<unknown>): Promise<unknown> {
  try {
    await within(pending, "byte owner terminal result");
  } catch (reason) {
    return reason;
  }
  throw new Error("Expected an actual rejected operation.");
}

/** Enumerates actual nested events without collapsing equal-valued reasons. */
function faults(reason: unknown): unknown[] {
  return reason instanceof AggregateError ? reason.errors.flatMap(faults) : [reason];
}

/** One genuine native source with an explicitly held producer pull. */
function held(cancelFault?: { readonly reason: unknown }) {
  const pulled = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  let cancels = 0;
  const source = new ReadableStream<Uint8Array>({
    pull() {
      pulled.resolve();
      return resumed.promise;
    },
    cancel() {
      cancels++;
      if (cancelFault !== undefined) throw cancelFault.reason;
    },
  }, { highWaterMark: 0 });
  return { source, pulled, resumed, cancels: () => cancels };
}

/** Machine-readable abort context and exact native signal reason are the contract. */
function aborted(reason: unknown, signal: AbortSignal): void {
  expect(reason).toBeInstanceOf(FileSystemError);
  expect(reason).toMatchObject({ code: "aborted", operation: "write", path: "/input" });
  if (!(reason instanceof FileSystemError)) throw new Error("Expected a filesystem abort.");
  expect(Object.hasOwn(reason, "cause")).toBe(true);
  expect(reason.cause).toBe(signal.reason);
}

/** Restores one exact native descriptor without relying on a runtime-specific mock implementation. */
function patch(target: object, name: PropertyKey, replacement: PropertyDescriptor): () => void {
  const previous = Object.getOwnPropertyDescriptor(target, name);
  if (previous === undefined) throw Error("Expected an owned descriptor for scoped instrumentation.");
  Object.defineProperty(target, name, { ...previous, ...replacement });
  let restored = false;
  return () => {
    if (!restored) {
      restored = true;
      Object.defineProperty(target, name, previous);
    }
    expect(Object.getOwnPropertyDescriptor(target, name)).toEqual(previous);
  };
}

const reasons: readonly unknown[] = [undefined, null, new Error("Caller cancellation.")];

describe("exact byte-stream abort ownership", () => {
  it("retains the existing producer context when another operation borrows its signal coverage", async () => {
    const control = new AbortController();
    const fixture = held();
    const source = withAbortSignal(fixture.source, control.signal, "/source", "read");
    const destination = withAbortSignal(source, control.signal, "/destination", "write");
    expect(destination).toBe(source);
    const reader = openBytes(destination);
    try {
      const reading = reader.read();
      await within(fixture.pulled.promise, "native source pull admission");
      control.abort(null);
      const failure = await rejected(reading);
      expect(failure).toBeInstanceOf(FileSystemError);
      expect(failure).toMatchObject({ code: "aborted", operation: "read", path: "/source", cause: null });
      expect(fixture.cancels()).toBe(1);
      expect(fixture.source.locked).toBe(false);
    } finally {
      fixture.resumed.resolve();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  });
  for (const [index, reason] of reasons.entries()) {
    for (const observers of [0, 1, 32]) {
      it(`shares one live signal through ${observers} observers, reason ${index}`, async () => {
        const control = new AbortController();
        const fixture = held();
        let stream = withAbortSignal(fixture.source, control.signal, "/input", "write");
        let observations = 0;
        for (let depth = 0; depth < observers; depth++) {
          stream = observeBytes(stream, () => observations++, "/input", "write");
        }
        for (let depth = 0; depth < 512; depth++) {
          expect(withAbortSignal(stream, control.signal, "/input", "write")).toBe(stream);
        }
        const reader = openBytes(stream);
        try {
          const reading = reader.read();
          await within(fixture.pulled.promise, "native pull admission");
          control.abort(reason);
          const failure = await rejected(reading);
          aborted(failure, control.signal);
          expect(fixture.cancels()).toBe(1);
          expect(fixture.source.locked).toBe(false);
          expect(observations).toBe(0);
          await retire(stream);
        } finally {
          fixture.resumed.resolve();
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      });
    }

    it(`retains an independent equal-valued native cancellation fault, reason ${index}`, async () => {
      const control = new AbortController();
      const cancelFault: { reason: unknown } = { reason };
      const fixture = held(cancelFault);
      const stream = withAbortSignal(fixture.source, control.signal, "/input", "write");
      const reader = openBytes(withAbortSignal(observeBytes(stream, () => {}, "/input"), control.signal, "/input"));
      try {
        const reading = reader.read();
        await within(fixture.pulled.promise, "native pull admission");
        control.abort(reason);
        // Undefined requests the native default DOMException. The independent
        // source fault uses the actual signal reason, not the requested value.
        cancelFault.reason = control.signal.reason;
        const observations = faults(await rejected(reading));
        expect(observations).toHaveLength(2);
        aborted(observations[0], control.signal);
        expect(observations[1]).toBe(control.signal.reason);
        expect(fixture.cancels()).toBe(1);
        expect(fixture.source.locked).toBe(false);
      } finally {
        fixture.resumed.resolve();
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });

    it(`retains an independent equal-valued native release fault, reason ${index}`, async () => {
      const control = new AbortController();
      const fixture = held();
      let releases = 0;
      instrumentedReader(fixture.source, (reader) => {
        const release = reader.releaseLock.bind(reader);
        reader.releaseLock = () => {
          release();
          releases++;
          throw control.signal.reason;
        };
      });
      const stream = withAbortSignal(fixture.source, control.signal, "/input", "write");
      const reader = openBytes(stream);
      try {
        const reading = reader.read();
        await within(fixture.pulled.promise, "native pull admission");
        control.abort(reason);
        const observations = faults(await rejected(reading));
        expect(observations).toHaveLength(2);
        aborted(observations[0], control.signal);
        expect(observations[1]).toBe(control.signal.reason);
        expect(releases).toBe(1);
        expect(fixture.cancels()).toBe(1);
        expect(fixture.source.locked).toBe(false);
      } finally {
        fixture.resumed.resolve();
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });

    it(`retains distinct signal events with one reason value, reason ${index}`, async () => {
      const first = new AbortController(), second = new AbortController();
      const fixture = held();
      const inner = withAbortSignal(fixture.source, first.signal, "/input", "write");
      const outer = withAbortSignal(inner, second.signal, "/input", "write");
      expect(outer).not.toBe(inner);
      const reader = openBytes(outer);
      try {
        const reading = reader.read();
        await within(fixture.pulled.promise, "native pull admission");
        first.abort(reason);
        second.abort(first.signal.reason);
        const observations = faults(await rejected(reading));
        expect(observations).toHaveLength(2);
        aborted(observations[0], second.signal);
        aborted(observations[1], first.signal);
        expect(observations[0]).not.toBe(observations[1]);
        expect(fixture.cancels()).toBe(1);
        expect(fixture.source.locked).toBe(false);
      } finally {
        fixture.resumed.resolve();
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });
  }

  it("preserves observer delivery and unsignalled byte validation", async () => {
    const control = new AbortController();
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    }, { highWaterMark: 0 });
    const observed: number[] = [];
    const stream = observeBytes(
      withAbortSignal(source, control.signal, "/input"),
      (chunk) => observed.push(...chunk),
      "/input",
    );
    expect(withAbortSignal(stream, control.signal, "/input")).toBe(stream);
    const reader = openBytes(stream);
    try {
      expect(await reader.read()).toMatchObject({ done: false, value: new Uint8Array([1, 2]) });
      expect(await reader.read()).toMatchObject({ done: false, value: new Uint8Array([3]) });
      expect((await reader.read()).done).toBe(true);
      expect(observed).toEqual([1, 2, 3]);
      expect(source.locked).toBe(false);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const invalid = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue("bytes" as unknown as Uint8Array);
      },
    });
    const validation = openBytes(withAbortSignal(invalid, undefined, "/input"));
    try {
      expect(await rejected(validation.read())).toBeInstanceOf(TypeError);
      expect(invalid.locked).toBe(false);
    } finally {
      await validation.cancel().catch(() => {});
      validation.releaseLock();
    }
  });

  it("does not reuse signal coverage after EOF or retirement begins", async () => {
    const control = new AbortController();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const stream = withAbortSignal(source, control.signal, "/input", "write");
    const reader = openBytes(stream);
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    expect(source.locked).toBe(false);
    control.abort(null);
    const next = withAbortSignal(stream, control.signal, "/input", "write");
    expect(next).not.toBe(stream);
    const later = openBytes(next);
    try {
      aborted(await rejected(later.read()), control.signal);
      expect(stream.locked).toBe(false);
    } finally {
      await later.cancel().catch(() => {});
      later.releaseLock();
    }

    const live = new AbortController();
    const fixture = held();
    const active = withAbortSignal(fixture.source, live.signal, "/input");
    const retirement = retire(active);
    const replacement = withAbortSignal(active, live.signal, "/input");
    expect(replacement).not.toBe(active);
    try {
      await retirement;
      await retire(replacement);
      expect(fixture.source.locked).toBe(false);
    } finally {
      fixture.resumed.resolve();
    }
  });
});

/** Native reader instrumentation retains real lock and Promise behavior. */
function instrumentedReader(
  source: ReadableStream<Uint8Array>,
  change: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
): void {
  const acquire = source.getReader.bind(source);
  Object.defineProperty(source, "getReader", {
    value: () => {
      const reader = acquire();
      change(reader);
      return reader;
    },
  });
}

describe("byte owner setup and listener retirement", () => {
  for (const [index, reason] of reasons.entries()) {
    for (const boundary of ["closed-get", "closed-then", "listener-add"] as const) {
      it(`rolls back ${boundary} failure and keeps independent equal cleanup events, reason ${index}`, async () => {
        const control = new AbortController();
        const fixture = held({ reason });
        let releases = 0, removals = 0;
        instrumentedReader(fixture.source, (reader) => {
          const nativeClosed = reader.closed;
          void nativeClosed.catch(() => {});
          if (boundary === "closed-get") {
            Object.defineProperty(reader, "closed", {
              get() {
                throw reason;
              },
            });
          } else if (boundary === "closed-then") {
            const then = nativeClosed.then.bind(nativeClosed);
            Object.defineProperty(nativeClosed, "then", {
              value: (...args: Parameters<typeof then>) => {
                void then(...args).catch(() => {});
                throw reason;
              },
            });
          }
          const release = reader.releaseLock.bind(reader);
          reader.releaseLock = () => {
            release();
            releases++;
            throw reason;
          };
        });
        if (boundary === "listener-add") {
          const add = control.signal.addEventListener.bind(control.signal);
          const remove = control.signal.removeEventListener.bind(control.signal);
          control.signal.addEventListener = (...args: Parameters<typeof add>) => {
            add(...args);
            throw reason;
          };
          control.signal.removeEventListener = (...args: Parameters<typeof remove>) => {
            remove(...args);
            removals++;
            throw reason;
          };
        }
        const stream = withAbortSignal(fixture.source, control.signal, "/input", "write");
        const reader = openBytes(stream);
        try {
          const observations = faults(await rejected(reader.read()));
          expect(observations).toHaveLength(boundary === "listener-add" ? 4 : 3);
          for (const failure of observations) expect(failure).toBe(reason);
          expect(fixture.cancels()).toBe(1);
          expect(releases).toBe(1);
          expect(removals).toBe(boundary === "listener-add" ? 1 : 0);
          expect(fixture.source.locked).toBe(false);
          await retire(stream);
        } finally {
          fixture.resumed.resolve();
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      });
    }

    it(`settles an abort despite an independent detach failure, reason ${index}`, async () => {
      const control = new AbortController();
      const fixture = held();
      const remove = control.signal.removeEventListener.bind(control.signal);
      let removals = 0;
      control.signal.removeEventListener = (...args: Parameters<typeof remove>) => {
        remove(...args);
        removals++;
        throw reason;
      };
      const stream = withAbortSignal(fixture.source, control.signal, "/input", "write");
      const reader = openBytes(stream);
      try {
        const reading = reader.read();
        await within(fixture.pulled.promise, "native pull admission");
        control.abort(reason);
        const observations = faults(await rejected(reading));
        expect(observations).toHaveLength(2);
        aborted(observations[0], control.signal);
        expect(observations[1]).toBe(reason);
        expect(removals).toBe(1);
        expect(fixture.cancels()).toBe(1);
        expect(fixture.source.locked).toBe(false);
      } finally {
        fixture.resumed.resolve();
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });

    it(`settles EOF with an actual detach failure, reason ${index}`, async () => {
      const control = new AbortController();
      let cancels = 0;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
        cancel() {
          cancels++;
        },
      });
      const remove = control.signal.removeEventListener.bind(control.signal);
      control.signal.removeEventListener = (...args: Parameters<typeof remove>) => {
        remove(...args);
        throw reason;
      };
      const stream = withAbortSignal(source, control.signal, "/input");
      const reader = openBytes(stream);
      try {
        expect(await rejected(reader.read())).toBe(reason);
        expect(cancels).toBe(0);
        expect(source.locked).toBe(false);
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });

    it(`retains setup failure after setup synchronously aborts, reason ${index}`, async () => {
      const control = new AbortController();
      const fixture = held();
      const add = control.signal.addEventListener.bind(control.signal);
      control.signal.addEventListener = (...args: Parameters<typeof add>) => {
        add(...args);
        control.abort(reason);
        throw control.signal.reason;
      };
      const stream = withAbortSignal(fixture.source, control.signal, "/input", "write");
      const reader = openBytes(stream);
      try {
        const observations = faults(await rejected(reader.read()));
        expect(observations).toHaveLength(2);
        aborted(observations[0], control.signal);
        expect(observations[1]).toBe(control.signal.reason);
        expect(fixture.cancels()).toBe(1);
        expect(fixture.source.locked).toBe(false);
      } finally {
        fixture.resumed.resolve();
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });

    it(`retains a native source error beside the abort even with equal reason, reason ${index}`, async () => {
      const control = new AbortController();
      const pulled = Promise.withResolvers<void>();
      const resumed = Promise.withResolvers<void>();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let cancels = 0;
      const source = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
        pull() {
          pulled.resolve();
          return resumed.promise;
        },
        cancel() {
          cancels++;
        },
      }, { highWaterMark: 0 });
      const stream = withAbortSignal(source, control.signal, "/input", "write");
      const reader = openBytes(stream);
      try {
        const reading = reader.read();
        await within(pulled.promise, "native pull admission");
        controller.error(reason);
        control.abort(reason);
        const observations = faults(await rejected(reading));
        expect(observations).toHaveLength(2);
        aborted(observations[0], control.signal);
        expect(observations[1]).toBe(reason);
        expect(cancels).toBe(0);
        expect(source.locked).toBe(false);
      } finally {
        resumed.resolve();
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });
  }
});

/** Borrowed read methods do not certify the native source's terminal state. */
describe("byte reader effect provenance", () => {
  for (const [index, reason] of reasons.entries()) {
    for (const borrowed of [false, true]) {
      it(`retains native terminal observations with borrowed read ${borrowed}, reason ${index}`, async () => {
        let cancels = 0;
        const source = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(reason);
          },
          cancel() {
            cancels++;
          },
        });
        if (borrowed) {
          instrumentedReader(source, (reader) => {
            const read = reader.read.bind(reader);
            reader.read = () => read();
          });
        }
        const reader = openBytes(withAbortSignal(source, undefined, "/input"));
        try {
          const failure = await rejected(reader.read());
          if (borrowed) expect(faults(failure)).toEqual([reason, reason]);
          else expect(failure).toBe(reason);
          expect(cancels).toBe(0);
          expect(source.locked).toBe(false);
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      });
    }
    for (const lane of ["throw", "reject", "started"] as const) {
      for (const cleanupFault of [false, true]) {
        it(`retires native source after ${lane} read refusal, cleanup fault ${cleanupFault}, reason ${index}`, async () => {
          const fixture = held(cleanupFault ? { reason } : undefined);
          let reads = 0, releases = 0;
          let physical: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
          instrumentedReader(fixture.source, (reader) => {
            const read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
            reader.read = () => {
              reads++;
              if (lane === "reject") return Promise.reject(reason);
              if (lane === "started") {
                physical = read();
                void physical.catch(() => {});
              }
              throw reason;
            };
            reader.releaseLock = () => {
              release();
              releases++;
              if (cleanupFault) throw reason;
            };
          });
          const stream = withAbortSignal(fixture.source, undefined, "/input");
          const reader = openBytes(stream);
          try {
            const failure = await rejected(reader.read());
            if (cleanupFault) expect(faults(failure)).toEqual([reason, reason, reason]);
            else expect(failure).toBe(reason);
            expect(reads).toBe(1);
            expect(releases).toBe(1);
            expect(fixture.cancels()).toBe(1);
            expect(fixture.source.locked).toBe(false);
            if (lane === "started") {
              expect(physical).toBeDefined();
              expect((await within(physical!, "actual native pending read retirement")).done).toBe(true);
            }
            await retire(stream);
          } finally {
            fixture.resumed.resolve();
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        });
      }
    }

    it(`retains unknown read refusal beside native closed failure, reason ${index}`, async () => {
      let native!: ReadableStreamDefaultController<Uint8Array>;
      let cancels = 0, releases = 0, cancelCalls = 0;
      let cancelledFailure: { reason: unknown } | undefined, closedFailure: { reason: unknown } | undefined;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          native = controller;
        },
        cancel() {
          cancels++;
        },
      }, { highWaterMark: 0 });
      instrumentedReader(source, (reader) => {
        void reader.closed.then(undefined, (failure: unknown) => {
          closedFailure = { reason: failure };
        });
        const cancel = reader.cancel.bind(reader);
        reader.cancel = async (value) => {
          cancelCalls++;
          try {
            await cancel(value);
          } catch (failure) {
            cancelledFailure = { reason: failure };
            throw failure;
          }
        };
        const release = reader.releaseLock.bind(reader);
        reader.read = () => {
          native.error(reason);
          throw reason;
        };
        reader.releaseLock = () => {
          release();
          releases++;
        };
      });
      const reader = openBytes(withAbortSignal(source, undefined, "/input"));
      try {
        const observations = faults(await rejected(reader.read()));
        expect(observations).toHaveLength(3);
        expect(observations).toEqual([reason, reason, reason]);
        expect(cancelCalls).toBe(1);
        expect(cancelledFailure).toBeDefined();
        expect(closedFailure).toBeDefined();
        expect(cancelledFailure?.reason).toBe(reason);
        expect(closedFailure?.reason).toBe(reason);
        expect(cancels).toBe(0);
        expect(releases).toBe(1);
        expect(source.locked).toBe(false);
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });

    it(`does not certify EOF from an unknown fabricated read, reason ${index}`, async () => {
      const fixture = held({ reason });
      instrumentedReader(fixture.source, (reader) => {
        reader.read = () => Promise.resolve({ done: true, value: undefined });
      });
      const reader = openBytes(withAbortSignal(fixture.source, undefined, "/input"));
      try {
        expect(await rejected(reader.read())).toBe(reason);
        expect(fixture.cancels()).toBe(1);
        expect(fixture.source.locked).toBe(false);
      } finally {
        fixture.resumed.resolve();
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });
  }
});

/** Read-result fields belong to one pending operation, not repeated native pulls. */
describe("byte read-result admission", () => {
  for (const [index, reason] of reasons.entries()) {
    for (const stage of ["done", "value"] as const) {
      for (const abort of [false, true]) {
        for (const cleanupFault of [false, true]) {
          it(`retires ${stage} getter refusal with abort ${abort} and cleanup ${cleanupFault}, reason ${index}`, async () => {
            const control = new AbortController();
            const fixture = held(cleanupFault ? { reason } : undefined);
            let fields = 0, releases = 0;
            const field = (): void => {
              fields++;
              if (abort) control.abort(reason);
              throw reason;
            };
            instrumentedReader(fixture.source, (reader) => {
              const release = reader.releaseLock.bind(reader);
              reader.read = () =>
                Promise.resolve({
                  get done() {
                    if (stage === "done") field();
                    return false as const;
                  },
                  get value() {
                    if (stage === "value") field();
                    return new Uint8Array([17]);
                  },
                });
              reader.releaseLock = () => {
                release();
                releases++;
                if (cleanupFault) throw reason;
              };
            });
            const reader = openBytes(withAbortSignal(fixture.source, control.signal, "/input", "write"));
            try {
              const failure = await rejected(reader.read());
              const observations = faults(failure);
              if (abort) {
                aborted(observations[0], control.signal);
                expect(observations.slice(1)).toEqual(cleanupFault ? [reason, reason, reason] : [reason]);
              } else if (cleanupFault) expect(observations).toEqual([reason, reason, reason]);
              else expect(failure).toBe(reason);
              expect(fields).toBe(1);
              expect(releases).toBe(1);
              expect(fixture.cancels()).toBe(1);
              expect(fixture.source.locked).toBe(false);
            } finally {
              fixture.resumed.resolve();
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          });
        }
      }

      it(`snapshots ${stage} once before validating or publishing bytes, reason ${index}`, async () => {
        const fixture = held();
        let fields = 0;
        instrumentedReader(fixture.source, (reader) => {
          reader.read = () =>
            Promise.resolve({
              get done() {
                if (stage === "done" && ++fields > 1) throw reason;
                return false as const;
              },
              get value() {
                if (stage === "value" && ++fields > 1) throw reason;
                return new Uint8Array([17]);
              },
            });
        });
        const reader = openBytes(withAbortSignal(fixture.source, undefined, "/input"));
        try {
          expect(await reader.read()).toMatchObject({ done: false, value: new Uint8Array([17]) });
          expect(fields).toBe(1);
          await reader.cancel();
          expect(fixture.cancels()).toBe(1);
          expect(fixture.source.locked).toBe(false);
        } finally {
          fixture.resumed.resolve();
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      });
    }

    it(`retains value-getter fault beside actual native closed error, reason ${index}`, async () => {
      let native!: ReadableStreamDefaultController<Uint8Array>;
      let cancels = 0, cancelCalls = 0;
      let cancelledFailure: { reason: unknown } | undefined, closedFailure: { reason: unknown } | undefined;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          native = controller;
        },
        cancel() {
          cancels++;
        },
      }, { highWaterMark: 0 });
      instrumentedReader(source, (reader) => {
        void reader.closed.then(undefined, (failure: unknown) => {
          closedFailure = { reason: failure };
        });
        const cancel = reader.cancel.bind(reader);
        reader.cancel = async (value) => {
          cancelCalls++;
          try {
            await cancel(value);
          } catch (failure) {
            cancelledFailure = { reason: failure };
            throw failure;
          }
        };
        reader.read = () =>
          Promise.resolve({
            done: false as const,
            get value(): Uint8Array {
              native.error(reason);
              throw reason;
            },
          });
      });
      const reader = openBytes(withAbortSignal(source, undefined, "/input"));
      try {
        const observations = faults(await rejected(reader.read()));
        expect(observations).toHaveLength(3);
        expect(observations).toEqual([reason, reason, reason]);
        expect(cancelCalls).toBe(1);
        expect(cancelledFailure).toBeDefined();
        expect(closedFailure).toBeDefined();
        expect(cancelledFailure?.reason).toBe(reason);
        expect(closedFailure?.reason).toBe(reason);
        expect(cancels).toBe(0);
        expect(source.locked).toBe(false);
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });

    for (const cleanupFault of [false, true]) {
      it(`keeps synchronous observer fault after self-retirement, cleanup ${cleanupFault}, reason ${index}`, async () => {
        const resumed = Promise.withResolvers<void>();
        let cancels = 0, releases = 0, observations = 0;
        const source = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array([17]));
            return resumed.promise;
          },
          cancel() {
            cancels++;
            if (cleanupFault) throw reason;
          },
        }, { highWaterMark: 0 });
        instrumentedReader(source, (reader) => {
          const release = reader.releaseLock.bind(reader);
          reader.releaseLock = () => {
            release();
            releases++;
            if (cleanupFault) throw reason;
          };
        });
        let retiring: Promise<void> | undefined;
        const observed = observeBytes(source, () => {
          observations++;
          retiring = retire(observed, reason);
          void retiring.catch(() => {});
          throw reason;
        }, "/input");
        const reader = openBytes(observed);
        try {
          const failure = await rejected(reader.read());
          if (cleanupFault) expect(faults(failure)).toEqual([reason, reason, reason]);
          else expect(failure).toBe(reason);
          expect(observations).toBe(1);
          expect(cancels).toBe(1);
          expect(releases).toBe(1);
          expect(source.locked).toBe(false);
          expect(retiring).toBeDefined();
          await retiring!.catch(() => {});
        } finally {
          resumed.resolve();
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      });
    }
  }

  it("validates and publishes the same single admitted byte value", async () => {
    const fixture = held();
    let values = 0;
    instrumentedReader(fixture.source, (reader) => {
      reader.read = () =>
        Promise.resolve({
          done: false as const,
          get value() {
            values++;
            return values === 1 ? new Uint8Array([17]) : new DataView(new ArrayBuffer(8)) as unknown as Uint8Array;
          },
        });
    });
    const reader = openBytes(withAbortSignal(fixture.source, undefined, "/input"));
    try {
      expect(await reader.read()).toMatchObject({ done: false, value: new Uint8Array([17]) });
      expect(values).toBe(1);
      await reader.cancel();
      expect(fixture.cancels()).toBe(1);
      expect(fixture.source.locked).toBe(false);
    } finally {
      fixture.resumed.resolve();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  });
});

/** A custom cancellation fault cannot certify delivery of a published source event. */
describe("byte cancellation delivery provenance", () => {
  for (const [index, reason] of reasons.entries()) {
    for (const lane of ["native", "get", "throw", "reject", "after"] as const) {
      it(`preserves published source error with ${lane} cancellation, reason ${index}`, async () => {
        const source = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(reason);
          },
        });
        const stream = withAbortSignal(source, undefined, "/input");
        // Native observation prepares a published wrapper error without granting
        // the private openBytes delivery receipt to that first native reader.
        const preparing = stream.getReader();
        void preparing.closed.catch(() => {});
        expect(await rejected(preparing.read())).toBe(reason);
        preparing.releaseLock();
        let attempts = 0;
        if (lane !== "native") {
          instrumentedReader(stream, (reader) => {
            void reader.closed.catch(() => {});
            if (lane === "get") {
              Object.defineProperty(reader, "cancel", {
                get() {
                  attempts++;
                  throw reason;
                },
              });
            } else {
              const cancel = reader.cancel.bind(reader);
              reader.cancel = (...args: Parameters<typeof cancel>) => {
                attempts++;
                if (lane === "after") void cancel(...args).catch(() => {});
                if (lane === "reject") return Promise.reject(reason);
                throw reason;
              };
            }
          });
        }
        const reader = openBytes(stream);
        void reader.closed.catch(() => {});
        try {
          expect(await rejected(reader.cancel())).toBe(reason);
          reader.releaseLock();
          if (lane === "native") await retire(stream);
          else expect(await rejected(retire(stream))).toBe(reason);
          expect(attempts).toBe(lane === "native" ? 0 : 1);
          expect(source.locked).toBe(false);
          expect(stream.locked).toBe(false);
        } finally {
          reader.releaseLock();
        }
      });
    }
  }
});

/** Covered upstream cancellation remains authoritative during byte observation. */
describe("covered byte observation terminal admission", () => {
  for (const [index, reason] of reasons.entries()) {
    for (const observers of [0, 1, 32]) {
      for (const throws of [false, true]) {
        for (const cleanupFault of [false, true]) {
          it(`refuses post-stop bytes with ${observers} observers, throw ${throws}, cleanup ${cleanupFault}, reason ${index}`, async () => {
            const control = new AbortController(), resumed = Promise.withResolvers<void>();
            let cancels = 0, releases = 0, admissions = 0;
            const source = new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new Uint8Array([17]));
                return resumed.promise;
              },
              cancel() {
                cancels++;
                if (cleanupFault) throw control.signal.reason;
              },
            }, { highWaterMark: 0 });
            const effect = (): void => {
              admissions++;
              control.abort(reason);
              if (throws) throw reason;
            };
            instrumentedReader(source, (reader) => {
              const read = reader.read.bind(reader), release = reader.releaseLock.bind(reader);
              if (observers === 0) {
                // With no byte observer, the real native read's borrowed value
                // getter is the synchronous source-admission effect instead.
                reader.read = () =>
                  read().then((result) =>
                    result.done ? result : ({
                      done: false as const,
                      get value() {
                        effect();
                        return result.value;
                      },
                    })
                  );
              }
              reader.releaseLock = () => {
                release();
                releases++;
                if (cleanupFault) throw control.signal.reason;
              };
            });
            let stream = withAbortSignal(source, control.signal, "/input", "write");
            const chain = [stream];
            for (let depth = 0; depth < observers; depth++) {
              stream = observeBytes(
                stream,
                () => {
                  if (depth === observers - 1) effect();
                },
                "/input",
                "write",
              );
              chain.push(stream);
            }
            expect(withAbortSignal(stream, control.signal, "/input", "write")).toBe(stream);
            const reader = openBytes(stream);
            try {
              const observations = faults(await rejected(reader.read()));
              aborted(observations[0], control.signal);
              expect(observations).toHaveLength(1 + (cleanupFault ? 2 : 0) + (throws ? 1 : 0));
              for (const observation of observations.slice(1)) {
                expect(observation === control.signal.reason || (throws && observation === reason)).toBe(true);
              }
              expect(admissions).toBe(1);
              expect(cancels).toBe(1);
              expect(releases).toBe(1);
              expect(source.locked).toBe(false);
              for (const upstream of chain.slice(0, -1)) expect(upstream.locked).toBe(false);
              await retire(stream);
            } finally {
              resumed.resolve();
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          });
        }
      }
    }
  }
});

/** Declared source identity cannot substitute for the reader actually acquired. */
describe("byte reader source binding", () => {
  for (const [index, reason] of reasons.entries()) {
    for (const actualFailure of [false, true]) {
      it(`keeps unrelated native reader outcome independent, failure ${actualFailure}, reason ${index}`, async () => {
        const originalSource = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(reason);
          },
        });
        const original = withAbortSignal(originalSource, undefined, "/original");
        // A plain native reader observes publication without the private delivery
        // receipt. This gives the borrowed acquisition a genuinely failed owner.
        const preparing = original.getReader();
        void preparing.closed.catch(() => {});
        expect(await rejected(preparing.read())).toBe(reason);
        preparing.releaseLock();
        const actual = new ReadableStream<Uint8Array>({
          start(controller) {
            if (actualFailure) controller.error(reason);
            else {
              controller.enqueue(new Uint8Array([17, 31]));
              controller.close();
            }
          },
        }, { highWaterMark: 0 });
        Object.defineProperty(original, "getReader", {
          value: () => actual.getReader(),
          configurable: true,
        });
        const observed = observeBytes(original, () => {}, "/actual");
        const reader = openBytes(observed);
        try {
          if (actualFailure) expect(await rejected(reader.read())).toBe(reason);
          else {
            expect(await reader.read()).toEqual({ done: false, value: new Uint8Array([17, 31]) });
            expect(await reader.read()).toEqual({ done: true, value: undefined });
          }
          // Actual native reader failure cannot mark the original publication
          // delivered merely because both failures happen to have the same value.
          expect(await rejected(retire(original))).toBe(reason);
          expect(actual.locked).toBe(false);
          expect(originalSource.locked).toBe(false);
          expect(original.locked).toBe(false);
          await retire(observed);
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      });
    }

    it(`refuses inherited signal coverage through unrelated live acquisition, reason ${index}`, async () => {
      const control = new AbortController();
      const originalFixture = held(), actualFixture = held();
      const original = withAbortSignal(originalFixture.source, control.signal, "/original", "read");
      Object.defineProperty(original, "getReader", {
        value: () => actualFixture.source.getReader(),
        configurable: true,
      });
      const observed = observeBytes(original, () => {}, "/input", "write");
      const covered = withAbortSignal(observed, control.signal, "/input", "write");
      expect(covered).not.toBe(observed);
      expect(withAbortSignal(covered, control.signal, "/input", "write")).toBe(covered);
      const reader = openBytes(covered);
      try {
        const reading = reader.read();
        await within(actualFixture.pulled.promise, "unrelated native pull admission");
        control.abort(reason);
        aborted(await rejected(reading), control.signal);
        expect(actualFixture.cancels()).toBe(1);
        expect(originalFixture.cancels()).toBe(1);
        expect(actualFixture.source.locked).toBe(false);
        expect(originalFixture.source.locked).toBe(false);
        expect(observed.locked).toBe(false);
        const originalFailure = await rejected(retire(original));
        expect(originalFailure).toMatchObject({ code: "aborted", operation: "read", path: "/original" });
        if (!(originalFailure instanceof FileSystemError)) throw new Error("Expected original source cancellation.");
        expect(originalFailure.cause).toBe(control.signal.reason);
      } finally {
        originalFixture.resumed.resolve();
        actualFixture.resumed.resolve();
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });
  }
});

/** Borrowed closed access/then cannot certify the native reader's terminal state. */
describe("byte reader closed authority", () => {
  for (const [index, reason] of reasons.entries()) {
    for (const lane of ["get", "then", "proxy"] as const) {
      for (const cleanupFault of [false, true]) {
        it(`retires live reader after unknown ${lane} closed settlement, cleanup ${cleanupFault}, reason ${index}`, async () => {
          const fixture = held(cleanupFault ? { reason } : undefined);
          const acquire = fixture.source.getReader.bind(fixture.source);
          let releases = 0, reads = 0;
          Object.defineProperty(fixture.source, "getReader", {
            value: () => {
              const reader = acquire(), closed = reader.closed;
              void closed.catch(() => {});
              const release = reader.releaseLock.bind(reader);
              reader.read = () => {
                reads++;
                throw reason;
              };
              reader.releaseLock = () => {
                release();
                releases++;
                if (cleanupFault) throw reason;
              };
              if (lane === "get") {
                Object.defineProperty(reader, "closed", { get: () => Promise.resolve() });
              } else if (lane === "then") {
                const then = closed.then.bind(closed);
                Object.defineProperty(closed, "then", {
                  value: (...args: Parameters<typeof then>) => {
                    args[0]?.();
                    return then(...args);
                  },
                });
              } else {
                // Declared access and methods are valid forwarded capabilities.
                // The captured native getter may reject this proxy receiver;
                // unavailable proof must not replace the actual read refusal.
                return new Proxy(reader, {
                  get(target, name) {
                    const value: unknown = Reflect.get(target, name, target);
                    return typeof value === "function" ? value.bind(target) : value;
                  },
                });
              }
              return reader;
            },
          });
          const stream = withAbortSignal(fixture.source, undefined, "/input");
          const reader = openBytes(stream);
          try {
            const failure = await rejected(reader.read());
            if (cleanupFault) expect(faults(failure)).toEqual([reason, reason, reason]);
            else expect(failure).toBe(reason);
            expect(reads).toBe(1);
            expect(fixture.cancels()).toBe(1);
            expect(releases).toBe(1);
            expect(fixture.source.locked).toBe(false);
            await retire(stream);
          } finally {
            fixture.resumed.resolve();
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        });
      }
    }

    it(`retains borrowed closed failure beside actual bound owner publication, reason ${index}`, async () => {
      const source = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(reason) });
      const original = withAbortSignal(source, undefined, "/original");
      const preparing = original.getReader();
      void preparing.closed.catch(() => {});
      expect(await rejected(preparing.read())).toBe(reason);
      preparing.releaseLock();
      const prototype = ReadableStreamDefaultReader.prototype;
      const getter = Object.getOwnPropertyDescriptor(prototype, "closed")?.get;
      if (getter === undefined) throw Error("Expected an actual native reader closed getter.");
      let reader: ReturnType<typeof openBytes> | undefined;
      let injections = 0;
      let restore: (() => void) | undefined;
      try {
        restore = patch(prototype, "closed", {
          get: function (this: ReadableStreamDefaultReader<Uint8Array>) {
            const closed = Reflect.apply(getter, this, []) as Promise<void>;
            void closed.catch(() => {});
            injections++;
            return Promise.reject(reason);
          },
        });
        const stream = observeBytes(original, () => {}, "/input");
        reader = openBytes(stream);
        expect(faults(await rejected(reader.read()))).toEqual([reason, reason]);
        expect(injections).toBe(1);
        expect(source.locked).toBe(false);
        expect(original.locked).toBe(false);
        await retire(stream);
      } finally {
        restore?.();
        expect(Object.getOwnPropertyDescriptor(prototype, "closed")?.get).toBe(getter);
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
    });

    it(`correlates actual local native closed/read failure once, reason ${index}`, async () => {
      let cancels = 0, releases = 0;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(reason);
        },
        cancel() {
          cancels++;
        },
      });
      instrumentedReader(source, (reader) => {
        const release = reader.releaseLock.bind(reader);
        reader.releaseLock = () => {
          release();
          releases++;
        };
      });
      const stream = withAbortSignal(source, undefined, "/input");
      const reader = openBytes(stream);
      try {
        expect(await rejected(reader.read())).toBe(reason);
        expect(cancels).toBe(0);
        expect(releases).toBe(1);
        expect(source.locked).toBe(false);
        await retire(stream);
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });
  }
});

/** Returned subscription work is a separate acquired operation, never producer terminal proof. */
describe("byte closed observer work", () => {
  for (const [index, reason] of reasons.entries()) {
    for (const cleanupFault of [false, true]) {
      it(`retires on rejected observer child, cleanup ${cleanupFault}, reason ${index}`, async () => {
        const fixture = held(cleanupFault ? { reason } : undefined);
        let releases = 0, reads = 0;
        const retiring = Promise.withResolvers<void>();
        instrumentedReader(fixture.source, (reader) => {
          void reader.closed.catch(() => {});
          const release = reader.releaseLock.bind(reader);
          const cancel = reader.cancel.bind(reader);
          reader.cancel = (reason) => {
            const cancelling = cancel(reason);
            retiring.resolve();
            return cancelling;
          };
          const declared = Promise.withResolvers<void>().promise;
          Object.defineProperty(declared, "then", { value: () => Promise.reject(reason) });
          Object.defineProperty(reader, "closed", { get: () => declared });
          reader.read = () => {
            reads++;
            return Promise.resolve({ done: false, value: new Uint8Array([1]) });
          };
          reader.releaseLock = () => {
            release();
            releases++;
          };
        });
        const stream = withAbortSignal(fixture.source, undefined, "/input");
        const reader = openBytes(stream);
        try {
          await within(retiring.promise, "observer failure owns cancellation before any read");
          const failure = await rejected(reader.read());
          if (cleanupFault) expect(faults(failure)).toEqual([reason, reason]);
          else expect(failure).toBe(reason);
          expect(reads).toBe(0);
          expect(fixture.cancels()).toBe(1);
          expect(releases).toBe(1);
          expect(fixture.source.locked).toBe(false);
          await retire(stream);
        } finally {
          fixture.resumed.resolve();
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      });
    }

    for (const [childFault, releaseFault] of [[true, false], [false, true], [true, true]] as const) {
      it(`joins release-dependent observer child, child ${childFault}, release ${releaseFault}, reason ${index}`, async () => {
        const fixture = held();
        const child = Promise.withResolvers<void>();
        let releases = 0, reads = 0;
        instrumentedReader(fixture.source, (reader) => {
          void reader.closed.catch(() => {});
          const declared = Promise.withResolvers<void>().promise;
          Object.defineProperty(declared, "then", { value: () => child.promise });
          Object.defineProperty(reader, "closed", { get: () => declared });
          reader.read = () => {
            reads++;
            throw reason;
          };
          const release = reader.releaseLock.bind(reader);
          reader.releaseLock = () => {
            release();
            releases++;
            if (childFault) child.reject(reason);
            else child.resolve();
            if (releaseFault) throw reason;
          };
        });
        const stream = withAbortSignal(fixture.source, undefined, "/input");
        const reader = openBytes(stream);
        try {
          expect(faults(await rejected(reader.read()))).toEqual([
            reason,
            ...(releaseFault ? [reason] : []),
            ...(childFault ? [reason] : []),
          ]);
          expect(reads).toBe(1);
          expect(fixture.cancels()).toBe(1);
          expect(releases).toBe(1);
          expect(fixture.source.locked).toBe(false);
          await retire(stream);
        } finally {
          child.resolve();
          fixture.resumed.resolve();
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      });
    }

    for (const callbackFirst of [false, true]) {
      it(`preserves returned subscription refusal, prior rejection ${callbackFirst}, reason ${index}`, async () => {
        const fixture = held();
        let releases = 0;
        instrumentedReader(fixture.source, (reader) => {
          void reader.closed.catch(() => {});
          const declared = Promise.withResolvers<void>().promise;
          Object.defineProperty(declared, "then", {
            value: () => ({
              then(_fulfilled: (value: unknown) => void, reject: (reason: unknown) => void) {
                if (callbackFirst) reject(reason);
                throw reason;
              },
            }),
          });
          Object.defineProperty(reader, "closed", { get: () => declared });
          const release = reader.releaseLock.bind(reader);
          reader.releaseLock = () => {
            release();
            releases++;
          };
        });
        const stream = withAbortSignal(fixture.source, undefined, "/input");
        const reader = openBytes(stream);
        try {
          const failure = await rejected(reader.read());
          if (callbackFirst) expect(faults(failure)).toEqual([reason, reason]);
          else expect(failure).toBe(reason);
          expect(fixture.cancels()).toBe(1);
          expect(releases).toBe(1);
          expect(fixture.source.locked).toBe(false);
          await retire(stream);
        } finally {
          fixture.resumed.resolve();
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      });
    }

    it(`retains equal read, declared closed and returned child faults, reason ${index}`, async () => {
      const fixture = held();
      const declared = Promise.withResolvers<void>();
      const child = Promise.withResolvers<void>();
      let releases = 0, reads = 0;
      instrumentedReader(fixture.source, (reader) => {
        void reader.closed.catch(() => {});
        const then = declared.promise.then.bind(declared.promise);
        Object.defineProperty(declared.promise, "then", {
          value: (...callbacks: Parameters<typeof then>) => {
            void then(...callbacks).catch(() => {});
            return child.promise;
          },
        });
        Object.defineProperty(reader, "closed", { get: () => declared.promise });
        reader.read = () => {
          reads++;
          declared.reject(reason);
          throw reason;
        };
        const release = reader.releaseLock.bind(reader);
        reader.releaseLock = () => {
          release();
          releases++;
          child.reject(reason);
        };
      });
      const stream = withAbortSignal(fixture.source, undefined, "/input");
      const reader = openBytes(stream);
      try {
        expect(faults(await rejected(reader.read()))).toEqual([reason, reason, reason]);
        expect(reads).toBe(1);
        expect(fixture.cancels()).toBe(1);
        expect(releases).toBe(1);
        expect(fixture.source.locked).toBe(false);
        await retire(stream);
      } finally {
        child.resolve();
        declared.resolve();
        fixture.resumed.resolve();
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });

    it(`retains declared closed failure which becomes observable after release, reason ${index}`, async () => {
      const fixture = held();
      const declared = Promise.withResolvers<void>();
      let releases = 0;
      instrumentedReader(fixture.source, (reader) => {
        void reader.closed.catch(() => {});
        Object.defineProperty(reader, "closed", { get: () => declared.promise });
        reader.read = () => Promise.resolve({ done: true, value: undefined });
        const release = reader.releaseLock.bind(reader);
        reader.releaseLock = () => {
          release();
          releases++;
          declared.reject(reason);
        };
      });
      const stream = withAbortSignal(fixture.source, undefined, "/input");
      const reader = openBytes(stream);
      try {
        expect(await rejected(reader.read())).toBe(reason);
        expect(fixture.cancels()).toBe(1);
        expect(releases).toBe(1);
        expect(fixture.source.locked).toBe(false);
        await retire(stream);
      } finally {
        declared.resolve();
        fixture.resumed.resolve();
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });
  }

  it("joins successful release-dependent observer work without fabricating a source error", async () => {
    const fixture = held();
    const child = Promise.withResolvers<void>();
    let releases = 0;
    instrumentedReader(fixture.source, (reader) => {
      void reader.closed.catch(() => {});
      const declared = Promise.withResolvers<void>().promise;
      Object.defineProperty(declared, "then", { value: () => child.promise });
      Object.defineProperty(reader, "closed", { get: () => declared });
      reader.read = () => Promise.resolve({ done: true, value: undefined });
      const release = reader.releaseLock.bind(reader);
      reader.releaseLock = () => {
        release();
        releases++;
        child.resolve();
      };
    });
    const stream = withAbortSignal(fixture.source, undefined, "/input");
    const reader = openBytes(stream);
    try {
      expect(await within(reader.read(), "successful released observer completion")).toEqual({
        done: true,
        value: undefined,
      });
      expect(fixture.cancels()).toBe(1);
      expect(releases).toBe(1);
      expect(fixture.source.locked).toBe(false);
      await retire(stream);
    } finally {
      child.resolve();
      fixture.resumed.resolve();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  });
});

/** A method accessor can release and replace a lock before returning the native capability. */
describe("byte method provenance before borrowed getters", () => {
  for (const [index, reason] of reasons.entries()) {
    for (const deletes of [false, true]) {
      for (const reacquires of [false, true]) {
        it(`retains read misuse and actual closed failure after getter release, delete ${deletes}, reacquire ${reacquires}, reason ${index}`, async () => {
          const source = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(reason) });
          const acquire = source.getReader.bind(source);
          let replacement: ReadableStreamDefaultReader<Uint8Array> | undefined;
          let getterCalls = 0, releaseCalls = 0;
          instrumentedReader(source, (reader) => {
            const read = reader.read, release = reader.releaseLock.bind(reader);
            Object.defineProperty(reader, "read", {
              configurable: true,
              get() {
                getterCalls++;
                if (deletes) Reflect.deleteProperty(reader, "read");
                release();
                if (reacquires) {
                  replacement = acquire();
                  void replacement.closed.catch(() => {});
                  expect(source.locked).toBe(true);
                }
                return read;
              },
            });
            reader.releaseLock = () => {
              releaseCalls++;
              release();
            };
          });
          const stream = withAbortSignal(source, undefined, "/input");
          const reader = openBytes(stream);
          try {
            const events = faults(await rejected(reader.read()));
            // Actual native read misuse is separate from the source error
            // already observed by the reader's original closed promise.
            expect(events).toHaveLength(2);
            expect(events[0]).toBeInstanceOf(TypeError);
            expect(events[1]).toBe(reason);
            expect(getterCalls).toBe(1);
            expect(releaseCalls).toBe(1);
            expect(source.locked).toBe(reacquires);
            await retire(stream);
          } finally {
            replacement?.releaseLock();
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          expect(source.locked).toBe(false);
        });
      }
    }
  }

  for (const deletes of [false, true]) {
    for (const reacquires of [false, true]) {
      it(`retains separate closed and cancel misuse after getter release, delete ${deletes}, reacquire ${reacquires}`, async () => {
        const fixture = held();
        const acquire = fixture.source.getReader.bind(fixture.source);
        let replacement: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let getterCalls = 0, releaseCalls = 0;
        let closedFailure: { reason: unknown } | undefined;
        instrumentedReader(fixture.source, (reader) => {
          void reader.closed.then(undefined, (reason: unknown) => {
            closedFailure = { reason };
          });
          const cancel = reader.cancel, release = reader.releaseLock.bind(reader);
          Object.defineProperty(reader, "cancel", {
            configurable: true,
            get() {
              getterCalls++;
              if (deletes) Reflect.deleteProperty(reader, "cancel");
              release();
              if (reacquires) {
                replacement = acquire();
                void replacement.closed.catch(() => {});
                expect(fixture.source.locked).toBe(true);
              }
              return cancel;
            },
          });
          reader.releaseLock = () => {
            releaseCalls++;
            release();
          };
        });
        const stream = withAbortSignal(fixture.source, undefined, "/input");
        try {
          const events = faults(await rejected(stream.cancel()));
          expect(events).toHaveLength(2);
          expect(events[0]).toBeInstanceOf(TypeError);
          expect(closedFailure).toBeDefined();
          expect(events[1]).toBe(closedFailure?.reason);
          expect(events[0]).not.toBe(events[1]);
          expect(getterCalls).toBe(1);
          expect(releaseCalls).toBe(1);
          expect(fixture.cancels()).toBe(0);
          expect(fixture.source.locked).toBe(reacquires);
        } finally {
          replacement?.releaseLock();
          fixture.resumed.resolve();
          await stream.cancel().catch(() => {});
        }
        expect(fixture.source.locked).toBe(false);
      });
    }
  }
});

describe("closed accessor provenance before invocation", () => {
  for (const [index, reason] of reasons.entries()) {
    for (const deletes of [false, true]) {
      it(`keeps unknown closed/read/cancel observations when getter deletes ${deletes}, reason ${index}`, async () => {
        let getterCalls = 0;
        const source = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(reason) });
        instrumentedReader(source, (reader) => {
          const closed = reader.closed;
          void closed.catch(() => {});
          Object.defineProperty(reader, "closed", {
            configurable: true,
            get() {
              getterCalls++;
              if (deletes) Reflect.deleteProperty(reader, "closed");
              return closed;
            },
          });
        });
        const stream = withAbortSignal(source, undefined, "/input");
        const reader = openBytes(stream);
        try {
          expect(faults(await rejected(reader.read()))).toEqual([reason, reason, reason]);
          expect(getterCalls).toBe(1);
          expect(source.locked).toBe(false);
          await retire(stream);
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      });
    }
  }
});

describe("borrowed reader prototype lookup", () => {
  it("does not grant native state from a proxy descriptor hiding a release effect", async () => {
    const fixture = held();
    const native = ReadableStreamDefaultReader.prototype;
    const getter = Object.getOwnPropertyDescriptor(native, "closed")?.get;
    if (getter === undefined) throw Error("Expected a native closed accessor.");
    let closedGets = 0;
    let closedFailure: { reason: unknown } | undefined;
    let acquired: ReadableStreamDefaultReader<Uint8Array> | undefined;
    instrumentedReader(fixture.source, (reader) => {
      acquired = reader;
      void reader.closed.then(undefined, (reason: unknown) => {
        closedFailure = { reason };
      });
      const release = reader.releaseLock.bind(reader);
      Object.setPrototypeOf(
        reader,
        new Proxy(Object.create(native) as object, {
          getOwnPropertyDescriptor(target, name) {
            return name === "closed"
              ? Object.getOwnPropertyDescriptor(native, name)
              : Reflect.getOwnPropertyDescriptor(target, name);
          },
          get(target, name, receiver) {
            if (name === "closed") {
              closedGets++;
              release();
              return Reflect.apply(getter, reader, []);
            }
            return Reflect.get(target, name, receiver);
          },
        }),
      );
      // Retain the native prototype identity in the actual chain. A copied
      // prototype would destroy Deno's WebIDL brand rather than test lookup.
      expect(reader instanceof ReadableStreamDefaultReader).toBe(true);
      const branded = Reflect.apply(getter, reader, []) as Promise<void>;
      void branded.catch(() => {});
    });
    const stream = withAbortSignal(fixture.source, undefined, "/input");
    const reader = openBytes(stream);
    try {
      const events = faults(await rejected(reader.read()));
      expect(events).toHaveLength(3);
      expect(events[0]).toBeInstanceOf(TypeError);
      expect(events[1]).toBeInstanceOf(TypeError);
      expect(closedFailure).toBeDefined();
      expect(events[2]).toBe(closedFailure?.reason);
      expect(events[0]).not.toBe(events[1]);
      expect(events[0]).not.toBe(events[2]);
      expect(events[1]).not.toBe(events[2]);
      expect(closedGets).toBe(1);
      expect(fixture.cancels()).toBe(0);
      expect(fixture.source.locked).toBe(false);
      await retire(stream);
    } finally {
      if (acquired !== undefined) {
        Object.setPrototypeOf(acquired, native);
        acquired.releaseLock();
      }
      fixture.resumed.resolve();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  });
});

describe("monotonic reader delivery eligibility", () => {
  for (const [index, reason] of reasons.entries()) {
    it(`keeps borrowed then getter provenance after it restores native shape, reason ${index}`, async () => {
      const source = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(reason) });
      let gets = 0;
      instrumentedReader(source, (reader) => {
        const closed = reader.closed;
        const then = closed.then;
        Object.defineProperty(closed, "then", {
          configurable: true,
          get() {
            gets++;
            Reflect.deleteProperty(closed, "then");
            return then;
          },
        });
      });
      const stream = withAbortSignal(source, undefined, "/input");
      const reader = openBytes(stream);
      try {
        expect(faults(await rejected(reader.read()))).toEqual([reason, reason, reason]);
        expect(gets).toBe(1);
        expect(source.locked).toBe(false);
        await retire(stream);
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    });

    it(`keeps original publication undelivered after borrowed closed getter releases and is restored, reason ${index}`, async () => {
      const source = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(reason) });
      const original = withAbortSignal(source, undefined, "/original");
      const preparing = original.getReader();
      void preparing.closed.catch(() => {});
      expect(await rejected(preparing.read())).toBe(reason);
      preparing.releaseLock();
      const prototype = ReadableStreamDefaultReader.prototype;
      const getter = Object.getOwnPropertyDescriptor(prototype, "closed")?.get;
      const release = prototype.releaseLock;
      if (getter === undefined) throw Error("Expected a native closed getter.");
      let reader: ReturnType<typeof openBytes> | undefined;
      let gets = 0;
      let closedFailure: { reason: unknown } | undefined;
      let restore: (() => void) | undefined;
      try {
        restore = patch(prototype, "closed", {
          get: function (this: ReadableStreamDefaultReader<Uint8Array>) {
            const before = Reflect.apply(getter, this, []) as Promise<void>;
            void before.catch(() => {});
            gets++;
            Reflect.apply(release, this, []);
            const after = Reflect.apply(getter, this, []) as Promise<void>;
            void after.then(undefined, (reason: unknown) => {
              closedFailure = { reason };
            });
            return after;
          },
        });
        reader = openBytes(original);
        const closed = reader.closed;
        void closed.catch(() => {});
        // Restoration before the public read cannot restore the acquired
        // capability's eligibility invalidated by the earlier borrowed getter.
        restore?.();
        expect(Object.getOwnPropertyDescriptor(prototype, "closed")?.get).toBe(getter);
        const closedFault = await rejected(closed);
        const readFault = await rejected(reader.read());
        expect(closedFailure).toBeDefined();
        expect(closedFault).toBe(closedFailure?.reason);
        expect(readFault).toBeInstanceOf(TypeError);
        expect(readFault).not.toBe(closedFault);
        expect(gets).toBe(1);
        expect(original.locked).toBe(false);
        expect(source.locked).toBe(false);
        expect(await rejected(retire(original))).toBe(reason);
      } finally {
        restore?.();
        expect(Object.getOwnPropertyDescriptor(prototype, "closed")?.get).toBe(getter);
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
    });
  }
});

describe("borrowed method effects cannot restore private delivery", () => {
  for (const [index, reason] of reasons.entries()) {
    for (const lane of ["read", "cancel"] as const) {
      it(`keeps delivery ineligible after borrowed ${lane} releases and native method is restored, reason ${index}`, async () => {
        const source = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(reason) });
        const original = withAbortSignal(source, undefined, "/original");
        const preparing = original.getReader();
        void preparing.closed.catch(() => {});
        expect(await rejected(preparing.read())).toBe(reason);
        preparing.releaseLock();
        const prototype = ReadableStreamDefaultReader.prototype;
        const getter = Object.getOwnPropertyDescriptor(prototype, "closed")?.get;
        const method = prototype[lane], release = prototype.releaseLock;
        if (getter === undefined) throw Error("Expected a native closed getter.");
        const reader = openBytes(original);
        let calls = 0;
        let restore: (() => void) | undefined;
        try {
          restore = patch(prototype, lane, {
            value: function (this: ReadableStreamDefaultReader<Uint8Array>) {
              const before = Reflect.apply(getter, this, []) as Promise<void>;
              void before.catch(() => {});
              calls++;
              Reflect.apply(release, this, []);
              const after = Reflect.apply(getter, this, []) as Promise<void>;
              void after.catch(() => {});
              throw reason;
            },
          });
          expect(await rejected(lane === "read" ? reader.read() : reader.cancel())).toBe(reason);
          restore?.();
          expect(prototype[lane]).toBe(method);
          expect(await rejected(lane === "read" ? reader.read() : reader.cancel())).toBeInstanceOf(TypeError);
          expect(calls).toBe(1);
          expect(original.locked).toBe(false);
          expect(source.locked).toBe(false);
          expect(await rejected(retire(original))).toBe(reason);
        } finally {
          restore?.();
          expect(prototype[lane]).toBe(method);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      });
    }
  }
});

/** Native consumer cancellation is terminal; admitted iterable effects still belong to its cleanup. */
describe("iterable byte result publication", () => {
  for (const [index, reason] of reasons.entries()) {
    for (const boundary of ["next-get", "next-call", "done", "value"] as const) {
      for (const effectFault of [false, true]) {
        for (const returnFault of [false, true]) {
          it(`owns ${boundary} cancellation effects, effect ${effectFault}, return ${returnFault}, reason ${index}`, async () => {
            let cancellation: Promise<void> | undefined;
            let nextCalls = 0, returns = 0, doneGets = 0, valueGets = 0, methodGets = 0;
            const cancel = () => {
              cancellation = reader.cancel(reason);
              void cancellation.catch(() => {});
              if (effectFault) throw reason;
            };
            const result: IteratorResult<Uint8Array> = {
              get done(): false {
                doneGets++;
                if (boundary === "done") cancel();
                return false;
              },
              get value(): Uint8Array {
                valueGets++;
                if (boundary === "value") cancel();
                return new Uint8Array([1, 2]);
              },
            };
            const iterator: AsyncIterator<Uint8Array> = {
              next() {
                nextCalls++;
                if (boundary === "next-call") cancel();
                return Promise.resolve(result);
              },
              return() {
                returns++;
                if (returnFault) throw reason;
                return Promise.resolve({ done: true, value: undefined });
              },
            };
            if (boundary === "next-get") {
              const next = iterator.next;
              Object.defineProperty(iterator, "next", {
                get() {
                  methodGets++;
                  cancel();
                  return next;
                },
              });
            }
            const stream = toByteStream({ [Symbol.asyncIterator]: () => iterator });
            const reader = stream.getReader();
            try {
              expect(await within(reader.read(), "cancelled iterable cannot publish a row")).toMatchObject({
                done: true,
              });
              if (cancellation === undefined) throw Error("Expected cancellation from the admitted borrowed effect.");
              if (effectFault || returnFault) {
                expect(faults(await rejected(cancellation))).toEqual([
                  ...(returnFault ? [reason] : []),
                  ...(effectFault ? [reason] : []),
                ]);
              } else await within(cancellation, "iterable result cancellation cleanup");
              expect(returns).toBe(1);
              expect(nextCalls).toBe(boundary === "next-get" ? 0 : 1);
              expect(methodGets).toBe(boundary === "next-get" ? 1 : 0);
              expect(doneGets).toBe(boundary === "done" || boundary === "value" ? 1 : 0);
              expect(valueGets).toBe(boundary === "value" ? 1 : 0);
              reader.releaseLock();
              expect(stream.locked).toBe(false);
            } finally {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          });
        }
      }
    }

    for (const nextFault of [false, true]) {
      for (const returnFault of [false, true]) {
        it(`joins actual late next outcome after cancellation, next ${nextFault}, return ${returnFault}, reason ${index}`, async () => {
          const opened = Promise.withResolvers<void>();
          const returned = Promise.withResolvers<void>();
          const next = Promise.withResolvers<IteratorResult<Uint8Array>>();
          let returns = 0, nextCalls = 0, doneGets = 0, valueGets = 0;
          const iterator: AsyncIterator<Uint8Array> = {
            next() {
              nextCalls++;
              opened.resolve();
              return next.promise;
            },
            return() {
              returns++;
              returned.resolve();
              if (returnFault) throw reason;
              return Promise.resolve({ done: true, value: undefined });
            },
          };
          const stream = toByteStream({ [Symbol.asyncIterator]: () => iterator });
          const reader = stream.getReader();
          let cancellation: Promise<void> | undefined;
          try {
            const reading = reader.read();
            await within(opened.promise, "actual iterable next admission");
            cancellation = reader.cancel(reason);
            void cancellation.catch(() => {});
            expect(await within(reading, "native cancellation terminates pending read")).toMatchObject({ done: true });
            await within(returned.promise, "iterator return attempted before late next settlement");
            if (nextFault) next.reject(reason);
            else {
              next.resolve({
                get done(): false {
                  doneGets++;
                  return false;
                },
                get value(): Uint8Array {
                  valueGets++;
                  return new Uint8Array([3]);
                },
              });
            }
            if (nextFault || returnFault) {
              expect(faults(await rejected(cancellation))).toEqual([
                ...(returnFault ? [reason] : []),
                ...(nextFault ? [reason] : []),
              ]);
            } else await within(cancellation, "successful late next retirement");
            expect(nextCalls).toBe(1);
            expect(returns).toBe(1);
            expect(doneGets).toBe(0);
            expect(valueGets).toBe(0);
            reader.releaseLock();
            expect(stream.locked).toBe(false);
          } finally {
            next.resolve({ done: true, value: undefined });
            await cancellation?.catch(() => {});
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        });
      }
    }
  }

  it("does not read EOF value or call return after an actually completed iterator", async () => {
    let nextCalls = 0, doneGets = 0, valueGets = 0, returns = 0;
    const iterator: AsyncIterator<Uint8Array> = {
      next() {
        nextCalls++;
        return Promise.resolve({
          get done(): true {
            doneGets++;
            return true;
          },
          get value(): undefined {
            valueGets++;
            throw Error("An EOF value is not an admitted byte field.");
          },
        });
      },
      return() {
        returns++;
        throw Error("A completed iterator needs no early-exit return.");
      },
    };
    const stream = toByteStream({ [Symbol.asyncIterator]: () => iterator });
    const reader = stream.getReader();
    try {
      expect(await within(reader.read(), "actual iterator EOF")).toMatchObject({ done: true });
      await reader.cancel();
      expect(nextCalls).toBe(1);
      expect(doneGets).toBe(1);
      expect(valueGets).toBe(0);
      expect(returns).toBe(0);
      reader.releaseLock();
      expect(stream.locked).toBe(false);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  });

  it("returns a never-pulled iterator exactly once on native consumer cancellation", async () => {
    let nextCalls = 0, returns = 0;
    const iterator: AsyncIterator<Uint8Array> = {
      next() {
        nextCalls++;
        return Promise.resolve({ done: false, value: new Uint8Array([1]) });
      },
      return() {
        returns++;
        return Promise.resolve({ done: true, value: undefined });
      },
    };
    const stream = toByteStream({ [Symbol.asyncIterator]: () => iterator });
    await within(stream.cancel(), "never-pulled iterable cancellation");
    await stream.cancel();
    expect(nextCalls).toBe(0);
    expect(returns).toBe(1);
    expect(stream.locked).toBe(false);
  });
});
