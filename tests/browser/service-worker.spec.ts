import { expect } from "@playwright/test";
import { test } from "./ready.ts";

import type { BrowserTestGlobalType } from "./fixtures/api.ts";

/** File-local global shape after the fixture page installs its Playwright API. */
type InstalledFixtureGlobalType = typeof globalThis & BrowserTestGlobalType;

test("ServiceWorker behavior is verified through page messaging in every browser", async ({ ready: page }) => {
  const result = await page.evaluate(async () =>
    await (globalThis as InstalledFixtureGlobalType).opfsTest.service(
      `/service/${crypto.randomUUID()}.txt`,
      "service",
    )
  );
  test.skip(!result.supported, "ServiceWorker is not exposed in this browser context.");
  expect(result.probe?.context).toBe("service-worker");
  if (result.probe?.rootAvailable) expect(result.value).toBe("service");
  else expect(result.probe?.rootError).toBeDefined();
});

test("Chromium exposes the registered service worker to Playwright instrumentation", async ({ browserName, context, ready: page }) => {
  test.skip(browserName !== "chromium", "Playwright serviceWorkers() inspection is Chromium-only.");
  const observed = context.waitForEvent("serviceworker");
  // Observe creation while the registration exists. The fixture unregisters
  // before returning, so a later serviceWorkers() snapshot is not a lifecycle guarantee.
  void observed.catch(() => {});
  const result = await page.evaluate(async () =>
    await (globalThis as InstalledFixtureGlobalType).opfsTest.service(
      `/service/${crypto.randomUUID()}.txt`,
      "instrumented",
    )
  );
  test.skip(!result.supported, "ServiceWorker is not exposed in this Chromium context.");
  expect(result.probe?.context).toBe("service-worker");
  expect(new URL((await observed).url()).pathname).toBe("/tests/browser/fixtures/service.ts");
});
