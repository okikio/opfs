// Reproduce the literal native capture using the separately admitted test-only fixture.
// Literal producer framing does not import src/amqp.ts at runtime. Project ZIP
// admission and close are tooling dependencies, not independent AMQP proof.
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import { env } from "node:process";
import { createHash } from "node:crypto";
import { withAmqpFixture } from "../../provider/amqp.ts";
import { close } from "../../../src/close.ts";
import type { AmqpChannelType } from "../../../src/amqp.ts";

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const utf = (value: string): Buffer => Buffer.from(value, "utf8");
const cat = (...parts: readonly Uint8Array[]): Buffer => Buffer.concat(parts);
function num(value: number | bigint, size: 1 | 2 | 4 | 8): Buffer {
  const out = Buffer.alloc(size);
  if (size === 8) out.writeBigUInt64BE(BigInt(value));
  else out.writeUIntBE(Number(value), 0, size);
  return out;
}
const short = (value: string): Buffer => cat(num(utf(value).length, 1), utf(value));
const long = (bytes: Uint8Array): Buffer => cat(num(bytes.length, 4), bytes);
const frame = (type: number, channel: number, body: Uint8Array): Buffer =>
  cat(num(type, 1), num(channel, 2), num(body.length, 4), body, num(206, 1));
const method = (channel: number, cls: number, id: number, ...parts: readonly Uint8Array[]): Buffer =>
  frame(1, channel, cat(num(cls, 2), num(id, 2), ...parts));
