import { defineConfig, devices } from "@playwright/test";

// Force software WebGL (SwiftShader) so rendered pixels are reproducible across
// machines that have different (or no) GPUs — essential for visual snapshots.
const SWIFTSHADER_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--in-process-gpu",
];

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",

  use: {
    baseURL: "http://localhost:5173",
    viewport: { width: 900, height: 640 },
    deviceScaleFactor: 1,
  },

  // Allow small, sub-perceptual differences (font/AA jitter) but catch real
  // visual regressions.
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      threshold: 0.2,
    },
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: SWIFTSHADER_ARGS },
      },
    },
  ],

  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
