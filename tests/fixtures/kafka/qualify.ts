/** Run the owned one-broker Metadata4/Admin comparison. No candidate Kafka parser or client is imported. */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openKafka } from "../../provider/kafka.ts";
import type { KafkaFixture } from "../../provider/kafka.ts";
import { decodeMetadata4 } from "./metadata.ts";
import type { MetadataBrokerType, MetadataType } from "./metadata.ts";

const FRAME_LIMIT = 4 * 1048576, ADMIN_LIMIT = 1048576, CORRELATION = 4102;
/** Fixture errors contain fixed rules, with original native diagnostics retained separately in the terminal receipt. */
function requireValue(value: boolean, message: string): asserts value {
  if (!value) throw new Error(`Kafka qualification ${message}.`);
}
function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
interface ArtifactType {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}
interface AdminPartitionType {
  readonly index: number;
  readonly leader: number;
  readonly replicas: readonly number[];
  readonly isr: readonly number[];
}
interface AdminType {
  readonly cluster: string | null;
  readonly controllerObservation: number;
  readonly brokers: readonly MetadataBrokerType[];
  readonly topic: string;
  readonly internal: boolean;
  readonly requested: number;
  readonly partitions: readonly AdminPartitionType[];
}
/** Independent AMO1 cursor: int32 UTF-8 lengths differ deliberately from Metadata4's int16 strings. */
class AdminCursor {
  #raw: Buffer<ArrayBuffer>;
  at = 0;
  constructor(raw: Buffer<ArrayBuffer>) {
    requireValue(raw.length <= ADMIN_LIMIT, "Admin byte ceiling");
    this.#raw = raw;
  }
  get left(): number {
    return this.#raw.length - this.at;
  }
  take(size: number): Buffer<ArrayBuffer> {
    requireValue(Number.isSafeInteger(size) && size >= 0 && size <= this.left, "Admin field extent");
    const bytes = this.#raw.subarray(this.at, this.at + size);
    this.at += size;
    return bytes;
  }
  int(): number {
    return this.take(4).readInt32BE();
  }
  boolean(): boolean {
    const byte = this.take(1)[0];
    requireValue(byte === 0 || byte === 1, "Admin boolean");
    return byte === 1;
  }
  count(maximum: number, minimum: number): number {
    const count = this.int();
    requireValue(count >= 0 && count <= maximum && count <= Math.floor(this.left / minimum), "Admin count");
    return count;
  }
  text(maximum: number, nullable = false): string | null {
    const size = this.int();
    if (nullable && size === -1) return null;
    requireValue(size >= 0 && size <= maximum, "Admin string extent");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.take(size));
  }
  node(unknown = false): number {
    const id = this.int();
    requireValue(id >= (unknown ? -1 : 0), "Admin node ID");
    return id;
  }
}
/** Decode the full envelope, including fault records, before accepting an observation. Never synthesize wire errors. */
function adminObservation(raw: Buffer<ArrayBuffer>): AdminType {
  const cursor = new AdminCursor(raw);
  requireValue(cursor.int() === 0x414d4f31, "Admin magic");
  let observation: AdminType | undefined;
  if (cursor.boolean()) {
    const cluster = cursor.text(1024, true), controllerObservation = cursor.node(true);
    const brokers: MetadataBrokerType[] = [], seenBrokers = new Set<number>();
    const brokerCount = cursor.count(128, 16);
    for (let at = 0; at < brokerCount; at++) {
      const id = cursor.node(), host = cursor.text(1024), port = cursor.int(), rack = cursor.text(1024, true);
      requireValue(
        host !== null && host.length > 0 && port >= 1 && port <= 65535 && !seenBrokers.has(id),
        "Admin broker",
      );
      seenBrokers.add(id);
      brokers.push({ id, host, port, rack });
    }
    const topic = cursor.text(249), internal = cursor.boolean(), requested = cursor.int();
    requireValue(topic !== null && topic.length > 0 && requested >= 0, "Admin topic/selection");
    const count = cursor.count(1024, 16), partitions: AdminPartitionType[] = [], seen = new Set<number>();
    let remainingIds = 8192;
    const ids = (): readonly number[] => {
      const count = cursor.count(Math.min(128, remainingIds), 4), values: number[] = [], seen = new Set<number>();
      remainingIds -= count;
      for (let at = 0; at < count; at++) {
        const id = cursor.node();
        requireValue(!seen.has(id), "Admin duplicate replica/ISR");
        seen.add(id);
        values.push(id);
      }
      return values;
    };
    for (let at = 0; at < count; at++) {
      const index = cursor.int(), leader = cursor.node(true);
      requireValue(index >= 0 && !seen.has(index), "Admin duplicate partition");
      seen.add(index);
      partitions.push({ index, leader, replicas: ids(), isr: ids() });
    }
    observation = { cluster, controllerObservation, brokers, topic, internal, requested, partitions };
  }
  const count = cursor.count(2, 8), faults: { phase: string | null; type: string | null }[] = [];
  for (let at = 0; at < count; at++) faults.push({ phase: cursor.text(32), type: cursor.text(512) });
  requireValue(cursor.left === 0, "Admin trailing bytes");
  if (faults.length) throw new Error("Kafka qualification native Admin envelope retained faults.", { cause: faults });
  requireValue(observation !== undefined, "Admin observation absent");
  return observation;
}
/** Comparison intentionally preserves replica assignment order while ignoring unspecified ISR/broker collection order. */
function compare(wire: MetadataType, admin: AdminType, topic: string): void {
  const brokerKey = (broker: MetadataBrokerType): string =>
    JSON.stringify([broker.id, broker.host, broker.port, broker.rack]);
  requireValue(wire.cluster !== null && wire.cluster === admin.cluster, "cluster differs");
  requireValue(
    JSON.stringify(wire.brokers.map(brokerKey).sort()) === JSON.stringify(admin.brokers.map(brokerKey).sort()),
    "broker tuples differ",
  );
  requireValue(wire.topics.length === 1 && admin.topic === topic && admin.requested === 0, "topic selection differs");
  const selected = wire.topics[0];
  requireValue(selected !== undefined && selected.name === topic && selected.error === 0, "native topic refusal");
  requireValue(selected.internal === admin.internal, "internal flag differs");
  requireValue(selected.partitions.length === admin.partitions.length, "partition extent differs");
  requireValue(
    admin.partitions.length === 1 && admin.partitions[0]?.index === 0,
    "owned one-partition fixture differs",
  );
  for (const partition of selected.partitions) {
    const native = admin.partitions.find((value) => value.index === partition.index);
    requireValue(native !== undefined && partition.error === 0 && partition.leader >= 0, "native partition refusal");
    requireValue(partition.leader === native.leader, "leader differs");
    requireValue(JSON.stringify(partition.replicas) === JSON.stringify(native.replicas), "replica assignment differs");
    requireValue(
      JSON.stringify([...partition.isr].sort((a, b) => a - b)) ===
        JSON.stringify([...native.isr].sort((a, b) => a - b)),
      "ISR membership differs",
    );
  }
  // Admin bootstrap.servers returns a random broker here; one-node equality proves no multibroker controller identity.
  requireValue(wire.brokers.length === 1 && admin.brokers.length === 1, "owned one-broker fixture differs");
  requireValue(wire.controller === admin.controllerObservation, "degenerate controller observation differs");
}
function integer(value: number, width: 2 | 4): Buffer<ArrayBuffer> {
  const raw = Buffer.alloc(width);
  if (width === 2) raw.writeInt16BE(value);
  else raw.writeInt32BE(value);
  return raw;
}
function text(value: string): Buffer<ArrayBuffer> {
  const raw = Buffer.from(value, "utf8");
  requireValue(raw.length <= 249, "literal request text extent");
  return Buffer.concat([integer(raw.length, 2), raw]);
}
/** Idempotent destruction must settle before fixture retirement; no socket survives disk or parser failures. */
async function retire(socket: Socket): Promise<void> {
  if (socket.closed) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Kafka qualification socket retirement deadline.")), 5000);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.destroy();
  });
}
/** Capture exactly one literal Metadata4 exchange, limiting before allocation and retaining partial response bytes. */
async function capture(fixture: KafkaFixture, evidence: string): Promise<Buffer<ArrayBuffer>> {
  requireValue(["127.0.0.1", "localhost", "::1"].includes(fixture.host), "non-loopback fixture endpoint");
  requireValue(Number.isInteger(fixture.port) && fixture.port >= 1 && fixture.port <= 65535, "fixture port");
  const content = Buffer.concat([
    integer(3, 2),
    integer(4, 2),
    integer(CORRELATION, 4),
    text("opfs-metadata-qualification"),
    integer(1, 4),
    text(fixture.topic),
    Buffer.from([0]),
  ]);
  const request = Buffer.concat([integer(content.length, 4), content]);
  writeFileSync(join(evidence, "metadata-request.bin"), request, { flag: "wx", mode: 0o600 });
  const responsePath = join(evidence, "metadata-response.bin");
  writeFileSync(responsePath, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
  const socket = createConnection({ host: fixture.host, port: fixture.port });
  let socketFault: Error | undefined, primary: unknown, failed = false, response: Buffer<ArrayBuffer> | undefined;
  socket.on("error", (error) => {
    socketFault = error;
  });
  const timer = setTimeout(() => socket.destroy(new Error("Kafka qualification wire deadline.")), 20000);
  try {
    await new Promise<void>((resolve, reject) => {
      const clean = (): void => {
        socket.off("connect", ready);
        socket.off("error", fail);
        socket.off("close", closed);
      };
      const ready = (): void => {
        clean();
        resolve();
      };
      const fail = (error: Error): void => {
        clean();
        reject(error);
      };
      const closed = (): void => fail(new Error("Kafka qualification socket closed during acquisition."));
      socket.once("connect", ready);
      socket.once("error", fail);
      socket.once("close", closed);
    });
    await new Promise<void>((resolve, reject) => socket.write(request, (error) => error ? reject(error) : resolve()));
    const receive = async (count: number): Promise<Buffer<ArrayBuffer>> => {
      requireValue(count >= 0 && count <= FRAME_LIMIT, "wire allocation ceiling");
      const bytes = Buffer.alloc(count);
      let at = 0;
      while (at < count) {
        if (socketFault) throw socketFault;
        const chunk: unknown = socket.read(Math.min(count - at, 65536, Math.max(1, socket.readableLength)));
        if (chunk instanceof Uint8Array && chunk.length) {
          requireValue(chunk.length <= count - at && chunk.length <= 65536, "wire chunk extent");
          appendFileSync(responsePath, chunk);
          bytes.set(chunk, at);
          at += chunk.length;
          continue;
        }
        requireValue(!socket.destroyed && !socket.readableEnded, "truncated wire response");
        await new Promise<void>((resolve, reject) => {
          const clean = (): void => {
            socket.off("readable", ready);
            socket.off("end", ready);
            socket.off("close", ready);
            socket.off("error", fail);
          };
          const ready = (): void => {
            clean();
            resolve();
          };
          const fail = (error: Error): void => {
            clean();
            reject(error);
          };
          socket.once("readable", ready);
          socket.once("end", ready);
          socket.once("close", ready);
          socket.once("error", fail);
        });
      }
      return bytes;
    };
    const prefix = await receive(4), size = prefix.readInt32BE();
    requireValue(size >= 4 && size <= FRAME_LIMIT, "wire frame ceiling");
    response = Buffer.concat([prefix, await receive(size)]);
  } catch (reason) {
    primary = reason;
    failed = true;
  }
  clearTimeout(timer);
  const failures: unknown[] = failed ? [primary] : [];
  try {
    await retire(socket);
  } catch (reason) {
    failures.push(reason);
  }
  if (failures.length) throw new AggregateError(failures, "Kafka qualification wire/retirement failed.");
  requireValue(response !== undefined, "wire response absent");
  return response;
}
/** Bounded structural error evidence preserves nested primary/cleanup causes without serializing a stack or cycle. */
function fault(value: unknown, depth = 0): unknown {
  if (depth > 6) return { omitted: "error nesting ceiling" };
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message.slice(0, 1024),
      cause: fault(value.cause, depth + 1),
      errors: value instanceof AggregateError
        ? value.errors.slice(0, 16).map((item: unknown) => fault(item, depth + 1))
        : undefined,
    };
  }
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 65536);
  if (Array.isArray(value)) return value.slice(0, 32).map((item: unknown) => fault(item, depth + 1));
  if (value instanceof Uint8Array) return { bytes: value.length, sha256: hash(value) };
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 32).map(([key, item]) => [key, fault(item, depth + 1)]));
  }
  return String(value).slice(0, 1024);
}
const { values, positionals } = parseArgs({
  options: {
    classes: { type: "string" },
    jars: { type: "string" },
    evidence: { type: "string" },
  },
  allowPositionals: true,
});
requireValue(
  positionals.length === 0 && !!values.classes && !!values.jars && !!values.evidence,
  "usage: qualify.ts --classes CLASSES --jars ADMITTED_JARS --evidence FRESH_DIRECTORY",
);
const evidence = resolve(values.evidence);
mkdirSync(evidence, { mode: 0o700 });
const started = Date.now(), failures: unknown[] = [], artifacts: ArtifactType[] = [];
let fixture: KafkaFixture | undefined, matched = false;
const save = (name: string, bytes: Buffer<ArrayBuffer>): void => {
  requireValue(bytes.length <= FRAME_LIMIT + 4, "artifact ceiling");
  writeFileSync(join(evidence, name), bytes, { flag: "wx", mode: 0o600 });
  artifacts.push({ file: name, bytes: bytes.length, sha256: hash(bytes) });
};
/** Preserve failed native stdout supplied by the provider, including envelopes nested under cleanup aggregates. */
const retainedFailures = new Set<object>();
let failedEnvelopes = 0;
const retainNative = (value: unknown, depth = 0): void => {
  if (depth > 6 || value === null || typeof value !== "object" || retainedFailures.has(value)) return;
  retainedFailures.add(value);
  if (value instanceof Error) {
    retainNative(value.cause, depth + 1);
    if (value instanceof AggregateError) {
      for (const reason of value.errors.slice(0, 16)) retainNative(reason, depth + 1);
    }
    return;
  }
  if ("stdout" in value && value.stdout instanceof Uint8Array) {
    requireValue(value.stdout.length <= 2 * ADMIN_LIMIT && failedEnvelopes < 16, "failed native stdout ceiling");
    save(`admin-failed-${++failedEnvelopes}.bin`, Buffer.from(value.stdout));
  }
  if ("cause" in value) retainNative(value.cause, depth + 1);
};
try {
  fixture = await openKafka({ classes: resolve(values.classes), jars: resolve(values.jars) });
  const response = await capture(fixture, evidence), wire = decodeMetadata4(response, CORRELATION);
  save("wire-decoded.json", Buffer.from(JSON.stringify(wire, null, 2) + "\n"));
  const raw = await fixture.admin();
  save("admin.bin", raw);
  const native = adminObservation(raw);
  save("admin-decoded.json", Buffer.from(JSON.stringify(native, null, 2) + "\n"));
  compare(wire, native, fixture.topic);
  matched = true;
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
// Hash the full or partial wire captures only after their socket and fixture ownership has been settled.
for (const name of ["metadata-request.bin", "metadata-response.bin"]) {
  try {
    const path = join(evidence, name);
    if (!existsSync(path)) continue;
    const info = lstatSync(path);
    requireValue(info.isFile() && !info.isSymbolicLink() && info.size <= FRAME_LIMIT + 4, "retained wire file");
    const bytes = readFileSync(path);
    requireValue(bytes.length === info.size && bytes.length <= FRAME_LIMIT + 4, "retained wire extent");
    artifacts.push({ file: name, bytes: bytes.length, sha256: hash(bytes) });
  } catch (reason) {
    failures.push(reason);
  }
}
const receipt = {
  scope: "Fresh owned one-broker Metadata4/Admin observation; no candidate Kafka implementation qualification.",
  matched,
  qualified: matched && failures.length === 0,
  candidateKafkaParserImported: false,
  nativeWireErrorSemanticsQualified: false,
  multibrokerControllerQualified: false,
  topic: fixture?.topic,
  partition: 0,
  milliseconds: Date.now() - started,
  inputs: fixture?.inputs,
  nativeCommands: fixture?.receipts,
  artifacts,
  failures: failures.map((value) => fault(value)),
};
try {
  save("terminal.json", Buffer.from(JSON.stringify(receipt, null, 2) + "\n"));
} catch (reason) {
  failures.push(reason);
}
if (failures.length) throw new AggregateError(failures, "Kafka Metadata4 qualification failed; retain fresh evidence.");
console.log(JSON.stringify({ evidence, matched, qualified: true, multibrokerControllerQualified: false }));
