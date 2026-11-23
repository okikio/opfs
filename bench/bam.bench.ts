/** Explicitly different BGZF/BAM workloads over pinned native bytes; no native tool starts here. */
import { bench, do_not_optimize } from "mitata";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { openBam } from "../src/dataset/bam.ts";
import type { BamPageType } from "../src/dataset/bam.ts";
import { createByteSource } from "../src/source.ts";
import { report } from "./result.ts";

const envelope = readFileSync(new URL("../tests/fixtures/bam/native/corpus.json", import.meta.url));
if (
  envelope.length !== 325349 ||
  createHash("sha256").update(envelope).digest("hex") !==
    "4b18297001bdc669a16801340dcb7e5847c073a5aa577cd6baf0c59de5297ebf"
) {
  throw new Error("BAM benchmark native corpus changed.");
}
interface FixtureType {
  readonly name: string;
  readonly originalSam: string;
  readonly bam: { readonly bytes: number; readonly sha256: string; readonly base64: string };
}
const fixture = (JSON.parse(envelope.toString()) as { cases: FixtureType[] }).cases.find((item) =>
  item.name === "cross-block"
)!;
const bytes = Buffer.from(fixture.bam.base64, "base64");
if (bytes.length !== fixture.bam.bytes || createHash("sha256").update(bytes).digest("hex") !== fixture.bam.sha256) {
  throw new Error("BAM benchmark native image changed.");
}
const expected = fixture.originalSam.split("\n").find((line) => !line.startsWith("@") && line.length > 0)!.split("\t");
const source = createByteSource(bytes);
/** Open every sample afresh so lifetime budgets and cached header blocks are part of each timed operation. */
async function preview(maxRecords: number): Promise<BamPageType> {
  const bam = await openBam(source);
  for await (const page of bam.records({ maxRecords })) return page;
  throw new Error("BAM benchmark returned no terminal preview page.");
}
const headerOnly = await preview(0), one = await preview(1);
if (
  headerOnly.records.length !== 0 || headerOnly.end !== "preview" || one.end !== "preview" ||
  one.records.length !== 1 || one.records[0]!.sequence !== expected[9] || one.records[0]!.name !== expected[0] ||
  !one.records[0]!.qualities?.every((value, index) => value === expected[10]!.charCodeAt(index) - 33)
) {
  throw new Error("BAM benchmark candidate differs from authored original before timing.");
}
const nativeDecoded = gunzipSync(bytes);
if (!nativeDecoded.subarray(0, 4).equals(Buffer.from([66, 65, 77, 1]))) {
  throw new Error("BAM benchmark native gzip baseline lacks BAM magic.");
}
// Native gzip checks gzip, not BAM record grammar or the candidate's stricter single-member framing.
bench(
  `bam native-zlib whole concatenated-gzip decode input=${bytes.length}B output=${nativeDecoded.length}B BAM-grammar=absent`,
  () => {
    do_not_optimize(gunzipSync(bytes));
  },
);
bench(
  `bam open+header-only preview input=${bytes.length}B source=${headerOnly.work.sourceBytes}B requests=${headerOnly.work.requests} decoded=${headerOnly.work.decodedBytes}B checked-blocks=${headerOnly.work.blocks}`,
  async () => {
    do_not_optimize(await preview(0));
  },
);
bench(
  `bam open+one-complete-crossing-record bases=160000 source=${one.work.sourceBytes}B requests=${one.work.requests} decoded=${one.work.decodedBytes}B output-allowance=${one.work.outputBytes}B checked-blocks=${one.work.blocks}`,
  async () => {
    do_not_optimize(await preview(1));
  },
);
await report();
