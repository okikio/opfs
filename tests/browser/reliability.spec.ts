import { test } from "./profile.ts";
import { expect } from "@playwright/test";
import { navigate, reload, remaining } from "./ready.ts";
import { withReleases } from "../close.ts";
import type { reliability } from "./fixtures/reliability.ts";
import type { BrowserTestGlobalType } from "./fixtures/api.ts";

/** These fixture capabilities exist only after the test module has initialized. */
type FixtureType = typeof globalThis & BrowserTestGlobalType & { opfsReliability: typeof reliability };

test("binary ranges, append, update, copy and move preserve real OPFS bytes", async ({ ready: page }) => {
  const result = await page.evaluate(() => (globalThis as FixtureType).opfsReliability.bytes());
  test.skip(!result.supported, "OPFS is unavailable in the actual Window realm.");
  expect(result.value).toEqual([0, 1, 42, 255, 8, 9]);
  expect(result.range).toEqual([1, 42, 255]);
  expect(result.empty).toEqual([]);
  expect(result.streamed).toEqual([255, 8]);
  expect(result.moved).toEqual(result.value);
  expect(result.names).toEqual(["moved.bin", "零 space.bin"]);
});

test("producer failure and pending-read cancellation preserve committed bytes and release locks", async ({ ready: page }) => {
  const result = await page.evaluate(() => (globalThis as FixtureType).opfsReliability.failure());
  test.skip(!result.supported, "OPFS is unavailable in the actual Window realm.");
  expect(result.sourcePreserved).toBe(true);
  expect(result.preserved).toBe("original");
  expect(result.code).toBe("aborted");
  expect(result.cancelled).toBe(1);
  expect(result.aborted).toBe("original");
  expect(result.recovered).toBe("recovered");
});

test(
  "cooperating pages and reload observe the same origin's committed bytes",
  async ({ context, ready: page }, testInfo) => {
    // This scenario owns two documents and a reload, while byte assertions remain unchanged.
    testInfo.setTimeout(180_000);
    const deadline = performance.now() + 150_000;
    const path = `/cooperate/${crypto.randomUUID()}.txt`;
    const written = await page.evaluate(
      ({ path }) => (globalThis as FixtureType).opfsReliability.write(path, "first"),
      {
        path,
      },
    );
    test.skip(!written, "OPFS is unavailable in the actual Window realm.");
    await withReleases(async (releases) => {
      remaining(deadline, "navigation");
      const second = await context.newPage();
      releases.push(() => second.close());
      await navigate(second, "app", deadline);
      expect(await second.evaluate(({ path }) => (globalThis as FixtureType).opfsTest.read(path), { path })).toBe(
        "first",
      );
      await second.evaluate(({ path }) => (globalThis as FixtureType).opfsReliability.write(path, "second"), { path });
      await reload(page, "app", deadline);
      expect(await page.evaluate(({ path }) => (globalThis as FixtureType).opfsTest.read(path), { path })).toBe(
        "second",
      );
    });
  },
);
