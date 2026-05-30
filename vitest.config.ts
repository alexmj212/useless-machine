import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests live next to the source. The Playwright visual specs under
    // tests/ run on their own runner, not Vitest.
    include: ["src/**/*.test.ts"],
  },
});
