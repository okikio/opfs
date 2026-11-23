/** Authored protocol peers exercise ownership; these cases are separate from native Kafka qualification. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { withKafkaSession } from "../src/kafka/session.ts";
import type { KafkaChannelType, KafkaSession } from "../src/kafka/session.ts";
import { KafkaClient, KafkaCompletionError, KafkaError, KafkaOutcomeError } from "../src/kafka.ts";

/** Test-only network integers use DataView directly, with no candidate Writer, Reader or framing imports. */
function number(value: number, width: 2 | 4): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(width), view = new DataView(bytes.buffer);
  if (width === 2) view.setInt16(0, value);
  else view.setInt32(0, value);
  return bytes;
}
function long(value: bigint): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigInt64(0, value);
  return bytes;
}
function cat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
function text(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new TextEncoder().encode(value);
  return cat(number(bytes.length, 2), bytes);
}
function response(correlation: number, body: Uint8Array = new Uint8Array()): Uint8Array<ArrayBuffer> {
  return cat(number(body.length + 4, 4), number(correlation, 4), body);
}
function requestInfo(bytes: Uint8Array): { key: number; version: number; correlation: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getInt32(0)).toBe(bytes.length - 4);
  expect(view.getInt16(12)).toBe(4);
  expect(new TextDecoder().decode(bytes.subarray(14, 18))).toBe("opfs");
  return { key: view.getInt16(4), version: view.getInt16(6), correlation: view.getInt32(8) };
}
interface PeerOptionsType {
  readonly security?: "tls" | "plaintext";
  readonly closeError?: Error;
  readonly reply?: (request: Uint8Array, send: (bytes: Uint8Array) => void, end: () => void) => void;
}
/** A close retires the readable even when it subsequently reports an owned failure. */
function peer(options: PeerOptionsType = {}) {
  let controller: ReadableStreamDefaultController<Uint8Array>, ended = false, closes = 0;
  const writes: Uint8Array<ArrayBuffer>[] = [];
  const readable = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const end = (): void => {
    if (!ended) {
      ended = true;
      controller.close();
    }
  };
  const send = (bytes: Uint8Array): void => {
    controller.enqueue(bytes);
  };
  const writable = new WritableStream<Uint8Array>({
    write(bytes) {
      writes.push(new Uint8Array(bytes));
      if (options.reply) options.reply(bytes, send, end);
      else send(response(requestInfo(bytes).correlation, new Uint8Array([8, 9])));
    },
  });
  const channel: KafkaChannelType = {
    security: options.security ?? "tls",
    readable,
    writable,
    async close() {
      closes++;
      end();
      if (options.closeError) throw options.closeError;
    },
  };
  return { channel, writes, send, end, closes: () => closes };
}
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (reason) {
    return reason;
  }
  throw new Error("Expected operation to reject.");
}
function released(channel: KafkaChannelType): void {
  expect(channel.readable.locked).toBe(false);
  expect(channel.writable.locked).toBe(false);
}

