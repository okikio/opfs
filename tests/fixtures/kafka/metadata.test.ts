/** Syntax controls for the independent fixture decoder; these do not qualify a production Kafka client. */
import { describe, it } from "node:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { expect } from "@std/expect";
import { decodeMetadata4 } from "./metadata.ts";
import { i16, i32, text } from "./wire.ts";

/** Authored one-broker envelope, preserving native -1 error and unknown leader/controller observations. */
function frame(error = 0): Buffer<ArrayBuffer> {
  const body = Buffer.concat([
    i32(17),
    i32(0),
    i32(1),
    i32(7),
    text("127.0.0.1"),
    i32(9092),
    i16(-1),
    i16(-1),
    i32(-1),
    i32(1),
    i16(error),
    text("opfs-control"),
    Buffer.from([0]),
    i32(1),
    i16(error),
    i32(0),
    i32(-1),
    i32(1),
    i32(7),
    i32(1),
    i32(7),
  ]);
  return Buffer.concat([i32(body.length), body]);
}
describe("independent Kafka Metadata4 decoder", () => {
  it("retains nullable fields, unknown nodes and signed native errors", () => {
    const result = decodeMetadata4(frame(-1), 17);
    expect(result.cluster).toBeNull();
    expect(result.controller).toBe(-1);
    expect(result.brokers).toEqual([{ id: 7, host: "127.0.0.1", port: 9092, rack: null }]);
    expect(result.topics[0]?.error).toBe(-1);
    expect(result.topics[0]?.partitions).toEqual([{ error: -1, index: 0, leader: -1, replicas: [7], isr: [7] }]);
  });
  it("refuses every truncated envelope without returning a partial observation", () => {
    const bytes = frame();
    for (let at = 0; at < bytes.length; at++) expect(() => decodeMetadata4(bytes.subarray(0, at), 17)).toThrow();
  });
  it("refuses wrong correlation, trailing bytes, negative throttle and impossible broker counts", () => {
    expect(() => decodeMetadata4(frame(), 18)).toThrow();
    const trailing = Buffer.concat([frame(), Buffer.from([0])]);
    trailing.writeInt32BE(trailing.length - 4, 0);
    expect(() => decodeMetadata4(trailing, 17)).toThrow();
    const throttle = frame();
    throttle.writeInt32BE(-1, 8);
    expect(() => decodeMetadata4(throttle, 17)).toThrow();
    for (const count of [-1, 129, 2147483647]) {
      const bytes = frame();
      bytes.writeInt32BE(count, 12);
      expect(() => decodeMetadata4(bytes, 17)).toThrow();
    }
  });
});

/** Explicit authored wire fragments keep malformed fields visible without using the decoder to construct expectations. */
function collection(items: readonly Buffer<ArrayBuffer>[], declared = items.length): Buffer<ArrayBuffer> {
  return Buffer.concat([i32(declared), ...items]);
}
function broker(id = 7, host = text("host-seven"), rack = i16(-1), port = 9092): Buffer<ArrayBuffer> {
  return Buffer.concat([i32(id), host, i32(port), rack]);
}
function partition(
  index = 0,
  leader = 7,
  replicas = collection([i32(7)]),
  isr = collection([i32(7)]),
  error = 0,
): Buffer<ArrayBuffer> {
  return Buffer.concat([i16(error), i32(index), i32(leader), replicas, isr]);
}
function topic(
  name = text("opfs-control"),
  partitions = collection([partition()]),
  internal = 0,
  error = 0,
): Buffer<ArrayBuffer> {
  return Buffer.concat([i16(error), name, Buffer.from([internal]), partitions]);
}
/** This builder emits only the documented fixed Metadata4 layout; it performs no semantic normalization. */
function observation(
  brokers = collection([broker()]),
  topics = collection([topic()]),
  cluster = i16(-1),
  controller = -1,
): Buffer<ArrayBuffer> {
  const body = Buffer.concat([i32(17), i32(0), brokers, cluster, i32(controller), topics]);
  return Buffer.concat([i32(body.length), body]);
}
function encoded(bytes: readonly number[]): Buffer<ArrayBuffer> {
  return Buffer.concat([i16(bytes.length), Buffer.from(bytes)]);
}

