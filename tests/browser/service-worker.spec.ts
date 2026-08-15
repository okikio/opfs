import { expect, test } from "@playwright/test";

/** Same-origin fixture page that registers and communicates with the ServiceWorker. */
const APP_URL = "http://127.0.0.1:4173/tests/browser/fixtures/index.html";

/** Opens the fixture page and waits for its OPFS test API. */
async function ready(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(APP_URL);
  await page.waitForFunction(() => Boolean((window as unknown as { opfsTest?: { ready?: boolean } }).opfsTest?.ready));
}

test("ServiceWorker behavior is verified through page messaging in every browser", async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () =>
    await window.opfsTest.service(`/service/${crypto.randomUUID()}.txt`, "service")
  );
  test.skip(!result.supported, "ServiceWorker is not exposed in this browser context.");
  expect(result.probe?.context).toBe("service-worker");
  if (result.probe?.rootAvailable) expect(result.value).toBe("service");
  else expect(result.probe?.rootError).toBeDefined();
});

test("Chromium exposes the registered service worker to Playwright instrumentation", async ({ browserName, context, page }) => {
  test.skip(browserName !== "chromium", "Playwright serviceWorkers() inspection is Chromium-only.");
  await ready(page);
  const result = await page.evaluate(async () =>
    await window.opfsTest.service(`/service/${crypto.randomUUID()}.txt`, "instrumented")
  );
  test.skip(!result.supported, "ServiceWorker is not exposed in this Chromium context.");
  expect(context.serviceWorkers().length).toBeGreaterThan(0);
});
