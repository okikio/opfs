import { bench, do_not_optimize } from "mitata";
import { decodeBase64 } from "@std/encoding/base64";
import { openMcap } from "../src/dataset/mcap.ts";
import { createByteSource } from "../src/source.ts";
import fixture from "../tests/fixtures/mcap/independent.json" with { type: "json" };
import { expectBytes, report } from "./result.ts";

// Cold physical indexing, descriptor paging and selected CRC work are different
// contracts. No native SDK, acquisition or fixture base64 decoding is timed.
const native = fixture.fixtures.find((f) => f.name === "chunked")!;
const bytes = decodeBase64(native.data), source = createByteSource(bytes, { identity: "native-mcap-benchmark" });
const allowance = {
  maxSourceBytes: 64 * 1024 ** 3,
  maxRequests: 10000000,
  maxDecodedBytes: 64 * 1024 ** 3,
  maxOutputBytes: 64 * 1024 ** 3,
};
const recording = await openMcap(source, { profile: "mcap0-uncompressed", ...allowance });
for (let id = 0; id < native.messages.length; id++) {
  const authored = native.messages[id]!;
  expectBytes((await recording.read(id)).bytes, decodeBase64(authored.data), `mcap/native/${id}`);
  const d = recording.messages({ cursor: id, limit: 1 }).messages[0]!;
  if (d.logTime !== BigInt(authored.logTime) || d.publishTime !== BigInt(authored.publishTime)) {
    throw new Error("MCAP bigint preflight failed.");
  }
}
const id = 3, expected = decodeBase64(native.messages[id]!.data), offset = 7, length = 32;
const raw = recording.source(id, allowance),
  physical = (JSON.parse(raw.identity!) as [string, string, number, number])[2];
expectBytes(
  await source.read(physical + offset, length),
  expected.subarray(offset, offset + length),
  "mcap/direct-range",
);
const checked = await recording.read(id, { offset, length }),
  unchecked = await recording.read(id, { offset, length, verify: false });
expectBytes(checked.bytes, expected.subarray(offset, offset + length), "mcap/verified-range");
expectBytes(unchecked.bytes, expected.subarray(offset, offset + length), "mcap/pending-range");
if (
  checked.integrity.scope !== "chunk" || checked.integrity.status !== "verified" ||
  unchecked.integrity.scope !== "chunk" || unchecked.integrity.status !== "pending"
) throw new Error("MCAP selected integrity preflight failed.");
const sparse = recording.messages({ channelId: 65535, limit: 2, maxScanned: 3 });
if (sparse.messages.length !== 0 || sparse.scanned !== 3 || sparse.cursor !== 3) {
  throw new Error("MCAP empty sparse page preflight failed.");
}
const data = await recording.verify({ scope: "data" });
if (data.integrity.status !== "verified") throw new Error("MCAP data CRC preflight failed.");
const cold = await openMcap(source, { profile: "mcap0-uncompressed" });
bench(
  `mcap borrowed-range lower-bound selected=${length}B validation=none`,
  async () => do_not_optimize(await source.read(physical + offset, length)),
);
bench(
  `mcap cold-physical-index file=${bytes.length}B messages=${recording.messageCount} chunks=${recording.chunkCount} source=${cold.work.sourceBytes}B requests=${cold.work.requests} metadata=${cold.work.metadataBytes}B summary=verified`,
  async () => do_not_optimize(await openMcap(source, { profile: "mcap0-uncompressed" })),
);
bench(
  "mcap warm-empty-sparse-page descriptors=7 limit=2 actual=0 scanned=3 cursor=3 no-payload-IO",
  () => do_not_optimize(recording.messages({ channelId: 65535, limit: 2, maxScanned: 3 })),
);
bench(
  `mcap selected-verified-chunk output=${length}B source=${checked.work.sourceBytes}B requests=${checked.work.requests} decoded=${checked.work.decodedBytes}B scope=whole-containing-chunk`,
  async () => do_not_optimize(await recording.read(id, { offset, length })),
);
bench(
  `mcap selected-pending output=${length}B source=${unchecked.work.sourceBytes}B requests=${unchecked.work.requests} decoded=${unchecked.work.decodedBytes}B crc=unchecked`,
  async () => do_not_optimize(await recording.read(id, { offset, length, verify: false })),
);
bench(
  `mcap verify-whole-data source=${data.work.sourceBytes}B requests=${data.work.requests} decoded=${data.work.decodedBytes}B output=0B scope=data`,
  async () => do_not_optimize(await recording.verify({ scope: "data" })),
);
await report();
