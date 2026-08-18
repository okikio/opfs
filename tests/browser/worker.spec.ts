import { expect, test } from "@playwright/test";

/** Same-origin fixture page that creates real DedicatedWorker and SharedWorker instances. */
const APP_URL = "http://127.0.0.1:4173/tests/browser/fixtures/index.html";

/** Opens the fixture page and waits for its OPFS test API. */
async function ready(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(APP_URL);
  await page.waitForFunction(() => Boolean((globalThis as unknown as { opfsTest?: { ready?: boolean } }).opfsTest?.ready));
}

test("DedicatedWorker uses real OPFS and probes synchronous access", async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () =>
    await globalThis.opfsTest.dedicated(`/dedicated/${crypto.randomUUID()}.txt`, "dedicated")
  );
  test.skip(!result.supported, "DedicatedWorker is not exposed in this browser context.");
  expect(result.probe?.context).toBe("dedicated-worker");
  if (result.probe?.rootAvailable) {
    expect(result.value).toBe("dedicated");
    if (result.probe.syncAccessHandleExposed && !result.syncOpened) expect(result.syncError).toBeDefined();
  } else {
    expect(result.probe?.rootError).toBeDefined();
  }
});

test("SharedWorker uses the browser's actual storage capability", async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () =>
    await globalThis.opfsTest.shared(`/shared/${crypto.randomUUID()}.txt`, "shared")
  );
  test.skip(!result.supported, "SharedWorker is not exposed in this browser context.");
  expect(["shared-worker", "worker"]).toContain(result.probe?.context);
  if (result.probe?.rootAvailable) expect(result.value).toBe("shared");
  else expect(result.probe?.rootError).toBeDefined();
});