function same(condition: unknown): asserts condition {
  if (!condition) throw new Error("Native AMQP capture differs from selected bounded profile.");
}
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => {});
    if (signal.aborted) abort();
  });
}
/** One retained reader; every complete native frame remains unchanged in the receipt. */
class Tape {
  readonly commands: Buffer[] = [];
  readonly replies: Buffer[] = [];
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #writer: WritableStreamDefaultWriter<Uint8Array>;
  #signal: AbortSignal;
  #pending = Buffer.alloc(0);
  constructor(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    signal: AbortSignal,
  ) {
    this.#reader = reader;
    this.#writer = writer;
    this.#signal = signal;
  }
  async write(bytes: Buffer): Promise<void> {
    this.#signal.throwIfAborted();
    this.commands.push(Buffer.from(bytes));
    await wait(this.#writer.write(bytes), this.#signal);
    this.#signal.throwIfAborted();
  }
  async #take(size: number): Promise<Buffer> {
    this.#signal.throwIfAborted();
    same(size <= 65536);
    const out = Buffer.alloc(size);
    let at = 0, empty = 0;
    while (at < size) {
      this.#signal.throwIfAborted();
      if (!this.#pending.length) {
        const next = await wait(this.#reader.read(), this.#signal);
        this.#signal.throwIfAborted();
        const done = next.done, supplied = next.value;
        same(!done && supplied instanceof Uint8Array && supplied.length <= 65536);
        if (!supplied.length) {
          same(++empty <= 16);
          continue;
        }
        this.#pending = Buffer.from(supplied);
        empty = 0;
      }
      const n = Math.min(size - at, this.#pending.length);
      this.#pending.copy(out, at, 0, n);
      at += n;
      this.#pending = this.#pending.subarray(n);
    }
    return out;
  }
  async packet(): Promise<{ type: number; channel: number; body: Buffer }> {
    while (true) {
      same(this.replies.length < 256);
      const header = await this.#take(7), size = header.readUInt32BE(3);
      same(size <= 65528);
      const body = await this.#take(size), end = await this.#take(1);
      same(end[0] === 206);
      this.replies.push(cat(header, body, end));
      const type = header[0]!, channel = header.readUInt16BE(1);
      if (type === 8) {
        same(channel === 0 && size === 0);
        continue;
      }
      return { type, channel, body };
    }
  }
  async expect(channel: number, cls: number, id: number): Promise<Buffer> {
    const packet = await this.packet();
    same(
      packet.type === 1 && packet.channel === channel && packet.body.length >= 4 &&
        packet.body.readUInt16BE(0) === cls && packet.body.readUInt16BE(2) === id,
    );
    return packet.body.subarray(4);
  }
  async initialize(): Promise<void> {
    await this.write(Buffer.from([65, 77, 81, 80, 0, 0, 9, 1]));
    const start = await this.expect(0, 10, 10);
    same(start[0] === 0 && start[1] === 9);
    const properties = long(
      cat(short("capabilities"), utf("F"), long(cat(short("authentication_failure_close"), utf("t"), num(1, 1)))),
    );
    await this.write(
      method(
        0,
        10,
        11,
        properties,
        short("PLAIN"),
        long(cat(num(0, 1), utf("fixture"), num(0, 1), utf("fixture-only-amqp"))),
        short("en_US"),
      ),
    );
    const tune = await this.expect(0, 10, 30);
    same(
      tune.length === 8 && tune.readUInt16BE(0) === 1 && tune.readUInt32BE(2) === 65536 && tune.readUInt16BE(6) === 60,
    );
    await this.write(method(0, 10, 31, num(1, 2), num(65536, 4), num(60, 2)));
    await this.write(method(0, 10, 40, short("/owned"), short(""), num(0, 1)));
    same((await this.expect(0, 10, 41)).equals(short("")));
    await this.write(method(1, 20, 10, short("")));
    same((await this.expect(1, 20, 11)).equals(num(0, 4)));
  }
  async body(): Promise<{ bytes: Buffer; header: Buffer }> {
    const header = await this.packet();
    same(
      header.type === 2 && header.channel === 1 && header.body.length >= 14 && header.body.readUInt16BE(0) === 60 &&
        header.body.readUInt16BE(2) === 0,
    );
    const size = header.body.readBigUInt64BE(4);
    same(size <= 1048576n);
    const chunks: Buffer[] = [];
    let length = 0;
    while (length < Number(size)) {
      const part = await this.packet();
      same(part.type === 3 && part.channel === 1 && part.body.length <= Number(size) - length);
      chunks.push(part.body);
      length += part.body.length;
    }
    return { bytes: Buffer.concat(chunks), header: header.body };
  }
  async finish(): Promise<void> {
    await this.write(method(0, 10, 50, num(200, 2), short(""), num(0, 2), num(0, 2)));
    same((await this.expect(0, 10, 51)).length === 0);
  }
}
const original = Buffer.from([0, 255, 13, 10, 128, 9]);
const wheelPath = env.OPFS_AMQP_ORACLE_WHEEL, outputPath = env.OPFS_AMQP_CAPTURE_OUTPUT;
if (!wheelPath || !outputPath) throw new Error("Set explicit admitted wheel and new capture output paths.");
await withAmqpFixture(readFileSync(wheelPath), async (fixture) => {
  async function capture(operation: "take" | "publish") {
    const signal = AbortSignal.timeout(30000), channel: AmqpChannelType = await fixture.openChannel({ signal });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
      writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    const failures: unknown[] = [];
    try {
      reader = channel.readable.getReader();
      writer = channel.writable.getWriter();
      const tape = new Tape(reader, writer, signal);
      await tape.initialize();
      let native: Record<string, unknown>;
      if (operation === "take") {
        await tape.write(method(1, 60, 70, num(0, 2), short("owned"), num(1, 1)));
        const declaration = await tape.expect(1, 60, 71), content = await tape.body();
        same(content.bytes.equals(original));
        native = {
          declaration: declaration.toString("base64"),
          contentHeader: content.header.toString("base64"),
          bodyBase64: content.bytes.toString("base64"),
          bodySha256: hash(content.bytes),
        };
      } else {
        await tape.write(method(1, 85, 10, num(0, 1)));
        same((await tape.expect(1, 85, 11)).length === 0);
        await tape.write(method(1, 60, 40, num(0, 2), short("owned"), short("key"), num(1, 1)));
        await tape.write(frame(2, 1, cat(num(60, 2), num(0, 2), num(original.length, 8), num(0, 2))));
        await tape.write(frame(3, 1, original));
        const confirmation = await tape.expect(1, 60, 80);
        same(confirmation.length === 9 && confirmation.readBigUInt64BE(0) === 1n && confirmation[8]! <= 1);
        native = { confirmation: confirmation.toString("base64") };
      }
      await tape.finish();
      const wire = Buffer.concat(tape.replies);
      return {
        operation,
        native,
        commands: tape.commands.map((bytes) => ({
          base64: bytes.toString("base64"),
          bytes: bytes.length,
          sha256: hash(bytes),
        })),
        replyFrames: tape.replies.map((bytes) => ({
          base64: bytes.toString("base64"),
          bytes: bytes.length,
          sha256: hash(bytes),
        })),
        replyWire: { base64: wire.toString("base64"), bytes: wire.length, sha256: hash(wire) },
      };
    } catch (reason) {
      failures.push(reason);
      throw reason;
    } finally {
      await close([() => channel.close(), () => reader?.releaseLock(), () => writer?.releaseLock()], failures);
    }
  }
  same((await fixture.seed(original)).confirmed === true);
  const take = await capture("take");
  same((await fixture.count()).messages === "0");
  const publish = await capture("publish"), independent = await fixture.take();
  same(
    independent.empty === false && typeof independent.base64 === "string" &&
      Buffer.from(independent.base64 as string, "base64").equals(original),
  );
  same((await fixture.count()).messages === "0");
  const receipt = {
    scope:
      "Native unmodified RabbitMQ binary frames; literal independent producer, Pika complete bytes before/after. Credentials are disposable fixture literals. Project ZIP/close are tooling only; src/amqp.ts has no runtime import.",
    oracle: { base64: original.toString("base64"), bytes: original.length, sha256: hash(original) },
    take,
    publish,
  };
  writeFileSync(outputPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  console.log(
    JSON.stringify({
      captured: [take.replyWire, publish.replyWire].map(({ bytes, sha256 }) => ({ bytes, sha256 })),
      fullByteOracle: receipt.oracle,
    }),
  );
});
