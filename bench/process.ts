import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";

/**
 * Runs one directly owned program until its process and stdio close.
 *
 * The twenty-minute watchdog bounds a broken workload; it is not a performance
 * target. SIGKILL prevents a stalled child from ignoring termination. Callers
 * own inherited output files and services and can release them after rejection.
 * This function does not launch a shell or own a child program's descendants.
 */
export async function runProgram(
  command: string,
  args: readonly string[],
  options: Pick<SpawnOptions, "cwd" | "env" | "stdio"> & { timeoutMs?: number } = {},
): Promise<void> {
  const { timeoutMs = 20 * 60_000, ...spawnOptions } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("Invalid program watchdog.");
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort(new DOMException(`${command} exceeded its operational watchdog.`, "TimeoutError"));
  }, timeoutMs);
  try {
    await new Promise<void>((resolve, reject) => {
      const failures: unknown[] = [];
      const child = spawn(command, args, {
        stdio: "inherit",
        ...spawnOptions,
        signal: controller.signal,
        killSignal: "SIGKILL",
      });
      child.on("error", (error) => failures.push(error));
      // 'error' can precede termination. Only 'close' permits caller cleanup.
      child.once("close", (code, signal) => {
        if (failures.length) {
          reject(failures.length === 1 ? failures[0] : new AggregateError(failures, "Program failed."));
        } else if (code !== 0) {
          reject(new Error(`${command} exited with ${code ?? signal}.`, { cause: { code, signal } }));
        } else resolve();
      });
    });
  } finally {
    clearTimeout(deadline);
  }
}
