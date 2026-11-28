/** Child execution for the package gate retains the repository's process timeout and cleanup. */
import { runProgram } from "../../bench/process.ts";
import type { SpawnOptions } from "node:child_process";

/** Runs one child command and rejects when it exits unsuccessfully. */
export function command(
  file: string,
  args: readonly string[],
  options: Pick<SpawnOptions, "cwd" | "env" | "stdio"> & { timeoutMs?: number } = {},
): Promise<void> {
  return runProgram(file, args, { stdio: "inherit", ...options });
}

/** Returns true when the executable can be started in this environment. */
export async function hasCommand(file: string): Promise<boolean> {
  try {
    await command(file, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
