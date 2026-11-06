import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createLz4Decoder } from "../src/archive/lz4.ts";
import type { Lz4ResultType } from "../src/archive/lz4.ts";
import { expectBytes, report } from "./result.ts";
import fixtures from "../tests/fixtures/lz4/independent.json" with { type: "json" };

/** Immutable fixture storage is borrowed; the decoder makes its own admitted input copies. */
function input(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at === bytes.length) return controller.close();
      const end = Math.min(at + 65536, bytes.length);
      controller.enqueue(bytes.subarray(at, end));
      at = end;
    },
  }, { highWaterMark: 0 });
}

/**
 * Discard output after optional untimed full-byte checks. Prefix runs await actual cancellation;
 * complete runs include footer validation. No whole decoded output is retained by this consumer.
 */
async function decode(
  bytes: Uint8Array,
  chunkBytes: number,
  prefix: boolean,
  expected?: Uint8Array,
): Promise<Lz4ResultType> {
  const decoder = createLz4Decoder(input(bytes), { outputChunkBytes: chunkBytes });
  const reader = decoder.stream.getReader();
  let at = 0, ended = false;
  let failed = false;
  let primary: unknown;
  const cleanup: unknown[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        ended = true;
        break;
      }
      if (expected) expectBytes(next.value, expected.subarray(at, at + next.value.length), "lz4/full-byte-oracle");
      at += next.value.length;
      if (prefix && at >= 4096) break;
    }
    if (expected && at !== (prefix ? Math.min(chunkBytes, expected.length) : expected.length)) {
      throw new Error("LZ4 benchmark output extent differs from its oracle.");
    }
  } catch (reason) {
    failed = true;
    primary = reason;
  }
  try {
    if (!ended) await reader.cancel(primary);
  } catch (reason) {
    // Cancellation of an already errored stream can reobserve the terminal decoder failure.
    if (!failed || reason !== primary) cleanup.push(reason);
  }
  try {
    reader.releaseLock();
  } catch (reason) {
    cleanup.push(reason);
  }
  let result: Lz4ResultType | undefined;
  try {
    result = await decoder.finished;
  } catch (reason) {
    if (!failed || reason !== primary) cleanup.push(reason);
  }
  const failures = [...(failed ? [primary] : []), ...cleanup];
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "LZ4 benchmark and teardown failed.", { cause: failures[0] });
  if (!result || result.status !== (prefix ? "cancelled" : "complete")) {
    throw new Error("LZ4 benchmark did not reach its intended terminal state.");
  }
  return result;
}

// Question: what do output chunk policy and early preview cancellation cost for these fixed native frames?
// The 4 KiB variant is a policy baseline, not another implementation or an equivalent full-verification workload.
// Input fixtures, base64 decoding and byte oracles are outside timing. Consumer queues and engine peak heap are
// not measured here. Names retain actual source/decoded/output work, so prefix timings cannot imply full verification.
for (const profile of ["independent", "dependent", "overlap", "raw"] as const) {
  const fixture = fixtures.frames[profile];
  const bytes = decodeBase64(fixture.archive), expected = decodeBase64(fixture.body);
  for (const chunk of [4096, 65536]) {
    const complete = await decode(bytes, chunk, false, expected);
    bench(
      `lz4/${profile} complete chunk=${chunk}B source=${complete.work.sourceBytes}B decoded=${complete.work.decodedBytes}B output=${complete.work.outputBytes}B`,
      async () => do_not_optimize(await decode(bytes, chunk, false)),
    );
  }
  const preview = await decode(bytes, 4096, true, expected);
  bench(
    `lz4/${profile} prefix+cancel source=${preview.work.sourceBytes}B decoded=${preview.work.decodedBytes}B output=${preview.work.outputBytes}B`,
    async () => do_not_optimize(await decode(bytes, 4096, true)),
  );
}
await report();
