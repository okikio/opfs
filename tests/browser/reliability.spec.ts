import { expect, test } from "@playwright/test";
import type { reliability } from "./fixtures/reliability.ts";
import type { BrowserTestGlobalType } from "./fixtures/api.ts";

/** These fixture capabilities exist only after the test module has initialized. */
type FixtureType = typeof globalThis & BrowserTestGlobalType & { opfsReliability: typeof reliability };

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/browser/fixtures/index.html");
  await page.waitForFunction(() => Boolean((globalThis as Partial<FixtureType>).opfsReliability));
});

test("binary ranges, append, update, copy and move preserve real OPFS bytes", async ({ page }) => {
  const result = await page.evaluate(() => (globalThis as FixtureType).opfsReliability.bytes());
  test.skip(!result.supported, "OPFS is unavailable in the actual Window realm.");
  expect(result.value).toEqual([0, 1, 42, 255, 8, 9]);
  expect(result.range).toEqual([1, 42, 255]);
  expect(result.empty).toEqual([]);
  expect(result.streamed).toEqual([255, 8]);
  expect(result.moved).toEqual(result.value);
  expect(result.names).toEqual(["moved.bin", "零 space.bin"]);
});

test("producer failure and pending-read cancellation preserve committed bytes and release locks", async ({ page }) => {
  const result = await page.evaluate(() => (globalThis as FixtureType).opfsReliability.failure());
  test.skip(!result.supported, "OPFS is unavailable in the actual Window realm.");
  expect(result.error).toContain("producer-failure");
  expect(result.preserved).toBe("original");
  expect(result.code).toBe("aborted");
  expect(result.cancelled).toBe(1);
  expect(result.aborted).toBe("original");
  expect(result.recovered).toBe("recovered");
});

test("cooperating pages and reload observe the same origin's committed bytes", async ({ context, page }) => {
  const path = `/cooperate/${crypto.randomUUID()}.txt`;
  const written = await page.evaluate(({ path }) => (globalThis as FixtureType).opfsReliability.write(path, "first"), {
    path,
  });
  test.skip(!written, "OPFS is unavailable in the actual Window realm.");
  const second = await context.newPage();
  try {
    await second.goto("/tests/browser/fixtures/index.html");
    await second.waitForFunction(() => Boolean((globalThis as Partial<FixtureType>).opfsReliability));
    expect(await second.evaluate(({ path }) => (globalThis as FixtureType).opfsTest.read(path), { path })).toBe(
      "first",
    );
    await second.evaluate(({ path }) => (globalThis as FixtureType).opfsReliability.write(path, "second"), { path });
    await page.reload();
    await page.waitForFunction(() => Boolean((globalThis as Partial<FixtureType>).opfsReliability));
    expect(await page.evaluate(({ path }) => (globalThis as FixtureType).opfsTest.read(path), { path })).toBe("second");
  } finally {
    await second.close();
  }
});
