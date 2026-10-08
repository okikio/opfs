import { open, test } from "./profile.ts";
import { expect } from "@playwright/test";
import { withReleases } from "../close.ts";
import { navigate, remaining } from "./ready.ts";

import type { BrowserTestGlobalType } from "./fixtures/api.ts";

/** File-local global shape after the fixture page installs its Playwright API. */
type InstalledFixtureGlobalType = typeof globalThis & BrowserTestGlobalType;

test("window probes the actual capability and round-trips when OPFS is available", async ({ ready: page }) => {
  const result = await page.evaluate(async () =>
    await (globalThis as InstalledFixtureGlobalType).opfsTest.roundTrip(`/window/${crypto.randomUUID()}.txt`, "window")
  );
  expect(result.supported).toBe(true);
  expect(result.probe?.context).toBe("window");
  if (result.probe?.rootAvailable) expect(result.value).toBe("window");
  else expect(result.probe?.rootError).toBeDefined();
});

test("an aborted write cannot commit", async ({ ready: page }) => {
  const result = await page.evaluate(async () =>
    await (globalThis as InstalledFixtureGlobalType).opfsTest.abort(`/abort/${crypto.randomUUID()}.txt`)
  );
  test.skip(!result.supported, "OPFS is unavailable in this browser context.");
  expect(result).toEqual({
    supported: true,
    name: "FileSystemError",
    code: "aborted",
    preserved: "original",
    published: false,
  });
});

test("queued Web Locks cancellation is normalized to the package error", async ({ ready: page }) => {
  const result = await page.evaluate(async () =>
    await (globalThis as InstalledFixtureGlobalType).opfsTest.queuedAbort()
  );
  test.skip(!result.supported, "This browser does not expose the Web Locks API.");
  expect(result).toEqual({ supported: true, name: "FileSystemError", code: "aborted" });
});

test("fresh browser contexts do not inherit another context's OPFS file", async ({ browser }, testInfo) => {
  testInfo.setTimeout(REOPEN_TIMEOUT);
  const deadline = performance.now() + REOPEN_TIMEOUT - REOPEN_RETIREMENT;
  const path = `/isolation/${crypto.randomUUID()}.txt`;
  await withReleases(async (releases) => {
    remaining(deadline, "navigation");
    const first = await browser.newContext();
    let firstClosing: Promise<void> | undefined;
    const closeFirst = () => firstClosing ??= first.close();
    releases.push(closeFirst);
    remaining(deadline, "navigation");
    const firstPage = await first.newPage();
    await navigate(firstPage, "app", deadline);
    const written = await firstPage.evaluate(
      async ({ path }) => await (globalThis as InstalledFixtureGlobalType).opfsTest.roundTrip(path, "private"),
      { path },
    );
    await closeFirst();
    if (!written.probe?.rootAvailable) {
      expect(written.probe?.rootError).toBeDefined();
      return;
    }

    remaining(deadline, "navigation");
    const second = await browser.newContext();
    releases.push(() => second.close());
    remaining(deadline, "navigation");
    const secondPage = await second.newPage();
    await navigate(secondPage, "app", deadline);
    expect(
      await secondPage.evaluate(
        async ({ path }) => await (globalThis as InstalledFixtureGlobalType).opfsTest.read(path),
        { path },
      ),
    ).toBeNull();
  });
});

/**
 * Two native launches and two native closes need their own finite scenario lifetime.
 * The scenario reserves its final 30s and open() reserves another native-close
 * interval before dispatch. This leaves at least 60s of acquisition/retirement
 * headroom; the ordinary one-context body remains 30s.
 */
const REOPEN_TIMEOUT = 180_000;
const REOPEN_RETIREMENT = 30_000;

test("a persistent profile reopens the same OPFS data", async ({ playwright, browserName, profile }, testInfo) => {
  testInfo.setTimeout(REOPEN_TIMEOUT);
  const deadline = performance.now() + REOPEN_TIMEOUT - REOPEN_RETIREMENT;
  const browserType = playwright[browserName];
  const path = `/persistence/${crypto.randomUUID()}.txt`;

  await withReleases(async (releases) => {
    const first = await open(browserType, profile, releases, deadline);
    remaining(deadline, "navigation");
    const firstPage = await first.context.newPage();
    await navigate(firstPage, "app", deadline);
    const written = await firstPage.evaluate(
      async ({ path }) => await (globalThis as InstalledFixtureGlobalType).opfsTest.roundTrip(path, "persisted"),
      { path },
    );
    await first.close();
    if (!written.probe?.rootAvailable) {
      expect(written.probe?.rootError).toBeDefined();
      return;
    }

    const second = await open(browserType, profile, releases, deadline);
    remaining(deadline, "navigation");
    const secondPage = await second.context.newPage();
    await navigate(secondPage, "app", deadline);
    expect(
      await secondPage.evaluate(
        async ({ path }) => await (globalThis as InstalledFixtureGlobalType).opfsTest.read(path),
        { path },
      ),
    ).toBe("persisted");
  });
});
