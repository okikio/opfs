import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath, versions } from "node:process";
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { capture, diagnostic, observation, retain } from "../.mise/tasks/command.mjs";
import { own } from "../.mise/tasks/container.mjs";
import { withReleases } from "./close.ts";

/** One shared native program; each runtime uses its documented ESM evaluator. */
function args(body: string): string[] {
  return versions.deno ? ["eval", "--no-config", body] : ["--input-type=module", "-e", body];
}

/** Immediate ownership protects every later assertion and fallible command. */
async function fixture(action: (owner: Awaited<ReturnType<typeof own>>) => Promise<void>): Promise<void> {
  await withReleases(async (releases) => {
    const root = await mkdtemp(join(tmpdir(), "opfs-command-control-"));
    releases.push(() => rm(root, { recursive: true, force: true }));
    await action(await own(root));
  });
}

describe("native command evidence", () => {
  for (const code of [0, 9]) {
    it(`retains exact independent binary streams and the actual exit ${code}`, async () => {
      await fixture(async (owner) => {
        const stdout = Buffer.from([0, 255, 128, 13, 10]);
        const stderr = Buffer.from([1, 254, 129, 0]);
        const output = await capture(
          execPath,
          args(`
          import { writeSync } from 'node:fs';
          writeSync(1, new Uint8Array([0,255,128,13,10]));
          writeSync(2, new Uint8Array([1,254,129,0]));
          process.exit(${code});
        `),
          { timeoutMs: 10_000 },
        );
        expect(output.exitObserved).toBe(true);
        expect(output.closeObserved).toBe(true);
        expect(output.code).toBe(code);
        expect(output.signal).toBe(null);
        expect(output.success).toBe(code === 0);
        expect(output.stdout.bytes).toEqual(stdout);
        expect(output.stderr.bytes).toEqual(stderr);
        expect(output.stdout.eof).toBe(true);
        expect(output.stderr.eof).toBe(true);
        expect(output.stdout.complete).toBe(true);
        expect(output.stderr.complete).toBe(true);
        expect(output.failures).toEqual([]);
        expect(observation(output).stdout.sha256).toBe(createHash("sha256").update(stdout).digest("hex"));
        const record = await retain(output, owner, "call-0001");
        expect(record.retentionFailures).toEqual([]);
        expect(await readFile(join(record.report, "stdout.bin"))).toEqual(stdout);
        expect(await readFile(join(record.report, "stderr.bin"))).toEqual(stderr);
        const metadata = JSON.parse(await readFile(join(record.report, "metadata.json"), "utf8"));
        expect(metadata.code).toBe(code);
        expect(metadata.stdout.sha256).toBe(createHash("sha256").update(stdout).digest("hex"));
        expect(metadata.stderr.sha256).toBe(createHash("sha256").update(stderr).digest("hex"));
        expect(metadata.stdout.retainedBytes).toBe(stdout.length);
        expect(metadata.stderr.retainedBytes).toBe(stderr.length);
        expect("bytes" in metadata.stdout).toBe(false);
      });
    });
  }
  it("records a missing executable without inventing a child exit or successful EOF", async () => {
    await fixture(async (owner) => {
      const output = await capture(join(owner.directory, "missing-executable"), [], { timeoutMs: 5000 });
      expect(output.success).toBe(false);
      expect(output.spawned).toBe(false);
      expect(output.exitObserved).toBe(false);
      expect(output.code).toBe(null);
      expect(output.signal).toBe(null);
      expect(output.stdout.complete).toBe(false);
      expect(output.stderr.complete).toBe(false);
      expect(output.failures.some((failure: { reason: { code?: string } }) => failure.reason.code === "ENOENT")).toBe(
        true,
      );
      const record = await retain(output, owner, "call-0001");
      expect(record.retentionFailures).toEqual([]);
      expect((await readFile(join(record.report, "stdout.bin"))).length).toBe(0);
      expect((await readFile(join(record.report, "stderr.bin"))).length).toBe(0);
      expect(JSON.parse(await readFile(join(record.report, "metadata.json"), "utf8")).code).toBe(null);
    });
  });
  it("retains a finite physical quota prefix without promoting it to complete output", async () => {
    await fixture(async (owner) => {
      const quota = 1024;
      const output = await capture(
        execPath,
        args(`
        import { writeSync } from 'node:fs';
        writeSync(2, new Uint8Array([0,255,128]));
        writeSync(1, new Uint8Array(32768).fill(255));
        setInterval(() => {}, 1000);
      `),
        { quotaBytes: quota, timeoutMs: 10_000 },
      );
      expect(output.success).toBe(false);
      expect(output.stdout.retainedBytes).toBe(quota);
      expect(output.stdout.observedBytes).toBeGreaterThan(quota);
      expect(output.stdout.bytes).toEqual(Buffer.alloc(quota, 255));
      expect(output.stdout.complete).toBe(false);
      expect(
        output.failures.some((failure: { stage: string; stream?: string }) =>
          failure.stage === "quota" && failure.stream === "stdout"
        ),
      ).toBe(true);
      expect(output.stderr.bytes).toEqual(Buffer.from([0, 255, 128]));
      const record = await retain(output, owner, "call-0001");
      expect(record.retentionFailures).toEqual([]);
      expect(await readFile(join(record.report, "stdout.bin"))).toEqual(Buffer.alloc(quota, 255));
      expect(await readFile(join(record.report, "stderr.bin"))).toEqual(Buffer.from([0, 255, 128]));
      // Kill acknowledgement is independent of the reported code/signal.
      expect(output.killed).toBe(true);
      expect(output.exitObserved).toBe(true);
    });
  });
  it("bounds a real stalled child and keeps deadline distinct from its actual status", async () => {
    const output = await capture(execPath, args("setInterval(() => {}, 1000)"), { timeoutMs: 1000 });
    expect(output.success).toBe(false);
    expect(output.failures.some((failure: { stage: string }) => failure.stage === "deadline")).toBe(true);
    expect(output.killed).toBe(true);
    expect(output.exitObserved).toBe(true);
    expect(output.code !== 0 || output.signal !== null).toBe(true);
    expect(output.closeObserved).toBe(true);
  });
  it("does not acquire a child after cancellation and retains the original reason", async () => {
    const signal = AbortSignal.abort(new Error("owned cancellation"));
    const output = await capture(execPath, args("process.exit(0)"), { signal });
    expect(output.spawned).toBe(false);
    expect(output.pid).toBe(null);
    expect(output.exitObserved).toBe(false);
    expect(output.success).toBe(false);
    expect(output.failures[0].reason).toBe(signal.reason);
    expect(output.stdout.eof).toBe(false);
  });
  it("cancels a physically ready native child and retains its admitted bytes and exact reason", async () => {
    await fixture(async (owner) => {
      await withReleases(async (releases) => {
        const controller = new AbortController();
        const marker = join(owner.directory, "ready.bin");
        const pending = capture(
          execPath,
          args(`
          import { writeSync, writeFileSync } from 'node:fs';
          writeSync(1, new Uint8Array([0,255,128]));
          writeFileSync(${JSON.stringify(marker)}, new Uint8Array([1]));
          setInterval(() => {}, 1000);
        `),
          { timeoutMs: 10_000, signal: controller.signal },
        );
        releases.push(async () => {
          controller.abort();
          await pending;
        });
        const expires = Date.now() + 5000;
        for (;;) {
          try {
            expect(await readFile(marker)).toEqual(Buffer.from([1]));
            break;
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
            if (Date.now() >= expires) throw new Error("Native child readiness watchdog expired.", { cause: error });
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        const reason = new Error("owned running cancellation");
        controller.abort(reason);
        const output = await pending;
        expect(output.success).toBe(false);
        expect(output.spawned).toBe(true);
        expect(output.exitObserved).toBe(true);
        expect(output.killed).toBe(true);
        expect(output.stdout.bytes).toEqual(Buffer.from([0, 255, 128]));
        expect(output.failures.find((failure: { stage: string }) => failure.stage === "cancel")?.reason).toBe(reason);
        expect(output.closeObserved).toBe(true);
      });
    });
  });
  it("retains workload exit and independent report acquisition faults without writing a replaced owner", async () => {
    await fixture(async (owner) => {
      const output = await capture(execPath, args("process.exit(9)"), { timeoutMs: 10_000 });
      const moved = `${owner.directory}-moved`;
      await withReleases(async (releases) => {
        releases.push(() => rm(moved, { recursive: true, force: true }));
        await rename(owner.directory, moved);
        // Restore the original pathname as a different native object, not a
        // trusted report root. The temporary fixture's outer release owns both.
        await writeFile(join(moved, "sentinel.bin"), new Uint8Array([0, 255, 128]));
        const replacement = await mkdtemp(`${owner.directory}-replacement-`);
        releases.push(() => rm(replacement, { recursive: true, force: true }));
        await rename(replacement, owner.directory);
        const record = await retain(output, owner, "call-0001");
        expect(record.code).toBe(9);
        expect(record.exitObserved).toBe(true);
        expect(record.retentionFailures.length).toBe(1);
        expect(record.retentionFailures[0].stage).toBe("acquire");
        expect(await readdir(owner.directory)).toEqual([]);
        expect(await readFile(join(moved, "sentinel.bin"))).toEqual(Buffer.from([0, 255, 128]));
      });
    });
  });
  it("retains stderr and journal when a physical stdout destination cannot be created", async () => {
    await fixture(async (owner) => {
      const output = await capture(
        execPath,
        args(`
        import { writeSync } from 'node:fs';
        writeSync(1, new Uint8Array([255,0]));
        writeSync(2, new Uint8Array([128,1]));
        process.exit(9);
      `),
        { timeoutMs: 10_000 },
      );
      let injected = false;
      const blocked = {
        ...owner,
        verify: async () => {
          await owner.verify();
          if (injected) return;
          try {
            await lstat(join(owner.directory, "call-0001"));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
          // The actual acquired destination now exists. Fault its stdout leaf;
          // the physical owner and independent stderr destination remain valid.
          await mkdir(join(owner.directory, "call-0001/stdout.bin"));
          injected = true;
        },
      };
      const record = await retain(output, blocked, "call-0001");
      expect(injected).toBe(true);
      expect(record.code).toBe(9);
      expect(record.retentionFailures.length).toBe(1);
      expect(record.retentionFailures[0].stage).toBe("write");
      expect(record.retentionFailures[0].stream).toBe("stdout");
      expect(await readFile(join(record.report, "stderr.bin"))).toEqual(Buffer.from([128, 1]));
      const metadata = JSON.parse(await readFile(join(record.report, "metadata.json"), "utf8"));
      expect(metadata.code).toBe(9);
      expect(metadata.retentionFailures.entries["0"].stage).toBe("write");
      expect(metadata.retentionFailures.entries["0"].stream).toBe("stdout");
    });
  });
  it("serializes original nested diagnostics and shared references without invoking accessors", () => {
    const original = Object.assign(new Error("inner"), { code: 9, detail: { actual: "unchanged" } });
    let accessed = 0;
    Object.defineProperty(original, "borrowed", {
      get() {
        accessed++;
        throw new Error("must not read");
      },
    });
    const failure = new AggregateError([original, new Error("cleanup")], "outer", { cause: original });
    const value = diagnostic(failure);
    expect(accessed).toBe(0);
    const json = JSON.stringify(value);
    expect(json).toContain('"code":9');
    expect(json).toContain('"actual":"unchanged"');
    expect(json).toContain('"message":"cleanup"');
    expect(json).toContain('"accessor":true');
    expect(json).toContain('"reference":');
  });
  it("does not invoke an Error name or byte-view constructor accessor", () => {
    let accessed = 0;
    const failure = new Error("owned reason");
    Object.defineProperty(failure, "name", {
      get() {
        accessed++;
        throw new Error("borrowed name");
      },
    });
    const bytes = Buffer.from([0, 255, 128]);
    Object.defineProperty(bytes, "constructor", {
      get() {
        accessed++;
        throw new Error("borrowed constructor");
      },
    });
    const value = diagnostic({ failure, bytes });
    expect(accessed).toBe(0);
    expect(value.failure.name).toEqual({ accessor: true });
    expect(value.failure.message).toBe("owned reason");
    expect(value.bytes).toEqual({ type: "Buffer", byteLength: 3 });
  });
});
