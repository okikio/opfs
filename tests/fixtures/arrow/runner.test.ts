/** Linux process-group regression for the test-only native producer supervisor. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { kill, platform } from "node:process";
import { close } from "../../../src/close.ts";
import { supervise } from "./runner.ts";

/** Absence is terminal; a PID's group is checked before any cleanup signal can reach it. */
function state(pid: number): { readonly group: number; readonly status: string } | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(`/proc/${pid}/stat`, "r");
  } catch (reason) {
    if (reason !== null && typeof reason === "object" && "code" in reason && reason.code === "ENOENT") return;
    throw reason;
  }
  try {
    const bytes = new Uint8Array(4096), length = readSync(descriptor, bytes);
    if (length === bytes.length) throw new Error("Owned worker stat exceeds its read budget.");
    const text = new TextDecoder().decode(bytes.subarray(0, length)), end = text.lastIndexOf(")");
    const fields = text.slice(end + 2).split(" ");
    if (end < 0 || !/^[A-Za-z]$/u.test(fields[0] ?? "") || !/^[1-9][0-9]*$/u.test(fields[2] ?? "")) {
      throw new Error("Owned worker stat is invalid.");
    }
    return { status: fields[0]!, group: Number(fields[2]) };
  } finally {
    closeSync(descriptor);
  }
}
/** SIGKILL is asynchronous; join only this worker's terminal state under a one-second bound. */
async function retired(pid: number, group: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const actual = state(pid);
    if (actual === undefined || actual.group !== group || actual.status === "Z" || actual.status === "X") return true;
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  return false;
}

describe("native producer supervisor", () => {
  it("retires an inherited-group worker after its parent exits unsuccessfully", async () => {
    expect(platform, "The native supervisor regression requires isolated Linux qualification.").toBe("linux");
    mkdirSync(".tmp", { recursive: true });
    const root = resolve(mkdtempSync(".tmp/arrow-supervisor-"));
    let owned: { readonly pid: number; readonly group: number } | undefined;
    let failure: readonly unknown[] = [];
    try {
      const worker = join(root, "worker.ts"), parent = join(root, "parent.ts"), receipt = join(root, "owned.json");
      writeFileSync(worker, "setInterval(() => {}, 1000);\n", { flag: "wx" });
      writeFileSync(
        parent,
        `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { execPath, pid, exit } from "node:process";
const child = spawn(execPath, [${JSON.stringify(worker)}], { stdio: "ignore" });
if (child.pid === undefined) throw new Error("Owned worker was not created.");
child.unref();
writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ pid: child.pid, group: pid }), { flag: "wx" });
exit(1);
`,
        { flag: "wx" },
      );
      const outcome = await supervise(["node", parent], 10_000);
      expect(lstatSync(receipt).size).toBeLessThan(1024);
      const value: unknown = JSON.parse(readFileSync(receipt, "utf8"));
      if (
        value === null || typeof value !== "object" || !("pid" in value) || !("group" in value) ||
        typeof value.pid !== "number" || typeof value.group !== "number" ||
        !Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.group) || value.group <= 0
      ) {
        throw new Error("Owned worker identity receipt is invalid.");
      }
      owned = { pid: value.pid, group: value.group };
      expect(outcome.code).toBe(1);
      expect(outcome.signal).toBeNull();
      expect(outcome.failure).toBeNull();
      expect(outcome.cleanupFaults).toEqual([]);
      expect(await retired(owned.pid, owned.group), "Worker survived its failed parent's group retirement.").toBe(true);
    } catch (reason) {
      failure = [reason];
    }
    await close([
      async () => {
        if (owned === undefined) return;
        const actual = state(owned.pid);
        if (actual !== undefined && actual.group === owned.group && actual.status !== "Z" && actual.status !== "X") {
          kill(owned.pid, "SIGKILL");
          expect(await retired(owned.pid, owned.group), "Owned regression worker cleanup did not finish.").toBe(true);
        }
      },
      () => rmSync(root, { recursive: true, force: true }),
    ], failure);
  });
});
