/**
 * Compare the candidate client with the admitted, unchanged Java SDK oracle on one disposable broker.
 *
 * Run with Node's TypeScript support:
 * node tests/fixtures/kafka/accept.ts --classes CLASSES --jars ADMITTED_JARS --evidence FRESH_DIRECTORY
 * The fixture owns the broker and channels. This executable owns fresh evidence and awaits retirement before PASS.
 * This proves only the selected plaintext, uncompressed CreateTime profile; it is not a filesystem or TLS test.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { KafkaClient, KafkaCompletionError } from "../../../src/kafka.ts";
import type { KafkaRecordType } from "../../../src/kafka.ts";
import { openKafka } from "../../provider/kafka.ts";
import type { KafkaFixture } from "../../provider/kafka.ts";
import { decode, input, originals } from "./manifest.ts";
import type { TerminalType } from "./manifest.ts";

const LIMIT = 4 * 1048576, TIMESTAMP = 1700000000000n;
function requireValue(value: boolean, message: string): asserts value {
  if (!value) throw new Error(`Kafka acceptance ${message}.`);
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
/** JSON receipts retain full payload bytes as hex and signed int64 values as decimal strings. */
function json(value: unknown): Buffer<ArrayBuffer> {
  return Buffer.from(
    JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      if (item instanceof Uint8Array) return { hex: Buffer.from(item).toString("hex") };
      // Buffer.toJSON runs before a replacer; normalize that representation without losing null/empty distinctions.
      if (
        item !== null && typeof item === "object" && "type" in item && item.type === "Buffer" &&
        "data" in item && Array.isArray(item.data)
      ) return { hex: Buffer.from(item.data).toString("hex") };
      return item;
    }, 2) + "\n",
  );
}
function sameBytes(actual: Uint8Array | null, expected: Uint8Array | null): boolean {
  if (actual === null || expected === null) return actual === expected;
  return actual.length === expected.length && actual.every((byte, at) => byte === expected[at]);
}
/** Compare records against authored input, never against a round trip through the candidate codec. */
function compare(
  actual: readonly (KafkaRecordType & { readonly offset: bigint })[],
  expected: readonly KafkaRecordType[],
  firstOffset: bigint,
): void {
  requireValue(actual.length === expected.length, "complete selected record count");
  for (let at = 0; at < expected.length; at++) {
    const got = actual[at], wanted = expected[at];
    requireValue(got !== undefined && wanted !== undefined, "record array extent");
    requireValue(got.offset === firstOffset + BigInt(at) && got.timestamp === wanted.timestamp, "offset/timestamp");
    requireValue(sameBytes(got.key, wanted.key) && sameBytes(got.value, wanted.value), "nullable binary payload");
    requireValue(got.headers.length === wanted.headers.length, "header count");
    for (let index = 0; index < wanted.headers.length; index++) {
      const gotHeader = got.headers[index], wantedHeader = wanted.headers[index];
      requireValue(gotHeader !== undefined && wantedHeader !== undefined, "header array extent");
      requireValue(
        gotHeader.name === wantedHeader.name && sameBytes(gotHeader.value, wantedHeader.value),
        "ordered header name/value",
      );
    }
  }
}
/** Java process success alone does not admit a partial acknowledgement or an envelope containing cleanup faults. */
function terminal(value: TerminalType, operation: 1 | 2, topic: string): void {
  requireValue(
    value.operation === operation && value.status === 0 && value.topic === topic && value.partition === 0 &&
      !value.unknown && !value.faultsTruncated && value.faults.length === 0,
    "native terminal identity/status",
  );
}
/** Preserve nested operation and retirement faults without serializing stacks or unbounded provider diagnostics. */
function fault(value: unknown, depth = 0): unknown {
  if (depth > 6) return { omitted: "nesting ceiling" };
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message.slice(0, 1024),
      cause: fault(value.cause, depth + 1),
      receipt: value instanceof KafkaCompletionError ? value.receipt : undefined,
      errors: value instanceof AggregateError
        ? value.errors.slice(0, 16).map((item: unknown) => fault(item, depth + 1))
        : undefined,
    };
  }
  if (value instanceof Uint8Array) return { bytes: value.length, sha256: hash(value) };
  if (Array.isArray(value)) return value.slice(0, 32).map((item: unknown) => fault(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 32).map(([key, item]) => [key, fault(item, depth + 1)]));
  }
  return typeof value === "string" ? value.slice(0, 4096) : value;
}

