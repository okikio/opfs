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

/** Native startup has a finite operational budget, not a library latency requirement. */
const COMMAND_TIMEOUT = 180_000;
/** Leave ten seconds for child retirement after a failed readiness admission. */
const READY_TIMEOUT = COMMAND_TIMEOUT - 10_000;
/** The longest control admits three children, then settles independent cleanup. */
const CONTROL_TIMEOUT = 3 * COMMAND_TIMEOUT + 30_000;

/**
 * Records settled native facts before a verdict or fixture retirement can fail.
 *
 * The first error remains the exact original assertion, acquisition or cleanup
 * reason. The independent observation is metadata, not retained raw fault bytes.
 * A rejected capture has no observation; this control does not invent one.
 */
async function inspect(action: (run: typeof capture) => Promise<void>): Promise<void> {
  const observations: ReturnType<typeof observation>[] = [];
  const run: typeof capture = async (...parameters) => {
    const output = await capture(...parameters);
    observations.push(observation(output));
    return output;
  };
  try {
    await action(run);
  } catch (reason) {
    throw new AggregateError(
      [reason, { observations }],
      `Native command control failed. Settled observations: ${JSON.stringify(observations)}`,
      { cause: reason },
    );
  }
}

/** Immediate ownership protects every later assertion and fallible command. */
async function fixture(
  action: (owner: Awaited<ReturnType<typeof own>>, run: typeof capture) => Promise<void>,
): Promise<void> {
  await inspect((run) =>
    withReleases(async (releases) => {
      const root = await mkdtemp(join(tmpdir(), "opfs-command-control-"));
      releases.push(() => rm(root, { recursive: true, force: true }));
      await action(await own(root), run);
    })
  );
}

