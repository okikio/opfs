/**
 * Start one program from the repository root and wait for it.
 *
 * Several repository tools run other programs in sequence: the type check runs `deno check` and `tsc`, the release
 * tool runs Sampo and the registries, and the CI lanes run mise tasks. Each child inherits this terminal, so its
 * output appears in order in a CI log, and each command is printed first as `==> program args`. A long argument list
 * is shortened in that line only; the child still receives every argument.
 *
 * @example
 * ```ts
 * import { spawn } from "./spawn.ts";
 *
 * spawn("deno", ["fmt", "--check"]); // throws when deno exits with a nonzero status
 * spawn("node", ["tools/release/manifest.ts"], { env: { CI: "1" } });
 * ```
 *
 * @module
 */
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** The repository root; every child starts here so relative paths in its arguments mean the same thing. */
const root = fileURLToPath(new URL("../", import.meta.url));

/** Show at most this many arguments in the printed command line. */
const shown = 6;

/** Options for {@link spawn}. */
export interface SpawnOptionsType {
  /** Variables added to this process's environment for the child only. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Run `program` with `args` to completion, with its output on this terminal.
 *
 * @throws {Error} When the program exits with a nonzero status or cannot start. The message names the command.
 */
export function spawn(program: string, args: readonly string[], options: SpawnOptionsType = {}): void {
  const line = args.length > shown ? `${args.slice(0, 3).join(" ")} … (${args.length} arguments)` : args.join(" ");
  console.log(`==> ${program} ${line}`);
  const result = spawnSync(program, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...options.env } });
  if (result.error) throw new Error(`${program} ${line} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${program} ${line} exited with ${result.status ?? result.signal}.`);
}
