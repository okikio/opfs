import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { AdmissionError, admit, navigate, open, READY_TIMEOUT } from "./ready.ts";
import { withReleases } from "../close.ts";
import type { BrowserTestGlobalType } from "./fixtures/api.ts";

// These controls exercise native acquisition, not storage-operation latency.
test.setTimeout(120_000);

/** Caller ownership is observed through actual close events and the context's page inventory. */
function own(page: Page, releases: Array<() => void | Promise<unknown>>, closed: () => void): void {
  page.on("close", closed);
  releases.push(() => page.close());
}

test("document admission waits for the actual held module, then exposes its complete API", async ({ context }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => release = resolve);
  let closes = 0;
  await withReleases(async (releases) => {
    const page = await context.newPage();
    own(page, releases, () => closes++);
    let handling: Promise<void> | undefined;
    const pending: { request?: Promise<unknown>; admission?: Promise<void> } = {};
    // Register both siblings before assertions. LIFO releases the held route first.
    releases.push(async () => {
      if (pending.admission !== undefined) await pending.admission;
    });
    releases.push(async () => {
      if (pending.request !== undefined) await pending.request;
    });
    releases.push(async () => {
      release();
      if (handling !== undefined) await handling;
    });
    await page.route("**/tests/browser/fixtures/app.ts", (route) => {
      handling = (async () => {
        await held;
        await route.continue();
      })();
      void handling.catch(() => {});
      return handling;
    });
    const request = pending.request = page.waitForRequest(
      (value) => new URL(value.url()).pathname === "/tests/browser/fixtures/app.ts",
      {
        timeout: 60_000,
      },
    );
    void request.catch(() => {});
    let settled = false;
    const admission = pending.admission = navigate(page, "app", performance.now() + READY_TIMEOUT);
    void admission.catch(() => {});
    void admission.then(() => settled = true, () => settled = true);
    await request;
    expect(settled).toBe(false);
    expect(await page.evaluate(() => Reflect.get(globalThis, "opfsTest"))).toBeUndefined();
    release();
    await admission;
    expect(
      await page.evaluate(() => {
        const fixture = globalThis as typeof globalThis & BrowserTestGlobalType;
        return { ready: fixture.opfsTest.ready, callable: typeof fixture.opfsTest.probe };
      }),
    ).toEqual({ ready: true, callable: "function" });
  });
  expect(closes).toBe(1);
  expect(context.pages()).toEqual([]);
});

test("a present malformed API refuses admission and its caller closes the acquired page", async ({ context }) => {
  let closes = 0;
  let failed: unknown;
  try {
    await withReleases(async (releases) => {
      const page = await context.newPage();
      own(page, releases, () => closes++);
      await page.setContent("<script>window.opfsTest={ready:true}</script>");
      await admit(page.mainFrame(), "app", performance.now() + READY_TIMEOUT);
    });
  } catch (error) {
    failed = error;
  }
  expect(failed).toBeInstanceOf(AdmissionError);
  expect((failed as AdmissionError).category).toBe("shape");
  expect((failed as AdmissionError).stage).toBe("api");
  expect(closes).toBe(1);
  expect(context.pages()).toEqual([]);
});

test("actual fixture script failure remains a load fault and retires its page", async ({ context }) => {
  let closes = 0;
  let failed: unknown;
  try {
    await withReleases(async (releases) => {
      const page = await context.newPage();
      own(page, releases, () => closes++);
      await page.route("**/tests/browser/fixtures/app.ts", (route) => route.abort("failed"));
      await navigate(page, "app", performance.now() + READY_TIMEOUT);
    });
  } catch (error) {
    failed = error;
  }
  expect(failed).toBeInstanceOf(AdmissionError);
  expect((failed as AdmissionError).category).toBe("native");
  expect((failed as AdmissionError).observations.some((value) => value.kind === "request")).toBe(true);
  expect(closes).toBe(1);
  expect(context.pages()).toEqual([]);
});

