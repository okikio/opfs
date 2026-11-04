import { expect } from "@playwright/test";
import { test } from "./ready.ts";

for (const kind of ["cache", "localstorage"] as const) {
  test(`${kind} refuses a persisted ghost child and retains its physical key`, async ({ ready: page }) => {
    const result = await page.evaluate(async (kind) => {
      const source = new URL("/tests/browser/fixtures/record.ts", location.href).href;
      const fixture = await import(source) as typeof import("./fixtures/record.ts");
      return await fixture.run(kind);
    }, kind);
    expect(result).toEqual({
      before: [97, 98, 99],
      listedBefore: ["/a"],
      getRefused: true,
      listRefused: true,
      facadeRefused: true,
      missing: null,
      persistedUnchanged: true,
      repaired: [97, 98, 99],
      listedAfter: ["/a"],
      foreign: "caller-owned",
    });
  });
}
