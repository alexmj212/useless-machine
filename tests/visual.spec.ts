import { test, expect, type Page } from "@playwright/test";

interface Phase {
  name: string;
  start: number;
  end: number;
  mid: number;
}

// The deterministic hook exposed by src/main.ts in `?test` mode.
interface UselessHook {
  ready: boolean;
  sequenceSeconds: number;
  phases: Phase[];
  frameAt: (seconds: number) => void;
  idle: () => void;
}

declare global {
  interface Window {
    __useless: UselessHook;
  }
}

async function gotoScene(page: Page): Promise<Phase[]> {
  await page.goto("/?test=1");
  await page.waitForFunction(() => window.__useless?.ready === true);
  return page.evaluate(() => window.__useless.phases);
}

const canvas = (page: Page) => page.locator("#app canvas");

test.describe("useless machine — visual states", () => {
  test("idle: lid closed, switch off", async ({ page }) => {
    await gotoScene(page);
    await page.evaluate(() => window.__useless.idle());
    await expect(canvas(page)).toHaveScreenshot("idle.png");
  });

  // The genuine key points of the routine, taken at exact phase boundaries
  // (the state each phase achieves) plus the mid-point of the closing motion.
  // `seconds` is resolved per-phase from the machine's own timeline.
  const keyPoints: Array<{
    name: string;
    phase: string;
    at: "end" | "mid";
  }> = [
    { name: "lid-open", phase: "lidOpen", at: "end" }, // lid fully raised
    { name: "arm-reached", phase: "reach", at: "end" }, // arm out, at the switch
    { name: "switch-knocked", phase: "knock", at: "end" }, // lever pushed to OFF
    { name: "arm-retracted", phase: "retract", at: "end" }, // arm withdrawn
    { name: "lid-closing", phase: "lidClose", at: "mid" }, // lid mid-close
  ];

  for (const k of keyPoints) {
    test(k.name, async ({ page }) => {
      const phases = await gotoScene(page);
      const phase = phases.find((p) => p.name === k.phase);
      expect(phase, `phase "${k.phase}" exists`).toBeDefined();
      const seconds = phase![k.at];
      await page.evaluate((s) => window.__useless.frameAt(s), seconds);
      await expect(canvas(page)).toHaveScreenshot(`${k.name}.png`);
    });
  }
});
