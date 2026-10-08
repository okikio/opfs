import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/** Same-origin benchmark server used by every browser project. */
const baseURL = "http://127.0.0.1:4173";
/** Concrete fixture that returns HTTP 200 when the Vite server is ready. */
const readyURL = `${baseURL}/tests/browser/fixtures/index.html`;

export default defineConfig({
  // Cleanup and artifact recreation stay inside the writable task-owned namespace.
  outputDir: fileURLToPath(new URL("../../.tmp/reports/browser-bench/artifacts", import.meta.url)),
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  failOnFlakyTests: true,
  globalSetup: fileURLToPath(new URL("./input.ts", import.meta.url)),
  reporter: [["line"], ["json", {
    outputFile: fileURLToPath(new URL("../../.tmp/reports/browser-bench/results.json", import.meta.url)),
  }]],
  use: { baseURL },
  webServer: {
    command:
      "deno run -A npm:vite@8.2.1 --config tests/browser/vite.config.ts --host 127.0.0.1 --port 4173 --strictPort",
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    url: readyURL,
    reuseExistingServer: false,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
