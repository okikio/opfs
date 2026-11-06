/** Pure-file native semantic assertions; no candidate modules, socket, broker, JVM or Python execution. */
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { check, digest } from "../acquire.ts";
import { decode, originals } from "./manifest.ts";
import { CAP, read, Reader } from "./wire.ts";
import { crc32c, TIMESTAMP } from "./records.ts";
import type { RecordType } from "./records.ts";
/** Every response checks original outer framing and correlation before native semantics. */
function response(path: string, correlation: number): Reader {
  const reader = new Reader(read(path)), size = reader.int();
  check(
    size >= 4 && size <= CAP && size === reader.data.length - 4 && reader.int() === correlation,
    "Original frame identity.",
  );
  return reader;
}
/** Nullable bytes must match in full; hashing alone is not the native sample comparison. */
function same(a: Buffer<ArrayBuffer> | null, b: Buffer<ArrayBuffer> | null): boolean {
  return a === null ? b === null : b !== null && a.equals(b);
}
/** Compare the ordered key/value/header bytes and precise timestamps/offsets. */
function records(actual: readonly (RecordType & { readonly offset: bigint })[], shift: bigint): void {
  const expected = originals(TIMESTAMP);
  check(actual.length === expected.length, "Complete native record inventory.");
  actual.forEach((record, at) => {
    const original = expected[at]!;
    check(
      record.offset === BigInt(at) + shift && record.timestamp === original.timestamp &&
        same(record.key, original.key) && same(record.value, original.value) &&
        record.headers.length === original.headers.length && record.headers.every((header, index) =>
          header.name === original.headers[index]!.name && same(header.value, original.headers[index]!.value)
        ),
      "Complete native original bytes/offsets/timestamps differ.",
    );
  });
}
/** Preserve the original one-partition Produce3 acknowledgment, including CreateTime's -1 append-time sentinel. */
function produced(path: string, topic: string): void {
  const reader = response(path, 3103);
  check(
    reader.count() === 1 && reader.text() === topic && reader.count() === 1 && reader.int() === 0 &&
      reader.short() === 0 && reader.long() === 3n && reader.long() === -1n && reader.int() >= 0,
    "Produce semantic acknowledgment.",
  );
  reader.done();
}
function end(path: string, topic: string, correlation: number, expected: bigint): void {
  const reader = response(path, correlation);
  check(
    reader.count() === 1 && reader.text() === topic && reader.count() === 1 && reader.int() === 0 &&
      reader.short() === 0,
    "ListOffsets topology/error.",
  );
  reader.long();
  check(reader.long() === expected, "ListOffsets actual offset.");
  reader.done();
}
/** Decode only the exact original NONE/CreateTime batches; no generalized Kafka support is implied. */
function fetched(path: string, topic: string, high: bigint): readonly (RecordType & { readonly offset: bigint })[] {
  const reader = response(path, 3106);
  check(
    reader.int() >= 0 && reader.count() === 1 && reader.text() === topic && reader.count() === 1 &&
      reader.int() === 0 && reader.short() === 0 && reader.long() === high,
    "Fetch topology/error/highwatermark.",
  );
  const stable = reader.long(), aborted = reader.int();
  check(stable >= 0n && (aborted === -1 || aborted === 0), "Unexpected transactional page.");
  const amount = reader.int();
  check(amount >= 0 && amount <= CAP, "Fetch record extent.");
  const batches = new Reader(reader.take(amount));
  reader.done();
  const output: (RecordType & { readonly offset: bigint })[] = [];
  while (batches.at < batches.data.length) {
    const offset = batches.long(), length = batches.int();
    check(length >= 49 && length <= CAP, "Batch preallocation extent.");
    const batch = new Reader(batches.take(length));
    batch.int();
    check(batch.byte() === 2, "Batch magic.");
    const crc = batch.uint();
    check(crc32c(batch.data.subarray(batch.at)) === crc, "Original batch CRC32C.");
    check(batch.short() === 0, "Only original uncompressed CreateTime batches admitted.");
    const last = batch.int(), firstTime = batch.long(), lastTime = batch.long();
    batch.long();
    batch.short();
    batch.int();
    const count = batch.count();
    check(count >= 1 && count <= 3 && last === count - 1, "Batch record count/delta.");
    for (let index = 0; index < count; index++) {
      const size = batch.varint();
      check(size >= 0n && size <= 1048576n, "Record extent.");
      const record = new Reader(batch.take(Number(size)));
      check(record.byte() === 0, "Record attributes.");
      const timestamp = firstTime + record.varint(), delta = record.varint();
      check(delta === BigInt(index) && timestamp >= firstTime && timestamp <= lastTime, "Record timestamp/delta.");
      const key = record.variableBlob(), value = record.variableBlob(), headerCount = record.varint();
      check(headerCount >= 0n && headerCount <= 32n, "Record headers.");
      const headers = Array.from({ length: Number(headerCount) }, () => {
        const name = record.variableBlob();
        check(name !== null && name.length <= 256, "Header name.");
        return { name: new TextDecoder("utf-8", { fatal: true }).decode(name), value: record.variableBlob() };
      });
      record.done();
      output.push({ offset: offset + delta, timestamp, key, value, headers });
      check(output.length <= 3, "Whole native page record budget.");
    }
    batch.done();
  }
  return output;
}
const [directory, topic, ...extra] = process.argv.slice(2);
check(
  directory && topic && extra.length === 0 && /^opfs-[A-Za-z0-9._-]{1,200}$/.test(topic),
  "Usage: verify.ts OUTPUT_DIRECTORY EXACT_OWNED_TOPIC",
);
// Preserve the old authority identities without importing or executing those Python bytes.
const here = dirname(fileURLToPath(import.meta.url));
for (
  const [name, sha] of [["manifest.py", "df1b7482f3dd559153734482c7be7a0b5799fa8351ebc880038f6409d1de0833"], [
    "probe.py",
    "54dec3674d58b2d9e04f9a0066fcf274edbdf6e9abca417bd336a5eb717fa79c",
  ]] as const
) check(digest(read(join(here, "history", name + ".snapshot"))) === sha, "Frozen independent source identity.");
const append = decode(read(join(directory, "sdk-append.bin")));
check(
  append.operation === 1 && append.status === 0 && append.topic === topic && append.partition === 0 &&
    !append.unknown && append.records.length === 0 && append.faults.length === 0 && !append.faultsTruncated &&
    append.acks.length === 3,
  "SDK append terminal.",
);
append.acks.forEach((ack, index) =>
  check(
    ack.partition === 0 && ack.offset === BigInt(index) && ack.timestamp === TIMESTAMP + BigInt(index),
    "SDK actual acknowledgments.",
  )
);
records(fetched(join(directory, "read/fetch-response.bin"), topic, 3n), 0n);
end(join(directory, "read/earliest-response.bin"), topic, 3104, 0n);
end(join(directory, "read/latest-response.bin"), topic, 3105, 3n);
produced(join(directory, "append/produce-response.bin"), topic);
end(join(directory, "append/latest-response.bin"), topic, 3105, 6n);
records(fetched(join(directory, "append/fetch-response.bin"), topic, 6n), 3n);
const fetchedSdk = decode(read(join(directory, "sdk-fetch.bin")));
check(
  fetchedSdk.operation === 2 && fetchedSdk.status === 0 && fetchedSdk.topic === topic && fetchedSdk.partition === 0 &&
    !fetchedSdk.unknown && fetchedSdk.acks.length === 0 && fetchedSdk.faults.length === 0 &&
    !fetchedSdk.faultsTruncated && fetchedSdk.records.length === 3,
  "SDK fetch terminal.",
);
check(fetchedSdk.records.every((record) => record.timestampType === "CREATE_TIME"), "SDK Enum.name() timestamp type.");
records(fetchedSdk.records, 3n);
const crcInput = read(join(directory, "append/produce-crc-input.bin"));
check(
  read(join(directory, "crc.txt")).equals(Buffer.from(crc32c(crcInput).toString(16).padStart(8, "0") + "\n")),
  "JDK CRC32C agreement.",
);
console.log(JSON.stringify({
  semanticFullBytes: true,
  sdkAppendOffsets: [0, 1, 2],
  literalAppendOffsets: [3, 4, 5],
  crc32c: true,
  candidateCodeImported: false,
  compressedCodecClaim: false,
  metadataSemanticClaim: false,
  scope: "TypeScript verifier execution; historical native broker/Java run remains separately identified.",
}));