describe("Kafka exclusive channel lifecycle", () => {
  it("uses classic headers, local correlations and response bodies under arbitrary transport boundaries", async () => {
    const source = peer({
      reply(request, send) {
        const { key, version, correlation } = requestInfo(request);
        expect(key).toBe(3);
        expect(version).toBe(4);
        const bytes = response(correlation, new Uint8Array([0, 255, 8]));
        for (const byte of bytes) send(new Uint8Array([byte]));
      },
    });
    await withKafkaSession({ openChannel: async () => source.channel }, async (session) => {
      expect(await session.exchange(3, 4, new Uint8Array())).toEqual(new Uint8Array([0, 255, 8]));
      expect(await session.exchange(3, 4, new Uint8Array())).toEqual(new Uint8Array([0, 255, 8]));
    });
    expect(source.writes.map((bytes) => requestInfo(bytes).correlation)).toEqual([1, 2]);
    expect(source.closes()).toBe(1);
    released(source.channel);
  });
  it("snapshots caller input synchronously and returns bytes independent from borrowed transport storage", async () => {
    let borrowed = new Uint8Array();
    const source = peer({
      reply(request, send) {
        expect(request.subarray(18)).toEqual(new Uint8Array([1, 2, 3]));
        borrowed = response(requestInfo(request).correlation, new Uint8Array([7, 8]));
        send(borrowed);
      },
    });
    await withKafkaSession({ openChannel: async () => source.channel }, async (session) => {
      const input = new Uint8Array([1, 2, 3]), pending = session.exchange(3, 4, input);
      input.fill(99);
      const actual = await pending;
      borrowed.fill(0);
      expect(actual).toEqual(new Uint8Array([7, 8]));
    });
  });
  it("refuses implicit plaintext and still closes before releasing locks", async () => {
    const source = peer({ security: "plaintext" });
    await expect(withKafkaSession({ openChannel: async () => source.channel }, async () => {})).rejects.toThrow();
    expect(source.writes).toHaveLength(0);
    expect(source.closes()).toBe(1);
    released(source.channel);
    const allowed = peer({ security: "plaintext" });
    await withKafkaSession({ openChannel: async () => allowed.channel, allowPlaintext: true }, async (session) => {
      await session.exchange(18, 0, new Uint8Array());
    });
    expect(allowed.closes()).toBe(1);
    released(allowed.channel);
  });
  it("binds close before reading a throwing property and preserves primary plus cleanup failure", async () => {
    const primary = new Error("selected property"), cleanup = new Error("selected cleanup"), events: string[] = [];
    const source = peer({ closeError: cleanup });
    const channel: KafkaChannelType = {
      get close() {
        events.push("close");
        return source.channel.close;
      },
      get security(): "tls" | "plaintext" {
        events.push("security");
        throw primary;
      },
      readable: source.channel.readable,
      writable: source.channel.writable,
    };
    const error = await rejection(withKafkaSession({ openChannel: async () => channel }, async () => {}));
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected owned aggregate.");
    expect(error.errors).toEqual([primary, cleanup]);
    expect(events).toEqual(["close", "security"]);
    expect(source.closes()).toBe(1);
    released(channel);
  });
  it("observes cancellation from a foreign property before acquiring stream locks", async () => {
    const controller = new AbortController(), reason = new Error("selected cancellation"), source = peer();
    let reads = 0, writes = 0;
    const channel: KafkaChannelType = {
      close: source.channel.close,
      get security(): "tls" | "plaintext" {
        controller.abort(reason);
        return "tls";
      },
      get readable() {
        reads++;
        return source.channel.readable;
      },
      get writable() {
        writes++;
        return source.channel.writable;
      },
    };
    expect(
      await rejection(
        withKafkaSession({ openChannel: async () => channel, signal: controller.signal }, async () => {}),
      ),
    )
      .toBe(reason);
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    expect(source.closes()).toBe(1);
    released(source.channel);
  });
  it("attempts close after partial lock acquisition and releases the acquired reader", async () => {
    const source = peer(), primary = new Error("writer getter failed");
    const channel: KafkaChannelType = {
      security: "tls",
      readable: source.channel.readable,
      close: source.channel.close,
      get writable(): WritableStream<Uint8Array> {
        throw primary;
      },
    };
    expect(await rejection(withKafkaSession({ openChannel: async () => channel }, async () => {}))).toBe(primary);
    expect(source.closes()).toBe(1);
    released(source.channel);
  });
  it("preserves an undefined primary reason when cleanup independently fails", async () => {
    const cleanup = new Error("cleanup"), source = peer({ closeError: cleanup });
    const error = await rejection(withKafkaSession({ openChannel: async () => source.channel }, async () => {
      throw undefined;
    }));
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected owned aggregate.");
    expect(error.errors).toEqual([undefined, cleanup]);
    released(source.channel);
  });
  it("does not acquire on an already cancelled signal", async () => {
    const controller = new AbortController(), reason = new Error("already cancelled");
    controller.abort(reason);
    let opens = 0;
    expect(
      await rejection(withKafkaSession({
        openChannel: async () => {
          opens++;
          return peer().channel;
        },
        signal: controller.signal,
      }, async () => {})),
    )
      .toBe(reason);
    expect(opens).toBe(0);
  });
  it("leaves late acquisition retirement to the explicit abort-aware opener contract", async () => {
    const controller = new AbortController(), reason = new Error("acquisition cancellation"), source = peer();
    let resolveOpen: (channel: KafkaChannelType) => void = () => {};
    let opened: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const pending = withKafkaSession({
      signal: controller.signal,
      openChannel: ({ signal }) => {
        opened();
        return new Promise<KafkaChannelType>((resolve) => {
          resolveOpen = async (channel) => {
            if (signal.aborted) await channel.close();
            resolve(channel);
          };
        });
      },
    }, async () => {});
    await started;
    controller.abort(reason);
    expect(await rejection(pending)).toBe(reason);
    resolveOpen(source.channel);
    // The opener's close is synchronous up to its resolved promise; no timer or polling is needed.
    expect(source.closes()).toBe(1);
    released(source.channel);
  });
  it("bounds a pending read by operation deadline and independently retires the channel", async () => {
    const source = peer({ reply() {} });
    await expect(withKafkaSession({ openChannel: async () => source.channel, timeoutMs: 10 }, async (session) => {
      await session.exchange(18, 0, new Uint8Array());
    })).rejects.toThrow();
    expect(source.closes()).toBe(1);
    released(source.channel);
  });
  it("bounds hung cleanup independently and releases both stream locks", async () => {
    const source = peer();
    const channel: KafkaChannelType = { ...source.channel, close: () => new Promise<void>(() => {}) };
    await expect(withKafkaSession({ openChannel: async () => channel, cleanupMs: 10 }, async () => 1)).rejects
      .toThrow();
    released(channel);
    source.end();
  });
  it("retires escaped sessions and rejects simultaneous exchanges without a second write", async () => {
    const source = peer();
    let escaped: KafkaSession | undefined;
    await withKafkaSession({ openChannel: async () => source.channel }, async (session) => {
      escaped = session;
      const first = session.exchange(3, 4, new Uint8Array());
      await expect(session.exchange(3, 4, new Uint8Array())).rejects.toThrow();
      await first;
    });
    if (!escaped) throw new Error("Session was not captured.");
    await expect(escaped.exchange(3, 4, new Uint8Array())).rejects.toThrow();
    expect(source.writes).toHaveLength(1);
    released(source.channel);
  });
  it("caps each session at five exchanges and starts new correlations on a fresh channel", async () => {
    const source = peer();
    await withKafkaSession({ openChannel: async () => source.channel }, async (session) => {
      for (let at = 0; at < 5; at++) await session.exchange(18, 0, new Uint8Array());
      await expect(session.exchange(18, 0, new Uint8Array())).rejects.toThrow();
    });
    expect(source.writes).toHaveLength(5);
    const next = peer();
    await withKafkaSession({ openChannel: async () => next.channel }, async (session) => {
      await session.exchange(18, 0, new Uint8Array());
    });
    expect(requestInfo(next.writes[0]!).correlation).toBe(1);
  });
});

