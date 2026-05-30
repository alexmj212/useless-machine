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

  // `threshold` absorbs sub-pixel anti-aliasing jitter per pixel; the tight
  // `maxDiffPixelRatio` keeps the suite sensitive enough to catch a real layout
  // change (a loose ratio once let a moved switch pass against a stale
  // baseline). On an intentional visual change, delete the affected snapshots
  // and regenerate — `--update-snapshots` will not overwrite a baseline that
  // still matches within these tolerances.
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.005,
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
