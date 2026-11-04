import { expect } from "@playwright/test";
import { test } from "./profile.ts";

// These controls use genuine iframe constructors. No prototype substitution
// stands in for another realm, and receipts precede rescue/iframe teardown.
for (const realm of ["local", "foreign"] as const) {
  for (const action of ["eof", "error", "abort", "refusal"] as const) {
    test(`byte ownership / ${realm} native stream / ${action}`, async ({ ready: page }) => {
      const rows = await page.evaluate(async ({ realm, action }) => {
        const moduleUrl = new URL("/src/stream.ts", location.href).href;
        const { openBytes, withAbortSignal } = await import(moduleUrl) as typeof import("../../src/stream.ts");
        const frame = document.createElement("iframe");
        let Constructor = ReadableStream;
        try {
          if (realm === "foreign") {
            const loaded = Promise.withResolvers<void>();
            frame.addEventListener("load", () => loaded.resolve(), { once: true });
            frame.src = "about:blank";
            document.body.append(frame);
            await loaded.promise;
            const target = frame.contentWindow as (Window & typeof globalThis) | null;
            if (!target) throw new Error("Owned iframe has no accessible native realm.");
            Constructor = target.ReadableStream;
          }
          const rows = [];
          for (const reason of [undefined, null, new Error("Actual source fault.")]) {
            const entered = Promise.withResolvers<void>(), held = Promise.withResolvers<void>();
            const control = new AbortController();
            let cancels = 0, delivered = false;
            let reads = 0, cancellations = 0;
            let readFailure: { reason: unknown } | undefined;
            let cancelFailure: { reason: unknown } | undefined;
            let closedFailure: { reason: unknown } | undefined;
            const source = new Constructor<Uint8Array>({
              start(controller) {
                if (action === "error") controller.error(reason);
              },
              pull(controller) {
                entered.resolve();
                if (action === "abort") return held.promise;
                if (!delivered) {
                  delivered = true;
                  controller.enqueue(new Uint8Array([17, 31]));
                  controller.close();
                }
              },
              cancel() {
                cancels++;
              },
            }, { highWaterMark: 0 });
            // Foreign methods already lack local intrinsic correlation. Record
            // actual native outcomes to distinguish three observations of one
            // producer error from three independent physical failures.
            if (realm === "foreign" && action === "error") {
              const acquire = source.getReader.bind(source);
              Object.defineProperty(source, "getReader", {
                value: () => {
                  const reader = acquire();
                  void reader.closed.then(undefined, (failure: unknown) => {
                    closedFailure = { reason: failure };
                  });
                  const read = reader.read.bind(reader), cancel = reader.cancel.bind(reader);
                  reader.read = async () => {
                    reads++;
                    try {
                      return await read();
                    } catch (failure) {
                      readFailure = { reason: failure };
                      throw failure;
                    }
                  };
                  reader.cancel = async (value) => {
                    cancellations++;
                    try {
                      await cancel(value);
                    } catch (failure) {
                      cancelFailure = { reason: failure };
                      throw failure;
                    }
                  };
                  return reader;
                },
              });
            }
            if (action === "refusal") {
              const getReader = source.getReader.bind(source);
              Object.defineProperty(source, "getReader", {
                value: () => {
                  const reader = getReader();
                  reader.read = () => {
                    throw reason;
                  };
                  return reader;
                },
              });
            }
            const reader = openBytes(withAbortSignal(source, control.signal, "/input", "write"));
            let outcome: { ok: true; value: ReadableStreamReadResult<Uint8Array> } | { ok: false; reason: unknown };
            try {
              const pending = reader.read().then(
                (value) => ({ ok: true as const, value }),
                (reason) => ({ ok: false as const, reason }),
              );
              if (action === "abort") {
                await entered.promise;
                control.abort(null);
              }
              outcome = await pending;
              const events = (value: unknown): unknown[] =>
                value instanceof AggregateError ? value.errors.flatMap(events) : [value];
              const failures = outcome.ok ? [] : events(outcome.reason);
              const bytes = outcome.ok && !outcome.value.done ? [...outcome.value.value] : [];
              const eof = action === "eof" ? (await reader.read()).done : false;
              rows.push({
                foreign: !(source instanceof ReadableStream),
                ok: outcome.ok,
                bytes,
                eof,
                locked: source.locked,
                cancels,
                nativeObservations: realm === "foreign" && action === "error"
                  ? {
                    reads,
                    cancellations,
                    read: readFailure !== undefined && readFailure.reason === reason,
                    cancel: cancelFailure !== undefined && cancelFailure.reason === reason,
                    closed: closedFailure !== undefined && closedFailure.reason === reason,
                  }
                  : undefined,
                errors: failures.length,
                exact: action === "abort"
                  ? failures.length === 1 && failures[0] instanceof Error && "cause" in failures[0] &&
                    failures[0].cause === null
                  : failures.every((value) => value === reason),
              });
            } finally {
              held.resolve();
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            }
          }
          return rows;
        } finally {
          frame.remove();
        }
      }, { realm, action });
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.foreign).toBe(realm === "foreign");
        expect(row.locked).toBe(false);
        expect(row.cancels).toBe(action === "abort" || action === "refusal" ? 1 : 0);
        expect(row.ok).toBe(action === "eof");
        expect(row.bytes).toEqual(action === "eof" ? [17, 31] : []);
        expect(row.eof).toBe(action === "eof");
        expect(row.errors).toBe(action === "eof" ? 0 : action === "error" && realm === "foreign" ? 3 : 1);
        expect(row.exact).toBe(true);
        if (realm === "foreign" && action === "error") {
          expect(row.nativeObservations).toEqual({
            reads: 1,
            cancellations: 1,
            read: true,
            cancel: true,
            closed: true,
          });
        }
      }
    });
  }
}