describe("Kafka transport admission", () => {
  it("rejects wrong correlations and buffered unsolicited bytes without publishing a response", async () => {
    for (const extra of [false, true]) {
      const source = peer({
        reply(request, send) {
          const correlation = requestInfo(request).correlation;
          send(extra ? cat(response(correlation), response(correlation + 1)) : response(correlation + 1));
        },
      });
      await expect(withKafkaSession({ openChannel: async () => source.channel }, async (session) => {
        await session.exchange(18, 0, new Uint8Array());
      })).rejects.toThrow();
      expect(source.closes()).toBe(1);
      released(source.channel);
    }
  });
  it("refuses EOF in the prefix or body, invalid signed extents and more than sixteen empty chunks", async () => {
    const replies = [new Uint8Array([0, 0]), cat(number(20, 4), number(1, 4)), number(-1, 4), number(4194305, 4)];
    for (const raw of replies) {
      const source = peer({
        reply(_request, send, end) {
          send(raw);
          end();
        },
      });
      await expect(withKafkaSession({ openChannel: async () => source.channel }, async (session) => {
        await session.exchange(18, 0, new Uint8Array());
      })).rejects.toThrow();
      released(source.channel);
    }
    const empty = peer({
      reply(_request, send) {
        for (let at = 0; at < 17; at++) send(new Uint8Array());
      },
    });
    await expect(withKafkaSession({ openChannel: async () => empty.channel }, async (session) => {
      await session.exchange(18, 0, new Uint8Array());
    })).rejects.toThrow();
    released(empty.channel);
  });
  it("refuses a transport chunk above 64 KiB even when the encoded response would fit", async () => {
    const source = peer({
      reply(request, send) {
        send(response(requestInfo(request).correlation, new Uint8Array(65529)));
      },
    });
    await expect(withKafkaSession({ openChannel: async () => source.channel }, async (session) => {
      await session.exchange(18, 0, new Uint8Array());
    })).rejects.toThrow();
    released(source.channel);
  });
  it("admits a 4 MiB response body in bounded chunks and refuses a second frame above the 8 MiB call budget", async () => {
    const source = peer({
      reply(request, send) {
        const bytes = response(requestInfo(request).correlation, new Uint8Array(4194300));
        for (let at = 0; at < bytes.length; at += 65536) send(bytes.subarray(at, at + 65536));
      },
    });
    await expect(withKafkaSession({ openChannel: async () => source.channel }, async (session) => {
      const first = await session.exchange(18, 0, new Uint8Array());
      expect(first.length).toBe(4194300);
      await session.exchange(18, 0, new Uint8Array());
    })).rejects.toThrow();
    expect(source.writes).toHaveLength(2);
    released(source.channel);
  });
  it("refuses an oversized request before dispatch and poisons a failed response stream", async () => {
    const source = peer({
      reply(request, send) {
        send(response(requestInfo(request).correlation + 1));
      },
    });
    let dispatched = false;
    await withKafkaSession({ openChannel: async () => source.channel }, async (session) => {
      await expect(session.exchange(0, 3, new Uint8Array(4194291), () => {
        dispatched = true;
      })).rejects.toThrow();
      expect(dispatched).toBe(false);
      expect(source.writes).toHaveLength(0);
      await expect(session.exchange(18, 0, new Uint8Array())).rejects.toThrow();
      await expect(session.exchange(18, 0, new Uint8Array())).rejects.toThrow();
      expect(source.writes).toHaveLength(1);
    });
    released(source.channel);
  });
});

