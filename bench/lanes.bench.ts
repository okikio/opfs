import { deepStrictEqual } from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env, memoryUsage, versions } from "node:process";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { bench, do_not_optimize, group, run } from "mitata";
import { createFileSystem } from "../mod.ts";
import { createMemoryAdapter } from "../src/adapter/memory.ts";
import { createNodeAdapter } from "../src/adapter/node.ts";
import { createMemoryDriver } from "../src/driver/memory.ts";
import { createNodeDriver } from "../src/driver/node.ts";
import type { RecordType } from "../src/schema.ts";
import { finish } from "./result.ts";

/** Each lane performs replacement followed by a fully consumed byte read. */
interface LaneType {
  /** Backend and layer are recorded separately from fixture size. */
  readonly name: string;
  /** Timed operation returns bytes so work cannot disappear through an unused result. */
  roundtrip(bytes: Uint8Array): Promise<Uint8Array>;
}

/** Deterministic nonzero payload detects stale data, truncated reads and wrong offsets. */
function payload(size: number): Uint8Array {
  return Uint8Array.from(
    { length: size },
    (_, index) => (index * 31 + 17) % 251,
  );
}

/** Unique host namespace keeps benchmark writes away from consumer data. */
const root = await mkdtemp(join(tmpdir(), "opfs-lanes-"));
/** Register root cleanup before directory setup or facade construction can fail. */
const cleanups: Array<() => void | Promise<void>> = [() => rm(root, { recursive: true, force: true })];
let failed = false;
let primary: unknown;
try {
  /** Raw Map baseline deliberately copies bytes on both ownership transfers. */
  const raw = new Map<string, Uint8Array>();
  /** Record driver includes serialization in the timed operation, unlike a pre-encoded fixture. */
  const memory = createMemoryDriver();
  /** Direct adapter includes the same translation and byte result as every other lane. */
  const memoryAdapter = createMemoryAdapter();
  /** Layer comparisons share equivalent results but retain the backend's actual mechanics. */
  const lanes: LaneType[] = [
    {
      name: "memory/native Map",
      async roundtrip(bytes) {
        raw.set("/bench.bin", bytes.slice());
        return raw.get("/bench.bin")!.slice();
      },
    },
    {
      name: "memory/driver",
      async roundtrip(bytes) {
        const record: RecordType = {
          version: 1,
          path: "/bench.bin",
          parent: "/",
          name: "bench.bin",
          kind: "file",
          size: bytes.byteLength,
          data: encodeBase64(bytes),
          lastModified: 0,
          mediaType: "application/octet-stream",
        };
        await memory.set(record);
        const stored = await memory.get(record.path);
        if (stored?.kind !== "file") {
          throw new Error("Driver roundtrip did not return a file.");
        }
        return decodeBase64(stored.data);
      },
    },
    {
      name: "memory/adapter",
      async roundtrip(bytes) {
        await memoryAdapter.writeFile("/bench.bin", bytes, { mode: "replace" });
        return await memoryAdapter.readFile("/bench.bin");
      },
    },
  ];

  /** Independent directories avoid accidental reuse of cached data from a different layer. */
  for (
    const layer of ["native", "driver", "adapter", "none", "basic", "timing"]
  ) {
    await mkdir(join(root, layer));
  }
  /** Node baseline is explicit even when this program is run by another compatible runtime. */
  const nativePath = join(root, "native", "bench.bin");
  /** Direct Node driver provides native byte operations below the adapter. */
  const driver = createNodeDriver({ root: join(root, "driver") });
  /** Direct Node adapter is composed independently from the driver lane. */
  const adapter = createNodeAdapter({ root: join(root, "adapter") });
  lanes.push(
    {
      name: "node/native filesystem",
      async roundtrip(bytes) {
        await writeFile(nativePath, bytes);
        return new Uint8Array(await readFile(nativePath));
      },
    },
    {
      name: "node/driver",
      async roundtrip(bytes) {
        await driver.writeFile("/bench.bin", bytes, { mode: "replace" });
        return await driver.readFile("/bench.bin");
      },
    },
    {
      name: "node/adapter",
      async roundtrip(bytes) {
        await adapter.writeFile("/bench.bin", bytes, { mode: "replace" });
        return await adapter.readFile("/bench.bin");
      },
    },
  );
  for (const metrics of ["none", "basic", "timing"] as const) {
    for (const backend of ["memory", "node"] as const) {
      const fs = createFileSystem(
        backend === "memory" ? createMemoryAdapter() : createNodeAdapter({ root: join(root, metrics) }),
        { coordination: "none", metrics },
      );
      cleanups.push(() => fs.close());
      lanes.push({
        name: `${backend}/facade ${metrics}`,
        async roundtrip(bytes) {
          await fs.writeFile("/bench.bin", bytes);
          return await fs.readFile("/bench.bin");
        },
      });
    }
  }

  for (const size of [1024, 64 * 1024, 1024 * 1024]) {
    const bytes = payload(size);
    for (const lane of lanes) {
      deepStrictEqual(
        await lane.roundtrip(bytes),
        bytes,
        `${lane.name}: byte oracle`,
      );
    }
    group(`exact replacement + consumed read: ${size} bytes`, () => {
      for (const lane of lanes) {
        bench(
          lane.name,
          async () => do_not_optimize(await lane.roundtrip(bytes)),
        );
      }
    });
  }
  // Mitata's native JSON retains distribution samples and runtime metadata.
  // Memory snapshots below are process observations, not a retained-memory leak claim.
  if (env.BENCH_JSON !== "1") {
    console.log(JSON.stringify({ versions, before: memoryUsage() }));
  }
  await run(env.BENCH_JSON === "1" ? { format: "json", throw: true } : { throw: true });
} catch (error) {
  failed = true;
  primary = error;
  throw error;
} finally {
  await finish(cleanups, failed ? [primary] : []);
}
