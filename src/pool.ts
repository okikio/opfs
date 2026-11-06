import { aggregate, close } from "./close.ts";

/** An actual settled invocation, with null/undefined rejection kept distinct. */
type OutcomeType<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly reason: unknown };

/** Observe both reactions immediately; admitted work never has a detached rejection. */
function capture<Value>(action: () => Value | PromiseLike<Value>): Promise<OutcomeType<Value>> {
  return Promise.resolve().then(action).then(
    (value) => ({ ok: true, value }),
    (reason: unknown) => ({ ok: false, reason }),
  );
}

/**
 * Maps bounded input in source order and joins every admitted operation.
 *
 * Completed results awaiting their turn count against the admission bound. One
 * input next can be pending while mapper calls run; an actual mapper failure
 * stops admission and interrupts that input before joining the admitted calls.
 * The interrupt capability belongs to the input owner and must not abort those
 * calls. Production native byte inputs provide it. Generic async iterators whose
 * next can stall must provide it too: return() alone cannot interrupt a queued
 * next, and this function does not claim that an arbitrary iterator is stoppable.
 *
 * Producer failures remain exact when sole. Mapper-only failures remain in an
 * operation-owned AggregateError. Independent producer, mapper and input cleanup
 * failures are retained without recognizing error names, classes or messages as
 * authority. A borrowed AggregateError thrown by a mapper stays one nested reason.
 * Return/throw starts input interruption outside the native generator's queue.
 * The first terminal request owns shutdown; concurrent terminal callers join
 * its physical outcome without rewriting that owner. Each return awaits its
 * own value and each throw retains its own reason. After the joined terminal
 * outcome settles, return follows the completed native iterator protocol rather
 * than replaying an already delivered operation failure. That protocol completion
 * does not assert that the earlier operation succeeded.
 */
