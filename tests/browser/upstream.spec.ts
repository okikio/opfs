import { test } from "./profile.ts";
import { expect } from "@playwright/test";
import type { upstream } from "./fixtures/upstream.ts";
import { directoryCases, syncCases } from "../upstream/wpt.ts";

/** Access remains explicit and local to this fixture page. */
type FixtureGlobalType = typeof globalThis & { upstreamTest: typeof upstream };

test.use({ entry: "upstream" });

for (const route of ["native", "facade"] as const) {
  for (const source of directoryCases) {
    test(`Copied WPT / ${route} / ${source.name}`, async ({ ready: page }) => {
      const result = await page.evaluate(
        async ({ name, route }) => await (globalThis as FixtureGlobalType).upstreamTest.directory(name, route),
        { name: source.name, route },
      );
      test.skip(!result.supported, result.reason ?? "Actual OPFS root probe failed.");
      expect(result).toEqual({ supported: true, name: source.name, route });
    });
  }
  test(`Copied WPT / ${route} / DedicatedWorker sync byte and cursor cases`, async ({ ready: page }) => {
    const result = await page.evaluate(
      async (route) => await (globalThis as FixtureGlobalType).upstreamTest.sync(route),
      route,
    );
    test.skip(!result.supported, result.reason ?? "Actual worker OPFS or sync access probe failed.");
    expect(result.error).toBeUndefined();
    expect(result.names).toEqual(syncCases.map((source) => source.name));
  });
}
