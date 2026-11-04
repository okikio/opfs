import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProgram } from "../bench/process.ts";
import { finish } from "../bench/result.ts";
import { withReleases } from "./close.ts";

describe("benchmark program ownership", () => {
  it("waits for successful output to close before releasing its owned file", async () =>
    await withReleases(async (releases) => {
      const root = await mkdtemp(join(tmpdir(), "opfs-process-"));
      releases.push(() => rm(root, { recursive: true, force: true }));
      const path = join(root, "result.txt");
      const output = await open(path, "wx");
      releases.push(() => output.close());
      try {
        await runProgram("node", ["--input-type=module", "-e", "process.stdout.write('complete')"], {
          stdio: ["ignore", output.fd, "ignore"],
        });
      } finally {
        await output.close();
      }
      expect(await readFile(path, "utf8")).toBe("complete");
    }));

  it("retains startup failure rather than treating an absent executable as success", async () => {
    await expect(runProgram(`opfs-absent-${crypto.randomUUID()}`, [], { stdio: "ignore" }))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a child which exits unsuccessfully", async () => {
    await expect(runProgram("node", ["-e", "process.exit(7)"], { stdio: "ignore" })).rejects.toMatchObject({
      cause: { code: 7, signal: null },
    });
  });

  it("terminates a stalled child before attempting every owned release", async () => {
    const cleanupFailure = new Error("independent file close failure");
    const releases: string[] = [];
    let primary: unknown;
    try {
      await runProgram("node", ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 250, stdio: "ignore" });
    } catch (error) {
      primary = error;
    }
    expect(primary).toMatchObject({ name: "AbortError", cause: { name: "TimeoutError" } });
    // runProgram settles only on close; releases cannot race a still-running
    // direct child. This control has no assertion about elapsed milliseconds.
    let failure: unknown;
    try {
      await finish([
        () => {
          releases.push("services");
        },
        () => {
          releases.push("file");
          throw cleanupFailure;
        },
      ], [primary]);
    } catch (error) {
      failure = error;
    }
    expect(releases).toEqual(["file", "services"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([primary, cleanupFailure]);
  });
});
