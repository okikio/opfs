/** Native Java oracle input/output contract; all integers preserve their signed int64 precision. */
import { Buffer } from "node:buffer";
import { check } from "../acquire.ts";
import { CAP, i32, i64, Reader, text } from "./wire.ts";
import type { RecordType } from "./records.ts";
/** Independently restated manifest originals; do not derive these from probe encoding or native output. */
export function originals(timestamp: bigint): readonly RecordType[] {
  return [
    {
      timestamp,
      key: null,
      value: Buffer.from(Array.from({ length: 256 * 512 }, (_, index) => index & 255)),
      headers: [{ name: "dup", value: Buffer.from([0x00, 0xff]) }, { name: "dup", value: null }, {
        name: "dup",
        value: Buffer.alloc(0),
      }],
    },
    { timestamp: timestamp + 1n, key: Buffer.alloc(0), value: null, headers: [] },
    {
      timestamp: timestamp + 2n,
      key: Buffer.from([0x00, 0xff, 0x00]),
      value: Buffer.alloc(0),
      headers: [{ name: "trace", value: Buffer.from([0x0d, 0x0a, 0x00, 0x80]) }],
    },
  ];
}

/** Complete native terminal observations; an acknowledgment is independent of later cleanup faults. */
export interface TerminalType {
  readonly operation: number;
  readonly status: number;
  readonly topic: string;
  readonly partition: number;
  readonly attempted: number;
  readonly unknown: boolean;
  readonly acks: readonly { readonly partition: number; readonly offset: bigint; readonly timestamp: bigint }[];
  readonly records: readonly (RecordType & { readonly offset: bigint; readonly timestampType: string })[];
  readonly faultsTruncated: boolean;
  readonly faults: readonly {
    readonly path: string;
    readonly class: string;
    readonly message: Buffer<ArrayBuffer> | null;
  }[];
}
/** Decode the entire Java terminal envelope, including bounded failure observations. */
export function decode(data: Buffer<ArrayBuffer>): TerminalType {
  check(data.length <= CAP, "Native oracle output ceiling.");
  const reader = new Reader(data);
  check(reader.int() === 0x4b4f5231, "Oracle output magic.");
  const operation = reader.byte(), status = reader.byte();
  check([0, 1, 2].includes(operation) && [0, 1].includes(status), "Terminal discriminator.");
  const topic = reader.text(249, true), partition = reader.int(), attempted = reader.int(), unknown = reader.boolean();
  const acks = Array.from(
    { length: reader.count() },
    () => ({ partition: reader.int(), offset: reader.long(), timestamp: reader.long() }),
  );
  const records = Array.from({ length: reader.count() }, () => {
    const offset = reader.long(),
      timestamp = reader.long(),
      timestampType = reader.text(64, true),
      key = reader.blob(1048576),
      value = reader.blob(1048576);
    const headers = Array.from(
      { length: reader.count(32) },
      () => ({ name: reader.text(256, true), value: reader.blob(1048576) }),
    );
    return { offset, timestamp, timestampType, key, value, headers };
  });
  const faultsTruncated = reader.boolean(),
    faults = Array.from(
      { length: reader.count(16) },
      () => ({ path: reader.text(256, true), class: reader.text(4096, true), message: reader.blob(4096) }),
    );
  reader.done();
  check((status === 0) === (faults.length === 0), "Terminal status/fault disagreement.");
  return { operation, status, topic, partition, attempted, unknown, acks, records, faultsTruncated, faults };
}
/** Build exact fixed input manifests for the existing native Java program; no JVM or network is started. */
export function input(
  options: {
    readonly mode: "append" | "fetch";
    readonly bootstrap: string;
    readonly topic: string;
    readonly partition: number;
    readonly timestamp?: bigint;
    readonly offset?: bigint;
    readonly count?: number;
    readonly waitMs?: number;
  },
): Buffer<ArrayBuffer> {
  check(
    /^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(options.bootstrap) && Number(options.bootstrap.split(":")[1]) <= 65535 &&
      /^opfs-[A-Za-z0-9._-]{1,200}$/.test(options.topic) && Number.isInteger(options.partition) &&
      options.partition >= 0 && options.partition <= 2147483647,
    "Explicit owned oracle endpoint/topic/partition.",
  );
  const chunks = [
    i32(0x4b4f5031),
    Buffer.from([options.mode === "append" ? 1 : 2]),
    text(options.bootstrap, true),
    text(options.topic, true),
    i32(options.partition),
  ];
  const field = (bytes: Buffer<ArrayBuffer> | null): Buffer<ArrayBuffer> =>
    bytes === null ? i32(-1) : Buffer.concat([i32(bytes.length), bytes]);
  if (options.mode === "append") {
    check(
      options.timestamp !== undefined && options.timestamp >= 0n && options.timestamp <= (1n << 63n) - 3n,
      "Timestamp must leave two successor values.",
    );
    const records = originals(options.timestamp);
    chunks.push(i32(records.length));
    for (const record of records) {
      chunks.push(
        i64(record.timestamp),
        field(record.key),
        field(record.value),
        i32(record.headers.length),
        ...record.headers.flatMap((header) => [text(header.name, true), field(header.value)]),
      );
    }
  } else {
    const offset = options.offset ?? 0n, count = options.count ?? 3, wait = options.waitMs ?? 10000;
    check(
      offset >= 0n && offset < (1n << 63n) && Number.isInteger(count) && count >= 1 && count <= 1024 &&
        Number.isInteger(wait) && wait >= 1 && wait <= 10000,
      "Bounded native fetch input.",
    );
    chunks.push(i64(offset), i32(count), i32(wait));
  }
  const output = Buffer.concat(chunks);
  check(output.length <= 2 * 1024 * 1024, "Oracle input ceiling.");
  return output;
}
