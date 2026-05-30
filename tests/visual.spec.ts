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
  views: string[];
  setView: (name: string) => void;
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

async function shoot(page: Page, view: string, name: string): Promise<void> {
  await page.evaluate((v) => window.__useless.setView(v), view);
  await expect(canvas(page)).toHaveScreenshot(`${view}-${name}.png`);
}

test.describe("useless machine — visual states", () => {
  // idle has no arm extended, so a couple of angles suffice.
  for (const view of ["hero", "top"]) {
    test(`idle @ ${view}`, async ({ page }) => {
      await gotoScene(page);
      await page.evaluate(() => window.__useless.idle());
      await shoot(page, view, "idle");
    });
  }

  // The genuine key points of the routine, taken at exact phase boundaries.
  // Contact-critical frames get extra angles (incl. a switch close-up) so the
  // arm/switch/deck overlap is caught from more than one viewpoint.
  const keyPoints: Array<{
    name: string;
    phase: string;
    at: "end" | "mid";
    views: string[];
  }> = [
    { name: "lid-open", phase: "lidOpen", at: "end", views: ["hero", "side", "top"] },
    { name: "arm-reached", phase: "reach", at: "end", views: ["hero", "side", "top", "closeup"] },
    { name: "switch-knocked", phase: "knock", at: "end", views: ["hero", "side", "top", "closeup"] },
    { name: "arm-retracted", phase: "retract", at: "end", views: ["hero", "side", "top"] },
    { name: "lid-closing", phase: "lidClose", at: "mid", views: ["hero"] },
  ];

  for (const k of keyPoints) {
    for (const view of k.views) {
      test(`${k.name} @ ${view}`, async ({ page }) => {
        const phases = await gotoScene(page);
        const phase = phases.find((p) => p.name === k.phase);
        expect(phase, `phase "${k.phase}" exists`).toBeDefined();
        await page.evaluate((s) => window.__useless.frameAt(s), phase![k.at]);
        await shoot(page, view, k.name);
      });
    }
  }
});