describe("authored Metadata4 syntax controls, separate from native broker evidence", () => {
  it("rejects malformed UTF-8 in every text role without replacement decoding", () => {
    // Overlong slash, surrogate, incomplete scalar and a scalar beyond Unicode's maximum.
    for (const bytes of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xf4, 0x90, 0x80, 0x80]]) {
      const invalid = encoded(bytes);
      const cases = [
        observation(collection([broker(7, invalid)])),
        observation(collection([broker(7, text("host"), invalid)])),
        observation(undefined, undefined, invalid),
        observation(undefined, collection([topic(invalid)])),
      ];
      for (const bytes of cases) expect(() => decodeMetadata4(bytes, 17)).toThrow();
    }
  });
  it("preserves a leading UTF-8 BOM as field data instead of silently changing identity", () => {
    const result = decodeMetadata4(
      observation(
        collection([broker(7, text("\ufeffhost"), text("\ufeffrack"))]),
        collection([topic(text("\ufefftopic"))]),
        text("\ufeffcluster"),
      ),
      17,
    );
    expect(result.brokers).toEqual([{ id: 7, host: "\ufeffhost", port: 9092, rack: "\ufeffrack" }]);
    expect(result.cluster).toBe("\ufeffcluster");
    expect(result.topics[0]?.name).toBe("\ufefftopic");
  });
  it("distinguishes nullable empty strings from null and rejects null on required text", () => {
    const empty = decodeMetadata4(
      observation(collection([broker(7, text("host"), text(""))]), undefined, text("")),
      17,
    );
    expect(empty.cluster).toBe("");
    expect(empty.brokers[0]?.rack).toBe("");
    const cases = [
      observation(collection([broker(7, text("host"), i16(-2))])),
      observation(undefined, undefined, i16(-2)),
      observation(collection([broker(7, i16(-1))])),
      observation(undefined, collection([topic(i16(-1))])),
      observation(collection([broker(7, text(""))])),
      observation(undefined, collection([topic(text(""))])),
    ];
    for (const bytes of cases) expect(() => decodeMetadata4(bytes, 17)).toThrow();
  });
  it("decodes both internal flag values and rejects every non-boolean byte profile", () => {
    expect(
      decodeMetadata4(observation(undefined, collection([topic(undefined, undefined, 1)])), 17).topics[0]?.internal,
    )
      .toBe(true);
    expect(decodeMetadata4(observation(), 17).topics[0]?.internal).toBe(false);
    for (const flag of [2, 127, 255]) {
      expect(() => decodeMetadata4(observation(undefined, collection([topic(undefined, undefined, flag)])), 17))
        .toThrow();
    }
  });
  it("rejects duplicate identities while allowing distinct brokers to share a host", () => {
    const cases = [
      observation(collection([broker(), broker(7, text("other-host"))])),
      observation(undefined, collection([topic(), topic()])),
      observation(undefined, collection([topic(undefined, collection([partition(), partition()]))])),
      observation(
        undefined,
        collection([topic(undefined, collection([partition(0, 7, collection([i32(7), i32(7)]))]))]),
      ),
      observation(
        undefined,
        collection([topic(undefined, collection([partition(0, 7, undefined, collection([i32(7), i32(7)]))]))]),
      ),
    ];
    for (const bytes of cases) expect(() => decodeMetadata4(bytes, 17)).toThrow();
    expect(decodeMetadata4(observation(collection([broker(7), broker(9)])), 17).brokers.map((value) => value.id))
      .toEqual([7, 9]);
  });
  it("rejects negative, oversized and byte-impossible counts at each nested collection", () => {
    for (const count of [-1, 65, 2147483647]) {
      expect(() => decodeMetadata4(observation(undefined, collection([], count)), 17)).toThrow();
    }
    for (const count of [-1, 1025, 2147483647]) {
      expect(() => decodeMetadata4(observation(undefined, collection([topic(undefined, collection([], count))])), 17))
        .toThrow();
    }
    for (const count of [-1, 129, 2147483647]) {
      for (const part of [partition(0, 7, collection([], count)), partition(0, 7, undefined, collection([], count))]) {
        expect(() => decodeMetadata4(observation(undefined, collection([topic(undefined, collection([part]))])), 17))
          .toThrow();
      }
    }
    // These counts fit their numeric ceilings but cannot fit the remaining wire bytes.
    expect(() => decodeMetadata4(observation(undefined, collection([], 1)), 17)).toThrow();
    expect(() => decodeMetadata4(observation(undefined, collection([topic(undefined, collection([], 1))])), 17))
      .toThrow();
  });
  it("bounds aggregate partition and replica work across otherwise valid individual collections", () => {
    const many = collection(Array.from({ length: 513 }, (_, index) => partition(index)));
    expect(() =>
      decodeMetadata4(
        observation(
          undefined,
          collection([
            topic(text("opfs-first"), many),
            topic(text("opfs-second"), many),
          ]),
        ),
        17,
      )
    ).toThrow();
    const members = collection(Array.from({ length: 128 }, (_, id) => i32(id)));
    const partitions = collection(Array.from({ length: 33 }, (_, index) => partition(index, 7, members, members)));
    expect(() => decodeMetadata4(observation(undefined, collection([topic(undefined, partitions)])), 17)).toThrow();
  });
  it("preserves unknown leader/controller and native errors without inventing a usable leader", () => {
    const result = decodeMetadata4(
      observation(
        undefined,
        collection([topic(undefined, collection([partition(0, -1, undefined, undefined, 5)]), 0, 3)]),
      ),
      17,
    );
    expect(result.controller).toBe(-1);
    expect(result.topics[0]).toEqual({
      error: 3,
      name: "opfs-control",
      internal: false,
      partitions: [{ error: 5, index: 0, leader: -1, replicas: [7], isr: [7] }],
    });
    // Controller roles can be separate from broker roles; syntax must not invent broker membership.
    expect(decodeMetadata4(observation(undefined, undefined, undefined, 99), 17).controller).toBe(99);
    const cases = [
      observation(undefined, undefined, undefined, -2),
      observation(collection([broker(-1)])),
      observation(undefined, collection([topic(undefined, collection([partition(0, -2)]))])),
      observation(undefined, collection([topic(undefined, collection([partition(-1)]))])),
      observation(undefined, collection([topic(undefined, collection([partition(0, 7, collection([i32(-1)]))]))])),
      observation(
        undefined,
        collection([topic(undefined, collection([partition(0, 7, undefined, collection([i32(-1)]))]))]),
      ),
    ];
    for (const bytes of cases) expect(() => decodeMetadata4(bytes, 17)).toThrow();
  });
  it("retains multiple reordered collections, assignment order, flags and non-null rack values", () => {
    const first = topic(
      text("opfs-z"),
      collection([
        partition(4, 9, collection([i32(9), i32(7)]), collection([i32(7), i32(9)])),
        partition(1, 7),
      ]),
      1,
    );
    const second = topic(text("opfs-a"), collection([partition(8, 7)]));
    const result = decodeMetadata4(
      observation(
        collection([broker(9, text("nine"), text("rack-b"), 19092), broker(7, text("seven"), text("rack-a"))]),
        collection([first, second]),
        text("cluster-id"),
        9,
      ),
      17,
    );
    expect(result.brokers).toEqual([
      { id: 9, host: "nine", port: 19092, rack: "rack-b" },
      { id: 7, host: "seven", port: 9092, rack: "rack-a" },
    ]);
    expect(result.cluster).toBe("cluster-id");
    expect(result.controller).toBe(9);
    expect(result.topics).toEqual([
      {
        error: 0,
        name: "opfs-z",
        internal: true,
        partitions: [
          { error: 0, index: 4, leader: 9, replicas: [9, 7], isr: [7, 9] },
          { error: 0, index: 1, leader: 7, replicas: [7], isr: [7] },
        ],
      },
      {
        error: 0,
        name: "opfs-a",
        internal: false,
        partitions: [{ error: 0, index: 8, leader: 7, replicas: [7], isr: [7] }],
      },
    ]);
  });
});

