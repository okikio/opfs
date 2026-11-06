import { expect } from "@playwright/test";
import type { BrowserContext, Frame } from "@playwright/test";
import { admit, open, READY_TIMEOUT, remaining, test as base } from "./ready.ts";
import { withReleases } from "../close.ts";

import type { OpfsDirectoryHandleType } from "../../src/driver/opfs.ts";
import type { BrowserTestGlobalType } from "./fixtures/api.ts";

/** File-local Window shape after the iframe fixture installs its Playwright API. */
type InstalledFixtureWindowType = typeof window & BrowserTestGlobalType;
/** Child realms keep their actual parent-origin placement and storage policy. */
const CROSS_URL = "http://127.0.0.1:4174/tests/browser/fixtures/frame.html";

/** One iframe acquisition owns its containing page; the context stays borrowed. */
async function frame(
  context: BrowserContext,
  mode: "same" | "cross" | "opaque",
  use: (frame: Frame) => Promise<void>,
): Promise<void> {
  await withReleases(async (releases) => {
    const deadline = performance.now() + READY_TIMEOUT;
    const pending: { attached?: Promise<Frame> } = {};
    // Register before the page owner so LIFO closes the page before draining a pending event.
    releases.push(async () => {
      if (pending.attached !== undefined) await pending.attached;
    });
    const page = await open(context, "app", releases, deadline);
    const childUrl = mode === "cross"
      ? CROSS_URL
      : mode === "same"
      ? "http://127.0.0.1:4173/tests/browser/fixtures/frame.html"
      : "about:srcdoc";
    const attached = pending.attached = page.waitForEvent("frameattached", {
      predicate: (value) => value !== page.mainFrame(),
      timeout: remaining(deadline, "navigation"),
    });
    void attached.catch(() => {});
    remaining(deadline, "navigation");
    await page.evaluate((mode) => {
      const element = document.createElement("iframe");
      if (mode === "opaque") {
        element.sandbox.add("allow-scripts");
        element.srcdoc = "<!doctype html><script>window.ready=true</script>";
      }
      document.body.append(element);
    }, mode);
    const child = await attached;
    await admit(
      child,
      mode === "opaque" ? "opaque" : "app",
      deadline,
      mode === "opaque" ? undefined : { url: childUrl },
    );
    await use(child);
  });
}

/** Only the requested realm is acquired, with setup time separate from the assertion body. */
const test = base.extend<{ same: Frame; cross: Frame; opaque: Frame }>({
  same: [async ({ context }, use) => await frame(context, "same", use), { timeout: READY_TIMEOUT }],
  cross: [async ({ context }, use) => await frame(context, "cross", use), { timeout: READY_TIMEOUT }],
  opaque: [async ({ context }, use) => await frame(context, "opaque", use), { timeout: READY_TIMEOUT }],
});

test("same-origin iframe observes its real OPFS placement", async ({ same: frame }) => {
  const result = await frame.evaluate(async () =>
    await (window as InstalledFixtureWindowType).opfsTest.roundTrip(`/frames/${crypto.randomUUID()}.txt`, "same")
  );
  expect(result.probe?.embedded).toBe(true);
  expect(result.probe?.sameOriginTop).toBe(true);
  if (result.probe?.rootAvailable) expect(result.value).toBe("same");
  else expect(result.probe?.rootError).toBeDefined();
});

test("cross-origin iframe reports partition/policy behavior instead of guessing by browser", async ({ cross: frame }) => {
  const probe = await frame.evaluate(async () => await (window as InstalledFixtureWindowType).opfsTest.probe());
  expect(probe.embedded).toBe(true);
  expect(probe.sameOriginTop).toBe(false);
  if (!probe.rootAvailable) expect(probe.rootError).toBeDefined();
});

test("opaque sandbox cannot obtain an OPFS storage root", async ({ opaque: frame }) => {
  const result = await frame.evaluate(async () => {
    const storage = navigator.storage as StorageManager & { getDirectory?: () => Promise<OpfsDirectoryHandleType> };
    if (typeof storage?.getDirectory !== "function") return { supported: false, available: false, name: null };
    try {
      await storage.getDirectory();
      return { supported: true, available: true, name: null };
    } catch (error) {
      return { supported: true, available: false, name: error instanceof DOMException ? error.name : "Error" };
    }
  });
  test.skip(!result.supported, "This opaque realm does not expose StorageManager.getDirectory.");
  // File System getDirectory rejects failed storage-key acquisition; opaque
  // origins cannot obtain storage keys (WHATWG Storage §4.2 / File System §3.6).
  expect(result.available).toBe(false);
  expect(result.name).toBe("SecurityError");
});
