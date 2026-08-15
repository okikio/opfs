import { chromium, expect, firefox, test, webkit } from "@playwright/test";

/** Same-origin fixture page used by Window and persistence scenarios. */
const APP_URL = "http://127.0.0.1:4173/tests/browser/fixtures/index.html";

/** Opens the fixture page and waits for its OPFS test API. */
async function ready(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(APP_URL);
  await page.waitForFunction(() => Boolean((window as unknown as { opfsTest?: { ready?: boolean } }).opfsTest?.ready));
}

test("window probes the actual capability and round-trips when OPFS is available", async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => await window.opfsTest.roundTrip(`/window/${crypto.randomUUID()}.txt`, "window"));
  expect(result.supported).toBe(true);
  expect(result.probe?.context).toBe("window");
  if (result.probe?.rootAvailable) expect(result.value).toBe("window");
  else expect(result.probe?.rootError).toBeDefined();
});

test("an aborted write cannot commit", async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => await window.opfsTest.abort(`/abort/${crypto.randomUUID()}.txt`));
  expect(["AbortError", "unavailable"]).toContain(result);
});

test("fresh browser contexts do not inherit another context's OPFS file", async ({ browser }) => {
  const path = `/isolation/${crypto.randomUUID()}.txt`;
  const first = await browser.newContext();
  const firstPage = await first.newPage();
  await ready(firstPage);
  const written = await firstPage.evaluate(async ({ path }) => await window.opfsTest.roundTrip(path, "private"), { path });
  await first.close();
  if (!written.probe?.rootAvailable) {
    expect(written.probe?.rootError).toBeDefined();
    return;
  }

  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await ready(secondPage);
  expect(await secondPage.evaluate(async ({ path }) => await window.opfsTest.read(path), { path })).toBeNull();
  await second.close();
});

test("a persistent profile reopens the same OPFS data", async ({ browserName }, testInfo) => {
  const browserType = browserName === "chromium" ? chromium : browserName === "firefox" ? firefox : webkit;
  const profile = testInfo.outputPath("profile");
  const path = `/persistence/${crypto.randomUUID()}.txt`;

  const first = await browserType.launchPersistentContext(profile);
  const firstPage = await first.newPage();
  await ready(firstPage);
  const written = await firstPage.evaluate(async ({ path }) => await window.opfsTest.roundTrip(path, "persisted"), { path });
  await first.close();
  if (!written.probe?.rootAvailable) {
    expect(written.probe?.rootError).toBeDefined();
    return;
  }

  const second = await browserType.launchPersistentContext(profile);
  const secondPage = await second.newPage();
  await ready(secondPage);
  expect(await secondPage.evaluate(async ({ path }) => await window.opfsTest.read(path), { path })).toBe("persisted");
  await second.close();
});
