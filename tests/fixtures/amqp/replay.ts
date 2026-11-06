import { decodeBase64 } from "@std/encoding/base64";
import type { AmqpChannelType } from "../../../src/amqp.ts";
import fixture from "./independent.json" with { type: "json" };

/** Untouched native frames with a literal producer's independently observed order. */
export interface AmqpTapeType {
  readonly commands: readonly Uint8Array<ArrayBuffer>[];
  readonly replies: readonly Uint8Array<ArrayBuffer>[];
  readonly release: readonly (readonly number[])[];
}

/** Admit native fixture hashes outside test operations and benchmark sampling. */
export async function prepareAmqpReplay(): Promise<{
  readonly original: Uint8Array<ArrayBuffer>;
  readonly take: AmqpTapeType;
  readonly publish: AmqpTapeType;
}> {
  const decode = (record: { base64: string }): Uint8Array<ArrayBuffer> => new Uint8Array(decodeBase64(record.base64));
  const records = [
    fixture.oracle,
    ...[fixture.take, fixture.publish].flatMap((tape) => [tape.replyWire, ...tape.commands, ...tape.replyFrames]),
  ];
  for (const record of records) {
    const bytes = decode(record);
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (bytes.length !== record.bytes || hash !== record.sha256) throw new Error("Native AMQP fixture hash differs.");
  }
  return {
    original: decode(fixture.oracle),
    take: {
      commands: fixture.take.commands.map(decode),
      replies: fixture.take.replyFrames.map(decode),
      release: [[0], [1], [], [2], [3], [4, 5, 6], [7]],
    },
    publish: {
      commands: fixture.publish.commands.map(decode),
      replies: fixture.publish.replyFrames.map(decode),
      release: [[0], [1], [], [2], [3], [4], [], [], [5], [6]],
    },
  };
}

/**
 * Replay exact native bytes after each captured command, with no candidate parser.
 *
 * A fresh channel owns its Webstreams and terminal command count. Fragmentation
 * changes transport boundaries only; it never rewrites an AMQP frame. close()
 * is idempotent and refuses a run that omitted any captured producer command.
 */
export function createAmqpReplay(tape: AmqpTapeType, fragmented = false): AmqpChannelType {
  let controller: ReadableStreamDefaultController<Uint8Array>, at = 0, closed = false;
  return {
    security: "plaintext",
    readable: new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    }),
    writable: new WritableStream<Uint8Array>({
      write(bytes) {
        const expected = tape.commands[at];
        if (!expected || bytes.length !== expected.length || bytes.some((byte, index) => byte !== expected[index])) {
          throw new Error("AMQP command differs from literal native producer.");
        }
        for (const index of tape.release[at++]!) {
          const frame = tape.replies[index]!;
          if (fragmented) { for (const byte of frame) controller.enqueue(new Uint8Array([byte])); }
          else controller.enqueue(new Uint8Array(frame));
        }
      },
    }),
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      controller.close();
      return at === tape.commands.length
        ? Promise.resolve()
        : Promise.reject(new Error("AMQP replay retired before every native producer command."));
    },
  };
}
