import { test, expect } from "@playwright/test";

// Verifies the contact-detection layer end-to-end in a real browser:
//   - the expected arm↔lever contact is detected near where it should land;
//   - real solver contact points are captured (the vertices that met);
//   - the knock is a CLEAN TAP — shallow overlap, no pass-through, no tunnelling.
// The pure geometry behind these checks is unit-tested in
// src/contact-checks.test.ts. (These assertions used to document a defect where
// the finger plowed ~0.15 m through the lever; the arm geometry was fixed so it
// now taps the lever from the side and the lever snaps clear.)

interface XYZ {
  x: number;
  y: number;
  z: number;
}
interface ContactReport {
  expected: {
    name: string;
    satisfied: boolean;
    closestDistance: number;
    tolerance: number;
    observedPoint: XYZ | null;
  }[];
  contactPoints: { point: XYZ; normal: XYZ; phase: string }[];
  maxPenetrationDepth: number;
  passThrough: boolean;
  tunnelEvents: number;
}
interface DebugApi {
  ready: boolean;
  reset: () => void;
  seek: (s: number) => void;
  getContactReport: () => ContactReport;
  getErrors: () => { msg: string }[];
}
declare global {
  interface Window {
    __uselessDebug?: DebugApi;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction("() => window.__uselessDebug?.ready === true");
});

test("detects the expected arm↔lever contact during the routine", async ({ page }) => {
  const report = await page.evaluate(() => {
    const d = window.__uselessDebug!;
    d.reset();
    d.seek(3.9); // run the whole routine deterministically
    return d.getContactReport();
  });

  const knock = report.expected.find((e) => e.name === "arm-knocks-lever")!;
  expect(knock.satisfied).toBe(true);
  expect(knock.closestDistance).toBeLessThanOrEqual(knock.tolerance);
  expect(knock.observedPoint).not.toBeNull();
  expect(report.contactPoints.length).toBeGreaterThan(0);
});

test("knocks the lever with a clean tap — no pass-through, no tunnelling", async ({ page }) => {
  const { report, errors } = await page.evaluate(() => {
    const d = window.__uselessDebug!;
    d.reset();
    d.seek(3.9);
    return { report: d.getContactReport(), errors: d.getErrors() };
  });

  // The finger taps the lever from the side and the lever snaps clear: the
  // overlap stays shallow, well under the pass-through threshold.
  expect(report.maxPenetrationDepth).toBeLessThanOrEqual(0.1);
  expect(report.passThrough).toBe(false);
  expect(errors.some((e) => /pass/i.test(e.msg))).toBe(false);
  // Neither a deep plow-through nor a clean miss/tunnel-through.
  expect(report.tunnelEvents).toBe(0);
});

test("the captured contact lands on the lever, not in mid-air", async ({ page }) => {
  const pt = await page.evaluate(() => {
    const d = window.__uselessDebug!;
    d.reset();
    d.seek(3.9);
    return d.getContactReport().expected.find((e) => e.name === "arm-knocks-lever")!.observedPoint!;
  });
  // The lever lives around x≈0.4–0.65, y≈1.2–1.6; the contact should be there.
  expect(pt.x).toBeGreaterThan(0.3);
  expect(pt.x).toBeLessThan(0.75);
  expect(pt.y).toBeGreaterThan(1.1);
  expect(pt.y).toBeLessThan(1.7);
});
