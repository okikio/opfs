/** Installed messaging kafka contracts. Each case owns its state and exact source oracle. */
import { describe, it } from "node:test";
import {
  createKafkaClient,
  KafkaClient,
  KafkaCompletionError,
  KafkaError,
  KafkaOutcomeError,
} from "@okikio/opfs/kafka";

describe("packed messaging kafka", () => {
  it("Kafka classic wire, cancellation and publication outcomes", async () => {
    // Authored classic response bytes make the packed-path check independent of candidate encoders.
    // Fresh native SDK interoperability is qualified separately; this peer proves no broker behavior.
    /** Join independently authored wire fields without importing the candidate Kafka serializer. */
    const kafkaCat = (...parts) => {
      const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
      let at = 0;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.length;
      }
      return bytes;
    };
    /** Encode signed classic Kafka integer fields in network byte order. */
    const kafkaInt = (value, width = 4) => {
      const bytes = new Uint8Array(width), view = new DataView(bytes.buffer);
      if (width === 2) view.setInt16(0, value);
      else view.setInt32(0, value);
      return bytes;
    };
    /** Preserve full bigint offsets in the independent classic-wire peer. */
    const kafkaLong = (value) => {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigInt64(0, value);
      return bytes;
    };
    /** Prefix UTF-8 text with its classic Kafka signed 16-bit byte extent. */
    const kafkaText = (value) => {
      const bytes = new TextEncoder().encode(value);
      return kafkaCat(kafkaInt(bytes.length, 2), bytes);
    };
    /** Supply only the reviewed response versions; unexpected APIs must fail the authored peer. */
    const kafkaBody = (key) => {
      if (key === 18) {
        return kafkaCat(
          kafkaInt(0, 2),
          kafkaInt(5),
          ...[[18, 0], [3, 4], [0, 3], [1, 4], [2, 1]].map(([api, version]) =>
            kafkaCat(kafkaInt(api, 2), kafkaInt(version, 2), kafkaInt(version, 2))
          ),
        );
      }
      if (key === 3) {
        return kafkaCat(
          kafkaInt(0),
          kafkaInt(1),
          kafkaInt(1),
          kafkaText("inert.example"),
          kafkaInt(9092),
          kafkaInt(-1, 2),
          kafkaText("packed-cluster"),
          kafkaInt(1),
          kafkaInt(1),
          kafkaInt(0, 2),
          kafkaText("owned"),
          new Uint8Array([0]),
          kafkaInt(1),
          kafkaInt(0, 2),
          kafkaInt(0),
          kafkaInt(1),
          kafkaInt(1),
          kafkaInt(1),
          kafkaInt(1),
          kafkaInt(1),
        );
      }
      if (key === 0) {
        return kafkaCat(
          kafkaInt(1),
          kafkaText("owned"),
          kafkaInt(1),
          kafkaInt(0),
          kafkaInt(0, 2),
          kafkaLong(23n),
          kafkaLong(-1n),
          kafkaInt(0),
        );
      }
      throw new Error("Packed Kafka requested an unexpected API");
    };
    /** Track one exclusive exchange and inject dispatch or retirement faults without pretending to be a live broker. */
    const kafkaPeer = (mode = "success") => {
      let controller, closed = 0;
      const seen = [];
      const readable = new ReadableStream({
        start(value) {
          controller = value;
        },
      });
      const writable = new WritableStream({
        write(bytes) {
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            key = view.getInt16(4),
            version = view.getInt16(6),
            correlation = view.getInt32(8);
          if (
            view.getInt32(0) !== bytes.length - 4 || view.getInt16(12) !== 4 ||
            new TextDecoder().decode(bytes.subarray(14, 18)) !== "opfs" || correlation !== seen.length + 1
          ) throw new Error("Packed Kafka classic request header changed");
          if (version !== ({ 18: 0, 3: 4, 0: 3 })[key]) throw new Error("Packed Kafka API version changed");
          seen.push(key);
          if (key === 0 && mode === "unknown") throw new Error("Authored dispatched transport fault");
          const body = kafkaCat(kafkaInt(correlation), kafkaBody(key)), frame = kafkaCat(kafkaInt(body.length), body);
          controller.enqueue(frame.slice(0, 3));
          controller.enqueue(frame.slice(3));
        },
      });
      const channel = {
        readable,
        writable,
        security: "tls",
        async close() {
          closed++;
          controller.close();
          if (mode === "cleanup") throw new Error("Authored retirement fault");
        },
      };
      return { channel, seen, closed: () => closed };
    };
    const kafkaRecord = { timestamp: 1700000000000n, key: null, value: new Uint8Array([0, 255]), headers: [] };
    let kafkaOpens = 0;
    const kafkaInert = {
      topic: "owned",
      partition: 0,
      brokerId: 1,
      openChannel: async () => {
        kafkaOpens++;
        throw new Error("Constructor must not acquire");
      },
    };
    new KafkaClient(kafkaInert);
    const kafkaCancelled = createKafkaClient(kafkaInert);
    if (kafkaOpens !== 0) throw new Error("Packed Kafka constructor performed I/O");
    const kafkaAbort = new AbortController(), kafkaReason = new Error("Packed caller cancellation");
    kafkaAbort.abort(kafkaReason);
    let kafkaCancelledCorrect = false;
    try {
      await kafkaCancelled.metadata({ signal: kafkaAbort.signal });
    } catch (error) {
      kafkaCancelledCorrect = error === kafkaReason;
    }
    if (!kafkaCancelledCorrect || kafkaOpens !== 0) {
      throw new Error("Packed Kafka ignored cancellation before acquisition");
    }
    for (const mode of ["success", "unknown", "cleanup"]) {
      const peer = kafkaPeer(mode),
        client = createKafkaClient({
          topic: "owned",
          partition: 0,
          brokerId: 1,
          openChannel: async () => peer.channel,
        });
      let receipt, failure;
      try {
        receipt = await client.append([kafkaRecord]);
      } catch (error) {
        failure = error;
      }
      if (
        mode === "success" &&
        (failure || receipt.topic !== "owned" || receipt.partition !== 0 || receipt.baseOffset !== 23n ||
          receipt.count !== 1 || receipt.logAppendTime !== -1n)
      ) throw new Error("Packed Kafka acknowledgement changed");
      if (mode === "unknown" && (!(failure instanceof KafkaOutcomeError) || failure.outcome !== "unknown")) {
        throw new Error("Packed Kafka lost an unknown append outcome");
      }
      if (
        mode === "cleanup" &&
        (!(failure instanceof KafkaCompletionError) || failure.receipt.baseOffset !== 23n ||
          failure.receipt.count !== 1)
      ) throw new Error("Packed Kafka lost a known acknowledgement during retirement");
      if (
        peer.seen.join(",") !== "18,3,0" || peer.closed() !== 1 || peer.channel.readable.locked ||
        peer.channel.writable.locked
      ) throw new Error("Packed Kafka exchange or channel ownership changed");
    }
    const kafkaRefusal = new KafkaError("append", 20, { baseOffset: 23n });
    if (kafkaRefusal.operation !== "append" || kafkaRefusal.code !== 20) {
      throw new Error("Packed Kafka native error identity changed");
    }
  });
});
