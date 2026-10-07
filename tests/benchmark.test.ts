import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { finish } from "../bench/result.ts";
import { validateLifecycle, validateMitata } from "../bench/validate.ts";
import { close, withReleases } from "./close.ts";

/** Artificial nanoseconds exercise the native format contract without running a benchmark. */
function native() {
  return {
    layout: [{ name: "format fixture" }],
    benchmarks: [{
      alias: "read",
      group: 0,
      kind: "static",
      runs: [{
        name: "read",
        stats: {
          kind: "fn",
          ticks: 12,
          samples: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
          min: 10,
          max: 21,
          avg: 15.5,
          p25: 12,
          p50: 15,
          p75: 18,
          p99: 20,
          p999: 20,
        },
      }],
    }],
  };
}
/** This shortened declared workload proves validation follows cadence rather than a fixed 121-cycle run. */
function lifecycle() {
  const memory = { rss: 100, heapTotal: 80, heapUsed: 60, external: 20, arrayBuffers: 10 };
  return {
    platform: "node native files",
    chunkBytes: 8,
    workload: { cycles: 3, observeEvery: 2, transferBytes: [16] },
    samples: [0, 2, 3].map((cycle) => ({ cycle, memory: { ...memory }, resources: ["PipeWrap"] })),
    cancellationMs: [0.1, 0.2, 0.3],
    transfers: [{ bytes: 16, elapsedMs: 1, peak: { ...memory }, facadeBufferedBytes: 0 }],
  };
}

