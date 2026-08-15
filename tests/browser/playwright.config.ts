import { defineConfig, devices } from "@playwright/test";
import { env } from "node:process";

/** Primary same-origin fixture server. */
const first = "http://127.0.0.1:4173";
/** Secondary origin used only for cross-origin iframe scenarios. */
const second = "http://127.0.0.1:4174";
/** Whether Playwright should enable CI-only retries and strict focused-test checks. */
const ci = Boolean(env.CI);

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 2 : 0,
  reporter: ci ? "github" : "line",
  use: {
    baseURL: first,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "deno run -A npm:vite@8.2.1 --host 127.0.0.1 --port 4173 --strictPort",
      url: first,
      reuseExistingServer: !ci,
    },
    {
      command: "deno run -A npm:vite@8.2.1 --host 127.0.0.1 --port 4174 --strictPort",
      url: second,
      reuseExistingServer: !ci,
    },
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
