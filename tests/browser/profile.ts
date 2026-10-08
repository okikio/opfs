import { test as base } from "./ready.ts";
import type { BrowserContext, BrowserType } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withReleases } from "../close.ts";

/** Fixture-only setup/teardown budget; ordinary test body and assertion timeouts remain unchanged. */
export const PROFILE_TIMEOUT = 90_000;
/** Native launch must leave time for Playwright's separate browser-close retirement. */
const RETIREMENT_TIMEOUT = 30_000;
/** A launch is a bounded native acquisition, never an abandoned Promise.race loser. */
const LAUNCH_TIMEOUT = 30_000;

/** One acquired context with an idempotent close registered before callers can use it. */
export interface ContextType {
  /** Actual native persistent browser context. */
  readonly context: BrowserContext;
  /** Returns the same settling or rejected native-close promise on every call. */
  close(): Promise<void>;
}

/**
 * Starts one browser only while its owner's deadline has acquisition and retirement time.
 *
 * Playwright's native launch deadline cancels its launch and retires its process.
 * Its default launch budget is longer than a test's lifetime, so every caller
 * supplies an earlier owner deadline. Cleanup still depends on native close and
 * the outer runner watchdog; this is not a promise to interrupt a stuck OS call.
 */
export async function open(
  browser: BrowserType,
  profile: string,
  releases: Array<() => void | Promise<unknown>>,
  deadline: number,
): Promise<ContextType> {
  const remaining = Math.floor(deadline - performance.now() - RETIREMENT_TIMEOUT);
  if (!Number.isFinite(remaining) || remaining < 1) {
    throw new Error("Persistent browser owner has no acquisition budget before retirement.");
  }
  const context = await browser.launchPersistentContext(profile, {
    headless: true,
    baseURL: "http://127.0.0.1:4173",
    timeout: Math.min(LAUNCH_TIMEOUT, remaining),
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= context.close();
  releases.push(close);
  if (performance.now() >= deadline - RETIREMENT_TIMEOUT) {
    throw new Error("Persistent browser acquisition settled without its owner's retirement reserve.");
  }
  return { context, close };
}

/**
 * Owns a disposable persistent profile for native OPFS semantics on every engine.
 * WebKit's ephemeral contexts reject OPFS on the tested macOS host. Each test
 * owns its context/profile and pages. Browser launch and retirement have separate
 * fixture time, so cold startup cannot consume the functional body budget. The
 * native acquisition deadline is shorter than the fixture owner lifetime.
 */
export const test = base.extend<{ profile: string; persistent: BrowserContext }>({
  profile: [async ({ browserName }, use) => {
    await withReleases(async (releases) => {
      const profile = await mkdtemp(join(tmpdir(), `opfs-browser-${browserName}-`));
      releases.push(() => rm(profile, { recursive: true, force: true }));
      await use(profile);
    });
  }, { timeout: PROFILE_TIMEOUT }],
  persistent: [async ({ playwright, browserName, profile }, use) => {
    const deadline = performance.now() + PROFILE_TIMEOUT;
    await withReleases(async (releases) => {
      const owner = await open(playwright[browserName], profile, releases, deadline);
      await use(owner.context);
    });
  }, { timeout: PROFILE_TIMEOUT }],
  context: async ({ persistent }, use) => {
    await use(persistent);
  },
  page: async ({ context }, use) => {
    await withReleases(async (releases) => {
      const page = await context.newPage();
      releases.push(() => page.close());
      await use(page);
    });
  },
});
