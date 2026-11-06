/** Finite Linux process-group ownership for reviewed fixture commands; no candidate modules. */
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { check } from "./acquire.ts";
export interface GroupType {
  readonly command: string;
  readonly args: readonly string[];
  readonly log: string;
  readonly seconds: number;
  readonly bytes: number;
}
export interface OutcomeType {
  readonly exit: number;
  readonly reason: string | null;
  readonly logBytes: number;
  readonly elapsedSeconds: number;
  readonly cleanupFaults: readonly string[];
}
/**
 * The detached child owns a new session. Deadline/log failures kill that exact
 * group, then wait at most 15 seconds for terminal pipe/exit state. The caller
 * owns the output receipt and the container resource/network envelope.
 */
export async function group(options: GroupType): Promise<OutcomeType> {
  check(
    process.platform === "linux" && Number.isFinite(options.seconds) && options.seconds > 0 &&
      options.seconds * 1000 <= 2147483647 && Number.isSafeInteger(options.bytes) && options.bytes > 0 &&
      options.bytes <= 4 * 1024 * 1024,
    "Finite Linux fixture process-group limits required.",
  );
  mkdirSync(dirname(options.log), { recursive: true });
  const fd = openSync(options.log, "wx", 0o600), start = performance.now();
  let count = 0, reason: string | null = null, retired = false;
  const cleanup: string[] = [];
  try {
    const child = spawn(options.command, [...options.args], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let signalFault: () => void = () => {};
    const failed = new Promise<void>((resolve) => {
      signalFault = resolve;
    });
    const fail = function (message: string): void {
      if (reason === null) {
        reason = message;
        signalFault();
      }
    };
    const closed = new Promise<number>((resolve) => {
      child.once("error", (error) => fail("launch error: " + error.message));
      child.once("close", (code) => {
        retired = true;
        resolve(code ?? 126);
      });
    });
    const collect = function (bytes: Buffer<ArrayBufferLike>): void {
      if (reason !== null) return;
      try {
        const admitted = bytes.subarray(0, Math.max(0, options.bytes - count));
        let at = 0;
        while (at < admitted.length) {
          const written = writeSync(fd, admitted, at, admitted.length - at);
          check(written > 0, "Log write made no progress.");
          at += written;
          count += written;
        }
        if (bytes.length > admitted.length) fail("combined diagnostic cap");
      } catch (error) {
        fail("log write error: " + String(error));
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => fail("whole process-group deadline"), options.seconds * 1000);
    let code = 126;
    try {
      await Promise.race([
        closed.then((exit) => {
          code = exit;
        }),
        failed,
      ]);
    } finally {
      clearTimeout(timer);
      // Even a leader that exited can leave descendants holding the pipes.
      // A fault is authoritative; no other process group is ever targeted.
      if (reason !== null || !retired) {
        if (child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) cleanup.push(String(error));
          }
        }
        let limit: ReturnType<typeof setTimeout> | undefined;
        try {
          const joined = await Promise.race([
            closed.then((exit) => {
              code = exit;
              return true;
            }),
            new Promise<boolean>((resolve) => {
              limit = setTimeout(() => resolve(false), 15_000);
            }),
          ]);
          if (!joined) cleanup.push("Owned process group did not retire within 15 seconds");
        } finally {
          if (limit !== undefined) clearTimeout(limit);
        }
      }
      child.stdout.removeListener("data", collect);
      child.stderr.removeListener("data", collect);
      child.stdout.destroy();
      child.stderr.destroy();
    }
    return {
      exit: reason !== null || cleanup.length ? 125 : code,
      reason,
      logBytes: count,
      elapsedSeconds: (performance.now() - start) / 1000,
      cleanupFaults: cleanup,
    };
  } finally {
    closeSync(fd);
  }
}