describe("native command evidence", () => {
  it(
    "keeps exact assertion and cleanup failures beside settled native observations",
    { timeout: CONTROL_TIMEOUT },
    async () => {
      for (const reason of [undefined, null, new Error("original assertion")]) {
        const cleanup = new Error("independent retirement");
        let failure: unknown;
        try {
          await inspect((run) =>
            withReleases(async (releases) => {
              releases.push(() => {
                throw cleanup;
              });
              await run(execPath, args("process.exit(0)"), { timeoutMs: COMMAND_TIMEOUT });
              throw reason;
            })
          );
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) throw failure;
        const primary = failure.errors[0];
        expect(primary).toBeInstanceOf(AggregateError);
        expect(primary.errors[0]).toBe(reason);
        expect(primary.errors[1]).toBe(cleanup);
        expect(failure.cause).toBe(primary);
        const facts = failure.errors[1].observations;
        expect(facts.length).toBe(1);
        expect(facts[0]).toMatchObject({
          spawned: true,
          exitObserved: true,
          closeObserved: true,
          code: 0,
          signal: null,
        });
        expect(facts[0].stdout).toMatchObject({ observedBytes: 0, retainedBytes: 0, eof: true, complete: true });
      }
    },
  );
  for (const code of [0, 9]) {
    it(
      `retains exact independent binary streams and the actual exit ${code}`,
      { timeout: CONTROL_TIMEOUT },
      async () => {
        await fixture(async (owner, run) => {
          const stdout = Buffer.from([0, 255, 128, 13, 10]);
          const stderr = Buffer.from([1, 254, 129, 0]);
          const output = await run(
            execPath,
            args(`
          import { writeSync } from 'node:fs';
          writeSync(1, new Uint8Array([0,255,128,13,10]));
          writeSync(2, new Uint8Array([1,254,129,0]));
          process.exit(${code});
        `),
            { timeoutMs: COMMAND_TIMEOUT },
          );
          const record = await retain(output, owner, "call-0001");
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
      },
    );
  }
  it(
    "records a missing executable without inventing a child exit or successful EOF",
    { timeout: CONTROL_TIMEOUT },
    async () => {
      await fixture(async (owner, run) => {
        const output = await run(join(owner.directory, "missing-executable"), [], { timeoutMs: COMMAND_TIMEOUT });
        const record = await retain(output, owner, "call-0001");
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
        expect(record.retentionFailures).toEqual([]);
        expect((await readFile(join(record.report, "stdout.bin"))).length).toBe(0);
        expect((await readFile(join(record.report, "stderr.bin"))).length).toBe(0);
        expect(JSON.parse(await readFile(join(record.report, "metadata.json"), "utf8")).code).toBe(null);
      });
    },
  );
  it(
    "retains a finite physical quota prefix without promoting it to complete output",
    { timeout: CONTROL_TIMEOUT },
    async () => {
      await fixture(async (owner, run) => {
        const quota = 1024;
        const output = await run(
          execPath,
          args(`
        import { writeSync } from 'node:fs';
        writeSync(2, new Uint8Array([0,255,128]));
        writeSync(1, new Uint8Array(32768).fill(255));
        setInterval(() => {}, 1000);
      `),
          { quotaBytes: quota, timeoutMs: COMMAND_TIMEOUT },
        );
        const record = await retain(output, owner, "call-0001");
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
        expect(record.retentionFailures).toEqual([]);
        expect(await readFile(join(record.report, "stdout.bin"))).toEqual(Buffer.alloc(quota, 255));
        expect(await readFile(join(record.report, "stderr.bin"))).toEqual(Buffer.from([0, 255, 128]));
        // Kill acknowledgement is independent of the reported code/signal.
        expect(output.killed).toBe(true);
        expect(output.exitObserved).toBe(true);
      });
    },
  );
  it(
    "bounds a real stalled child and keeps deadline distinct from its actual status",
    { timeout: CONTROL_TIMEOUT },
    async () => {
      await inspect(async (run) => {
        const output = await run(execPath, args("setInterval(() => {}, 1000)"), { timeoutMs: 1000 });
        expect(output.success).toBe(false);
        expect(output.failures.some((failure: { stage: string }) => failure.stage === "deadline")).toBe(true);
        expect(output.killed).toBe(true);
        expect(output.exitObserved).toBe(true);
        expect(output.code !== 0 || output.signal !== null).toBe(true);
        expect(output.closeObserved).toBe(true);
      });
    },
  );
  it(
    "does not acquire a child after cancellation and retains the original reason",
    { timeout: CONTROL_TIMEOUT },
    async () => {
      await inspect(async (run) => {
        const signal = AbortSignal.abort(new Error("owned cancellation"));
        const output = await run(execPath, args("process.exit(0)"), { signal });
        expect(output.spawned).toBe(false);
        expect(output.pid).toBe(null);
        expect(output.exitObserved).toBe(false);
        expect(output.success).toBe(false);
        expect(output.failures[0].reason).toBe(signal.reason);
        expect(output.stdout.eof).toBe(false);
      });
    },
  );
  it("cancels a physically ready native child and retains its admitted bytes and exact reason", {
    timeout: CONTROL_TIMEOUT,
  }, async () => {
    await fixture(async (owner, run) => {
      await withReleases(async (releases) => {
        const controller = new AbortController();
        const marker = join(owner.directory, "ready.bin");
        let finished = false;
        const pending = run(
          execPath,
          args(`
          import { writeSync, writeFileSync } from 'node:fs';
          writeSync(1, new Uint8Array([0,255,128]));
          writeFileSync(${JSON.stringify(marker)}, new Uint8Array([1]));
          setInterval(() => {}, 1000);
        `),
          { timeoutMs: COMMAND_TIMEOUT, signal: controller.signal },
        ).then((output) => {
          finished = true;
          return output;
        });
        releases.push(async () => {
          controller.abort();
          await pending;
        });
        const expires = Date.now() + READY_TIMEOUT;
        for (;;) {
          try {
            expect(await readFile(marker)).toEqual(Buffer.from([1]));
            break;
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
            if (finished) {
              throw new Error("Native child settled before readiness.", { cause: observation(await pending) });
            }
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
  it("retains workload exit and independent report acquisition faults without writing a replaced owner", {
    timeout: CONTROL_TIMEOUT,
  }, async () => {
    await fixture(async (owner, run) => {
      const output = await run(execPath, args("process.exit(9)"), { timeoutMs: COMMAND_TIMEOUT });
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
  it(
    "retains stderr and journal when a physical stdout destination cannot be created",
    { timeout: CONTROL_TIMEOUT },
    async () => {
      await fixture(async (owner, run) => {
        const output = await run(
          execPath,
          args(`
        import { writeSync } from 'node:fs';
        writeSync(1, new Uint8Array([255,0]));
        writeSync(2, new Uint8Array([128,1]));
        process.exit(9);
      `),
          { timeoutMs: COMMAND_TIMEOUT },
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
    },
  );
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
