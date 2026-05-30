import { test, expect, type Page } from "@playwright/test";

// The deterministic hook exposed by src/main.ts in `?test` mode.
interface UselessHook {
  ready: boolean;
  sequenceSeconds: number;
  frameAt: (seconds: number) => void;
  idle: () => void;
}

declare global {
  interface Window {
    __useless: UselessHook;
  }
}

async function gotoScene(page: Page): Promise<number> {
  await page.goto("/?test=1");
  await page.waitForFunction(() => window.__useless?.ready === true);
  return page.evaluate(() => window.__useless.sequenceSeconds);
}

const canvas = (page: Page) => page.locator("#app canvas");

test.describe("useless machine — visual states", () => {
  test("idle: lid closed, switch off", async ({ page }) => {
    await gotoScene(page);
    await page.evaluate(() => window.__useless.idle());
    await expect(canvas(page)).toHaveScreenshot("idle.png");
  });

  // Key moments across the sequence, as fractions of its total length.
  const moments: Array<{ name: string; at: number }> = [
    { name: "lid-opening", at: 0.15 },
    { name: "arm-reaching", at: 0.45 },
    { name: "knock-contact", at: 0.62 },
    { name: "arm-retracting", at: 0.8 },
    { name: "lid-closing", at: 0.95 },
  ];

  for (const m of moments) {
    test(m.name, async ({ page }) => {
      const total = await gotoScene(page);
      await page.evaluate((s) => window.__useless.frameAt(s), m.at * total);
      await expect(canvas(page)).toHaveScreenshot(`${m.name}.png`);
    });
  }
});
