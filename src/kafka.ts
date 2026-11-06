/** Explicit-partition Kafka classic APIs. No transport, credentials, retry loop or filesystem is discovered. @module */
import { Reader, Writer } from "./kafka/wire.ts";
import { decodeRecords, encodeBatch, recordLimits, snapshotRecords } from "./kafka/records.ts";
import type { KafkaRecordLimitsType, KafkaRecordType } from "./kafka/records.ts";
import { withKafkaSession } from "./kafka/session.ts";
import type { KafkaSession, KafkaSessionOptionsType } from "./kafka/session.ts";
export type { KafkaChannelType } from "./kafka/session.ts";
export type { KafkaFetchedRecordType, KafkaHeaderType, KafkaRecordType } from "./kafka/records.ts";

/** The caller authorizes one topic, partition and broker on an already authenticated exclusive channel. */
export interface KafkaOptionsType extends KafkaSessionOptionsType, KafkaRecordLimitsType {
  readonly topic: string;
  readonly partition: number;
  readonly brokerId: number;
}
/** An operation may add cancellation authority; it cannot replace the client's lifetime signal. */
export interface KafkaRequestType {
  readonly signal?: AbortSignal;
}
/** Returned endpoint strings are observations, never permission for this client to open a connection. */
export interface KafkaBrokerType {
  readonly id: number;
  readonly host: string;
  readonly port: number;
  readonly rack: string | null;
}
/** One native partition observation; replica assignment order and current ISR membership remain separate facts. */
export interface KafkaPartitionType {
  readonly index: number;
  readonly error: number;
  readonly leader: number;
  readonly replicas: readonly number[];
  readonly isr: readonly number[];
}
/** Metadata4 has no leader epoch. Unknown controller/leader IDs remain -1. */
export interface KafkaMetadataType {
  readonly throttleMs: number;
  readonly clusterId: string | null;
  readonly controllerId: number;
  readonly brokers: readonly KafkaBrokerType[];
  readonly topic: string;
  readonly error: number;
  readonly internal: boolean;
  readonly partitions: readonly KafkaPartitionType[];
}
/** An all-ISR acknowledgement is not indefinite retention, exactly-once delivery or replicated durability on one broker. */
export interface KafkaReceiptType {
  readonly topic: string;
  readonly partition: number;
  readonly baseOffset: bigint;
  readonly count: number;
  readonly logAppendTime: bigint;
  readonly throttleMs: number;
}
/** The latest consumer offset is the high watermark, not the unreplicated log end. */
export interface KafkaOffsetType {
  readonly topic: string;
  readonly partition: number;
  readonly position: "earliest" | "latest";
  readonly offset: bigint;
  readonly timestamp: bigint;
}
/** Pages without batch boundaries retain the cursor. Empty compacted batches can advance it; neither is permanent EOF. */
export interface KafkaPageType extends ReturnType<typeof decodeRecords> {
  readonly topic: string;
  readonly partition: number;
  readonly highWatermark: bigint;
  readonly lastStableOffset: bigint;
  readonly throttleMs: number;
  readonly recordsState: "null" | "present";
}
type ResultType = KafkaMetadataType | KafkaReceiptType | KafkaOffsetType | KafkaPageType;
/** A complete native refusal retains its numeric code and selected observation without echoing provider strings. */
export class KafkaError extends Error {
  readonly operation: string;
  readonly code: number;
  readonly observation: unknown;
  constructor(operation: string, code: number, observation?: unknown) {
    super("Kafka refused the selected operation.");
    this.name = "KafkaError";
    this.operation = operation;
    this.code = code;
    this.observation = observation;
  }
}
/** Produce was handed to the transport. Reconcile before retrying, including after a native nonzero response. */
export class KafkaOutcomeError extends Error {
  readonly outcome = "unknown";
  constructor(cause: unknown) {
    super("Kafka append outcome is unknown; reconcile before retrying.", { cause });
    this.name = "KafkaOutcomeError";
  }
}
/** A parsed result survived a later cancellation or retirement failure. Retain it for recovery. */
export class KafkaCompletionError extends Error {
  readonly receipt: ResultType;
  constructor(receipt: ResultType, cause: unknown) {
    super("Kafka returned a known result, but channel retirement or cancellation failed.", { cause });
    this.name = "KafkaCompletionError";
    this.receipt = receipt;
  }
}
function requireValue(value: boolean, message: string): asserts value {
  if (!value) throw new TypeError(`Malformed or unsupported Kafka ${message}.`);
}
function integer(value: number, minimum = 0): number {
  if (!Number.isInteger(value) || value < minimum || value > 2147483647) throw new RangeError("Invalid Kafka integer.");
  return value;
}
function throttle(reader: Reader): number {
  return integer(reader.int());
}
/** Validate collections before iteration; replica order remains distinct from ISR membership. */
function nodes(reader: Reader): number[] {
  const count = reader.arrayLength(4, false, 128), result: number[] = [], seen = new Set<number>();
  for (let at = 0; at < count; at++) {
    const id = integer(reader.int());
    requireValue(!seen.has(id), "duplicate node ID");
    seen.add(id);
    result.push(id);
  }
  return result;
}
/** Parse independently of the test fixture decoder, requiring exactly the requested topic. */
function metadata(bytes: Uint8Array, topic: string): KafkaMetadataType {
  const reader = new Reader(bytes), throttleMs = throttle(reader), count = reader.arrayLength(12, false, 128);
  const brokers: KafkaBrokerType[] = [], seen = new Set<number>();
  for (let at = 0; at < count; at++) {
    const id = integer(reader.int()), host = reader.text(), port = reader.int(), rack = reader.text(true);
    requireValue(
      !seen.has(id) && host.length > 0 && host.length <= 1024 && (rack?.length ?? 0) <= 1024 && port >= 1 &&
        port <= 65535,
      "broker fields",
    );
    seen.add(id);
    brokers.push({ id, host, port, rack });
  }
  const clusterId = reader.text(true), controllerId = integer(reader.int(), -1);
  requireValue((clusterId?.length ?? 0) <= 1024 && reader.arrayLength(9, false, 1) === 1, "metadata topic extent");
  const error = reader.short(), actual = reader.text(), flag = reader.byte();
  requireValue(actual === topic && flag <= 1, "metadata topic identity");
  const length = reader.arrayLength(18, false, 1024),
    partitions: KafkaPartitionType[] = [],
    indexes = new Set<number>();
  let remainingNodes = 8192;
  for (let at = 0; at < length; at++) {
    const error = reader.short(), index = integer(reader.int()), leader = integer(reader.int(), -1);
    requireValue(!indexes.has(index), "duplicate partition");
    indexes.add(index);
    const replicas = nodes(reader), isr = nodes(reader);
    remainingNodes -= replicas.length + isr.length;
    requireValue(remainingNodes >= 0, "metadata node allocation policy");
    partitions.push({ index, error, leader, replicas, isr });
  }
  reader.done();
  return { throttleMs, clusterId, controllerId, brokers, topic, error, internal: flag === 1, partitions };
}
/** Fixed classic versions avoid silent downgrade or flexible-response guessing. */
async function versions(session: KafkaSession): Promise<void> {
  const reader = new Reader(await session.exchange(18, 0, new Uint8Array())), error = reader.short();
  const count = reader.arrayLength(6, false, 256), entries = new Map<number, readonly [number, number]>();
  for (let at = 0; at < count; at++) {
    const key = reader.short(), low = reader.short(), high = reader.short();
    requireValue(key >= 0 && low >= 0 && high >= low && !entries.has(key), "API version ranges");
    entries.set(key, [low, high]);
  }
  reader.done();
  if (error !== 0) {
    throw new KafkaError("versions", error, {
      versions: [...entries].map(([key, [minimum, maximum]]) => ({ key, minimum, maximum })),
    });
  }
  for (const [key, selected] of [[18, 0], [3, 4], [0, 3], [1, 4], [2, 1]] as const) {
    const range = entries.get(key);
    requireValue(!!range && range[0] <= selected && range[1] >= selected, "API version profile");
  }
}
/** A fresh channel per call prevents hidden retry, stateful discovery and cross-call correlation authority. */
export class KafkaClient {
  readonly #topic: string;
  readonly #partition: number;
  readonly #broker: number;
  readonly #session: KafkaSessionOptionsType;
  readonly #limits: KafkaRecordLimitsType;
  constructor(options: KafkaOptionsType) {
    const topic = options.topic;
    if (typeof topic !== "string" || !/^[A-Za-z0-9._-]{1,249}$/.test(topic) || topic === "." || topic === "..") {
      throw new TypeError("Invalid Kafka topic.");
    }
    this.#topic = topic;
    this.#partition = integer(options.partition);
    this.#broker = integer(options.brokerId);
    const acquire = options.openChannel;
    if (typeof acquire !== "function") throw new TypeError("Kafka requires an explicit channel opener.");
    const { signal, timeoutMs, cleanupMs, allowPlaintext, maxBytes, maxRecords, maxHeaders, maxRecordHeaders } =
      options;
    this.#session = {
      openChannel: acquire.bind(options),
      ...(signal === undefined ? {} : { signal }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(cleanupMs === undefined ? {} : { cleanupMs }),
      ...(allowPlaintext === undefined ? {} : { allowPlaintext }),
    };
    this.#limits = recordLimits({
      ...(maxBytes === undefined ? {} : { maxBytes }),
      ...(maxRecords === undefined ? {} : { maxRecords }),
      ...(maxHeaders === undefined ? {} : { maxHeaders }),
      ...(maxRecordHeaders === undefined ? {} : { maxRecordHeaders }),
    });
  }
  /**
   * Retain a completely admitted result before session retirement can fail.
   * Dispatch without such a result leaves append uncertain, even when close or
   * cancellation also fails; cleanup cannot roll back bytes handed to the writer.
   */
  async #call<T extends ResultType>(
    action: (session: KafkaSession, remember: (value: T) => void, dispatch: () => void) => Promise<T>,
    options: KafkaRequestType,
    append = false,
  ): Promise<T> {
    const requestSignal = options.signal, lifetime = this.#session.signal;
    const signal = requestSignal && lifetime ? AbortSignal.any([requestSignal, lifetime]) : requestSignal ?? lifetime;
    let receipt: T | undefined, dispatched = false;
    try {
      return await withKafkaSession(
        { ...this.#session, ...(signal === undefined ? {} : { signal }) },
        (session) =>
          action(session, (value) => {
            receipt = value;
          }, () => {
            dispatched = true;
          }),
      );
    } catch (reason) {
      if (receipt !== undefined) throw new KafkaCompletionError(receipt, reason);
      if (append && dispatched) throw new KafkaOutcomeError(reason);
      throw reason;
    }
  }
  async #metadata(session: KafkaSession): Promise<KafkaMetadataType> {
    await versions(session);
    return metadata(await session.exchange(3, 4, new Writer().int(1).text(this.#topic).byte(0).finish()), this.#topic);
  }
  async #preflight(session: KafkaSession): Promise<void> {
    const value = await this.#metadata(session);
    if (value.error !== 0) throw new KafkaError("metadata", value.error, value);
    const partition = value.partitions.find((entry) => entry.index === this.#partition);
    requireValue(partition !== undefined, "configured partition absent");
    if (partition.error !== 0) throw new KafkaError("metadata", partition.error, value);
    requireValue(
      partition.leader === this.#broker && value.brokers.some((broker) => broker.id === this.#broker),
      "configured broker is not the observed leader",
    );
  }
  /**
   * Observe one selected topic without dialing returned hosts or asserting a future leadership lease.
   * Native topic and partition errors remain observation fields; transport and malformed-response failures reject.
   */
  metadata(options: KafkaRequestType = {}): Promise<KafkaMetadataType> {
    return this.#call(async (session, remember) => {
      const result = await this.#metadata(session);
      remember(result);
      return result;
    }, options);
  }
  /** Read the earliest retained position or latest consumer high watermark; no group offset is changed. */
  offset(position: "earliest" | "latest", options: KafkaRequestType = {}): Promise<KafkaOffsetType> {
    if (position !== "earliest" && position !== "latest") throw new TypeError("Invalid Kafka offset position.");
    return this.#call(async (session, remember) => {
      await this.#preflight(session);
      const body = new Writer().int(-1).int(1).text(this.#topic).int(1).int(this.#partition).long(
        position === "earliest" ? -2n : -1n,
      ).finish();
      const reader = new Reader(await session.exchange(2, 1, body));
      this.#partitionResponse(reader);
      const error = reader.short(), timestamp = reader.long(), offset = reader.long();
      reader.done();
      if (error !== 0) throw new KafkaError("offset", error, { timestamp, offset });
      requireValue(timestamp === -1n && offset >= 0n, "earliest/latest offset success fields");
      const result = { topic: this.#topic, partition: this.#partition, position, offset, timestamp };
      remember(result);
      return result;
    }, options);
  }
  /** Require one attributable topic and partition before interpreting any selected operation's native result. */
  #partitionResponse(reader: Reader): void {
    requireValue(
      reader.arrayLength(6, false, 1) === 1 && reader.text() === this.#topic && reader.arrayLength(4, false, 1) === 1 &&
        reader.int() === this.#partition,
      "partition response identity",
    );
  }
  /** Copy records before yielding, then dispatch one non-idempotent batch with acks=-1. Never retries an unknown outcome. */
  append(records: readonly KafkaRecordType[], options: KafkaRequestType = {}): Promise<KafkaReceiptType> {
    const captured = snapshotRecords(records, this.#limits);
    requireValue(captured.length > 0, "empty append");
    const batch = encodeBatch(captured, this.#limits);
    const body = new Writer().text(null).short(-1).int(10000).int(1).text(this.#topic).int(1).int(this.#partition)
      .bytes(batch).finish();
    return this.#call(
      async (session, remember, dispatch) => {
        await this.#preflight(session);
        const reader = new Reader(await session.exchange(0, 3, body, dispatch));
        this.#partitionResponse(reader);
        const error = reader.short(),
          baseOffset = reader.long(),
          logAppendTime = reader.long(),
          throttleMs = throttle(reader);
        reader.done();
        if (error !== 0) {
          throw new KafkaError("append", error, {
            baseOffset,
            logAppendTime,
            throttleMs,
            count: captured.length,
          });
        }
        requireValue(
          baseOffset >= 0n && baseOffset + BigInt(captured.length - 1) <= 9223372036854775807n && logAppendTime >= -1n,
          "append success fields",
        );
        const result = {
          topic: this.#topic,
          partition: this.#partition,
          baseOffset,
          count: captured.length,
          logAppendTime,
          throttleMs,
        };
        remember(result);
        return result;
      },
      options,
      true,
    );
  }
  /** Materialize one completely checked uncompressed CreateTime page. A refused page returns neither records nor cursor. */
  fetch(offset: bigint, options: KafkaRequestType = {}): Promise<KafkaPageType> {
    if (typeof offset !== "bigint" || offset < 0n || offset > 9223372036854775807n) {
      throw new RangeError("Invalid Kafka fetch offset.");
    }
    return this.#call(async (session, remember) => {
      await this.#preflight(session);
      const body = new Writer().int(-1).int(1000).int(1).int(4194304).byte(0).int(1).text(this.#topic).int(1).int(
        this.#partition,
      ).long(offset).int(4194304).finish();
      const reader = new Reader(await session.exchange(1, 4, body)), throttleMs = throttle(reader);
      this.#partitionResponse(reader);
      const error = reader.short(), highWatermark = reader.long(), lastStableOffset = reader.long();
      const aborted = reader.arrayLength(16, true, 1024);
      const abortedTransactions = aborted === null ? null : [] as { producerId: bigint; firstOffset: bigint }[];
      for (let index = 0; index < (aborted ?? 0); index++) {
        abortedTransactions!.push({ producerId: reader.long(), firstOffset: reader.long() });
      }
      const length = reader.int();
      requireValue(length >= -1 && length <= reader.remaining, "record-set extent");
      const recordsState = length === -1 ? "null" : "present",
        bytes = length === -1 ? new Uint8Array() : reader.take(length);
      reader.done();
      if (error !== 0) {
        throw new KafkaError("fetch", error, {
          highWatermark,
          lastStableOffset,
          throttleMs,
          recordsState,
          abortedTransactions,
        });
      }
      requireValue(aborted === null || aborted === 0, "transactional fetch profile");
      requireValue(highWatermark >= 0n && lastStableOffset >= -1n, "fetch success fields");
      const page = decodeRecords(bytes, offset, this.#limits);
      const result: KafkaPageType = {
        ...page,
        topic: this.#topic,
        partition: this.#partition,
        highWatermark,
        lastStableOffset,
        throttleMs,
        recordsState,
      };
      remember(result);
      return result;
    }, options);
  }
}
/** Construction captures policy only; the first explicit operation acquires transport. */
export function createKafkaClient(options: KafkaOptionsType): KafkaClient {
  return new KafkaClient(options);
}