/** Authored ApiVersions0/Metadata4/Produce3 response bodies; no candidate encoding is used to define expected receipts. */
function nativeBody(key: number, code = 0): Uint8Array<ArrayBuffer> {
  if (key === 18) {
    return cat(
      number(0, 2),
      number(5, 4),
      ...[[18, 0], [3, 4], [0, 3], [1, 4], [2, 1]].map(([key, version]) =>
        cat(number(key!, 2), number(version!, 2), number(version!, 2))
      ),
    );
  }
  if (key === 3) {
    return cat(
      number(0, 4),
      number(1, 4),
      number(1, 4),
      text("inert.example"),
      number(9092, 4),
      number(-1, 2),
      text("cluster"),
      number(1, 4),
      number(1, 4),
      number(0, 2),
      text("owned"),
      new Uint8Array([0]),
      number(1, 4),
      number(0, 2),
      number(0, 4),
      number(1, 4),
      number(1, 4),
      number(1, 4),
      number(1, 4),
      number(1, 4),
    );
  }
  if (key === 0) {
    return cat(
      number(1, 4),
      text("owned"),
      number(1, 4),
      number(0, 4),
      number(code, 2),
      long(23n),
      long(-1n),
      number(0, 4),
    );
  }
  throw new Error("Unexpected authored API.");
}
const records = [{ timestamp: 1700000000000n, key: null, value: new Uint8Array([0, 255]), headers: [] }] as const;
describe("Kafka append outcome and known-result recovery", () => {
  it("marks an unknown outcome when writer.write itself throws synchronously after preflight", async () => {
    const primary = new Error("native writer throw");
    const source = peer({
      reply(request, send) {
        const info = requestInfo(request);
        send(response(info.correlation, nativeBody(info.key)));
      },
    });
    const acquire = source.channel.writable.getWriter.bind(source.channel.writable);
    Object.defineProperty(source.channel.writable, "getWriter", {
      value() {
        const writer = acquire(), write = writer.write.bind(writer);
        Object.defineProperty(writer, "write", {
          value(bytes: Uint8Array) {
            if (requestInfo(bytes).key === 0) throw primary;
            return write(bytes);
          },
        });
        return writer;
      },
    });
    const client = new KafkaClient({
      openChannel: async () => source.channel,
      topic: "owned",
      partition: 0,
      brokerId: 1,
    });
    const error = await rejection(client.append(records));
    expect(error).toBeInstanceOf(KafkaOutcomeError);
    if (!(error instanceof KafkaOutcomeError)) throw new Error("Expected unknown append.");
    expect(error.outcome).toBe("unknown");
    expect(error.cause).toBe(primary);
    expect(source.writes.map((request) => requestInfo(request).key)).toEqual([18, 3]);
    released(source.channel);
  });
  it("retains acknowledged offsets when independent cleanup fails", async () => {
    const cleanup = new Error("channel cleanup");
    const source = peer({
      closeError: cleanup,
      reply(request, send) {
        const info = requestInfo(request);
        send(response(info.correlation, nativeBody(info.key)));
      },
    });
    const client = new KafkaClient({
      openChannel: async () => source.channel,
      topic: "owned",
      partition: 0,
      brokerId: 1,
    });
    const error = await rejection(client.append(records));
    expect(error).toBeInstanceOf(KafkaCompletionError);
    if (!(error instanceof KafkaCompletionError)) throw new Error("Expected known append receipt.");
    expect(error.receipt).toEqual({
      topic: "owned",
      partition: 0,
      baseOffset: 23n,
      count: 1,
      logAppendTime: -1n,
      throttleMs: 0,
    });
    expect(error.cause).toBe(cleanup);
    released(source.channel);
  });
  it("keeps a complete native nonzero Produce result unknown instead of granting retry permission", async () => {
    const source = peer({
      reply(request, send) {
        const info = requestInfo(request);
        send(response(info.correlation, nativeBody(info.key, 20)));
      },
    });
    const client = new KafkaClient({
      openChannel: async () => source.channel,
      topic: "owned",
      partition: 0,
      brokerId: 1,
    });
    const error = await rejection(client.append(records));
    expect(error).toBeInstanceOf(KafkaOutcomeError);
    if (!(error instanceof KafkaOutcomeError)) throw new Error("Expected unknown append.");
    expect(error.outcome).toBe("unknown");
    expect(error.cause).toBeInstanceOf(KafkaError);
    if (!(error.cause instanceof KafkaError)) throw new Error("Expected retained native Produce observation.");
    expect(error.cause.operation).toBe("append");
    expect(error.cause.code).toBe(20);
    expect(error.cause.observation).toEqual({ baseOffset: 23n, logAppendTime: -1n, throttleMs: 0, count: 1 });
    expect(source.writes.map((request) => requestInfo(request).key)).toEqual([18, 3, 0]);
    released(source.channel);
  });
});

