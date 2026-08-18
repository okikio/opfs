import { expect, test } from "@playwright/test";

/** Same-origin fixture used as the top-level embedding document. */
const APP_URL = "http://127.0.0.1:4173/tests/browser/fixtures/index.html";
/** Second-origin fixture used to exercise storage partition and policy behavior. */
const CROSS_URL = "http://127.0.0.1:4174/tests/browser/fixtures/frame.html";

/** Waits until an iframe has installed the shared browser test API. */
async function waitForApi(frame: import("@playwright/test").Frame): Promise<void> {
  await frame.waitForFunction(() => Boolean((globalThis as unknown as { opfsTest?: { ready?: boolean } }).opfsTest?.ready));
}

test("same-origin iframe observes its real OPFS placement", async ({ page }) => {
  await page.goto(APP_URL);
  const framePromise = page.waitForEvent("framenavigated", {
    predicate: (frame) => frame !== page.mainFrame() && frame.url().includes("/tests/browser/fixtures/frame.html"),
  });
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.src = "/tests/browser/fixtures/frame.html";
    document.body.append(frame);
  });
  const frame = await framePromise;
  await waitForApi(frame);
  const result = await frame.evaluate(async () =>
    await globalThis.opfsTest.roundTrip(`/frames/${crypto.randomUUID()}.txt`, "same")
  );
  expect(result.probe?.embedded).toBe(true);
  expect(result.probe?.sameOriginTop).toBe(true);
  if (result.probe?.rootAvailable) expect(result.value).toBe("same");
  else expect(result.probe?.rootError).toBeDefined();
});

test("cross-origin iframe reports partition/policy behavior instead of guessing by browser", async ({ page }) => {
  await page.goto(APP_URL);
  const framePromise = page.waitForEvent("framenavigated", {
    predicate: (frame) => frame.url().startsWith("http://127.0.0.1:4174/"),
  });
  await page.evaluate((url) => {
    const frame = document.createElement("iframe");
    frame.src = url;
    document.body.append(frame);
  }, CROSS_URL);
  const frame = await framePromise;
  await waitForApi(frame);
  const probe = await frame.evaluate(async () => await globalThis.opfsTest.probe());
  expect(probe.embedded).toBe(true);
  expect(probe.sameOriginTop).toBe(false);
  if (!probe.rootAvailable) expect(probe.rootError).toBeDefined();
});

test("opaque sandbox reports the platform result without browser-name assumptions", async ({ page }) => {
  await page.goto(APP_URL);
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.sandbox.add("allow-scripts");
    frame.srcdoc = "<!doctype html><script>globalThis.ready=true</script>";
    document.body.append(frame);
  });
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
  await frame.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
  const result = await frame.evaluate(async () => {
    const storage = navigator.storage as StorageManager & { getDirectory?: () => Promise<FileSystemDirectoryHandle> };
    if (typeof storage?.getDirectory !== "function") return { available: false, name: "NotSupportedError" };
    try {
      await storage.getDirectory();
      return { available: true, name: null };
    } catch (error) {
      return { available: false, name: error instanceof DOMException ? error.name : "Error" };
    }
  });
  expect(typeof result.available).toBe("boolean");
  if (!result.available) expect(typeof result.name).toBe("string");
});
