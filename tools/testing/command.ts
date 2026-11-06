/** Bounded native command observations. Importing this module starts no child. */
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { EventEmitter } from "node:events";
import { own } from "./container.ts";

/** A bounded cause tree that never invokes getters or serializes object prototypes. */
export type DiagnosticType = null | boolean | number | string | { [key: string]: DiagnosticType };

/** One native failure and its lifecycle stage, retaining the original in-memory cause. */
export type CommandFailureType = { stage: string; stream?: string; reason: unknown };

/** Completeness requires independently observed EOF and command retirement. */
export type PipeType = {
  quotaBytes: number;
  observedBytes: number;
  retainedBytes: number;
  eof: boolean;
  complete: boolean;
  bytes: Buffer;
};

/** A killed child is not an invented exit or proof that its pipes reached EOF. */
export type CommandType = {
  command: string;
  args: string[];
  started: string;
  finished?: string;
  pid: number | null;
  spawned: boolean;
  exitObserved: boolean;
  closeObserved: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  success: boolean;
  stdout: PipeType;
  stderr: PipeType;
  failures: CommandFailureType[];
};

/** Per-child bounds do not transfer ownership of daemon-side resources. */
export type CaptureOptionsType = {
  timeoutMs?: number;
  quotaBytes?: number;
  drainTimeoutMs?: number;
  signal?: AbortSignal;
};

/** Serializes original data causes without invoking getters or duplicating shared error graphs. */
export function diagnostic(value: unknown): DiagnosticType {
  const seen = new Map<object, Record<string, DiagnosticType>>();
  let remaining = 1_048_576;
  let properties = 4096;
  function visit(input: unknown, path: string, depth: number): DiagnosticType {
    if (typeof input === "string") {
      const accepted = input.slice(0, Math.max(0, remaining));
      remaining -= accepted.length;
      return accepted.length === input.length
        ? accepted
        : { text: accepted, omittedCharacters: input.length - accepted.length };
    }
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (typeof input !== "object") return { type: typeof input, value: String(input) };
    const reference = seen.get(input);
    if (reference) return { reference };
    if (depth > 32 || seen.size >= 4096) return { omitted: "diagnostic traversal limit" };
    seen.set(input, {
      id: seen.size,
      path: path.slice(0, 1024),
      ...(path.length > 1024 ? { omittedPathCharacters: path.length - 1024 } : {}),
    });
    if (ArrayBuffer.isView(input)) {
      return { type: Buffer.isBuffer(input) ? "Buffer" : "ArrayBufferView", byteLength: input.byteLength };
    }
    const result: Record<string, DiagnosticType> = {};
    function field(key: string): void {
      const property = Object.getOwnPropertyDescriptor(input, key);
      if (!property) return;
      if (properties-- <= 0) {
        result.omittedProperties = true;
        return;
      }
      if (key.length > remaining) {
        result.omittedProperties = true;
        return;
      }
      remaining -= key.length;
      if ("value" in property) result[key] = visit(property.value, `${path}.${key}`, depth + 1);
      else result[key] = { accessor: true };
    }
    for (const key of Object.getOwnPropertyNames(input)) {
      if (properties <= 0) {
        result.omittedProperties = true;
        break;
      }
      field(key);
    }
    if (input instanceof Error && !("name" in result)) {
      for (let prototype = Object.getPrototypeOf(input); prototype; prototype = Object.getPrototypeOf(prototype)) {
        const name = Object.getOwnPropertyDescriptor(prototype, "name");
        if (name && "value" in name) {
          result.name = visit(name.value, `${path}.name`, depth + 1);
          break;
        }
      }
    }
    return Array.isArray(input) ? { type: "array", entries: result } : result;
  }
  return visit(value, "$", 0);
}

