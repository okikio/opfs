import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { openSftpClient, SftpProtocolError, SftpPublicationError } from "../src/sftp.ts";
import type { SftpOptionsType } from "../src/sftp.ts";

const encode = (text: string) => new TextEncoder().encode(text);
/** Independent test encoder writes the published big-endian wire format directly. */
function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}
const str = (value: string | Uint8Array) => {
  const bytes = typeof value === "string" ? encode(value) : value;
  return concat(u32(bytes.length), bytes);
};
const packet = (type: number, body: Uint8Array) => concat(u32(1 + body.length), new Uint8Array([type]), body);
const status = (id: number, code: number) =>
  packet(101, concat(u32(id), u32(code), str("untrusted server text"), str("")));
const attrs = () => concat(u32(5), u32(0), u32(6), u32(0x81a4));

function peer(options: {
  readonly fragment?: boolean;
  readonly version?: number;
  readonly override?: (type: number, id: number, bytes: Uint8Array) => Uint8Array | null | undefined;
} = {}) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let count = 0;
  let directory = 0;
  const requests: { type: number; id: number; bytes: Uint8Array }[] = [];
  const writes: Uint8Array[] = [];
  function reply(value: Uint8Array) {
    if (options.fragment) { for (const byte of value) controller.enqueue(new Uint8Array([byte])); }
    else controller.enqueue(value);
  }
  const config: SftpOptionsType = {
    timeoutMs: 1000,
    openChannel: () =>
      Promise.resolve({
        readable: new ReadableStream({
          start(value) {
            controller = value;
          },
        }),
        writable: new WritableStream<Uint8Array>({
          write(bytes) {
            const type = bytes[4]!;
            if (type === 1) {
              reply(packet(2, concat(u32(options.version ?? 3), str("fsync@openssh.com"), str("1"))));
              return;
            }
            const id = new DataView(bytes.buffer, bytes.byteOffset + 5, 4).getUint32(0);
            requests.push({ type, id, bytes: new Uint8Array(bytes) });
            const overridden = options.override?.(type, id, bytes);
            if (overridden !== undefined) {
              if (overridden !== null) reply(overridden);
              return;
            }
            if (type === 3 || type === 11) reply(packet(102, concat(u32(id), str(`handle${++count}`))));
            else if (type === 17 || type === 7 || type === 8) reply(packet(105, concat(u32(id), attrs())));
            else if (type === 4) reply(status(id, 0));
            else if (type === 5) {
              const handleSize = new DataView(bytes.buffer, bytes.byteOffset + 9, 4).getUint32(0);
              const offset = new DataView(bytes.buffer, bytes.byteOffset + 13 + handleSize, 8).getBigUint64(0);
              const length = new DataView(bytes.buffer, bytes.byteOffset + 21 + handleSize, 4).getUint32(0);
              const data = encode("abcdef").slice(Number(offset), Number(offset) + Math.min(length, 2));
              reply(data.length ? packet(103, concat(u32(id), str(data))) : status(id, 1));
            } else if (type === 6) {
              writes.push(new Uint8Array(bytes));
              reply(status(id, 0));
            } else if (type === 12) {
              if (directory++ === 0) {
                reply(
                  packet(104, concat(u32(id), u32(1), str("native name"), str("not parsed as attributes"), attrs())),
                );
              } else reply(status(id, 1));
            } else reply(status(id, 8));
          },
        }),
        close() {
          if (!closed) {
            closed = true;
            controller.close();
          }
          return Promise.resolve();
        },
      }),
  };
  return { config, requests, writes, reply, closed: () => closed };
}

