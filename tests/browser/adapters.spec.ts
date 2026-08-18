import { expect, test } from "@playwright/test";

/** Same-origin fixture page that exposes the browser adapter test API. */
const APP_URL = "http://127.0.0.1:4173/tests/browser/fixtures/index.html";

/** Opens the fixture page and waits until its module API is ready for Playwright calls. */
async function ready(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(APP_URL);
  await page.waitForFunction(() => Boolean((globalThis as unknown as { opfsTest?: { ready?: boolean } }).opfsTest?.ready));
}

for (const kind of ["localstorage", "indexeddb", "cache"] as const) {
  test(`${kind} adapter executes against the real browser backend`, async ({ page }) => {
    await ready(page);
    expect(await page.evaluate(async ({ kind }) => await globalThis.opfsTest.adapter(kind), { kind })).toBe(kind);
  });
}

test("IndexedDB append preserves both independent writers", async ({ page }) => {
  await ready(page);
  const value = await page.evaluate(async () => await globalThis.opfsTest.indexedDbAppend());
  expect(["baseAB", "baseBA"]).toContain(value);
});