/**
 * Captures independent raw prefixes, at most 16MiB per pipe.
 *
 * Exit is observed on the child's exit event; close and pipe EOF have separate
 * authority. A quota, cancellation or deadline kills only this exact child.
 * Retirement then has a finite drain grace. Forced pipe closure never becomes
 * EOF or an invented exit. The caller still owns daemon-side containers and any
 * descendants. Synchronous native acquisition and filesystem writes remain
 * inside the caller's outer operational watchdog.
 */
export function capture(
  command: string,
  args: readonly string[],
  options: CaptureOptionsType = {},
): Promise<CommandType> {
  const timeout = options.timeoutMs ?? 30_000;
  const quota = options.quotaBytes ?? 16 * 1024 * 1024;
  const grace = options.drainTimeoutMs ?? 1000;
  const signal = options.signal;
  for (const [name, value] of [["timeout", timeout], ["drain grace", grace]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2 ** 31 - 1) {
      throw new RangeError(`Invalid command ${name}.`);
    }
  }
  if (!Number.isSafeInteger(quota) || quota < 1 || quota > 16 * 1024 * 1024) {
    throw new RangeError("Invalid command byte quota.");
  }
  const pipe = (): {
    quotaBytes: number;
    observedBytes: number;
    retainedBytes: number;
    eof: boolean;
    storage?: Buffer;
  } => ({
    quotaBytes: quota,
    observedBytes: 0,
    retainedBytes: 0,
    eof: false,
  });
  const streams = { stdout: pipe(), stderr: pipe() };
  const emptyPipe = (): PipeType => ({
    quotaBytes: quota,
    observedBytes: 0,
    retainedBytes: 0,
    eof: false,
    complete: false,
    bytes: Buffer.alloc(0),
  });
  const result: CommandType = {
    command,
    args: [...args],
    started: new Date().toISOString(),
    pid: null,
    spawned: false,
    exitObserved: false,
    closeObserved: false,
    code: null,
    signal: null,
    killed: false,
    success: false,
    stdout: emptyPipe(),
    stderr: emptyPipe(),
    failures: [],
  };
  return new Promise<CommandType>((resolve) => {
    let child: ChildProcessByStdio<null, Readable, Readable> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let retirement: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let stopping = false;
    const listeners: (() => void)[] = [];
    function listen(target: EventEmitter, name: string, action: (...args: never[]) => void): void {
      const listener = (...args: unknown[]) => Reflect.apply(action, undefined, args);
      target.on(name, listener);
      listeners.push(() => target.removeListener(name, listener));
    }
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(retirement);
      signal?.removeEventListener("abort", abort);
      for (const remove of listeners) remove();
      for (const name of ["stdout", "stderr"] as const) {
        const stream = streams[name];
        result[name] = {
          quotaBytes: quota,
          observedBytes: stream.observedBytes,
          retainedBytes: stream.retainedBytes,
          eof: stream.eof,
          complete: result.spawned && stream.eof && !result.failures.some((failure) => failure.stream === name),
          bytes: stream.storage?.subarray(0, stream.retainedBytes) ?? Buffer.alloc(0),
        };
      }
      result.killed = child?.killed ?? false;
      result.finished = new Date().toISOString();
      result.success = result.exitObserved && result.code === 0 && result.signal === null && result.closeObserved &&
        result.stdout.complete && result.stderr.complete && result.failures.length === 0;
      resolve(result);
    }
    function stop() {
      if (stopping || settled) return;
      stopping = true;
      if (child) {
        try {
          child.kill("SIGKILL");
        } catch (reason) {
          result.failures.push({ stage: "kill", reason });
        }
      }
      retirement = setTimeout(() => {
        result.failures.push({
          stage: "drain",
          reason: new Error("Command retirement did not observe pipe close within its grace."),
        });
        child?.stdout.destroy();
        child?.stderr.destroy();
        child?.unref();
        finish();
      }, grace);
    }
    function abort() {
      result.failures.push({ stage: "cancel", reason: signal?.reason });
      stop();
    }
    if (signal?.aborted) {
      result.failures.push({ stage: "cancel", reason: signal.reason });
      finish();
      return;
    }
    try {
      child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
      result.pid = child.pid ?? null;
      listen(child, "spawn", () => {
        result.spawned = true;
      });
      listen(child, "error", (reason: Error) => {
        result.failures.push({ stage: "process", reason });
        stop();
      });
      listen(child, "exit", (code: number | null, signal: NodeJS.Signals | null) => {
        result.exitObserved = true;
        result.code = code;
        result.signal = signal;
      });
      listen(child, "close", () => {
        result.closeObserved = true;
        finish();
      });
      for (const name of ["stdout", "stderr"] as const) {
        const stream = streams[name];
        listen(child[name], "data", (bytes: Buffer) => {
          stream.observedBytes += bytes.length;
          const accepted = Math.min(bytes.length, quota - stream.retainedBytes);
          if (accepted) {
            stream.storage ??= Buffer.alloc(quota);
            bytes.copy(stream.storage, stream.retainedBytes, 0, accepted);
            stream.retainedBytes += accepted;
          }
          if (
            stream.observedBytes > quota &&
            !result.failures.some((failure) => failure.stage === "quota" && failure.stream === name)
          ) {
            result.failures.push({
              stage: "quota",
              stream: name,
              reason: new Error("Command pipe exceeds its retained byte quota."),
            });
            stop();
          }
        });
        listen(child[name], "end", () => {
          stream.eof = true;
        });
        listen(child[name], "error", (reason: Error) => {
          result.failures.push({ stage: "read", stream: name, reason });
          stop();
        });
      }
      signal?.addEventListener("abort", abort, { once: true });
      deadline = setTimeout(() => {
        result.failures.push({ stage: "deadline", reason: new Error("Command exceeded its operational deadline.") });
        stop();
      }, timeout);
    } catch (reason) {
      result.failures.push({ stage: "spawn", reason });
      if (child) stop();
      else finish();
    }
  });
}

