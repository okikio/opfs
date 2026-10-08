import { test as base } from "@playwright/test";
import type { BrowserContext } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withReleases } from "../close.ts";

/**
 * Owns a disposable persistent profile for native OPFS semantics on every engine.
 * WebKit's ephemeral contexts reject OPFS on the tested macOS host. Each test
 * owns its context/profile and pages: a long copied-conformance file must not
 * accumulate browser process state across otherwise independent cases. This does
 * not suppress an actual missing API or worker capability.
 */
export const test = base.extend<{ persistent: BrowserContext }>({
  persistent: async ({ playwright, browserName }, use) => {
    await withReleases(async (releases) => {
      const profile = await mkdtemp(join(tmpdir(), "opfs-browser-"));
      releases.push(() => rm(profile, { recursive: true, force: true }));
      const context = await playwright[browserName].launchPersistentContext(profile, {
        headless: true,
        baseURL: "http://127.0.0.1:4173",
      });
      releases.push(() => context.close());
      await use(context);
    });
  },
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
