import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { FtpError, FtpPublicationError, openFtpClient } from "../src/ftp.ts";
import type { FtpOptionsType, FtpSocketType, FtpTransportType } from "../src/ftp.ts";

const encoder = new TextEncoder();
/** Scripted wire peer; its replies are independent protocol bytes, not client helpers. */
function peer(options: {
  readonly greeting?: string;
  readonly greetingBytes?: Uint8Array;
  readonly features?: string;
  readonly data?: string;
  readonly terminal?: string;
  readonly command?: (command: string) => string | undefined;
  readonly fragment?: boolean;
  readonly dataStalls?: boolean;
} = {}) {
  const commands: string[] = [];
  const connects: { readonly host: string; readonly port: number }[] = [];
  const security: string[] = [];
  const uploads: Uint8Array[] = [];
  let control!: ReadableStreamDefaultController<Uint8Array>;
  let data!: ReadableStreamDefaultController<Uint8Array>;
  let closed = 0;
  let dataClosed = false;
  let controlClosed = false;
  function reply(text: string) {
    if (options.fragment) { for (const byte of encoder.encode(text)) control.enqueue(new Uint8Array([byte])); }
    else control.enqueue(encoder.encode(text));
  }
  const socket: FtpSocketType = {
    peerAddress: "192.0.2.9",
    readable: new ReadableStream({
      start(value) {
        control = value;
        if (options.greetingBytes) control.enqueue(options.greetingBytes);
        else reply(options.greeting ?? "220 ready\r\n");
      },
    }),
    writable: new WritableStream({
      write(bytes) {
        const command = new TextDecoder().decode(bytes).slice(0, -2);
        commands.push(command);
        const custom = options.command?.(command);
        if (custom !== undefined) {
          if (custom) reply(custom);
          return;
        }
        if (command.startsWith("USER ")) reply("331 password\r\n");
        else if (command.startsWith("PASS ")) reply("230 logged in\r\n");
        else if (command === "AUTH TLS") reply("234 proceed\r\n");
        else if (command === "FEAT") {
          reply(options.features ?? "211-features\r\n MLST type*;size*;\r\n REST STREAM\r\n UTF8\r\n211 end\r\n");
        } else if (command === "EPSV") reply("229 passive (|||30000|)\r\n");
        else if (command.startsWith("REST ")) reply("350 restarting\r\n");
        else if (command.startsWith("MLST ")) {
          reply("250-Listing\r\n type=file;size=3;modify=20261105010203;unique=a; file name\r\n250 end\r\n");
        } else if (/^(RETR|MLSD|STOR) /.test(command)) {
          reply("150 opening\r\n");
          if (!command.startsWith("STOR ")) {
            if (options.data) data.enqueue(encoder.encode(options.data));
            if (!options.dataStalls) {
              data.close();
              dataClosed = true;
            }
            if (options.terminal !== "") reply(options.terminal ?? "226 complete\r\n");
          }
        } else reply("200 ok\r\n");
      },
    }),
    close() {
      if (!controlClosed) {
        closed++;
        control.close();
        controlClosed = true;
      }
      return Promise.resolve();
    },
  };
  const transport: FtpTransportType = {
    connect({ host, port }) {
      connects.push({ host, port });
      if (connects.length === 1) return Promise.resolve(socket);
      dataClosed = false;
      return Promise.resolve({
        peerAddress: "192.0.2.9",
        readable: new ReadableStream<Uint8Array>({
          start(value) {
            data = value;
          },
        }),
        writable: new WritableStream<Uint8Array>({
          write(value) {
            uploads.push(new Uint8Array(value));
          },
          close() {
            if (!dataClosed) {
              data.close();
              dataClosed = true;
            }
            if (options.terminal !== "") reply(options.terminal ?? "226 complete\r\n");
          },
        }),
        close() {
          if (!dataClosed) {
            closed++;
            data.close();
            dataClosed = true;
          }
          return Promise.resolve();
        },
      });
    },
    secure(value, context) {
      security.push(`${context.role}:${commands.at(-1)}`);
      return Promise.resolve({ socket: value, context: "test-only-not-real-TLS" });
    },
  };
  const config: FtpOptionsType = {
    host: "ftp.invalid",
    username: "user",
    password: "secret",
    mode: "plain",
    transport,
    timeoutMs: 1000,
  };
  return { config, commands, connects, security, uploads, closed: () => closed, reply };
}

