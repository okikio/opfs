import { close, withReleases } from "../close.ts";

/** A test-owned operational alarm; controls inject expiry without depending on wall-clock speed. */
export type AlarmType = (phase: "admission" | "cancellation", expire: () => void) => () => void;

/** Each phase gets a finite operational budget, not a mounted-filesystem latency assertion. */
function alarm(_phase: "admission" | "cancellation", expire: () => void): () => void {
  const timer = setTimeout(expire, 60_000);
  return () => clearTimeout(timer);
}

/** The normalized facade failure must belong to this caller's actual cancellation. */
function aborted(reason: unknown, signal: AbortSignal): boolean {
  return typeof reason === "object" && reason !== null &&
    Reflect.get(reason, "code") === "aborted" && Reflect.get(reason, "cause") === signal.reason;
}

/**
 * Owns one stalled write from producer admission through actual retirement.
 *
 * The caller borrows its filesystem and supplies only the write operation. Both
 * phase alarms refuse the scenario; neither supplies EOF. Every exit aborts and
 * awaits the pending write before the caller may run another case, reuse the
 * path, or close its filesystem. A backend that never settles after abort still
 * requires the outer runner to terminate it; a timeout is not invented cleanup.
 * Independent operation and alarm-retirement failures survive the primary fault.
 */
export async function stalled(
  write: (source: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<unknown>,
  start: AlarmType = alarm,
): Promise<void> {
  await withReleases(async (releases) => {
    const controller = new AbortController();
    const admitted = Promise.withResolvers<void>();
    let canceled = 0;
    const source = new ReadableStream<Uint8Array>({
      pull() {
        admitted.resolve();
        return new Promise<void>(() => {});
      },
      cancel() {
        canceled++;
      },
    }, { highWaterMark: 0 });
    // Register the source before the deferred writer can acquire its reader.
    releases.push(async () => {
      if (source.locked) throw new Error("Write settled with an owned source reader still locked.");
      await source.cancel();
    });
    const pending = Promise.resolve().then(() => write(source, controller.signal));
    const outcome = pending.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    let inspected = false;
    releases.push(async () => {
      controller.abort(new Error("Stalled scenario retirement."));
      const result = await outcome;
      if (inspected) return;
      if (result.status === "fulfilled") throw new Error("Write resolved after scenario refusal.");
      if (!aborted(result.reason, controller.signal)) throw result.reason;
    });

    const admission = await bound(
      "admission",
      Promise.race([
        admitted.promise.then(() => ({ status: "admitted" as const })),
        outcome,
      ]),
    );
    if (admission.status !== "admitted") {
      inspected = true;
      if (admission.status === "rejected") throw admission.reason;
      throw new Error("Write resolved before its stalled producer was admitted.");
    }
    controller.abort(new Error("Caller canceled the admitted producer."));
    const result = await bound("cancellation", outcome);
    inspected = true;
    if (result.status === "fulfilled") throw new Error("Aborted write resolved.");
    if (!aborted(result.reason, controller.signal)) throw result.reason;
    if (source.locked || canceled !== 1) {
      throw new Error("Stalled write did not retire its source exactly once.", {
        cause: { locked: source.locked, canceled },
      });
    }

    async function bound<Value>(phase: "admission" | "cancellation", operation: Promise<Value>): Promise<Value> {
      return await withReleases(async (alarms) => {
        const expired = Promise.withResolvers<never>();
        void expired.promise.catch(() => {});
        alarms.push(start(phase, () => {
          const reason = new Error(`Stalled write exceeded its ${phase} operational deadline.`);
          controller.abort(reason);
          expired.reject(reason);
        }));
        return await Promise.race([operation, expired.promise]);
      });
    }
  });
}

/** Settles every started case operation before throwing its independent failures in authored order. */
export async function drain(operations: readonly Promise<unknown>[]): Promise<void> {
  const outcomes = await Promise.allSettled(operations);
  await close([], outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []));
}