describe("benchmark evidence contracts", () => {
  it("releases acquired fixture resources when later setup rejects with undefined", async () => {
    const events: string[] = [];
    const cleanup = new Error("database close failed");
    const failure = await withReleases(async (releases) => {
      releases.push(() => {
        events.push("directory");
      });
      releases.push(() => {
        events.push("database");
        throw cleanup;
      });
      throw undefined;
    }).then(() => undefined, (error: unknown) => error);
    expect(events).toEqual(["database", "directory"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([undefined, cleanup]);
  });
  it("awaits every browser fixture release after a drain failure and retains its primary", async () => {
    const drain = new Error("drain failed");
    const connection = new Error("connection close failed");
    const events: string[] = [];
    const failure = await close([
      () => {
        events.push("drain");
        throw drain;
      },
      async () => {
        await Promise.resolve();
        events.push("close");
        throw connection;
      },
      () => {
        events.push("delete");
      },
    ], [undefined]).then(() => undefined, (error: unknown) => error);
    expect(events).toEqual(["drain", "close", "delete"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([undefined, drain, connection]);
    expect((failure as AggregateError).cause).toBe(undefined);
  });
  it("retains a browser fixture primary by identity and awaits successful releases", async () => {
    const primary = new Error("body failed");
    let released = false;
    const failure = await close([async () => {
      await Promise.resolve();
      released = true;
    }], [primary]).then(() => undefined, (error: unknown) => error);
    expect(released).toBe(true);
    expect(failure).toBe(primary);
  });
  it("accepts the native format with finite complete samples and statistics", () => {
    expect(() => validateMitata(native())).not.toThrow();
    const zero = native();
    zero.benchmarks[0]!.runs[0]!.stats = {
      ...zero.benchmarks[0]!.runs[0]!.stats,
      samples: [0, 0, 0, 10, 10, 10, 10, 10, 10, 10, 10, 10],
      min: 0,
      max: 10,
      avg: 7.5,
      p25: 0,
      p50: 10,
      p75: 10,
      p99: 10,
      p999: 10,
    };
    expect(() => validateMitata(zero)).not.toThrow();
    for (
      const resources of [
        { heap: { _: 2, total: 1, min: 0.25, max: 0.75, avg: 0.5 } },
        { heap: { _: 0, total: 0, min: null, max: null, avg: null } },
        { gc: { total: 1, min: 0, max: 1, avg: 0.5 } },
        { heap: { _: 1, total: 0, min: 0, max: 0, avg: 0 }, gc: { total: 0, min: 0, max: 0, avg: 0 } },
      ]
    ) {
      expect(() =>
        validateMitata({ benchmarks: [{ runs: [{ stats: { ...zero.benchmarks[0]!.runs[0]!.stats, ...resources } }] }] })
      ).not.toThrow();
    }
  });
  it("rejects absent, empty, failed, nonfinite and incomplete native measurements", () => {
    const valid = native(), run = valid.benchmarks[0]!.runs[0]!;
    const reports: unknown[] = [null, {}, { benchmarks: [] }, { benchmarks: [{ runs: [] }] }];
    for (
      const stats of [
        {},
        { ...run.stats, samples: [] },
        { ...run.stats, samples: [NaN] },
        { ...run.stats, samples: [-1] },
        { ...run.stats, p50: Infinity },
        { ...run.stats, p99: NaN },
        { ...run.stats, min: 12 },
        { ...run.stats, max: 11 },
        { ...run.stats, p50: 0 },
        { ...run.stats, avg: NaN },
        { ...run.stats, avg: 30 },
        { ...run.stats, p25: Infinity },
        { ...run.stats, p75: 10 },
        { ...run.stats, p999: 13 },
      ]
    ) reports.push({ benchmarks: [{ runs: [{ stats }] }] });
    for (
      const resources of [
        { heap: {} },
        { gc: {} },
        { heap: null },
        { gc: null },
        { heap: { _: 0, total: 0, min: 0, max: 0, avg: 0 } },
        { heap: { _: 0, total: 1, min: null, max: null, avg: null } },
        { heap: { _: 1, total: 1, min: null, max: null, avg: null } },
        { heap: { _: 1.5, total: 1, min: 0, max: 1, avg: 0.5 } },
        { heap: { _: Infinity, total: 1, min: 0, max: 1, avg: 0.5 } },
        { heap: { _: 1, total: Infinity, min: 0, max: 1, avg: 0.5 } },
        { heap: { _: 1, total: 1, min: 2, max: 1, avg: 1 } },
        { heap: { _: 1, total: 1, min: 0, max: 1, avg: 2 } },
        { heap: { _: 2, total: 100, min: 0, max: 1, avg: 0.5 } },
        { gc: { total: 1, min: 0, max: 1 } },
        { gc: { total: 1, min: 0, max: 1, avg: NaN } },
        { gc: { total: 1, min: -1, max: 1, avg: 0 } },
        { gc: { total: 0.5, min: 0, max: 1, avg: 0.5 } },
        { gc: { total: 1, min: 0, max: 1, avg: 2 } },
      ]
    ) reports.push({ benchmarks: [{ runs: [{ stats: { ...run.stats, ...resources } }] }] });
    const { p99: _p99, ...incomplete } = run.stats;
    reports.push({ benchmarks: [{ runs: [{ stats: incomplete }] }] });
    reports.push({ benchmarks: [{ runs: [{ ...run, error: "oracle failed" }] }] });
    reports.push({ benchmarks: [valid.benchmarks[0], { runs: [{ ...run, error: "later run failed" }] }] });
    for (const value of reports) expect(() => validateMitata(value)).toThrow();
  });
  it("accepts every declared lifecycle cycle and transfer with finite resource observations", () => {
    expect(() => validateLifecycle(lifecycle())).not.toThrow();
  });
  it("rejects missing cycles, cadence, transfer identity, or finite memory observations", () => {
    const incomplete = lifecycle();
    incomplete.samples.pop();
    const cancelled = lifecycle();
    cancelled.cancellationMs.pop();
    const cadence = lifecycle();
    cadence.workload.observeEvery = 0;
    const cycle = lifecycle();
    cycle.samples[1]!.cycle = 1;
    const transfer = lifecycle();
    transfer.transfers[0]!.bytes = 15;
    const memory = lifecycle();
    memory.samples[0]!.memory.external = Infinity;
    const peak = lifecycle();
    peak.transfers[0]!.peak.heapUsed = NaN;
    const time = lifecycle();
    time.transfers[0]!.elapsedMs = 0;
    const infinite = lifecycle();
    infinite.chunkBytes = Infinity;
    const fractional = lifecycle();
    fractional.chunkBytes = 1.5;
    const transferSize = lifecycle();
    transferSize.workload.transferBytes[0] = 1.5;
    transferSize.transfers[0]!.bytes = 1.5;
    for (
      const value of [
        incomplete,
        cancelled,
        cadence,
        cycle,
        transfer,
        memory,
        peak,
        time,
        infinite,
        fractional,
        transferSize,
      ]
    ) {
      expect(() => validateLifecycle(value)).toThrow();
    }
  });
  it("attempts every owned release and preserves undefined beside independent cleanup failures", async () => {
    const events: string[] = [];
    const cleanup = new Error("close failed");
    let failure: unknown;
    try {
      await finish([
        () => {
          events.push("first");
        },
        () => {
          events.push("second");
          throw cleanup;
        },
        () => {
          events.push("third");
        },
      ], [undefined]);
    } catch (error) {
      failure = error;
    }
    expect(events).toEqual(["third", "second", "first"]);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Missing aggregate cleanup failure.");
    expect(failure.errors).toEqual([undefined, cleanup]);
  });
});
