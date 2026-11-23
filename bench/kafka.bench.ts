/** Compare owned-byte copying with full record admission; neither lane opens a broker or measures network throughput. */
import { bench, do_not_optimize } from "mitata";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { decodeRecords } from "../src/kafka/records.ts";
import { originals } from "../tests/fixtures/kafka/manifest.ts";
import { expectBytes, report } from "./result.ts";

// Hash admission, fixture I/O and the complete original-byte comparison stay outside sampling.
const path = new URL("../tests/fixtures/kafka/native-second/read/fetch-response.bin", import.meta.url);
const info = lstatSync(path);
if (!info.isFile() || info.size > 262144) throw new Error("Kafka benchmark fixture extent differs.");
const response = readFileSync(path);
if (
  createHash("sha256").update(response).digest("hex") !==
    "d79d756497f3ae3f62f8dcdce69afdafb8a8a727e40f67b405a9e1b5dc00e16a" ||
  response.readInt32BE(0) !== response.length - 4 || response.readInt32BE(65) !== response.length - 69
) throw new Error("Kafka benchmark frozen Fetch4 identity differs.");
const records = response.subarray(69), decoded = decodeRecords(records, 0n), expected = originals(1700000000000n);
if (decoded.records.length !== 3 || decoded.nextOffset !== 3n) throw new Error("Kafka benchmark page differs.");
for (const [index, wanted] of expected.entries()) {
  const actual = decoded.records[index]!;
  if (
    actual.offset !== BigInt(index) || actual.timestamp !== wanted.timestamp ||
    actual.headers.length !== wanted.headers.length
  ) throw new Error("Kafka benchmark record identity differs.");
  for (const [got, original] of [[actual.key, wanted.key], [actual.value, wanted.value]] as const) {
    if (got === null || original === null) {
      if (got !== original) throw new Error("Kafka benchmark null field differs.");
    } else expectBytes(got, original, "kafka/record/original");
  }
  for (const [at, header] of wanted.headers.entries()) {
    const got = actual.headers[at]!;
    if (got.name !== header.name) throw new Error("Kafka benchmark ordered header differs.");
    if (got.value === null || header.value === null) {
      if (got.value !== header.value) throw new Error("Kafka benchmark null header differs.");
    } else expectBytes(got.value, header.value, "kafka/header/original");
  }
}
bench(
  `kafka trusted owned copy bytes=${records.length} validation=none lower-bound`,
  () => do_not_optimize(new Uint8Array(records)),
);
bench(
  `kafka record admission bytes=${records.length} records=3 validation=CRC32C+full-page owned-payloads`,
  () => do_not_optimize(decodeRecords(records, 0n)),
);
await report();
