import { open, test } from "./profile.ts";
import { expect } from "@playwright/test";
import { withReleases } from "../close.ts";
import { navigate, remaining } from "./ready.ts";

import type { BrowserTestGlobalType } from "./fixtures/api.ts";

/** File-local global shape after the fixture page installs its Playwright API. */
type InstalledFixtureGlobalType = typeof globalThis & BrowserTestGlobalType;

test("native OPFS writes count intrinsic offset bytes and ignore caller metadata", async ({ ready: page }) => {
  const result = await page.evaluate(async () => {
    const probeUrl = new URL("/src/probe.ts", location.href).href;
    const { probeOpfs } = await import(probeUrl) as typeof import("../../src/probe.ts");
    const capabilities = await probeOpfs();
    if (!capabilities.rootAvailable) return { available: false as const, capabilities };
    const moduleUrl = new URL("/src/driver/opfs.ts", location.href).href;
    const { createOpfsDriver } = await import(moduleUrl) as typeof import("../../src/driver/opfs.ts");
    const origin = await navigator.storage.getDirectory();
    const name = `intrinsic-${crypto.randomUUID()}`;
    const root = await origin.getDirectoryHandle(name, { create: true });
    const driver = createOpfsDriver(root);
    const outcomes: Array<{ readonly kind: string; readonly bytes: number[] }> = [];
    try {
      const stores: Array<readonly [string, ArrayBufferLike]> = [["fixed", new ArrayBuffer(4)]];
      if (typeof SharedArrayBuffer !== "undefined") stores.push(["shared", new SharedArrayBuffer(4)]);
      if (Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get) {
        stores.push(["resizable", new ArrayBuffer(4, { maxByteLength: 8 })]);
      }
      for (const [kind, store] of stores) {
        new Uint8Array(store).set([99, 4, 5, 99]);
        for (const route of ["bytes", "stream", "positional"] as const) {
          await driver.writeFile("/file", new Uint8Array([1, 1, 1, 1]), { mode: "replace" });
          const view = new Uint8Array(store, 1, 2);
          const refuse = () => {
            throw new Error("Caller-owned byte method was invoked.");
          };
          Object.defineProperties(view, {
            buffer: { value: new ArrayBuffer(0) },
            byteOffset: { value: 0 },
            byteLength: { value: 0 },
            subarray: { value: refuse },
            slice: { value: refuse },
            [Symbol.iterator]: { value: refuse },
          });
          if (route === "bytes") await driver.writeFile("/file", view, { mode: "update", at: 1, truncate: true });
          else if (route === "stream") {
            const source = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(view);
                controller.close();
              },
            });
            await driver.writeStream!("/file", source, { mode: "update", at: 1, truncate: true });
            if (source.locked) throw new Error("Native byte input retained its borrowed lock.");
          } else {
            const writer = await driver.openWritableFile!("/file", { maxPendingBytes: 2 });
            try {
              await writer.write(view, { at: 1 });
              await writer.truncate(3);
              await writer.close();
            } catch (error) {
              await writer.abort(error);
              throw error;
            }
          }
          outcomes.push({ kind: `${kind}/${route}`, bytes: [...await driver.readFile("/file")] });
        }
      }
      const detached = new Uint8Array([4, 5]);
      structuredClone(detached.buffer, { transfer: [detached.buffer] });
      for (const invalid of [new Proxy(new Uint8Array([4, 5]), {}), detached, new Uint16Array([4, 5])]) {
        let rejected = false;
        try {
          await driver.writeFile("/file", invalid as Uint8Array, { mode: "replace" });
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          rejected = true;
        }
        if (!rejected) throw new Error("Invalid native byte input was accepted.");
        outcomes.push({ kind: "invalid/preserved", bytes: [...await driver.readFile("/file")] });
      }
      return { available: true as const, capabilities, outcomes };
    } finally {
      await origin.removeEntry(name, { recursive: true });
    }
  });
  if (!result.available) {
    expect(result.capabilities.rootAvailable).toBe(false);
    expect(result.capabilities.rootError).toBeDefined();
    expect(result.capabilities.rootError?.name.length).toBeGreaterThan(0);
    return;
  }
  expect(result.capabilities.rootAvailable).toBe(true);
  expect(result.outcomes.some(({ kind }) => kind === "fixed/bytes")).toBe(true);
  expect(result.outcomes.some(({ kind }) => kind === "fixed/stream")).toBe(true);
  expect(result.outcomes.some(({ kind }) => kind === "fixed/positional")).toBe(true);
  for (const { bytes } of result.outcomes) expect(bytes).toEqual([1, 4, 5]);
});

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
