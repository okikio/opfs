import { strict as assert } from "node:assert";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getActiveResourcesInfo, memoryUsage, versions } from "node:process";
import { createFileSystem } from "../mod.ts";
import { createNodeAdapter } from "../src/adapter/node.ts";
import { expectBytes, finish, payload } from "./result.ts";

/** Heap observations need explicit collection and are never presented as a universal memory SLA. */
const collect: () => void = Reflect.get(globalThis, "gc");
if (typeof collect !== "function") throw new Error("Run node --expose-gc bench/lifecycle.bench.ts.");
/** Only a disposable native namespace belongs to this program. */
const root = await mkdtemp(join(tmpdir(), "opfs-lifecycle-"));
/** The source creates one fixed-size chunk at a time, independently of total input size. */
const chunk = payload(64 * 1024);
/** Declared scales travel with the report; the validator checks completeness against this contract. */
const workload = { cycles: 121, observeEvery: 20, transferBytes: [1024 * 1024, 32 * 1024 * 1024] };
/** Raw observations preserve every sample rather than applying an invented leak threshold. */
const samples: Array<{ cycle: number; memory: ReturnType<typeof memoryUsage>; resources: string[] }> = [];
const cancellationMs: number[] = [];
const transfers: Array<
  { bytes: number; elapsedMs: number; peak: ReturnType<typeof memoryUsage>; facadeBufferedBytes: number }
> = [];

/** Settles completed descriptor cleanup before observing the process after collection. */
async function observe(cycle: number): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  collect();
  collect();
  samples.push({ cycle, memory: memoryUsage(), resources: getActiveResourcesInfo().sort() });
}

let failed = false;
let primary: unknown;
try {
  // Warm runtime imports, filesystem machinery and cancellation before recording retained memory.
  for (let cycle = 0; cycle < workload.cycles; cycle++) {
    const fs = createFileSystem(createNodeAdapter({ root }), { coordination: "local", metrics: "basic" });
    let failed = false;
    let primary: unknown;
    try {
      await fs.writeFile("/cycle.bin", chunk);
      expectBytes(await fs.readFile("/cycle.bin"), chunk, "lifecycle roundtrip");
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      let cancellations = 0;
      const source = new ReadableStream<Uint8Array>({
        pull() {
          started.resolve();
        },
        cancel() {
          cancellations++;
        },
      }, { highWaterMark: 0 });
      const pending = fs.writeFile("/abort.bin", source, { signal: controller.signal });
      const rejected = pending.then(() => {
        throw new Error("Cancelled write succeeded.");
      }, (error: unknown) => error);
      // Admission can fail before the derived success oracle is awaited.
      void rejected.catch(() => undefined);
      let failed = false;
      let primary: unknown;
      try {
        await admit(started.promise, pending);
        const at = performance.now();
        controller.abort("lifecycle cancellation");
        const error = await rejected;
        cancellationMs.push(performance.now() - at);
        assert.equal(typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined, "aborted");
        assert.equal(cancellations, 1);
        assert.equal(source.locked, false);
      } catch (error) {
        failed = true;
        primary = error;
        throw error;
      } finally {
        await finish([async () => {
          controller.abort("lifecycle cleanup");
          await pending.then(() => undefined, () => undefined);
          // Consume the derived oracle rejection too, even when admission failed first.
          await rejected.catch(() => undefined);
        }], failed ? [primary] : []);
      }
      await fs.writeFile("/abort.bin", chunk);
      expectBytes(await fs.readFile("/abort.bin"), chunk, "lock reuse");
      await fs.emptyDir("/");
      assert.equal(fs.getMetrics().bufferedBytes, 0);
    } catch (error) {
      failed = true;
      primary = error;
      throw error;
    } finally {
      await finish([() => fs.close()], failed ? [primary] : []);
    }
    assert.deepEqual(await readdir(root), []);
    if (cycle % workload.observeEvery === 0) await observe(cycle);
  }

  for (const bytes of workload.transferBytes) {
    const fs = createFileSystem(createNodeAdapter({ root }), {
      coordination: "none",
      metrics: "basic",
      maxBufferedWriteBytes: 1024,
    });
    let failed = false;
    let primary: unknown;
    try {
      let produced = 0;
      let peak = memoryUsage();
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (produced === bytes) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
          produced += chunk.byteLength;
          const current = memoryUsage();
          if (current.rss > peak.rss) peak = current;
        },
      }, { highWaterMark: 0 });
      const at = performance.now();
      await fs.writeFile("/stream.bin", source);
      const elapsedMs = performance.now() - at;
      // Incremental verification retains at most one native read chunk.
      const reader = (await fs.openReadStream("/stream.bin")).getReader();
      let consumed = 0;
      let failed = false;
      let primary: unknown;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          for (let index = 0; index < next.value.byteLength; index++) {
            assert.equal(next.value[index], chunk[(consumed + index) % chunk.byteLength]);
          }
          consumed += next.value.byteLength;
        }
      } catch (error) {
        failed = true;
        primary = error;
        throw error;
      } finally {
        await finish([
          () => reader.releaseLock(),
          async () => {
            if (failed) await reader.cancel(primary);
          },
        ], failed ? [primary] : []);
      }
      assert.equal(consumed, bytes);
      assert.equal(source.locked, false);
      const metrics = fs.getMetrics();
      assert.equal(metrics.peakBufferedBytes, 0);
      transfers.push({ bytes, elapsedMs, peak, facadeBufferedBytes: metrics.peakBufferedBytes });
      await fs.remove("/stream.bin");
    } catch (error) {
      failed = true;
      primary = error;
      throw error;
    } finally {
      await finish([() => fs.close()], failed ? [primary] : []);
    }
  }
  await observe(workload.cycles);
  console.log(
    JSON.stringify(
      {
        versions,
        workload,
        measurement:
          "instrumented write includes per-source-pull memoryUsage; peak is sampled RSS, not a global maximum; active resources are not an FD census",
        platform: "node native files",
        chunkBytes: chunk.byteLength,
        samples,
        cancellationMs,
        transfers,
      },
      null,
      2,
    ),
  );
} catch (error) {
  failed = true;
  primary = error;
  throw error;
} finally {
  await finish([() => rm(root, { recursive: true, force: true })], failed ? [primary] : []);
}

/** Admission watchdog diagnoses a stalled fixture before measured cancellation starts. */
async function admit(started: Promise<void>, pending: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      started,
      pending.then(() => {
        throw new Error("Lifecycle write completed before source admission.");
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Lifecycle source admission stalled for 5 seconds.")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
