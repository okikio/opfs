/** A bounded outer owner retires the producer's whole POSIX process group. */
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execPath, kill, platform } from "node:process";
import { parseArgs } from "node:util";
import { MIB } from "./files.ts";

export interface OutcomeType {
  readonly code: number | null;
  readonly signal: string | null;
  readonly failure: string | null;
  readonly cleanupFaults: readonly string[];
  readonly bytes: number;
  readonly output: Buffer;
}
/** A fault kills the exact owned group, then joins for at most 15 seconds before releasing pipes. */
export async function supervise(argv: readonly string[], deadline: number): Promise<OutcomeType> {
  if (
    platform !== "linux" || argv.length === 0 || !Number.isSafeInteger(deadline) || deadline <= 0 ||
    deadline > 2147483647
  ) throw new Error("Native supervision requires Linux and a finite positive deadline.");
  const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [], cleanupFaults: string[] = [];
  let bytes = 0, captured = 0, failure: string | null = null, retired = false;
  let terminal: { code: number | null; signal: string | null } = { code: null, signal: null };
  let notifyFailure: () => void = () => {};
  const failed = new Promise<void>((done) => {
    notifyFailure = done;
  });
  function fail(reason: string): void {
    if (failure === null) {
      failure = reason;
      notifyFailure();
    }
  }
  const closed = new Promise<void>((done) => {
    child.once("error", (error) => fail("Native launch error: " + error.message));
    child.once("close", (code, signal) => {
      terminal = { code, signal };
      retired = true;
      done();
    });
  });
  const collect = (chunk: Buffer): void => {
    if (failure !== null) return;
    bytes += chunk.length;
    const admitted = chunk.subarray(0, Math.max(0, 4 * MIB - captured));
    if (admitted.length) {
      chunks.push(Buffer.from(admitted));
      captured += admitted.length;
    }
    if (admitted.length !== chunk.length) fail("Native stage combined diagnostics exceed 4 MiB.");
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const timer = setTimeout(() => fail("Native stage outer deadline."), deadline);
  try {
    await Promise.race([closed, failed]);
  } finally {
    clearTimeout(timer);
    if (failure !== null || !retired || terminal.code !== 0 || terminal.signal !== null) {
      if (child.pid !== undefined) {
        try {
          kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            cleanupFaults.push("Group retirement: " + String(error));
          }
        }
      }
      let limit: ReturnType<typeof setTimeout> | undefined;
      try {
        const joined = await Promise.race([
          closed.then(() => true),
          new Promise<boolean>((done) => {
            limit = setTimeout(() => done(false), 15_000);
          }),
        ]);
        if (!joined) cleanupFaults.push("Owned child stdio did not close within 15 seconds after group retirement.");
      } finally {
        if (limit !== undefined) clearTimeout(limit);
      }
    }
    child.stdout.removeListener("data", collect);
    child.stderr.removeListener("data", collect);
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
  return { ...terminal, failure, cleanupFaults, bytes, output: Buffer.concat(chunks) };
}
export async function produce(source: string): Promise<void> {
  const { values } = parseArgs({ options: { artifacts: { type: "string" }, output: { type: "string" } } });
  if (values.artifacts === undefined || values.output === undefined) {
    throw new TypeError("--artifacts and a new --output directory are required.");
  }
  const root = resolve(values.output);
  mkdirSync(root);
  const result = await supervise([
    execPath,
    source,
    "--artifacts",
    resolve(values.artifacts),
    "--output",
    join(root, "independent.json"),
  ], 180_000);
  writeFileSync(join(root, "native.log"), result.output, { flag: "wx" });
  writeFileSync(join(root, "native-state.json"), JSON.stringify({ ...result, output: undefined }) + "\n", {
    flag: "wx",
  });
  if (result.code !== 0 || result.failure !== null || result.cleanupFaults.length !== 0) {
    throw new Error("Native producer failed; retain native-state.json and native.log.");
  }
}
