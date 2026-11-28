/**
 * Preserve Gitleaks' native arguments and output while checking the Git process that supplies its input.
 * Gitleaks 8.30.1 can return zero after a failed Git traversal. Git's own Trace2 exit records keep that
 * failure separate from findings and from optional repository metadata. Trace files belong to one scan
 * and are removed before it returns; their argument records are never included in diagnostics.
 * @module
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

/** One Git process whose start, command name and terminal status must describe the same traversal. */
interface Session {
  /** Command selected by the scanner's native Git argument shape, before Git resolves it. */
  expected: string | undefined;
  /** Command reported by Git after its own argument processing. */
  command: string | undefined;
  /** Whether a process start with a complete argument array was observed. */
  started: boolean;
  /** Git's process exit, distinct from the later atexit bookkeeping event. */
  exit: number | undefined;
}

/** Commands that supply scanned patches or the contents of a scanned archive. */
const traversals = new Set(["log", "diff", "cat-file"]);

/**
 * Check native Git Trace2 events and return the number of completed patch traversals.
 *
 * Every log, diff and archive-blob reader must start and exit successfully. At least one log or diff
 * is required. An unrelated ls-remote failure only prevents finding links and does not invalidate a
 * completed scan. Missing, malformed or incomplete evidence throws without exposing recorded arguments.
 */
export function inspect(trace: string): number {
  const sessions = new Map<string, Session>();
  for (const line of trace.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("Git produced malformed Trace2 status evidence.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Git produced malformed Trace2 status evidence.");
    }
    const event = value as Record<string, unknown>;
    if (typeof event.sid !== "string" || !event.sid || typeof event.event !== "string") {
      throw new Error("Git produced malformed Trace2 status evidence.");
    }
    const session = sessions.get(event.sid) ?? {
      expected: undefined,
      command: undefined,
      started: false,
      exit: undefined,
    };
    sessions.set(event.sid, session);
    if (event.event === "start") {
      if (!Array.isArray(event.argv) || !event.argv.every((part) => typeof part === "string")) {
        throw new Error("Git produced malformed Trace2 start evidence.");
      }
      session.started = true;
      // Gitleaks invokes `git -C <source> log|diff|cat-file`; metadata also uses `git ls-remote`.
      // This identifies the process to check without interpreting the scanner's flags or log options.
      session.expected = event.argv[event.argv[1] === "-C" ? 3 : 1];
    } else if (event.event === "cmd_name") {
      if (typeof event.name !== "string") throw new Error("Git produced malformed Trace2 command evidence.");
      session.command = event.name;
    } else if (event.event === "exit") {
      if (!Number.isInteger(event.code) || (event.code as number) < 0) {
        throw new Error("Git produced malformed Trace2 exit evidence.");
      }
      if (session.exit !== undefined && session.exit !== event.code) {
        throw new Error("Git produced conflicting Trace2 exit evidence.");
      }
      session.exit = event.code as number;
    }
  }
  let patches = 0;
  for (const session of sessions.values()) {
    if (!traversals.has(session.expected ?? "") && !traversals.has(session.command ?? "")) continue;
    if (!session.started || session.expected !== session.command || session.exit === undefined) {
      throw new Error("Git traversal did not produce complete Trace2 status evidence.");
    }
    if (session.exit !== 0) {
      throw new Error(
        `Git ${session.command} failed with exit code ${session.exit}. Restore the required Git objects and retry.`,
      );
    }
    if (session.command === "log" || session.command === "diff") patches++;
  }
  if (!patches) {
    throw new Error("No completed Git traversal was recorded. For scanner help, use standalone --help or -h.");
  }
  return patches;
}

/**
 * Scan one repository with unchanged Gitleaks flags and inherited standard streams.
 *
 * Scanner failures retain their exit code. Successful scans also need Git's successful traversal
 * evidence. Standalone help is an early control and requires no repository. The invocation owns its
 * temporary trace and signal listeners; interrupt and terminate are forwarded to the child before
 * cleanup. Missing objects fail locally instead of triggering a partial clone's implicit network fetch.
 */
export async function scan(args: readonly string[], root = process.cwd()): Promise<number> {
  const directory = mkdtempSync(join(tmpdir(), "gitleaks-"));
  const trace = join(directory, "git.jsonl");
  try {
    writeFileSync(trace, "", { mode: 0o600, flag: "wx" });
    const child = spawn("gitleaks", [
      "git",
      "--redact",
      "--no-banner",
      "--log-level",
      "warn",
      "--exit-code",
      "1",
      ...args,
      ".",
    ], {
      cwd: root,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TRACE2_EVENT: trace },
      stdio: "inherit",
    });
    let forwarded: NodeJS.Signals | undefined;
    /** Preserve the requested signal while allowing the parent to finish trace cleanup. */
    const interrupt = () => {
      forwarded = "SIGINT";
      child.kill("SIGINT");
    };
    const terminate = () => {
      forwarded = "SIGTERM";
      child.kill("SIGTERM");
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      const signal = forwarded ?? result.signal;
      if (signal) return 128 + (constants.signals[signal] ?? 0);
      if (result.code !== 0) return result.code ?? 2;
      if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return 0;
      inspect(readFileSync(trace, "utf8"));
      return 0;
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await scan(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Secret scanning failed.");
    process.exitCode = 2;
  }
}
