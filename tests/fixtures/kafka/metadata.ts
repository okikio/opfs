/** Independent Metadata4 fixture decoding. This is not the future production client parser. */
export interface MetadataBrokerType {
  readonly id: number;
  readonly host: string;
  readonly port: number;
  readonly rack: string | null;
}
/** Numeric native error codes remain evidence, including UNKNOWN_SERVER_ERROR (-1). */
export interface MetadataPartitionType {
  readonly error: number;
  readonly index: number;
  readonly leader: number;
  readonly replicas: readonly number[];
  readonly isr: readonly number[];
}
export interface MetadataTopicType {
  readonly error: number;
  readonly name: string;
  readonly internal: boolean;
  readonly partitions: readonly MetadataPartitionType[];
}
/** A decoded wire observation, without a claim that the configured leader is usable. */
export interface MetadataType {
  readonly correlation: number;
  readonly throttleMs: number;
  readonly brokers: readonly MetadataBrokerType[];
  readonly cluster: string | null;
  readonly controller: number;
  readonly topics: readonly MetadataTopicType[];
}
/** Refuse malformed input before allocating derived arrays; no production module is imported. */
function requireValue(value: boolean, message: string): asserts value {
  if (!value) throw new Error(`Metadata4 ${message}.`);
}
/** One synchronous borrowed cursor; returned values contain no borrowed bytes or hidden transport state. */
class Cursor {
  #bytes: Uint8Array;
  #view: DataView;
  at = 0;
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get left(): number {
    return this.#bytes.length - this.at;
  }
  take(length: number): Uint8Array {
    requireValue(Number.isSafeInteger(length) && length >= 0 && length <= this.left, "field extent");
    const result = this.#bytes.subarray(this.at, this.at + length);
    this.at += length;
    return result;
  }
  integer(width: 1 | 2 | 4): number {
    const start = this.at;
    this.take(width);
    return width === 1
      ? this.#view.getUint8(start)
      : width === 2
      ? this.#view.getInt16(start)
      : this.#view.getInt32(start);
  }
  count(maximum: number, minimumBytes: number): number {
    const value = this.integer(4);
    requireValue(value >= 0 && value <= maximum && value <= Math.floor(this.left / minimumBytes), "array extent");
    return value;
  }
  text(maximum: number, nullable = false): string | null {
    const length = this.integer(2);
    if (nullable && length === -1) return null;
    requireValue(length >= 0 && length <= maximum, "text extent");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.take(length));
  }
  node(unknown = false): number {
    const value = this.integer(4);
    requireValue(value >= (unknown ? -1 : 0), "node ID");
    return value;
  }
}
/**
 * Decode one complete length-prefixed classic Metadata4 response and require its expected correlation.
 *
 * Safety ceilings are 4 MiB body, 128 brokers, 64 topics, 1024 partitions total and 8192 replica/ISR IDs total.
 * Unknown leader/controller (-1), nullable cluster/rack and native errors are preserved. Cross-field authority,
 * configured topic matching and Admin comparison belong to the qualification caller, not this syntax decoder.
 */
export function decodeMetadata4(bytes: Uint8Array, correlation: number): MetadataType {
  requireValue(Number.isInteger(correlation) && correlation >= 0 && correlation <= 2147483647, "expected correlation");
  requireValue(bytes.length >= 8 && bytes.length <= 4194308, "frame extent");
  const cursor = new Cursor(bytes);
  requireValue(cursor.integer(4) === bytes.length - 4, "length prefix");
  const actual = cursor.integer(4);
  requireValue(actual === correlation, "correlation");
  const throttleMs = cursor.integer(4);
  requireValue(throttleMs >= 0, "throttle");
  const brokers: MetadataBrokerType[] = [], brokerIds = new Set<number>();
  const brokerCount = cursor.count(128, 12);
  for (let at = 0; at < brokerCount; at++) {
    const id = cursor.node(), host = cursor.text(1024), port = cursor.integer(4), rack = cursor.text(1024, true);
    requireValue(host !== null && host.length > 0 && port >= 1 && port <= 65535 && !brokerIds.has(id), "broker fields");
    brokerIds.add(id);
    brokers.push({ id, host, port, rack });
  }
  const cluster = cursor.text(1024, true), controller = cursor.node(true);
  const topics: MetadataTopicType[] = [], topicNames = new Set<string>();
  const topicCount = cursor.count(64, 9);
  let partitionsLeft = 1024, nodesLeft = 8192;
  const nodes = (): readonly number[] => {
    const length = cursor.count(Math.min(nodesLeft, 128), 4), values: number[] = [], seen = new Set<number>();
    nodesLeft -= length;
    for (let at = 0; at < length; at++) {
      const id = cursor.node();
      requireValue(!seen.has(id), "duplicate replica/ISR ID");
      seen.add(id);
      values.push(id);
    }
    return values;
  };
  for (let at = 0; at < topicCount; at++) {
    const error = cursor.integer(2), name = cursor.text(249), flag = cursor.integer(1);
    requireValue(name !== null && name.length > 0 && !topicNames.has(name) && flag <= 1, "topic fields");
    topicNames.add(name);
    const length = cursor.count(partitionsLeft, 18), partitions: MetadataPartitionType[] = [], seen = new Set<number>();
    partitionsLeft -= length;
    for (let index = 0; index < length; index++) {
      const error = cursor.integer(2), partition = cursor.integer(4), leader = cursor.node(true);
      requireValue(partition >= 0 && !seen.has(partition), "partition index");
      seen.add(partition);
      partitions.push({ error, index: partition, leader, replicas: nodes(), isr: nodes() });
    }
    topics.push({ error, name, internal: flag === 1, partitions });
  }
  requireValue(cursor.left === 0, "trailing bytes");
  return { correlation: actual, throttleMs, brokers, cluster, controller, topics };
}