const { values, positionals } = parseArgs({
  options: { classes: { type: "string" }, jars: { type: "string" }, evidence: { type: "string" } },
  allowPositionals: true,
});
requireValue(
  positionals.length === 0 && !!values.classes && !!values.jars && !!values.evidence,
  "usage: accept.ts --classes CLASSES --jars ADMITTED_JARS --evidence FRESH_DIRECTORY",
);
const evidence = resolve(values.evidence);
mkdirSync(evidence, { mode: 0o700 });
const artifacts: { file: string; bytes: number; sha256: string }[] = [], failures: unknown[] = [];
const started = Date.now();
let fixture: KafkaFixture | undefined, nativeToCandidate = false, candidateToNative = false;
const save = (file: string, bytes: Uint8Array): void => {
  requireValue(bytes.length <= LIMIT, "artifact byte ceiling");
  writeFileSync(join(evidence, file), bytes, { flag: "wx", mode: 0o600 });
  artifacts.push({ file, bytes: bytes.length, sha256: hash(bytes) });
};
/** The provider retains failed native stdout in a bounded Error.cause, including when broker retirement also fails. */
const seen = new Set<object>();
let failedOutputs = 0;
const retainNative = (value: unknown, depth = 0): void => {
  if (depth > 6 || value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (value instanceof Error) {
    retainNative(value.cause, depth + 1);
    if (value instanceof AggregateError) {
      for (const item of value.errors.slice(0, 16)) retainNative(item, depth + 1);
    }
  } else {
    if ("stdout" in value && value.stdout instanceof Uint8Array) {
      requireValue(value.stdout.length <= 2 * 1048576 && failedOutputs < 16, "native failure capture ceiling");
      save(`native-failed-${++failedOutputs}.bin`, value.stdout);
    }
    if ("cause" in value) retainNative(value.cause, depth + 1);
  }
};
try {
  fixture = await openKafka({ classes: resolve(values.classes), jars: resolve(values.jars) });
  const owned = fixture;
  const client = new KafkaClient({
    topic: owned.topic,
    partition: 0,
    brokerId: 1,
    allowPlaintext: true,
    timeoutMs: 20000,
    cleanupMs: 5000,
    openChannel: (options) => owned.openChannel(options),
  });
  // The native JVM runs inside the broker container; this endpoint is not the host's dynamically mapped listener.
  const selection = { bootstrap: "127.0.0.1:9092", topic: owned.topic, partition: 0 };
  const nativeInput = input({ ...selection, mode: "append", timestamp: TIMESTAMP });
  save("native-append-input.bin", nativeInput);
  const nativeOutput = await owned.oracle(nativeInput);
  save("native-append-output.bin", nativeOutput);
  const appended = decode(nativeOutput), expectedNative = originals(TIMESTAMP);
  save("native-append-decoded.json", json(appended));
  terminal(appended, 1, owned.topic);
  requireValue(
    appended.attempted === 2 && appended.acks.length === 3 && appended.records.length === 0 &&
      appended.acks.every((ack, at) =>
        ack.partition === 0 && ack.offset === BigInt(at) && ack.timestamp === expectedNative[at]?.timestamp
      ),
    "native initial acknowledgements",
  );
  const metadata = await client.metadata();
  save("candidate-metadata.json", json(metadata));
  requireValue(
    metadata.topic === owned.topic && metadata.error === 0 && !metadata.internal &&
      metadata.brokers.length === 1 && metadata.brokers[0]?.id === 1 && metadata.partitions.length === 1 &&
      metadata.partitions[0]?.index === 0 && metadata.partitions[0]?.error === 0 &&
      metadata.partitions[0]?.leader === 1 && metadata.partitions[0]?.replicas.join() === "1" &&
      metadata.partitions[0]?.isr.join() === "1",
    "candidate metadata versus explicit one-broker fixture configuration",
  );
  const earliest = await client.offset("earliest"), latest = await client.offset("latest");
  save("candidate-initial-offsets.json", json({ earliest, latest }));
  requireValue(
    earliest.offset === 0n && latest.offset === 3n && earliest.timestamp === -1n && latest.timestamp === -1n,
    "native earliest/latest positions and timestamp sentinels",
  );
  const page = await client.fetch(0n);
  save("candidate-fetch.json", json(page));
  requireValue(
    page.topic === owned.topic && page.partition === 0 && page.recordsState === "present",
    "candidate page selection",
  );
  compare(page.records, expectedNative, 0n);
  requireValue(page.nextOffset === 3n && page.highWatermark === 3n, "candidate initial cursor/high watermark");
  nativeToCandidate = true;

  const expectedCandidate = originals(TIMESTAMP + 1000n);
  // Retain the independent originals in KOP1 form, but do not send this append manifest to the native producer.
  save("candidate-originals.bin", input({ ...selection, mode: "append", timestamp: TIMESTAMP + 1000n }));
  const ack = await client.append(expectedCandidate);
  save("candidate-append.json", json(ack));
  requireValue(
    ack.topic === owned.topic && ack.partition === 0 && ack.baseOffset === 3n && ack.count === 3,
    "candidate acknowledgement",
  );
  const fetchInput = input({ ...selection, mode: "fetch", offset: 3n, count: 3, waitMs: 10000 });
  save("native-fetch-input.bin", fetchInput);
  const fetchedOutput = await owned.oracle(fetchInput);
  save("native-fetch-output.bin", fetchedOutput);
  const fetched = decode(fetchedOutput);
  save("native-fetch-decoded.json", json(fetched));
  terminal(fetched, 2, owned.topic);
  requireValue(fetched.acks.length === 0 && fetched.attempted === -1, "native fetch terminal fields");
  requireValue(fetched.records.every((record) => record.timestampType === "CREATE_TIME"), "native CreateTime profile");
  compare(fetched.records, expectedCandidate, 3n);
  const finalOffset = await client.offset("latest");
  save("candidate-final-offset.json", json(finalOffset));
  requireValue(finalOffset.offset === 6n && finalOffset.timestamp === -1n, "native final high watermark");
  candidateToNative = true;
} catch (reason) {
  failures.push(reason);
  try {
    retainNative(reason);
  } catch (captureFailure) {
    failures.push(captureFailure);
  }
}
try {
  if (fixture) await fixture.close();
} catch (reason) {
  failures.push(reason);
}
const qualified = nativeToCandidate && candidateToNative && failures.length === 0;
try {
  save(
    "terminal.json",
    json({
      scope:
        "One owned broker, partition 0, plaintext, uncompressed magic-2 CreateTime records; Java SDK interoperability.",
      qualified,
      nativeToCandidate,
      candidateToNative,
      topic: fixture?.topic,
      partition: 0,
      milliseconds: Date.now() - started,
      candidateKafkaClientImported: true,
      tlsQualified: false,
      multibrokerQualified: false,
      filesystemQualified: false,
      inputs: fixture?.inputs,
      nativeCommands: fixture?.receipts,
      artifacts: [...artifacts],
      failures: failures.map((reason) => fault(reason)),
    }),
  );
} catch (reason) {
  failures.push(reason);
}
if (failures.length) throw new AggregateError(failures, "Kafka candidate acceptance failed; retain fresh evidence.");
requireValue(qualified, "both directions absent");
console.log(JSON.stringify({ evidence, qualified, nativeToCandidate, candidateToNative }));