export function map<Input, Output>(
  concurrency: number,
  source: Iterable<Input> | AsyncIterable<Input>,
  operation: (input: Input) => Promise<Output>,
  options: { readonly interrupt?: () => void | PromiseLike<void> } = {},
): AsyncGenerator<Output> {
  let consumerStopped = false;
  type TerminalType = { readonly kind: "return" } | {
    readonly kind: "throw";
    readonly reason: unknown;
    delivered: boolean;
  };
  let terminal: TerminalType | undefined;
  let stopInput: (() => void) | undefined;
  const run = async function* (): AsyncGenerator<Output> {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError("Pool concurrency must be a positive integer.");
    }
    const iterator = Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
    const tasks: Array<Promise<OutcomeType<Output>>> = [];
    const stopped = { stop: true } as const;
    let mapperFailed = false;
    let wake: (() => void) | undefined;
    // One active input/result wait avoids accumulating reactions on a never-
    // settled global failure promise as a large successful input is consumed.
    const wait = <Value>(pending: Promise<OutcomeType<Value>>): Promise<OutcomeType<Value> | typeof stopped> =>
      new Promise((resolve) => {
        if (mapperFailed || consumerStopped) {
          resolve(stopped);
          return;
        }
        let settled = false;
        const stop = () => {
          if (settled) return;
          settled = true;
          if (wake === stop) wake = undefined;
          resolve(stopped);
        };
        wake = stop;
        void pending.then((result) => {
          if (settled) return;
          settled = true;
          if (wake === stop) wake = undefined;
          resolve(result);
        });
      });
    let inputDone = false;
    let finished = false;
    let pending: Promise<OutcomeType<IteratorResult<Input>>> | undefined;
    let inputFailure: { readonly reason: unknown } | undefined;
    let external: { readonly reason: unknown } | undefined;

    let stopping: Promise<OutcomeType<void | undefined>> | undefined;
    const beginStop = () =>
      stopping ??= capture(() => {
        if (!finished) return options.interrupt?.();
      });
    stopInput = () => {
      wake?.();
      void beginStop();
    };

    try {
      while (true) {
        if (mapperFailed || consumerStopped) break;
        if (!inputDone && tasks.length < concurrency) {
          pending = capture(() => iterator.next());
          const result = await wait(pending);
          if ("stop" in result) break;
          pending = undefined;
          if (!result.ok) {
            inputFailure = { reason: result.reason };
            break;
          }
          if (result.value.done) {
            inputDone = true;
            continue;
          }
          const input = result.value.value;
          const task = capture(() => operation(input)).then((outcome) => {
            if (!outcome.ok) {
              mapperFailed = true;
              wake?.();
            }
            return outcome;
          });
          tasks.push(task);
          continue;
        }
        if (tasks.length === 0) {
          finished = true;
          break;
        }
        const next = tasks[0];
        if (next === undefined) throw new Error("The admitted mapping queue is empty.");
        const result = await wait(next);
        if ("stop" in result || !result.ok) break;
        tasks.shift();
        yield result.value;
      }
    } catch (reason) {
      external = { reason };
      throw reason;
    } finally {
      // All reactions are already owned. Stop only input acquisition, then join
      // its pending next and all admitted mappers without aborting those requests.
      const stopping = beginStop();
      const [stop, input, mapped] = await Promise.all([
        stopping,
        pending,
        Promise.all(tasks),
      ]);
      if (input !== undefined && !input.ok) inputFailure = { reason: input.reason };
      const mapperReasons = mapped.flatMap((outcome) => outcome.ok ? [] : [outcome.reason]);
      const primary: unknown[] = [];
      if (terminal?.kind === "throw") {
        terminal.delivered = true;
        primary.push(terminal.reason);
      }
      if (external !== undefined) primary.push(external.reason);
      if (inputFailure !== undefined) {
        primary.push(inputFailure.reason, ...mapperReasons);
      } else if (mapperReasons.length > 0) {
        primary.push(aggregate(mapperReasons, "Admitted provider mappings failed."));
      }
      if (!stop.ok) primary.push(stop.reason);
      await close([
        async () => {
          // An explicit input owner also has a lock to release after normal EOF.
          if (options.interrupt !== undefined || !inputDone) await iterator.return?.();
        },
      ], primary);
    }
  };
  const output = run();
  const nativeNext = output.next.bind(output);
  const nativeReturn = output.return.bind(output);
  const nativeThrow = output.throw.bind(output);
  const pending = new Set<Promise<OutcomeType<IteratorResult<Output>>>>();
  let completed = false;
  let shutdown: Promise<OutcomeType<IteratorResult<Output>>> | undefined;
  let shutdownSettled = false;
  output.next = (...args) => {
    const next = nativeNext(...args);
    const observed = next.then(
      (value): OutcomeType<IteratorResult<Output>> => {
        const result = { ok: true, value } as const;
        pending.delete(observed);
        if (value.done) completed = true;
        return result;
      },
      (reason: unknown): OutcomeType<IteratorResult<Output>> => {
        const result = { ok: false, reason } as const;
        pending.delete(observed);
        completed = true;
        return result;
      },
    );
    pending.add(observed);
    return next;
  };
  const finish = async (
    value: Parameters<typeof nativeReturn>[0],
    request: TerminalType,
  ): Promise<IteratorResult<Output>> => {
    // Observe a supplied return promise immediately, even while native work is
    // pending. Native return Await failure is a fresh caller event, not evidence
    // that an earlier physical shutdown failed again.
    const argument = request.kind === "return" ? capture(() => value) : undefined;
    if (shutdownSettled || (completed && shutdown === undefined)) {
      if (request.kind === "throw") throw request.reason;
      const returned = await argument;
      if (returned === undefined) throw new Error("Return value observation is missing.");
      if (!returned.ok) throw returned.reason;
      return { done: true, value: returned.value };
    }
    if (shutdown === undefined) {
      // Publish the active owner before any effect can reenter this entrypoint.
      const owner = Promise.withResolvers<OutcomeType<IteratorResult<Output>>>();
      shutdown = owner.promise;
      terminal = request;
      consumerStopped = true;
      const acquiring = [...pending];
      stopInput?.();
      const closing = capture(async () => {
        if (request.kind === "throw") return await nativeReturn(undefined);
        const returned = await argument;
        if (returned === undefined) throw new Error("Return value observation is missing.");
        // Rejected return Await resumes a suspended native generator by throw,
        // so its finally still joins physical work before reporting this event.
        return await (returned.ok ? nativeReturn(returned.value) : nativeThrow(returned.reason));
      });
      const observed = capture(async () => {
        const [acquired, ended] = await Promise.all([Promise.all(acquiring), closing]);
        const failures: unknown[] = [];
        for (const result of acquired) if (!result.ok) failures.push(result.reason);
        if (!ended.ok) failures.push(ended.reason);
        if (terminal?.kind === "throw" && !terminal.delivered) {
          terminal.delivered = true;
          failures.push(terminal.reason);
        }
        await close([], failures);
        if (!ended.ok) throw ended.reason;
        return ended.value;
      });
      void observed.then((outcome) => {
        // Mark protocol completion before delivering the cached physical result.
        // A consumer closing an already-failed next must not replay that failure.
        shutdownSettled = true;
        owner.resolve(outcome);
      });
    }
    const closed = await shutdown;
    if (request !== terminal) {
      if (request.kind === "throw") {
        await close([], [...(closed.ok ? [] : [closed.reason]), request.reason]);
      } else {
        const returned = await argument;
        if (returned === undefined) throw new Error("Return value observation is missing.");
        await close([], [...(closed.ok ? [] : [closed.reason]), ...(returned.ok ? [] : [returned.reason])]);
        if (!returned.ok) throw returned.reason;
        return { done: true, value: returned.value };
      }
    }
    if (!closed.ok) throw closed.reason;
    return closed.value;
  };
  output.return = (value) => finish(value, { kind: "return" });
  output.throw = (reason) => finish(undefined, { kind: "throw", reason, delivered: false });
  return output;
}
