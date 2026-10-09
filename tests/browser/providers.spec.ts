import { expect } from "@playwright/test";
import { test } from "./ready.ts";
import type { BrowserTestGlobalType, ProviderBodyOptionsType } from "./fixtures/api.ts";

/** The fixture constructs iframe objects; Playwright only receives detached observations. */
type InstalledFixtureGlobalType = typeof globalThis & BrowserTestGlobalType;

for (const provider of ["s3", "azure"] as const) {
  for (const empty of [true, false]) {
    for (const length of provider === "azure" ? [true, false] : [true]) {
      test(`${provider} direct iframe stream ${empty ? "empty" : "payload"}, length ${length}`, async ({ ready: page }) => {
        const options: ProviderBodyOptionsType = {
          provider,
          route: "request",
          body: "stream",
          empty,
          mode: true,
          length,
        };
        const result = await page.evaluate(
          async (options) => await (globalThis as InstalledFixtureGlobalType).opfsTest.providerBody(options),
          options,
        );
        expect(result.foreign).toBe(true);
        expect(result.intrinsicUnlocked).toBe(true);
        expect(result.cancellations).toBe(0);
        if (provider === "azure" && !length) {
          // Predispatch refusal keeps the stream unowned by Fetch.
          expect(result.locked).toBe(false);
          expect(result.error).toBe("TypeError");
          expect(result.requests).toEqual([]);
          expect(result.status).toBeUndefined();
        } else {
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(503);
          // Raw request hands the body to Fetch; native Request consumption
          // proves EOF and bytes, without promising Fetch releases its lock.
          // A consumed one-shot native stream cannot be replayed after 503.
          expect(result.requests).toEqual([{
            stage: "direct",
            bytes: empty ? [] : [17, 31],
            duplex: true,
            length: empty ? "0" : "2",
          }]);
        }
      });
    }
  }

  for (const body of ["bytes", "stream"] as const) {
    for (const empty of [true, false]) {
      for (const mode of [true, false]) {
        test(`${provider} public put iframe ${body} ${empty ? "empty" : "payload"}, mode ${mode}`, async ({ ready: page }) => {
          const options: ProviderBodyOptionsType = { provider, route: "put", body, empty, mode, length: true };
          const result = await page.evaluate(
            async (options) => await (globalThis as InstalledFixtureGlobalType).opfsTest.providerBody(options),
            options,
          );
          expect(result.foreign).toBe(true);
          expect(result.intrinsicUnlocked).toBe(true);
          expect(result.locked).toBe(false);
          const refusal = provider === "azure" && body === "stream" && !mode;
          if (refusal) {
            expect(result.error).toBe("TypeError");
            expect(result.size).toBeUndefined();
            expect(result.requests).toEqual([]);
            expect(result.cancellations).toBe(1);
          } else {
            expect(result.error).toBeUndefined();
            expect(result.size).toBe(empty ? 0 : 2);
            expect(result.cancellations).toBe(0);
            const stages = body === "bytes"
              ? ["put"]
              : provider === "s3" && !mode
              ? empty ? ["allocate", "abort", "put"] : ["allocate", "part", "commit"]
              : provider === "azure" && !empty
              ? ["part", "commit"]
              : ["put"];
            expect(result.requests.map(({ stage }) => stage)).toEqual(stages);
            const payloads = result.requests.filter(({ stage }) => stage === "put" || stage === "part");
            expect(payloads.map(({ bytes }) => bytes)).toEqual([empty ? [] : [17, 31]]);
          }
        });
      }
    }
  }
}
