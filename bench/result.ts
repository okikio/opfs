import { deepStrictEqual } from "node:assert/strict";
import { env } from "node:process";
import { run } from "mitata";

/** Exact nonzero bytes reveal stale content, truncation and offsets before timing begins. */
export function payload(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => (index * 31 + 17) % 251);
}

/** A benchmark proceeds only after its independent byte oracle succeeds. */
export function expectBytes(actual: Uint8Array, expected: Uint8Array, lane: string): void {
  deepStrictEqual(actual, expected, `${lane}: byte oracle`);
}

/** Native Mitata JSON retains distributions for repeatable reports instead of terminal averages. */
export async function report(): Promise<void> {
  await run(env.BENCH_JSON === "1" ? { format: "json", throw: true } : { throw: true });
}

/**
 * Releases owned resources in reverse acquisition order and attempts every release.
 * A cleanup failure retains each supplied original reason, including undefined, beside cleanup errors.
 * When cleanup succeeds, the caller remains responsible for rethrowing its original failure.
 */
export async function finish(
  cleanups: readonly (() => void | Promise<void>)[],
  primary: readonly unknown[] = [],
): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError([...primary, ...failures], "Benchmark owned-resource cleanup failed.");
}
