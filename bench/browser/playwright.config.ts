import { defineConfig, devices } from "@playwright/test";

/** Same-origin benchmark server used by every browser project. */
const baseURL = "http://127.0.0.1:4173";
/** Concrete fixture that returns HTTP 200 when the Vite server is ready. */
const readyURL = `${baseURL}/tests/browser/fixtures/index.html`;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  reporter: "line",
  use: { baseURL },
  webServer: {
    command: "deno run -A npm:vite@8.2.1 ../.. --host 127.0.0.1 --port 4173 --strictPort",
    url: readyURL,
    reuseExistingServer: true,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
