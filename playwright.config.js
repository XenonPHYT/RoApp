import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:8787",
    browserName: "chromium",
    headless: true,
  },
  webServer: {
    command: "npm run dev -- --port 8787",
    url: "http://localhost:8787/health",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