/** Complete authored Metadata4 fields; returned hosts are observations, never dial authority. */
function metadataControl(options: {
  readonly topic?: string;
  readonly error?: number;
  readonly partitionError?: number;
  readonly leader?: number;
  readonly brokerIds?: readonly number[];
  readonly partitions?: readonly number[];
  readonly replicas?: readonly number[];
  readonly isr?: readonly number[];
  readonly flag?: number;
  readonly port?: number;
  readonly nullable?: boolean;
} = {}): Uint8Array<ArrayBuffer> {
  const brokers = options.brokerIds ?? [1], partitions = options.partitions ?? [0];
  const replicas = options.replicas ?? [1], isr = options.isr ?? [1];
  return cat(
    number(0, 4),
    number(brokers.length, 4),
    ...brokers.map((id) => cat(number(id, 4), text("inert.example"), number(options.port ?? 9092, 4), number(-1, 2))),
    options.nullable ? number(-1, 2) : text("cluster"),
    number(options.nullable ? -1 : 1, 4),
    number(1, 4),
    number(options.error ?? 0, 2),
    text(options.topic ?? "owned"),
    Uint8Array.of(options.flag ?? 0),
    number(partitions.length, 4),
    ...partitions.map((partition) =>
      cat(
        number(options.partitionError ?? 0, 2),
        number(partition, 4),
        number(options.leader ?? 1, 4),
        number(replicas.length, 4),
        ...replicas.map((id) => number(id, 4)),
        number(isr.length, 4),
        ...isr.map((id) => number(id, 4)),
      )
    ),
  );
}
/** Common attributable response prefix for classic ListOffsets1 and Fetch4. */
function selected(topic = "owned", partition = 0): Uint8Array<ArrayBuffer> {
  return cat(number(1, 4), text(topic), number(1, 4), number(partition, 4));
}
function offsetControl(
  timestamp = -1n,
  offset = 23n,
  code = 0,
  topic = "owned",
  partition = 0,
): Uint8Array<ArrayBuffer> {
  return cat(selected(topic, partition), number(code, 2), long(timestamp), long(offset));
}
function fetchControl(options: {
  readonly code?: number;
  readonly high?: bigint;
  readonly stable?: bigint;
  readonly topic?: string;
  readonly partition?: number;
  readonly records?: Uint8Array | null;
  readonly aborted?: readonly { readonly producer: bigint; readonly offset: bigint }[];
} = {}): Uint8Array<ArrayBuffer> {
  const data = options.records ?? new Uint8Array(), aborted = options.aborted;
  return cat(
    number(0, 4),
    selected(options.topic, options.partition),
    number(options.code ?? 0, 2),
    long(options.high ?? 30n),
    long(options.stable ?? -1n),
    number(aborted === undefined ? -1 : aborted.length, 4),
    ...(aborted ?? []).map((entry) => cat(long(entry.producer), long(entry.offset))),
    number(options.records === null ? -1 : data.length, 4),
    data,
  );
}
/** Fixed null-key/null-value batch for an adversarial Fetch page, independent of the candidate encoder. */
function nullBatch(): Uint8Array<ArrayBuffer> {
  const body = cat(
    number(0, 2),
    number(0, 4),
    long(100n),
    long(100n),
    long(-1n),
    number(-1, 2),
    number(-1, 4),
    number(1, 4),
    Uint8Array.of(12, 0, 0, 0, 1, 1, 0),
  );
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  const tail = cat(number(-1, 4), Uint8Array.of(2), number((crc ^ 0xffffffff) >>> 0, 4), body);
  return cat(long(0n), number(tail.length, 4), tail);
}
/** Each test peer supplies one fixed API-specific observation with ordinary successful preflight. */
function clientPeer(operation: number, body: Uint8Array, metadata = metadataControl()) {
  const source = peer({
    reply(request, send) {
      const info = requestInfo(request);
      const value = info.key === operation ? body : info.key === 3 ? metadata : nativeBody(info.key);
      send(response(info.correlation, value));
    },
  });
  const client = new KafkaClient({
    openChannel: async () => source.channel,
    topic: "owned",
    partition: 0,
    brokerId: 1,
  });
  return { ...source, client };
}

