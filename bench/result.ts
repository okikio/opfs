import { env, stdout } from "node:process";
import { run } from "mitata";

/** Exact nonzero bytes reveal stale content, truncation and offsets before timing begins. */
export function payload(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => (index * 31 + 17) % 251);
}

/**
 * Checks every visible byte before sampling, regardless of the view's prototype.
 *
 * Failure retains lengths or the first differing offset and two scalar bytes.
 * Large native buffers must not be copied or formatted into an assertion diff:
 * diagnostic allocation could hide the original failure behind an OOM kill.
 * This check remains outside timed callbacks and does not validate storage durability.
 */
export function expectBytes(actual: Uint8Array, expected: Uint8Array, lane: string): void {
  if (actual.byteLength !== expected.byteLength) {
    throw new Error(`${lane}: byte oracle length differs.`, {
      cause: { actualBytes: actual.byteLength, expectedBytes: expected.byteLength },
    });
  }
  for (let offset = 0; offset < expected.byteLength; offset++) {
    if (actual[offset] !== expected[offset]) {
      throw new Error(`${lane}: byte oracle differs at byte ${offset}.`, {
        cause: { offset, actual: actual[offset], expected: expected[offset] },
      });
    }
  }
}

/** Native Mitata JSON retains distributions for repeatable reports instead of terminal averages. */
export async function report(): Promise<void> {
  if (env.BENCH_JSON !== "1") {
    await run({ throw: true });
    return;
  }
  // Mitata's default console printer can leave a large piped Bun report
  // unfinished at process exit. Keep its native serializer, then await I/O.
  let output = "";
  await run({
    format: "json",
    throw: true,
    print: (value) => {
      output += `${value}\n`;
    },
  });
  await new Promise<void>((resolve, reject) => {
    stdout.write(output, (error) => error ? reject(error) : resolve());
  });
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
