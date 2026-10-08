import { expect, test } from "@playwright/test";

import type { BenchmarkResultType, BrowserTestGlobalType } from "../../tests/browser/fixtures/api.ts";

// Repeated real storage samples can exceed the ordinary correctness-test limit.
test.setTimeout(120_000);

/** File-local browser global shape after the benchmark fixture installs its API. */
type InstalledFixtureGlobalType = typeof globalThis & BrowserTestGlobalType;
/** File-local Window shape while the benchmark fixture module may still be initializing. */
type PendingFixtureWindowType = typeof window & Partial<BrowserTestGlobalType>;

/** Fixture page that exposes raw, adapter, and facade browser benchmark operations. */
const APP_URL = "http://127.0.0.1:4173/tests/browser/fixtures/index.html";

/** Opens the benchmark fixture and waits for its callable API. */
async function ready(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(APP_URL);
  await page.waitForFunction(() => Boolean((window as PendingFixtureWindowType).opfsTest?.ready));
}

/** Normalizes one browser benchmark result into comparable overhead ratios. */
function report(
  browser: string,
  backend: string,
  iterations: number,
  bytes: number,
  result: BenchmarkResultType,
): Record<string, number | string | BenchmarkResultType["samples"]> {
  const samples = result.samples;
  return {
    browser,
    backend,
    iterations,
    bytes,
    units: "milliseconds",
    statistic: "median of nine rotated batch averages; per-operation values divide each batch by iterations",
    scenario: "warm replacement plus fully consumed read; namespaces prepared outside timing; coordination disabled",
    representation: backend === "opfs"
      ? "native file bytes in every layer"
      : backend === "localstorage"
      ? "raw base64 payload versus JSON base64 file records in driver/adapter/facade; conversions included"
      : "native raw bytes versus base64 file records in driver/adapter/facade; conversions included",
    rawBatchMs: result.rawMs,
    driverBatchMs: result.driverMs,
    adapterBatchMs: result.adapterMs,
    facadeBatchMs: result.facadeMs,
    measuredBatchMs: result.measuredMs,
    rawPerOperationMs: result.rawMs / iterations,
    driverPerOperationMs: result.driverMs / iterations,
    adapterPerOperationMs: result.adapterMs / iterations,
    facadePerOperationMs: result.facadeMs / iterations,
    measuredPerOperationMs: result.measuredMs / iterations,
    batchSamplesMs: samples,
    perOperationSamplesMs: {
      rawMs: samples.rawMs.map((value) => value / iterations),
      driverMs: samples.driverMs.map((value) => value / iterations),
      adapterMs: samples.adapterMs.map((value) => value / iterations),
      facadeMs: samples.facadeMs.map((value) => value / iterations),
      measuredMs: samples.measuredMs.map((value) => value / iterations),
    },
    adapterOverhead: result.adapterMs / result.rawMs,
    driverOverhead: result.driverMs / result.rawMs,
    facadeOverhead: result.facadeMs / result.rawMs,
    facadeOverAdapter: result.facadeMs / result.adapterMs,
    metricsOverhead: result.measuredMs / result.facadeMs,
  };
}

test("reports native OPFS, driver, adapter, facade, and metrics overhead", async ({ browserName, page }, testInfo) => {
  await ready(page);
  const result = await page.evaluate(async () =>
    await (globalThis as InstalledFixtureGlobalType).opfsTest.benchmark(25, 64 * 1024)
  );
  test.skip(result === null, "OPFS is unavailable in this browser context.");
  expect(result!.rawMs).toBeGreaterThan(0);
  expect(result!.driverMs).toBeGreaterThan(0);
  expect(result!.adapterMs).toBeGreaterThan(0);
  expect(result!.facadeMs).toBeGreaterThan(0);
  expect(result!.measuredMs).toBeGreaterThan(0);
  const sample = report(browserName, "opfs", 25, 64 * 1024, result!);
  console.log(`[opfs benchmark] ${JSON.stringify(sample)}`);
  await testInfo.attach("opfs-benchmark.json", {
    body: JSON.stringify(sample, null, 2),
    contentType: "application/json",
  });
});

for (const backend of ["localstorage", "indexeddb", "cache"] as const) {
  test(
    `reports raw ${backend}, driver, adapter, facade, and metrics overhead`,
    async ({ browserName, page }, testInfo) => {
      await ready(page);
      const result = await page.evaluate(
        async ({ backend }) =>
          await (globalThis as InstalledFixtureGlobalType).opfsTest.benchmarkAdapter(backend, 20, 16 * 1024),
        { backend },
      );
      test.skip(result === null, `${backend} is unavailable in this browser context.`);
      expect(result!.rawMs).toBeGreaterThan(0);
      expect(result!.driverMs).toBeGreaterThan(0);
      expect(result!.adapterMs).toBeGreaterThan(0);
      expect(result!.facadeMs).toBeGreaterThan(0);
      expect(result!.measuredMs).toBeGreaterThan(0);
      const sample = report(browserName, backend, 20, 16 * 1024, result!);
      console.log(`[opfs benchmark] ${JSON.stringify(sample)}`);
      await testInfo.attach(`${backend}-benchmark.json`, {
        body: JSON.stringify(sample, null, 2),
        contentType: "application/json",
      });
    },
  );
}