describe("Kafka selected API observations and refusal", () => {
  it("returns nullable Metadata observations and native error fields without dialing observed endpoints", async () => {
    const source = clientPeer(3, metadataControl({ nullable: true, leader: -1, error: -1, partitionError: 6 }));
    const value = await source.client.metadata();
    expect(value.clusterId).toBeNull();
    expect(value.controllerId).toBe(-1);
    expect(value.error).toBe(-1);
    expect(value.partitions[0]!.leader).toBe(-1);
    expect(value.partitions[0]!.error).toBe(6);
    expect(value.brokers[0]!.host).toBe("inert.example");
    expect(source.writes.map((request) => requestInfo(request).key)).toEqual([18, 3]);
    expect(source.closes()).toBe(1);
    released(source.channel);
  });
  it("refuses duplicate Metadata identities, invalid broker fields, topic mismatch, flags and trailing bytes", async () => {
    const invalidUtf8 = metadataControl();
    invalidUtf8[14] = 255;
    const controls = [
      metadataControl({ brokerIds: [1, 1] }),
      metadataControl({ partitions: [0, 0] }),
      metadataControl({ replicas: [1, 1] }),
      metadataControl({ isr: [1, 1] }),
      metadataControl({ port: 0 }),
      metadataControl({ topic: "other" }),
      metadataControl({ flag: 2 }),
      invalidUtf8,
      cat(metadataControl(), Uint8Array.of(0)),
    ];
    for (const body of controls) {
      const source = clientPeer(3, body);
      await expect(source.client.metadata()).rejects.toThrow();
      expect(source.writes.map((request) => requestInfo(request).key)).toEqual([18, 3]);
      expect(source.closes()).toBe(1);
      released(source.channel);
    }
  });
  it("keeps native preflight errors attributable and refuses Produce before dispatch", async () => {
    for (const body of [metadataControl({ error: 5 }), metadataControl({ partitionError: 6 })]) {
      const source = clientPeer(3, body), error = await rejection(source.client.append(records));
      expect(error).toBeInstanceOf(KafkaError);
      expect(error).not.toBeInstanceOf(KafkaOutcomeError);
      if (!(error instanceof KafkaError)) throw new Error("Expected attributable metadata refusal.");
      expect(error.operation).toBe("metadata");
      expect([5, 6]).toContain(error.code);
      expect(error.observation).toMatchObject({ topic: "owned", partitions: [{ index: 0 }] });
      expect(source.writes.map((request) => requestInfo(request).key)).toEqual([18, 3]);
      released(source.channel);
    }
  });
  it("refuses unknown or different leaders, absent configured brokers and absent configured partitions before Produce", async () => {
    for (
      const body of [
        metadataControl({ leader: -1 }),
        metadataControl({ leader: 2 }),
        metadataControl({ brokerIds: [2] }),
        metadataControl({ partitions: [1] }),
      ]
    ) {
      const source = clientPeer(3, body), error = await rejection(source.client.append(records));
      expect(error).not.toBeInstanceOf(KafkaOutcomeError);
      expect(source.writes.map((request) => requestInfo(request).key)).toEqual([18, 3]);
      expect(source.closes()).toBe(1);
      released(source.channel);
    }
  });
  it("preserves signed native ApiVersions refusal and stops before Metadata", async () => {
    const body = nativeBody(18);
    new DataView(body.buffer).setInt16(0, -1);
    const source = clientPeer(18, body), error = await rejection(source.client.metadata());
    expect(error).toBeInstanceOf(KafkaError);
    if (!(error instanceof KafkaError)) throw new Error("Expected native version refusal.");
    expect(error.operation).toBe("versions");
    expect(error.code).toBe(-1);
    expect(error.observation).toEqual({
      versions: [[18, 0], [3, 4], [0, 3], [1, 4], [2, 1]].map(([key, version]) => ({
        key,
        minimum: version,
        maximum: version,
      })),
    });
    expect(source.writes).toHaveLength(1);
    released(source.channel);
  });
  it("rejects duplicate or unsupported API ranges before any selected operation", async () => {
    const duplicate = cat(
      number(0, 2),
      number(2, 4),
      number(18, 2),
      number(0, 2),
      number(0, 2),
      number(18, 2),
      number(0, 2),
      number(0, 2),
    );
    const unsupported = nativeBody(18);
    // Second range is Metadata; this peer admits version5 only, while the client requires exactly version4.
    new DataView(unsupported.buffer).setInt16(14, 5);
    new DataView(unsupported.buffer).setInt16(16, 5);
    for (const body of [duplicate, unsupported]) {
      const source = clientPeer(18, body);
      await expect(source.client.metadata()).rejects.toThrow();
      expect(source.writes).toHaveLength(1);
      released(source.channel);
    }
  });
  it("accepts the native -1 offset timestamp sentinel and preserves bigint offsets beyond Number precision", async () => {
    for (const position of ["earliest", "latest"] as const) {
      const source = clientPeer(2, offsetControl(-1n, 9007199254740993n));
      const value = await source.client.offset(position);
      expect(value.timestamp).toBe(-1n);
      expect(value.offset).toBe(9007199254740993n);
      const request = source.writes[2]!;
      expect(new DataView(request.buffer, request.byteOffset, request.byteLength).getBigInt64(request.length - 8)).toBe(
        position === "earliest" ? -2n : -1n,
      );
      released(source.channel);
    }
    for (const timestamp of [-2n, 0n, 100n]) {
      const invalid = clientPeer(2, offsetControl(timestamp));
      await expect(invalid.client.offset("latest")).rejects.toThrow();
      released(invalid.channel);
    }
  });
  it("retains native offset error observations before applying success-only timestamp and offset rules", async () => {
    const source = clientPeer(2, offsetControl(-2n, -1n, -1)), error = await rejection(source.client.offset("latest"));
    expect(error).toBeInstanceOf(KafkaError);
    if (!(error instanceof KafkaError)) throw new Error("Expected native offset refusal.");
    expect(error.operation).toBe("offset");
    expect(error.code).toBe(-1);
    expect(error.observation).toEqual({ timestamp: -2n, offset: -1n });
    released(source.channel);
  });
  it("keeps a positive timestamp from a native nonzero offset response as error evidence", async () => {
    const source = clientPeer(2, offsetControl(100n, -1n, 5)),
      error = await rejection(source.client.offset("earliest"));
    expect(error).toBeInstanceOf(KafkaError);
    if (!(error instanceof KafkaError)) throw new Error("Expected native offset refusal.");
    expect(error.code).toBe(5);
    expect(error.observation).toEqual({ timestamp: 100n, offset: -1n });
    released(source.channel);
  });
  it("marks an unattributable Produce acknowledgement unknown rather than publishing its offsets", async () => {
    const source = clientPeer(0, cat(selected("other"), number(0, 2), long(23n), long(-1n), number(0, 4)));
    const error = await rejection(source.client.append(records));
    expect(error).toBeInstanceOf(KafkaOutcomeError);
    expect(error).not.toBeInstanceOf(KafkaCompletionError);
    expect(source.writes.map((request) => requestInfo(request).key)).toEqual([18, 3, 0]);
    released(source.channel);
  });
  it("rejects successful offset/fetch results attributed to a different topic or partition", async () => {
    for (const identity of [{ topic: "other", partition: 0 }, { topic: "owned", partition: 1 }]) {
      const offset = clientPeer(2, offsetControl(-1n, 23n, 0, identity.topic, identity.partition));
      await expect(offset.client.offset("latest")).rejects.toThrow();
      released(offset.channel);
      const fetch = clientPeer(1, fetchControl(identity));
      await expect(fetch.client.fetch(23n)).rejects.toThrow();
      released(fetch.channel);
    }
  });
  it("preserves native Fetch error fields and aborted transactions without claiming a successful supported profile", async () => {
    const source = clientPeer(
      1,
      fetchControl({ code: 5, high: -1n, stable: -1n, records: null, aborted: [{ producer: 77n, offset: -2n }] }),
    );
    const error = await rejection(source.client.fetch(23n));
    expect(error).toBeInstanceOf(KafkaError);
    if (!(error instanceof KafkaError)) throw new Error("Expected native fetch refusal.");
    expect(error.operation).toBe("fetch");
    expect(error.code).toBe(5);
    expect(error.observation).toEqual({
      highWatermark: -1n,
      lastStableOffset: -1n,
      throttleMs: 0,
      recordsState: "null",
      abortedTransactions: [{ producerId: 77n, firstOffset: -2n }],
    });
    released(source.channel);
  });
  it("retains a null or empty record-set cursor without treating the high watermark as permanent EOF", async () => {
    for (const records of [null, new Uint8Array()]) {
      const source = clientPeer(1, fetchControl({ high: 100n, records }));
      const value = await source.client.fetch(23n);
      expect(value.nextOffset).toBe(23n);
      expect(value.records).toEqual([]);
      expect(value.highWatermark).toBe(100n);
      expect(value.lastStableOffset).toBe(-1n);
      expect(value.recordsState).toBe(records === null ? "null" : "present");
      released(source.channel);
    }
  });
  it("refuses transactional success profiles and malformed late batches without publishing a cursor or completion receipt", async () => {
    const valid = clientPeer(1, fetchControl({ records: nullBatch() }));
    const baseline = await valid.client.fetch(0n);
    expect(baseline.nextOffset).toBe(1n);
    expect(baseline.records).toEqual([{ offset: 0n, timestamp: 100n, key: null, value: null, headers: [] }]);
    released(valid.channel);
    const pages = [
      fetchControl({ aborted: [{ producer: 1n, offset: 0n }] }),
      fetchControl({ records: cat(nullBatch(), Uint8Array.of(0)) }),
    ];
    for (const body of pages) {
      const source = clientPeer(1, body), error = await rejection(source.client.fetch(0n));
      expect(error).not.toBeInstanceOf(KafkaCompletionError);
      expect(error).not.toBeInstanceOf(KafkaOutcomeError);
      expect(source.writes.map((request) => requestInfo(request).key)).toEqual([18, 3, 1]);
      expect(source.closes()).toBe(1);
      released(source.channel);
    }
  });
  it("snapshots append payload and nested headers before the channel opener can resolve", async () => {
    let grant: (value: KafkaChannelType) => void = () => {
      throw new Error("Acquisition promise is not initialized.");
    };
    const acquired = new Promise<KafkaChannelType>((resolve) => {
      grant = resolve;
    });
    const value = Uint8Array.of(7, 8), header = Uint8Array.of(9), headers = [{ name: "x", value: header }];
    const source = peer({
      reply(request, send) {
        const info = requestInfo(request);
        if (info.key === 0) {
          // The fixed topic/header lengths place the sole serialized record after byte110.
          expect(request.subarray(110)).toEqual(Uint8Array.of(24, 0, 0, 0, 1, 4, 7, 8, 2, 2, 120, 2, 9));
        }
        send(response(info.correlation, nativeBody(info.key)));
      },
    });
    const client = new KafkaClient({ openChannel: async () => acquired, topic: "owned", partition: 0, brokerId: 1 });
    const pending = client.append([{ timestamp: 100n, key: null, value, headers }]);
    value.fill(0);
    header.fill(0);
    headers.push({ name: "later", value: header });
    grant(source.channel);
    expect((await pending).count).toBe(1);
    expect(source.writes.map((request) => requestInfo(request).key)).toEqual([18, 3, 0]);
    released(source.channel);
  });
  it("combines client and request cancellation instead of letting a request signal replace lifetime cancellation", async () => {
    for (const cancelled of ["client", "request"] as const) {
      const lifetime = new AbortController(), request = new AbortController(), reason = new Error(cancelled);
      let acquired = 0;
      const client = new KafkaClient({
        openChannel: async () => {
          acquired++;
          throw new Error("Must not acquire.");
        },
        topic: "owned",
        partition: 0,
        brokerId: 1,
        signal: lifetime.signal,
      });
      (cancelled === "client" ? lifetime : request).abort(reason);
      expect(await rejection(client.fetch(0n, { signal: request.signal }))).toBe(reason);
      expect(acquired).toBe(0);
    }
  });
});