/** Records finite stream identities without embedding raw bytes in JSON or error messages. */
export function observation(output: CommandType) {
  const stream = (value: PipeType) => ({
    quotaBytes: value.quotaBytes,
    observedBytes: value.observedBytes,
    retainedBytes: value.retainedBytes,
    eof: value.eof,
    complete: value.complete,
    sha256: createHash("sha256").update(value.bytes).digest("hex"),
  });
  return {
    ...output,
    stdout: stream(output.stdout),
    stderr: stream(output.stderr),
    failures: diagnostic(output.failures),
  };
}

/**
 * Attempts both raw files and their journal independently before a caller raises
 * workload failure. Exclusive creation and acquired physical roots reject aliases;
 * these checks admit quiescent owners, not hostile concurrent filesystem races.
 */
export async function retain(output: CommandType, owner: Awaited<ReturnType<typeof own>>, name: string) {
  if (!/^call-[0-9]+$/u.test(name)) throw new TypeError("Invalid command observation name.");
  const record = {
    ...observation(output),
    report: join(owner.directory, name),
    retentionFailures: [] as CommandFailureType[],
  };
  let acquired;
  try {
    await owner.verify();
    await mkdir(record.report);
    acquired = await own(record.report);
  } catch (reason) {
    record.retentionFailures.push({ stage: "acquire", reason });
  }
  if (acquired) {
    for (const stream of ["stdout", "stderr"] as const) {
      try {
        await owner.verify();
        await acquired.verify();
        await writeFile(join(record.report, `${stream}.bin`), output[stream].bytes, { flag: "wx" });
        await acquired.verify();
      } catch (reason) {
        record.retentionFailures.push({ stage: "write", stream, reason });
      }
    }
    try {
      await owner.verify();
      await acquired.verify();
      await writeFile(
        join(record.report, "metadata.json"),
        JSON.stringify(
          {
            ...record,
            retentionFailures: diagnostic(record.retentionFailures),
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
      await acquired.verify();
    } catch (reason) {
      record.retentionFailures.push({ stage: "metadata", reason });
    }
  }
  return record;
}
