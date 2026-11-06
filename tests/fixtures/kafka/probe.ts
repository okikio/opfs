/** Literal loopback-only wire capture; framing never claims broker semantic success. No production imports. */
import { Buffer } from "node:buffer";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { check, digest } from "../acquire.ts";
import { CAP, i16, i32, i64, Reader, text } from "./wire.ts";
import { batch, TIMESTAMP } from "./records.ts";
/** Fixed classic APIs, deliberately avoiding flexible encoding and obsolete Produce/Fetch versions. */
const VERSIONS: Readonly<Record<number, number>> = { 18: 0, 3: 4, 0: 3, 1: 4, 2: 1 };
/** One complete request; the length prefix excludes its own four bytes. */
function request(key: number, correlation: number, body: Buffer<ArrayBuffer>): Buffer<ArrayBuffer> {
  const version = VERSIONS[key];
  check(version !== undefined, "Literal API profile.");
  const content = Buffer.concat([i16(key), i16(version), i32(correlation), text("opfs-literal"), body]);
  check(content.length <= CAP, "Request extent.");
  return Buffer.concat([i32(content.length), content]);
}
/** ApiVersions0 is exactly error/count/triples; duplicate/range/trailing fields refuse. */
function versions(raw: Buffer<ArrayBuffer>): void {
  const reader = new Reader(raw);
  check(reader.short() === 0, "ApiVersions native refusal.");
  const count = reader.count(), found = new Map<number, readonly [number, number]>();
  for (let at = 0; at < count; at++) {
    const key = reader.short(), low = reader.short(), high = reader.short();
    check(!found.has(key) && low >= 0 && high >= low, "API range/duplicate.");
    found.set(key, [low, high]);
  }
  reader.done();
  for (const [key, version] of Object.entries(VERSIONS)) {
    const range = found.get(Number(key));
    check(range && range[0] <= version && range[1] >= version, "Pinned API version not advertised.");
  }
}
/** Await exact socket destruction, including aborted reads and partial writes. */
async function retire(socket: Socket): Promise<void> {
  if (socket.closed) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Literal socket retirement deadline.")), 5000);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.destroy();
  });
}
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" },
    topic: { type: "string" },
    partition: { type: "string" },
    offset: { type: "string" },
    output: { type: "string" },
  },
});
check(
  positionals.length === 1 && (positionals[0] === "read" || positionals[0] === "append") && values.port &&
    values.topic && values.partition && values.offset && values.output,
  "Usage: probe.ts read|append --port PORT --topic OWNED_TOPIC --partition INTEGER --offset INTEGER --output FRESH_DIRECTORY",
);
const mode = positionals[0], port = Number(values.port), topic = values.topic, partition = Number(values.partition);
check(/^[0-9]+$/.test(values.offset), "Explicit nonnegative int64 offset.");
const offset = BigInt(values.offset);
check(
  Number.isInteger(port) && port >= 1 && port <= 65535 && /^opfs-[A-Za-z0-9._-]{1,200}$/.test(topic) &&
    Number.isInteger(partition) && partition >= 0 && partition <= 2147483647 && offset >= 0n && offset < (1n << 63n),
  "Explicit owned topic/partition/loopback port/offset.",
);
const root = values.output;
mkdirSync(root, { mode: 0o700 });
const deadline = Date.now() + 45000;
const receipts: Record<string, unknown>[] = [];
let attempted = false, fault: unknown;
function save(
  name: string,
  raw: Buffer<ArrayBuffer>,
): { readonly file: string; readonly bytes: number; readonly sha256: string } {
  check(raw.length <= CAP + 4, "Capture file extent.");
  writeFileSync(join(root, name), raw, { flag: "wx", mode: 0o600 });
  return { file: name, bytes: raw.length, sha256: digest(raw) };
}
/** Each exchange owns a fresh connection; no response abandonment can desynchronize another call. */
async function exchange(
  name: string,
  key: number,
  correlation: number,
  body: Buffer<ArrayBuffer>,
): Promise<Buffer<ArrayBuffer>> {
  check(Date.now() < deadline, "Capture deadline.");
  const wire = request(key, correlation, body),
    receipt: Record<string, unknown> = {
      api: key,
      version: VERSIONS[key],
      correlation,
      request: save(name + "-request.bin", wire),
      sendAttempted: false,
    };
  receipts.push(receipt);
  const responsePath = join(root, name + "-response.bin");
  writeFileSync(responsePath, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
  const socket = createConnection({ host: "127.0.0.1", port }),
    timer = setTimeout(() => socket.destroy(new Error("Whole capture deadline.")), deadline - Date.now());
  socket.setTimeout(5000, () => socket.destroy(new Error("Capture socket inactivity deadline.")));
  // Preserve socket errors until a pending wait can consume them; never use an unhandled error event.
  let socketFault: Error | undefined;
  socket.on("error", (error) => {
    socketFault = error;
  });
  let primary: unknown, failed = false;
  let result: Buffer<ArrayBuffer> | undefined;
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
      const closed = (): void => fail(new Error("Literal socket closed before acquisition."));
      socket.once("connect", ready);
      socket.once("error", fail);
      socket.once("close", closed);
    });
    receipt.sendAttempted = true;
    if (key === 0) attempted = true;
    await new Promise<void>((resolve, reject) => socket.write(wire, (error) => error ? reject(error) : resolve()));
    const receive = async function (count: number): Promise<Buffer<ArrayBuffer>> {
      check(count >= 0 && count <= CAP, "Response preallocation extent.");
      const result = Buffer.alloc(count);
      let at = 0;
      while (at < count) {
        if (socketFault) throw socketFault;
        const chunk: unknown = socket.read(Math.min(count - at, 65536, Math.max(1, socket.readableLength)));
        if (chunk instanceof Uint8Array && chunk.length) {
          const bytes = Buffer.from(chunk);
          check(bytes.length <= count - at, "Native response overread.");
          appendFileSync(responsePath, bytes);
          bytes.copy(result, at);
          at += bytes.length;
          continue;
        }
        check(!socket.readableEnded && !socket.destroyed, "Truncated native response.");
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
      return result;
    };
    const size = (await receive(4)).readInt32BE();
    check(size >= 4 && size <= CAP, "Response preallocation extent.");
    const response = await receive(size);
    check(response.readInt32BE() === correlation, "Response correlation.");
    receipt.framingComplete = true;
    result = response.subarray(4);
  } catch (error) {
    primary = error;
    failed = true;
  }
  // Settle both retirement and capture before returning; cleanup must retain any primary failure.
  clearTimeout(timer);
  const faults: unknown[] = [];
  try {
    const original = readFileSync(responsePath);
    receipt.response = { file: name + "-response.bin", bytes: original.length, sha256: digest(original) };
  } catch (error) {
    faults.push(error);
  }
  try {
    await retire(socket);
  } catch (error) {
    faults.push(error);
  }
  if (faults.length) {
    throw new AggregateError(
      failed ? [primary, ...faults] : faults,
      "Literal exchange, receipt or retirement failed.",
    );
  }
  if (failed) throw primary;
  check(result !== undefined, "Literal exchange result missing.");
  return result;
}
try {
  versions(await exchange("versions", 18, 3101, Buffer.alloc(0)));
  // Metadata4 semantic interpretation remains a separate qualification gap.
  await exchange("metadata", 3, 3102, Buffer.concat([i32(1), text(topic), Buffer.from([0])]));
  if (mode === "append") {
    const record = batch();
    save("produce-batch.bin", record.bytes);
    save("produce-crc-input.bin", record.crcInput);
    await exchange(
      "produce",
      0,
      3103,
      Buffer.concat([
        i16(-1),
        i16(-1),
        i32(5000),
        i32(1),
        text(topic),
        i32(1),
        i32(partition),
        i32(record.bytes.length),
        record.bytes,
      ]),
    );
  }
  for (const [name, timestamp, correlation] of [["earliest", -2n, 3104], ["latest", -1n, 3105]] as const) {
    await exchange(
      name,
      2,
      correlation,
      Buffer.concat([i32(-1), i32(1), text(topic), i32(1), i32(partition), i64(timestamp)]),
    );
  }
  await exchange(
    "fetch",
    1,
    3106,
    Buffer.concat([
      i32(-1),
      i32(1000),
      i32(1),
      i32(CAP),
      Buffer.from([0]),
      i32(1),
      text(topic),
      i32(1),
      i32(partition),
      i64(offset),
      i32(CAP),
    ]),
  );
} catch (error) {
  fault = error;
} finally {
  save(
    "receipt.json",
    Buffer.from(
      JSON.stringify(
        {
          mode,
          topic,
          partition,
          fetchOffset: offset.toString(),
          fixedTimestamp: TIMESTAMP.toString(),
          exchanges: receipts,
          produceAttempted: attempted,
          appendOutcomeRequiresOracleReview: attempted,
          faultClass: fault === undefined ? null : fault instanceof Error ? fault.name : "unknown",
          semanticSuccessClaimed: false,
          sourceOnlyUntilParentGO: true,
        },
        null,
        2,
      ) + "\n",
    ),
  );
}
if (fault !== undefined) {
  throw new Error("Literal capture failed; retained framing is not semantic success.", { cause: fault });
}