for (const [kind, file] of [["script", "app.ts"], ["document", "index.html"]] as const) {
  test(`an HTTP failure from the required fixture ${kind} is retained before page retirement`, async ({ context }) => {
    let closes = 0;
    let selectedDocumentLoaded = false;
    const path = `/tests/browser/fixtures/${file}`;
    const documentUrl = new URL(path, "http://127.0.0.1:4173").href;
    const fulfilled: number[] = [];
    let failed: unknown;
    try {
      await withReleases(async (releases) => {
        const pending: { fulfillment?: Promise<void> } = {};
        // Close the containing page before draining a still-pending native route on failure.
        releases.push(async () => {
          if (pending.fulfillment !== undefined) await pending.fulfillment;
        });
        const page = await context.newPage();
        own(page, releases, () => closes++);
        page.on("domcontentloaded", () => {
          if (page.url() === documentUrl) selectedDocumentLoaded = true;
        });
        await page.route(`**/tests/browser/fixtures/${file}`, (route) => {
          const fulfillment = pending.fulfillment = (async () => {
            await route.fulfill({
              status: 404,
              contentType: kind === "script" ? "text/javascript" : "text/html",
              body: kind === "script"
                ? "// authored missing fixture module"
                : "<!doctype html><title>Missing fixture</title>",
            });
            fulfilled.push(404);
          })();
          void fulfillment.catch(() => {});
          return fulfillment;
        });
        await navigate(page, "app", performance.now() + READY_TIMEOUT);
      });
    } catch (error) {
      failed = error;
    }
    expect(fulfilled).toEqual([404]);
    expect(failed).toBeInstanceOf(AdmissionError);
    expect((failed as AdmissionError).category).toBe("native");
    const faults = (failed as AdmissionError).observations;
    // A browser can reject the request before exposing Response; the fulfilled status is independent above.
    expect(faults.some((value) =>
      value.url === path &&
      (value.kind === "response" && value.status === 404 || value.kind === "request")
    )).toBe(true);
    if (kind === "document") {
      expect(selectedDocumentLoaded).toBe(true);
      expect(faults).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "response", url: path, status: 404 }),
      ]));
    }
    expect(closes).toBe(1);
    expect(context.pages()).toEqual([]);
  });
}

test("an unready document hits the native admission deadline and remains unadmitted", async ({ context, playwright }) => {
  let closes = 0;
  let failed: unknown;
  try {
    await withReleases(async (releases) => {
      const page = await context.newPage();
      own(page, releases, () => closes++);
      await page.setContent("<title>Actual document without an installed API</title>");
      await admit(page.mainFrame(), "app", performance.now() + 30_000 + 1_000);
    });
  } catch (error) {
    failed = error;
  }
  expect(failed).toBeInstanceOf(AdmissionError);
  expect((failed as AdmissionError).category).toBe("native");
  expect((failed as AdmissionError).cause).toBeInstanceOf(playwright.errors.TimeoutError);
  expect(closes).toBe(1);
  expect(context.pages()).toEqual([]);
});

test("an expired owner refuses before acquiring any page in its borrowed context", async ({ context }) => {
  let acquired = 0;
  const onPage = () => acquired++;
  context.on("page", onPage);
  try {
    await expect(withReleases(async (releases) => {
      await open(context, "app", releases, performance.now());
    })).rejects.toMatchObject({ stage: "navigation", category: "owner" });
  } finally {
    context.off("page", onPage);
  }
  expect(acquired).toBe(0);
  expect(context.pages()).toEqual([]);
});

test("an admitted page closes once without replacing its original body failure", async ({ context }) => {
  const primary = new Error("authored body failure");
  let closes = 0;
  let failed: unknown;
  try {
    await withReleases(async (releases) => {
      const page = await open(context, "app", releases, performance.now() + READY_TIMEOUT);
      page.on("close", () => closes++);
      throw primary;
    });
  } catch (error) {
    failed = error;
  }
  expect(failed).toBe(primary);
  expect(closes).toBe(1);
  expect(context.pages()).toEqual([]);
});