/** Read only bounded regular originals; the frozen receipt below binds every admitted artifact. */
function nativeFile(name: string, maximum: number): Buffer<ArrayBuffer> {
  if (!/^[a-z][a-z0-9-]*\.(?:json|bin)$/.test(name)) throw new Error("Unexpected native artifact path.");
  const url = new URL(`./native-metadata/${name}`, import.meta.url), info = lstatSync(url);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error("Native original type/extent.");
  const bytes = readFileSync(url);
  if (bytes.length !== info.size) throw new Error("Native original changed extent.");
  return bytes;
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Native object expected.");
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("Native array extent.");
  return value;
}
function nodeIds(value: unknown): number[] {
  return array(value, 128).map((item) => {
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0) throw new Error("Native node ID.");
    return item;
  });
}

describe("retained independent Metadata4/Admin native observation", () => {
  it("checks every frozen artifact identity before comparing the wire frame with the Admin observation", () => {
    const terminalBytes = nativeFile("terminal.json", 65536);
    expect(createHash("sha256").update(terminalBytes).digest("hex"))
      .toBe("270aff37450b4f7d9daec609c194ea5f2725d8271e267d095f1694ea5b183abc");
    const terminal = object(JSON.parse(terminalBytes.toString("utf8")) as unknown);
    expect(terminal.qualified).toBe(true);
    expect(terminal.failures).toEqual([]);
    expect(terminal.candidateKafkaParserImported).toBe(false);
    expect(terminal.multibrokerControllerQualified).toBe(false);
    const admitted = new Map<string, Buffer<ArrayBuffer>>();
    for (const entry of array(terminal.artifacts, 5)) {
      const artifact = object(entry);
      if (typeof artifact.file !== "string" || admitted.has(artifact.file)) {
        throw new Error("Native artifact identity.");
      }
      const bytes = nativeFile(artifact.file, 4194308);
      expect(bytes.length).toBe(artifact.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
      admitted.set(artifact.file, bytes);
    }
    expect([...admitted.keys()].sort()).toEqual([
      "admin-decoded.json",
      "admin.bin",
      "metadata-request.bin",
      "metadata-response.bin",
      "wire-decoded.json",
    ]);
    const response = admitted.get("metadata-response.bin"), nativeBytes = admitted.get("admin-decoded.json");
    if (!response || !nativeBytes) throw new Error("Required native originals missing.");
    // The expected observation came from public Java Admin, not wire-decoded.json or the decoder under test.
    const native = object(JSON.parse(nativeBytes.toString("utf8")) as unknown), wire = decodeMetadata4(response, 4102);
    expect(wire.cluster).toBe(native.cluster);
    const nativeBrokers = array(native.brokers, 128).map((entry) => {
      const value = object(entry);
      return [value.id, value.host, value.port, value.rack];
    });
    const actualBrokers = wire.brokers.map((value) => [value.id, value.host, value.port, value.rack]);
    const tupleKey = (value: readonly unknown[]): string => JSON.stringify(value);
    expect(actualBrokers.map(tupleKey).sort()).toEqual(nativeBrokers.map(tupleKey).sort());
    expect(wire.topics).toHaveLength(1);
    const selected = wire.topics[0];
    if (!selected) throw new Error("Native topic missing.");
    expect(selected.name).toBe(terminal.topic);
    expect(selected.name).toBe(native.topic);
    expect(selected.internal).toBe(native.internal);
    expect(selected.error).toBe(0);
    expect(native.requested).toBe(terminal.partition);
    const partitions = array(native.partitions, 1024).map(object);
    expect(selected.partitions).toHaveLength(partitions.length);
    for (const actual of selected.partitions) {
      const expected = partitions.find((value) => value.index === actual.index);
      if (!expected) throw new Error("Independent native partition missing.");
      expect(actual.error).toBe(0);
      expect(actual.leader).toBe(expected.leader);
      expect(actual.replicas).toEqual(nodeIds(expected.replicas));
      expect([...actual.isr].sort((a, b) => a - b)).toEqual(nodeIds(expected.isr).sort((a, b) => a - b));
    }
    // Equality here is a degenerate one-broker observation; it does not qualify controller discovery in a cluster.
    expect(wire.controller).toBe(native.controllerObservation);
  });
});
