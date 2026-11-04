import { describe, it } from "node:test";
import { Buffer } from "node:buffer";
import { expect } from "@std/expect";
import { expectBytes, finish } from "../bench/result.ts";
import { validateLifecycle, validateMitata } from "../bench/validate.ts";
import { close, withReleases } from "./close.ts";
import { inputs, openInputGuard, verifyInputs } from "../bench/input.ts";
import type { InputFilesType, InputKindType, InputReceiptType } from "../bench/input.ts";
import { relative, resolve } from "node:path";

describe("Exact benchmark byte oracles", () => {
  it("accepts byte-equivalent buffers, subclasses and offset views without comparing prototypes", () => {
    const expected = Uint8Array.of(0, 255, 17, 42, 128);
    class Bytes extends Uint8Array {}
    const backing = Uint8Array.of(99, ...expected, 77);
    for (const actual of [Buffer.from(expected), new Bytes(expected), backing.subarray(1, 6)]) {
      expect(() => expectBytes(actual, expected, "independent view")).not.toThrow();
    }
    expect(() => expectBytes(new Uint8Array(), new Uint8Array(), "empty")).not.toThrow();
  });

  it("rejects corruption at every offset and a large tail", () => {
    const expected = Uint8Array.from({ length: 256 }, (_, offset) => offset);
    for (let offset = 0; offset < expected.length; offset++) {
      const actual = expected.slice();
      actual[offset] = actual[offset]! ^ 1;
      expect(() => expectBytes(actual, expected, "corrupt byte")).toThrow();
    }
    const tail = new Uint8Array(64 * 1024);
    tail[tail.length - 1] = 1;
    expect(() => expectBytes(tail, new Uint8Array(tail.length), "last byte")).toThrow();
  });

  for (const direction of ["shorter", "longer"] as const) {
    it(`rejects a ${direction} visible view with otherwise exact prefix bytes`, () => {
      const expected = Uint8Array.from({ length: 256 }, (_, offset) => offset);
      const actual = direction === "shorter" ? expected.subarray(0, 255) : Uint8Array.of(...expected, 99);
      let failure: unknown;
      try {
        expectBytes(actual, expected, "different length");
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof Error)) throw new Error("Missing length failure.");
      expect(failure.cause).toEqual({ actualBytes: actual.byteLength, expectedBytes: expected.byteLength });
    });
  }

  it("retains bounded scalar diagnostics when a multi-megabyte result is wrong", () => {
    const expected = new Uint8Array(2 * 1024 * 1024);
    const actual = expected.slice();
    actual[actual.length - 1] = 255;
    let failure: unknown;
    try {
      expectBytes(actual, expected, "large result");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Missing byte failure.");
    expect(failure.message.length).toBeLessThan(1024);
    expect(failure.cause).toEqual({ offset: actual.length - 1, actual: 255, expected: 0 });
    expect(JSON.stringify(failure.cause).length).toBeLessThan(1024);
  });
});