async function bytes(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

describe("FTP protocol session", () => {
  it("parses fragmented multiline control replies and MLST facts without trimming names", async () => {
    const wire = peer({ fragment: true });
    const files = await openFtpClient(wire.config);
    try {
      const stat = await files.stat("file name");
      expect(stat.name).toBe("file name");
      expect(stat.size).toBe(3);
      expect(stat.unique).toBe("a");
      expect(wire.commands.slice(0, 5)).toEqual(["USER user", "PASS secret", "TYPE I", "MODE S", "STRU F"]);
    } finally {
      await files.close();
    }
  });
  it("validates injected command bytes before acquiring a connection", async () => {
    const wire = peer();
    await expect(openFtpClient({ ...wire.config, username: "user\r\nDELE x" })).rejects.toThrow("command bytes");
    expect(wire.connects.length).toBe(0);
    const files = await openFtpClient(wire.config);
    const count = wire.commands.length;
    await expect(files.stat("file\nDELE x")).rejects.toThrow("command bytes");
    expect(wire.commands.length).toBe(count);
    await files.close();
  });
  it("downloads only the REST suffix, pins the EPSV host, and waits for terminal success", async () => {
    const wire = peer({ data: "suffix", terminal: "" });
    const files = await openFtpClient(wire.config);
    try {
      const transfer = await files.openRead("a", { offset: 10 });
      const body = bytes(transfer.stream);
      let completed = false;
      transfer.done.then(() => {
        completed = true;
      });
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(wire.connects[1]).toEqual({ host: "192.0.2.9", port: 30000 });
      expect(wire.commands.slice(-3)).toEqual(["EPSV", "REST 10", "RETR a"]);
      wire.reply("226 complete\r\n");
      expect(await body).toBe("suffix");
      expect(await transfer.done).toEqual({ bytes: 6, code: 226 });
      expect((await files.stat("a")).size).toBe(3);
    } finally {
      await files.close();
    }
  });
  it("refuses concurrent commands and cancels a transfer even while its stream is locked", async () => {
    const wire = peer({ dataStalls: true, terminal: "" });
    const files = await openFtpClient(wire.config);
    const transfer = await files.openRead("a");
    const reader = transfer.stream.getReader();
    const reading = reader.read();
    await expect(files.stat("b")).rejects.toThrow("busy");
    await transfer.cancel(new Error("preview finished"));
    await expect(transfer.done).rejects.toThrow("preview finished");
    await expect(reading).rejects.toThrow("preview finished");
    await expect(files.stat("b")).rejects.toThrow("closed");
    reader.releaseLock();
    expect(wire.closed()).toBe(2);
  });
  it("observes negative final replies while the data channel is stalled", async () => {
    const wire = peer({ dataStalls: true, terminal: "426 aborted\r\n" });
    const files = await openFtpClient(wire.config);
    const transfer = await files.openRead("a");
    await expect(transfer.done).rejects.toBeInstanceOf(FtpError);
    expect(wire.closed()).toBe(2);
  });
  it("limits idle transfer lifetime without requiring the consumer to pull", async () => {
    const wire = peer({ dataStalls: true, terminal: "" });
    const files = await openFtpClient({ ...wire.config, timeoutMs: 25 });
    const transfer = await files.openRead("a");
    // Keep Node alive; AbortSignal.timeout intentionally does not retain its loop.
    const hold = setTimeout(() => {}, 1000);
    try {
      await expect(transfer.done).rejects.toThrow();
    } finally {
      clearTimeout(hold);
      await files.close();
    }
  });
  it("bounds control replies and rejects bare LF and unsupported Telnet bytes", async () => {
    for (const greeting of ["220 bad\n", "220 bad\u0000\r\n", `220 ${"x".repeat(100)}\r\n`]) {
      const wire = peer({ greeting });
      await expect(openFtpClient({ ...wire.config, maxLineBytes: 32 })).rejects.toThrow();
      expect(wire.closed()).toBe(1);
    }
    const wire = peer({ greetingBytes: new Uint8Array([50, 50, 48, 32, 255, 13, 10]) });
    await expect(openFtpClient(wire.config)).rejects.toThrow();
    expect(wire.closed()).toBe(1);
  });
  it("requires advertised REST and structured listing capabilities", async () => {
    const wire = peer({ features: "211-features\r\n UTF8\r\n211 end\r\n" });
    const files = await openFtpClient(wire.config);
    await expect(files.list(".")).rejects.toThrow("MLSD");
    await expect(files.openRead("a", { offset: 1 })).rejects.toThrow("REST STREAM");
    expect(wire.connects.length).toBe(1);
  });
  it("materializes bounded MLSD and retains leading spaces in child names", async () => {
    const wire = peer({ data: "type=cdir; .\r\ntype=pdir; ..\r\ntype=file;size=4;  leading\r\n" });
    const files = await openFtpClient(wire.config);
    try {
      expect((await files.list(".")).map((value) => value.name)).toEqual([" leading"]);
    } finally {
      await files.close();
    }
  });
  it("rejects malformed MLSx, unsafe sizes and entry/byte budgets", async () => {
    for (
      const data of [
        "type=file;size=9007199254740992; a\r\n",
        "type=file;type=dir; a\r\n",
        "type=file; a\n",
        "type=file; a\r\ntype=file; b\r\n",
      ]
    ) {
      const wire = peer({ data });
      const files = await openFtpClient({ ...wire.config, maxEntries: 1 });
      await expect(files.list(".")).rejects.toThrow();
      await expect(files.stat("a")).rejects.toThrow("closed");
      await files.close();
    }
  });
  it("snapshots bounded materialized upload bytes and requires final receipt", async () => {
    const wire = peer();
    const files = await openFtpClient(wire.config);
    try {
      const content = encoder.encode("abc");
      const writing = files.put("a", content);
      content.fill(120);
      expect(await writing).toEqual({ bytes: 3, code: 226 });
      expect(new TextDecoder().decode(wire.uploads[0])).toBe("abc");
    } finally {
      await files.close();
    }
  });
  it("reports unknown publication after dispatched STOR loses acknowledgement", async () => {
    const wire = peer({ terminal: "" });
    const files = await openFtpClient({ ...wire.config, timeoutMs: 25 });
    const hold = setTimeout(() => {}, 1000);
    try {
      await expect(files.put("a", encoder.encode("abc"))).rejects.toBeInstanceOf(FtpPublicationError);
    } finally {
      clearTimeout(hold);
      await files.close();
    }
  });
  it("does not mark an EPSV refusal as unknown publication", async () => {
    const wire = peer({ command: (command) => command === "EPSV" ? "500 unsupported\r\n" : undefined });
    const files = await openFtpClient(wire.config);
    await expect(files.put("a", encoder.encode("abc"))).rejects.toBeInstanceOf(FtpError);
    expect(wire.commands.some((value) => value.startsWith("STOR "))).toBe(false);
  });
  it("orders explicit TLS before credentials and PROT P before data (protocol proof only)", async () => {
    const wire = peer({ data: "abc" });
    const files = await openFtpClient({ ...wire.config, mode: "explicit-tls" });
    try {
      const transfer = await files.openRead("a");
      expect(await bytes(transfer.stream)).toBe("abc");
      expect(wire.commands.slice(0, 5)).toEqual(["AUTH TLS", "PBSZ 0", "PROT P", "USER user", "PASS secret"]);
      expect(wire.security).toEqual(["control:AUTH TLS", "data:RETR a"]);
    } finally {
      await files.close();
    }
  });
  it("never downgrades after AUTH TLS rejection", async () => {
    const wire = peer({ command: (command) => command === "AUTH TLS" ? "534 refused\r\n" : undefined });
    await expect(openFtpClient({ ...wire.config, mode: "explicit-tls" })).rejects.toThrow();
    expect(wire.commands).toEqual(["AUTH TLS"]);
  });
  it("passes cancellation to an in-flight TLS upgrade and its capability retires a late protected socket", async () => {
    const wire = peer();
    const abort = new AbortController();
    let secureStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      secureStarted = resolve;
    });
    let finish!: () => void;
    let retired = 0;
    const transport: FtpTransportType = {
      connect: wire.config.transport.connect,
      secure: (_socket, { signal }) =>
        new Promise((resolve, reject) => {
          secureStarted();
          // A capability owns partial/late acquisitions until successful transfer.
          const cancel = () => reject(signal.reason);
          signal.addEventListener("abort", cancel, { once: true });
          finish = () => {
            signal.removeEventListener("abort", cancel);
            if (signal.aborted) {
              retired++;
              return;
            }
            resolve({ socket: _socket, context: undefined });
          };
        }),
    };
    const opening = openFtpClient({ ...wire.config, mode: "explicit-tls", transport, signal: abort.signal });
    await started;
    abort.abort(new Error("login cancelled"));
    await expect(opening).rejects.toThrow("login cancelled");
    finish();
    expect(retired).toBe(1);
    expect(wire.closed()).toBe(1);
    expect(wire.commands).toEqual(["AUTH TLS"]);
  });
  it("observes terminal failure concurrently with a stalled FTPS data handshake", async () => {
    const wire = peer({ dataStalls: true, terminal: "426 no data\r\n" });
    const transport: FtpTransportType = {
      connect: wire.config.transport.connect,
      secure: (socket, { role, signal }) => {
        if (role === "control") return Promise.resolve({ socket, context: undefined });
        return new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    };
    const files = await openFtpClient({ ...wire.config, transport, mode: "explicit-tls" });
    await expect(files.openRead("a")).rejects.toThrow("did not complete");
    expect(wire.closed()).toBe(2);
  });
  it("publishes one idempotent close promise before abort listeners can reenter disposal", async () => {
    const wire = peer({ dataStalls: true, terminal: "" });
    const files = await openFtpClient(wire.config);
    const transfer = await files.openRead("a");
    const closing = files.close();
    expect(files.close()).toBe(closing);
    await closing;
    await expect(transfer.done).rejects.toThrow("closed");
    expect(wire.closed()).toBe(2);
  });
});
