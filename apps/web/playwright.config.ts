import { defineConfig, devices } from "@playwright/test";

const previewPort = Number(process.env.FLOWPILOT_TEST_PORT ?? 4173);
const apiPort = Number(process.env.FLOWPILOT_TEST_API_PORT ?? 3100);
const localOrigin = `http://127.0.0.1:${previewPort}`;
const localApiOrigin = `http://127.0.0.1:${apiPort}`;
const configuredBaseUrl = process.env.FLOWPILOT_TEST_BASE_URL?.replace(/\/$/, "");
const configuredOrigin = configuredBaseUrl?.replace(/\/flowpilot$/i, "");
const appBaseUrl = `${configuredOrigin ?? localOrigin}/flowpilot/`;
const useManagedServers = !configuredBaseUrl;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "./test-results/playwright",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 4,
  timeout: 60_000,
  expect: {
    timeout: 8_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.002,
    },
  },
  reporter: [
    ["list"],
    ["html", { outputFolder: "./test-results/playwright-report", open: "never" }],
  ],
  use: {
    baseURL: appBaseUrl,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    colorScheme: "light",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "edge",
      grep: /@smoke/,
      use: {
        ...devices["Desktop Edge"],
        channel: "msedge",
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: useManagedServers
    ? [
        {
          command: `dotnet bin/Debug/net10.0/FlowPilot.Api.dll --environment Development --Kestrel:Endpoints:Http:Url ${localApiOrigin}`,
          cwd: "../api/src/FlowPilot.Api",
          url: `${localApiOrigin}/api/flowpilot/v1/health/ready`,
          reuseExistingServer: false,
          timeout: 180_000,
          env: {
            ASPNETCORE_ENVIRONMENT: "Development",
          },
        },
        {
          command: `pnpm dev --host 127.0.0.1 --port ${previewPort} --strictPort --mode debug`,
          url: `${localOrigin}/flowpilot/login`,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: {
            VITE_API_PROXY_TARGET: localApiOrigin,
          },
        },
      ]
    : undefined,
});