/** An owned in-memory tree exposes exact reads; controls require no native filesystem permissions. */
function catalog() {
  const root = resolve("benchmark-input-control");
  const bodies = new Map<string, Uint8Array>();
  const directories = new Set(["", "src", "bench", "tests", ".mise", ".mise/tasks"]);
  const links = new Set<string>();
  const reads: string[] = [];
  const name = (path: string) => relative(root, path).replaceAll("\\", "/");
  const set = (path: string, text: string) => {
    bodies.set(path, new TextEncoder().encode(text));
    const pieces = path.split("/");
    for (let index = 1; index < pieces.length; index++) directories.add(pieces.slice(0, index).join("/"));
  };
  for (const path of ["mod.ts", "deno.json", "deno.lock", "package.json"]) set(path, `input:${path}`);
  for (
    const path of [
      "src/storage.ts",
      "bench/program.ts",
      "bench/browser/opfs.spec.ts",
      "tests/gate.ts",
      "tests/close.ts",
      "tests/browser/profile.ts",
      "tests/browser/fixtures/index.html",
      "tests/provider/fixture.ts",
      "tests/upstream/provenance.json",
      "tests/upstream/original/source.test.ts.txt",
      ".mise/tasks/bench-report",
      ".mise/tasks/test-filesystem-clients",
    ]
  ) set(path, `input:${path}`);
  const kind = (path: string): InputKindType => {
    if (links.has(path)) return "link";
    if (directories.has(path)) return "directory";
    if (bodies.has(path)) return "file";
    throw new Error(`Missing input: ${path}`);
  };
  const files: InputFilesType = {
    kind: (path) => Promise.resolve(kind(name(path))),
    entries: (path) => {
      const prefix = name(path) ? `${name(path)}/` : "";
      const children = [...new Set([...directories, ...bodies.keys(), ...links])]
        .filter((value) => value.startsWith(prefix) && value !== name(path))
        .map((value) => value.slice(prefix.length)).filter((value) => !value.includes("/"));
      return Promise.resolve(children.map((value) => ({ name: value, kind: kind(`${prefix}${value}`) })));
    },
    read: (path) => {
      const key = name(path);
      reads.push(key);
      const value = bodies.get(key);
      if (!value || kind(key) !== "file") throw new Error(`Not a regular input: ${key}`);
      return Promise.resolve(value.slice());
    },
  };
  return { root, files, set, bodies, directories, links, reads };
}

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
  it("invalidates every executed support and provenance class, including added or removed inputs", async () => {
    for (
      const path of [
        "bench/browser/opfs.spec.ts",
        "tests/gate.ts",
        "tests/close.ts",
        "tests/browser/profile.ts",
        "tests/provider/fixture.ts",
        "tests/upstream/provenance.json",
        "tests/upstream/original/source.test.ts.txt",
        ".mise/tasks/bench-report",
      ]
    ) {
      const tree = catalog();
      const before = await inputs(tree.root, tree.files);
      expect(Object.hasOwn(before, path)).toBe(true);
      tree.set(path, "changed independently of benchmark output");
      const after = await inputs(tree.root, tree.files);
      expect(() => verifyInputs(before, after)).toThrow("source inputs changed");
    }
    const tree = catalog(), before = await inputs(tree.root, tree.files);
    tree.set("tests/nested/new.ts", "new support");
    expect(() => verifyInputs(before, {})).toThrow();
    expect(() => verifyInputs(before, { ...before })).not.toThrow();
    const added = await inputs(tree.root, tree.files);
    expect(() => verifyInputs(before, added)).toThrow();
    tree.bodies.delete("tests/close.ts");
    const removed = await inputs(tree.root, tree.files);
    expect(() => verifyInputs(added, removed)).toThrow();
  });
  it("excludes test definitions, nested outputs, dependencies and link targets before reading", async () => {
    const tree = catalog(), before = await inputs(tree.root, tree.files);
    for (const directory of ["node_modules", ".tmp", ".git", ".release", "reports", "output", "test-results"]) {
      tree.set(`bench/nested/${directory}/unrelated.ts`, "not a measured input");
    }
    for (const path of ["tests/unrelated.test.ts", "tests/browser/unrelated.spec.ts", "src/.DS_Store"]) {
      tree.set(path, "unrelated");
    }
    tree.links.add("bench/linked-module.ts");
    tree.links.add("tests/linked-directory");
    const after = await inputs(tree.root, tree.files);
    expect(() => verifyInputs(before, after)).not.toThrow();
    expect(tree.reads.some((path) => path.includes("node_modules") || path.includes("linked-"))).toBe(false);
    expect(Object.hasOwn(after, "tests/upstream/original/source.test.ts.txt")).toBe(true);
  });
  it("rejects missing or linked required roots and manifests instead of acknowledging a partial catalog", async () => {
    for (
      const path of [
        "",
        "src",
        "bench",
        "tests",
        ".mise",
        ".mise/tasks",
        "mod.ts",
        "deno.json",
        "deno.lock",
        "package.json",
      ]
    ) {
      for (const link of [false, true]) {
        const tree = catalog();
        if (link) tree.links.add(path);
        else {
          tree.directories.delete(path);
          tree.bodies.delete(path);
        }
        await expect(inputs(tree.root, tree.files)).rejects.toBeInstanceOf(Error);
      }
    }
  });
  it("retains browser admission failure receipts, separate from unchanged inputs and earlier saved snapshots", async () => {
    const tree = catalog(), saved: InputReceiptType[] = [];
    const complete = await openInputGuard(
      (value) => {
        saved.push(value);
        return Promise.resolve();
      },
      tree.root,
      tree.files,
    );
    expect(saved[0]?.status).toBe("running");
    tree.set("tests/close.ts", "mutation during admitted workload");
    await expect(complete()).rejects.toThrow("source inputs changed");
    expect(saved.map((value) => value.status)).toEqual(["running", "invalid"]);
    expect(saved[1]?.inputsAfter).not.toEqual(saved[1]?.inputs);
    expect(saved[0]?.status).toBe("running");
    const stable = catalog(), positive: InputReceiptType[] = [];
    await (await openInputGuard(
      (value) => {
        positive.push(value);
        return Promise.resolve();
      },
      stable.root,
      stable.files,
    ))();
    expect(positive.map((value) => value.status)).toEqual(["running", "unchanged"]);
    const missing = catalog(), invalid: InputReceiptType[] = [];
    missing.bodies.delete("mod.ts");
    await expect(openInputGuard(
      (value) => {
        invalid.push(value);
        return Promise.resolve();
      },
      missing.root,
      missing.files,
    )).rejects.toBeInstanceOf(Error);
    expect(invalid.map((value) => value.status)).toEqual(["invalid"]);
  });
  it("marks unreadable after-work inputs invalid and preserves evidence-write failure beside admission failure", async () => {
    const tree = catalog(), saved: InputReceiptType[] = [];
    const complete = await openInputGuard(
      (value) => {
        saved.push(value);
        return Promise.resolve();
      },
      tree.root,
      tree.files,
    );
    tree.bodies.delete("mod.ts");
    await expect(complete()).rejects.toThrow("Missing input");
    expect(saved.map((value) => value.status)).toEqual(["running", "invalid"]);
    expect(saved[1]?.inputsAfter).toBe(undefined);

    const changed = catalog(), disk = new Error("invalid receipt write failed");
    const failing = await openInputGuard(
      (value) => {
        if (value.status === "invalid") throw disk;
        return Promise.resolve();
      },
      changed.root,
      changed.files,
    );
    changed.set("tests/gate.ts", "different guard");
    const error = await failing().then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Missing admission/evidence aggregate.");
    expect(error.errors).toHaveLength(2);
    expect(error.errors[0]).toBeInstanceOf(Error);
    expect((error.errors[0] as Error).message).toContain("source inputs changed");
    expect(error.errors[1]).toBe(disk);
    expect(error.cause).toBe(error.errors[0]);
  });
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
