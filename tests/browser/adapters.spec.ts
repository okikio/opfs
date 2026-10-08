import { expect } from "@playwright/test";
import { test } from "./ready.ts";

import type { BrowserTestGlobalType } from "./fixtures/api.ts";

/** File-local global shape after the fixture page installs its Playwright API. */
type InstalledFixtureGlobalType = typeof globalThis & BrowserTestGlobalType;

for (const kind of ["localstorage", "indexeddb", "cache"] as const) {
  test(`${kind} adapter executes against the real browser backend`, async ({ ready: page }) => {
    expect(
      await page.evaluate(
        async ({ kind }) => await (globalThis as InstalledFixtureGlobalType).opfsTest.adapter(kind),
        { kind },
      ),
    ).toBe(kind);
  });
}

test("IndexedDB append preserves both independent writers", async ({ ready: page }) => {
  const value = await page.evaluate(async () =>
    await (globalThis as InstalledFixtureGlobalType).opfsTest.indexedDbAppend()
  );
  expect(["baseAB", "baseBA"]).toContain(value);
});
