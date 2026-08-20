import { expect, test } from "@playwright/test";

import type { BrowserTestGlobalType } from "../../tests/browser/fixtures/api.ts";

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
  result: { rawMs: number; adapterMs: number; facadeMs: number },
): Record<string, number | string> {
  return {
    browser,
    backend,
    iterations,
    bytes,
    ...result,
    adapterOverhead: result.adapterMs / result.rawMs,
    facadeOverhead: result.facadeMs / result.rawMs,
    facadeOverAdapter: result.facadeMs / result.adapterMs,
  };
}

test("reports raw native OPFS, direct adapter, and facade overhead", async ({ browserName, page }, testInfo) => {
  await ready(page);
  const result = await page.evaluate(async () =>
    await (globalThis as InstalledFixtureGlobalType).opfsTest.benchmark(25, 64 * 1024)
  );
  test.skip(result === null, "OPFS is unavailable in this browser context.");
  expect(result!.rawMs).toBeGreaterThan(0);
  expect(result!.adapterMs).toBeGreaterThan(0);
  expect(result!.facadeMs).toBeGreaterThan(0);
  const sample = report(browserName, "opfs", 25, 64 * 1024, result!);
  console.log(`[opfs benchmark] ${JSON.stringify(sample)}`);
  await testInfo.attach("opfs-benchmark.json", {
    body: JSON.stringify(sample, null, 2),
    contentType: "application/json",
  });
});

for (const backend of ["localstorage", "indexeddb", "cache"] as const) {
  test(`reports raw ${backend}, direct adapter, and facade overhead`, async ({ browserName, page }, testInfo) => {
    await ready(page);
    const result = await page.evaluate(
      async ({ backend }) =>
        await (globalThis as InstalledFixtureGlobalType).opfsTest.benchmarkAdapter(backend, 20, 16 * 1024),
      { backend },
    );
    test.skip(result === null, `${backend} is unavailable in this browser context.`);
    expect(result!.rawMs).toBeGreaterThan(0);
    expect(result!.adapterMs).toBeGreaterThan(0);
    expect(result!.facadeMs).toBeGreaterThan(0);
    const sample = report(browserName, backend, 20, 16 * 1024, result!);
    console.log(`[opfs benchmark] ${JSON.stringify(sample)}`);
    await testInfo.attach(`${backend}-benchmark.json`, {
      body: JSON.stringify(sample, null, 2),
      contentType: "application/json",
    });
  });
}
