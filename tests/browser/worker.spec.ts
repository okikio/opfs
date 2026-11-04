import { expect } from "@playwright/test";
import { test } from "./ready.ts";

import type { BrowserTestGlobalType } from "./fixtures/api.ts";

/** File-local global shape after the fixture page installs its Playwright API. */
type InstalledFixtureGlobalType = typeof globalThis & BrowserTestGlobalType;

test("DedicatedWorker uses real OPFS and probes synchronous access", async ({ ready: page }) => {
  const result = await page.evaluate(async () =>
    await (globalThis as InstalledFixtureGlobalType).opfsTest.dedicated(
      `/dedicated/${crypto.randomUUID()}.txt`,
      "dedicated",
    )
  );
  test.skip(!result.supported, "DedicatedWorker is not exposed in this browser context.");
  expect(result.probe?.context).toBe("dedicated-worker");
  if (result.probe?.rootAvailable) {
    expect(result.value).toBe("dedicated");
    if (result.probe.syncAccessHandleExposed) {
      expect(result.syncError).toBeUndefined();
      expect(result.syncOpened).toBe(true);
      expect(result.syncBytes).toEqual([0, 9, 127, 255, 0, 0]);
      expect(result.syncClosedCode).toBe("invalid-operation");
      expect(result.syncReopened).toBe(true);
    }
  } else {
    expect(result.probe?.rootError).toBeDefined();
  }
});

test("SharedWorker uses the browser's actual storage capability", async ({ ready: page }) => {
  const result = await page.evaluate(async () =>
    await (globalThis as InstalledFixtureGlobalType).opfsTest.shared(
      `/shared/${crypto.randomUUID()}.txt`,
      "shared",
    )
  );
  test.skip(!result.supported, "SharedWorker is not exposed in this browser context.");
  expect(["shared-worker", "worker"]).toContain(result.probe?.context);
  if (result.probe?.rootAvailable) expect(result.value).toBe("shared");
  else expect(result.probe?.rootError).toBeDefined();
});