describe("SFTP native version3 packets", () => {
  it("shares one admitted file CLOSE across explicit disposal and asyncDispose", async () => {
    const wire = peer();
    const files = await openSftpClient(wire.config);
    try {
      const file = await files.openFile("a");
      const closing = file.close();
      expect(file[Symbol.asyncDispose]()).toBe(closing);
      await closing;
      expect(wire.requests.filter((request) => request.type === 4).length).toBe(1);
    } finally {
      await files.close();
    }
  });
  it("does not retain a pre-aborted file-close admission as its disposal attempt", async () => {
    const wire = peer();
    const files = await openSftpClient(wire.config);
    try {
      const file = await files.openFile("a");
      await expect(file.close({ signal: AbortSignal.abort(new Error("not yet")) })).rejects.toThrow("not yet");
      expect(file.closed).toBe(false);
      await file.close();
      expect(wire.requests.filter((request) => request.type === 4).length).toBe(1);
      expect(file.closed).toBe(true);
    } finally {
      await files.close();
    }
  });
  it("keeps empty opaque handles valid instead of interpreting their bytes", async () => {
    const wire = peer({ override: (type, id) => type === 3 ? packet(102, concat(u32(id), str(""))) : undefined });
    const files = await openSftpClient(wire.config);
    try {
      const file = await files.openFile("a");
      await file.close();
    } finally {
      await files.close();
    }
  });
  it("reports lost dirty CLOSE acknowledgements as unknown publication", async () => {
    const wire = peer({ override: (type) => type === 4 ? null : undefined });
    const files = await openSftpClient({ ...wire.config, timeoutMs: 20 });
    const file = await files.openFile("a", { mode: "replace" });
    const hold = setTimeout(() => {}, 1000);
    try {
      await expect(file.close()).rejects.toBeInstanceOf(SftpPublicationError);
    } finally {
      clearTimeout(hold);
      await files.close();
    }
  });
  it("does not confuse undispatched request-budget admission with unknown mutation", async () => {
    const wire = peer();
    const files = await openSftpClient({ ...wire.config, maxRequests: 1 });
    await files.stat("a");
    await expect(files.openFile("new", { mode: "replace" })).rejects.toBeInstanceOf(RangeError);
    expect(wire.requests.length).toBe(1);
  });
  it("does not retry a refused directory CLOSE or leak its inaccessible handle", async () => {
    const wire = peer({ override: (type, id) => type === 4 ? status(id, 4) : undefined });
    const files = await openSftpClient(wire.config);
    await expect(files.list(".")).rejects.toThrow("status 4");
    expect(wire.requests.filter((request) => request.type === 4).length).toBe(1);
    expect(files.closed).toBe(true);
  });
  it("negotiates fragmented packets and decodes structured attributes, not longname", async () => {
    const wire = peer({ fragment: true });
    const files = await openSftpClient(wire.config);
    try {
      expect(files.extensions["fsync@openssh.com"]).toEqual(["1"]);
      expect(await files.stat("a")).toEqual({ kind: "file", size: 6, permissions: 0x81a4 });
      await files.stat("a", { follow: false });
      expect(wire.requests.at(-1)?.type).toBe(7);
      expect(await files.list(".")).toEqual([{
        name: "native name",
        attributes: { kind: "file", size: 6, permissions: 0x81a4 },
      }]);
      expect(wire.requests.at(-1)?.type).toBe(4);
    } finally {
      await files.close();
    }
  });
  it("rejects other protocol versions without guessing schemas", async () => {
    const wire = peer({ version: 6 });
    await expect(openSftpClient(wire.config)).rejects.toBeInstanceOf(SftpProtocolError);
    expect(wire.closed()).toBe(true);
  });
  it("loops native short reads and reports EOF only when explicitly observed", async () => {
    const wire = peer();
    const files = await openSftpClient(wire.config);
    try {
      const file = await files.openFile("a");
      const exact = await file.read(1, 4);
      expect(new TextDecoder().decode(exact.bytes)).toBe("bcde");
      expect(exact.eof).toBe(false);
      const beyond = await file.read(4, 8);
      expect(new TextDecoder().decode(beyond.bytes)).toBe("ef");
      expect(beyond.eof).toBe(true);
      expect(await file.read(0, 0)).toEqual({ bytes: new Uint8Array(0), eof: false });
      await file.close();
      expect(file.closed).toBe(true);
      await expect(file.read(0, 1)).rejects.toThrow("closed");
    } finally {
      await files.close();
    }
  });
  it("bounds open server handles and releases admission only after acknowledged CLOSE", async () => {
    const wire = peer();
    const files = await openSftpClient({ ...wire.config, maxOpenFiles: 1 });
    try {
      const one = await files.openFile("a");
      await expect(files.openFile("b")).rejects.toThrow("open-handle budget");
      await expect(files.list(".")).rejects.toThrow("open-handle budget");
      await one.close();
      const two = await files.openFile("b");
      await two.close();
    } finally {
      await files.close();
    }
  });
  it("rejects wrong IDs, trailing bytes, zero DATA and oversized DATA then retires the channel", async () => {
    for (
      const response of [
        (id: number) => packet(103, concat(u32(id + 1), str("a"))),
        (id: number) => packet(103, concat(u32(id), str("a"), u32(0))),
        (id: number) => packet(103, concat(u32(id), str(""))),
        (id: number) => packet(103, concat(u32(id), str("too long"))),
      ]
    ) {
      const wire = peer({ override: (type, id) => type === 5 ? response(id) : undefined });
      const files = await openSftpClient(wire.config);
      const file = await files.openFile("a");
      await expect(file.read(0, 1)).rejects.toBeInstanceOf(SftpProtocolError);
      expect(wire.closed()).toBe(true);
      expect(file.closed).toBe(true);
    }
  });
  it("refuses uint64 precision loss and unknown attribute flags", async () => {
    for (const data of [concat(u32(1), u32(0x200000), u32(0)), u32(16)]) {
      const wire = peer({ override: (type, id) => type === 17 ? packet(105, concat(u32(id), data)) : undefined });
      const files = await openSftpClient(wire.config);
      await expect(files.stat("a")).rejects.toBeInstanceOf(SftpProtocolError);
      expect(wire.closed()).toBe(true);
    }
  });
  it("refuses packet length before allocation and invalid NAME counts/paths", async () => {
    for (
      const response of [
        () => u32(0xffffffff),
        (id: number) => packet(104, concat(u32(id), u32(0xffffffff))),
        (id: number) => packet(104, concat(u32(id), u32(1), str("../escape"), str(""), attrs())),
      ]
    ) {
      const wire = peer({ override: (type, id) => type === 12 ? response(id) : undefined });
      const files = await openSftpClient(wire.config);
      await expect(files.list(".")).rejects.toBeInstanceOf(SftpProtocolError);
      expect(wire.closed()).toBe(true);
    }
  });
  it("known server failure preserves session alignment and omits untrusted error text", async () => {
    let failed = false;
    const wire = peer({
      override: (type, id) => {
        if (type === 17 && !failed) {
          failed = true;
          return status(id, 2);
        }
        return undefined;
      },
    });
    const files = await openSftpClient(wire.config);
    try {
      await expect(files.stat("missing")).rejects.toThrow("status 2");
      expect(files.closed).toBe(false);
      expect((await files.stat("a")).size).toBe(6);
    } finally {
      await files.close();
    }
  });
  it("snapshots materialized WRITE bytes and selects exclusive create flags explicitly", async () => {
    const wire = peer();
    const files = await openSftpClient(wire.config);
    try {
      const file = await files.openFile("new", { mode: "create" });
      const opening = wire.requests[0]!.bytes;
      const nameSize = new DataView(opening.buffer, opening.byteOffset + 9, 4).getUint32(0);
      expect(new DataView(opening.buffer, opening.byteOffset + 13 + nameSize, 4).getUint32(0)).toBe(42);
      const content = encode("abc");
      const writing = file.write(1, content);
      content.fill(120);
      expect(await writing).toEqual({ at: 1, bytes: 3 });
      expect(new TextDecoder().decode(wire.writes[0]!.slice(-3))).toBe("abc");
      await file.close();
    } finally {
      await files.close();
    }
  });
  it("reports lost mutating OPEN and WRITE acknowledgements as unknown, without retries", async () => {
    for (const lost of [3, 6]) {
      const wire = peer({ override: (type) => type === lost ? null : undefined });
      const files = await openSftpClient({ ...wire.config, timeoutMs: 20 });
      const hold = setTimeout(() => {}, 1000);
      try {
        if (lost === 3) {
          await expect(files.openFile("a", { mode: "replace" })).rejects.toBeInstanceOf(SftpPublicationError);
        } else {
          const file = await files.openFile("a", { mode: "write" });
          await expect(file.write(0, encode("a"))).rejects.toBeInstanceOf(SftpPublicationError);
        }
        expect(wire.requests.filter((request) => request.type === lost).length).toBe(1);
        expect(files.closed).toBe(true);
      } finally {
        clearTimeout(hold);
        await files.close();
      }
    }
  });
  it("refuses competing operations, forwards cancellation and closes all handles", async () => {
    const wire = peer({ override: (type) => type === 5 ? null : undefined });
    const files = await openSftpClient(wire.config);
    const file = await files.openFile("a");
    const abort = new AbortController();
    const reading = file.read(0, 3, { signal: abort.signal });
    await expect(files.stat("b")).rejects.toThrow("busy");
    abort.abort(new Error("preview stopped"));
    await expect(reading).rejects.toThrow("preview stopped");
    expect(file.closed).toBe(true);
    expect(wire.closed()).toBe(true);
  });
  it("validates native byte views, extents and UTF-8 paths before sending requests", async () => {
    const wire = peer();
    const files = await openSftpClient(wire.config);
    try {
      await expect(files.openFile("a\0b")).rejects.toThrow("pathname");
      expect(wire.requests.length).toBe(0);
      const file = await files.openFile("a", { mode: "write" });
      const count = wire.requests.length;
      await expect(file.write(0, new Uint16Array(2) as unknown as Uint8Array)).rejects.toThrow("native Uint8Array");
      await expect(file.read(Number.MAX_SAFE_INTEGER, 1)).rejects.toThrow("extent");
      expect(wire.requests.length).toBe(count);
      await file.close();
    } finally {
      await files.close();
    }
  });
});
