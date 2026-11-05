import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createBzipDecoder } from "../src/archive/bzip.ts";
import type { BzipResultType } from "../src/archive/bzip.ts";
import { expectBytes, report } from "./result.ts";
import corpus from "../tests/fixtures/bzip/independent.json" with { type: "json" };

/** A fresh decoder owns finite per-stream accounting for every sample; the immutable Blob source stays borrowed. */
async function decode(source: ByteSourceType, prefix: boolean, expected?: Uint8Array): Promise<BzipResultType> {
  const decoder = createBzipDecoder(source, { outputChunkBytes: prefix ? 4096 : 65536 });
  const reader = decoder.stream.getReader();
  let at = 0, ended = false;
  const failures: unknown[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        ended = true;
        break;
      }
      if (expected) expectBytes(next.value, expected.subarray(at, at + next.value.length), "bzip/original-full-bytes");
      at += next.value.length;
      if (prefix) break;
    }
    if (expected && at !== (prefix ? Math.min(4096, expected.length) : expected.length)) {
      throw new Error("BZip2 benchmark byte extent differs from original input.");
    }
  } catch (reason) {
    failures.push(reason);
  }
  try {
    if (!ended) await reader.cancel();
  } catch (reason) {
    if (!failures.includes(reason)) failures.push(reason);
  }
  try {
    reader.releaseLock();
  } catch (reason) {
    failures.push(reason);
  }
  let result: BzipResultType | undefined;
  try {
    result = await decoder.finished;
  } catch (reason) {
    if (!failures.includes(reason)) failures.push(reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "BZip2 benchmark and terminal join failed.");
  if (
    !result || result.status !== (prefix ? "cancelled" : "complete") ||
    (prefix
      ? result.integrity !== "checksum-pending" || result.verifiedBlocks < 1
      : result.integrity !== "checksum-verified")
  ) throw new Error("BZip2 benchmark reached the wrong evidence scope.");
  return result;
}

// Question: what do complete verification and verified-block-prefix cancellation cost for these native streams?
// Input/base64/Blob creation and full original-byte preflight occur outside timing. The decoded Blob baseline
// only copies existing plaintext; it performs neither decompression nor integrity checks and is a lower bound.
// Fresh decoder lifetimes mean samples need no elevated shared ledger. Policies stay finite and unchanged.
for (const name of ["binary", "multiblock", "long-run"]) {
  const fixture = corpus.fixtures.find((value) => value.name === name)!;
  const packed = decodeBase64(fixture.packed), expected = decodeBase64(fixture.body);
  const source = createBlobSource(new Blob([new Uint8Array(packed).buffer]));
  const plain = new Blob([new Uint8Array(expected).buffer]);
  expectBytes(new Uint8Array(await plain.arrayBuffer()), expected, `bzip/${name}/decoded-Blob-oracle`);
  for (const prefix of [false, true]) {
    const preflight = await decode(source, prefix, expected);
    if (!prefix && preflight.work.sourceBytes !== packed.length) {
      throw new Error("BZip2 full stream did not consume exact packed extent.");
    }
    const length = prefix ? Math.min(4096, expected.length) : expected.length;
    const label = `bzip/${name} ${
      prefix ? "verified-block-prefix+cancel" : "complete-stream"
    } packed=${packed.length}B original=${expected.length}B`;
    bench(
      `${label} decoded-Blob-copy lower-bound output=${length}B integrity=none`,
      async () => do_not_optimize(await plain.slice(0, length).arrayBuffer()),
    );
    bench(
      `${label} source=${preflight.work.sourceBytes}B decoded=${preflight.work.decodedBytes}B output=${preflight.work.outputBytes}B blocks=${preflight.verifiedBlocks} steps=${preflight.steps} scratch=${preflight.memoryBytes}B integrity=${preflight.integrity}`,
      async () => do_not_optimize(await decode(source, prefix)),
    );
  }
}

await report();
