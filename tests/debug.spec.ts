import { test, expect } from "@playwright/test";

// Exercises the debug menu's automation API (window.__uselessDebug), which is
// the same surface a human's HUD buttons drive. These assert the *instrument*
// works — telemetry, deterministic seeking, the collision/body introspection
// and the event log — not that the animation itself is bug-free (finding those
// bugs is the menu's whole job).

interface BodyInfo {
  name: string;
  position: { x: number; y: number; z: number };
  aabb: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
}
interface Telemetry {
  phase: string;
  phaseTime: number;
  armAngle: number;
  switchAngle: number;
  switchOn: boolean;
  lidAngle: number;
  armLeverGap: number;
  activeContacts: string[];
}
interface LogEntry {
  t: number;
  level: string;
  msg: string;
}
interface DebugApi {
  ready: boolean;
  keypoints: string[];
  getState: () => Telemetry;
  getLog: () => LogEntry[];
  getBodies: () => BodyInfo[];
  getContacts: () => string[];
  seek: (s: number) => void;
  seekPhase: (name: string) => void;
  setCollisionBoxes: (on: boolean) => void;
  reset: () => void;
}

declare global {
  interface Window {
    __uselessDebug?: DebugApi;
  }
}

const READY = "() => window.__uselessDebug?.ready === true";

test.describe("useless machine debug menu", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(READY);
  });

  test("exposes keypoints and a floating toggle", async ({ page }) => {
    const keypoints = await page.evaluate(() => window.__uselessDebug!.keypoints);
    expect(keypoints).toEqual(
      expect.arrayContaining(["idle", "extending", "contact", "retracting", "settled"]),
    );
    await expect(page.locator(".dbg-fab")).toBeVisible();
  });

  test("opens the panel with the toggle button", async ({ page }) => {
    await page.locator(".dbg-fab").click();
    await expect(page.locator(".dbg-panel")).toBeVisible();
    await expect(page.locator(".dbg-telemetry")).toBeVisible();
  });

  test("reports idle telemetry before activation", async ({ page }) => {
    const s = await page.evaluate(() => window.__uselessDebug!.getState());
    expect(s.phase).toBe("idle");
    expect(s.switchOn).toBe(false);
    expect(s.switchAngle).toBeLessThan(0);
  });

  test("seeks deterministically into the routine", async ({ page }) => {
    const idle = await page.evaluate(() => {
      window.__uselessDebug!.reset();
      return window.__uselessDebug!.getState().armAngle;
    });
    const mid = await page.evaluate(() => {
      window.__uselessDebug!.seek(0.62); // the "extending" keypoint
      return window.__uselessDebug!.getState();
    });
    // Mid-routine the arm has swept well out from its hidden rest toward the lever.
    expect(Math.abs(mid.armAngle - idle)).toBeGreaterThan(0.3);
    expect(mid.phaseTime).toBeGreaterThanOrEqual(0);
    expect(["opening", "extending", "retracting", "closing", "idle"]).toContain(mid.phase);
  });

  test("introspects the physics bodies and their AABBs", async ({ page }) => {
    const bodies = await page.evaluate(() => window.__uselessDebug!.getBodies());
    expect(bodies.map((b) => b.name).sort()).toEqual(["arm", "base", "lever"]);
    for (const b of bodies) {
      expect(b.aabb.max.x).toBeGreaterThan(b.aabb.min.x);
      expect(b.aabb.max.y).toBeGreaterThan(b.aabb.min.y);
      expect(b.aabb.max.z).toBeGreaterThan(b.aabb.min.z);
    }
  });

  test("toggling collision boxes does not disrupt the API", async ({ page }) => {
    await page.evaluate(() => window.__uselessDebug!.setCollisionBoxes(true));
    const s = await page.evaluate(() => window.__uselessDebug!.getState());
    expect(s.phase).toBeDefined();
  });

  test("logs phase transitions while seeking through the timeline", async ({ page }) => {
    const log = await page.evaluate(() => {
      const d = window.__uselessDebug!;
      d.reset();
      d.seek(2.0); // run past the whole routine (~1.7s envelope)
      return d.getLog();
    });
    expect(log.length).toBeGreaterThan(0);
    expect(log.some((e) => e.level === "phase")).toBe(true);
  });
});
