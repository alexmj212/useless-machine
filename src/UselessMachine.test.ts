import { describe, it, expect } from "vitest";
import { UselessMachine, ARM_HIDDEN, type BehaviorName } from "./UselessMachine.js";

/** Step the physics sim until idle (or a timeout), returning angle samples. */
function runUntilIdle(m: UselessMachine, maxSeconds = 6) {
  const dt = 1 / 60;
  const samples: number[] = [];
  let finished = false;
  for (let t = 0; t < maxSeconds; t += dt) {
    m.update(dt);
    samples.push(m.switchAngle);
    if (!m.isBusy && t > 0.1) {
      finished = true;
      break;
    }
  }
  expect(finished, "machine finished its routine within the timeout").toBe(true);
  return samples;
}

describe("UselessMachine — idle", () => {
  it("starts OFF, not busy, lid closed", () => {
    const m = new UselessMachine();
    expect(m.isBusy).toBe(false);
    expect(m.switchAngle).toBeLessThan(0); // OFF leans -ve
    expect(m.lidAngle).toBeCloseTo(0, 2);
  });

  it("stays put when left alone", () => {
    const m = new UselessMachine();
    for (let i = 0; i < 120; i++) m.update(1 / 60);
    expect(m.isBusy).toBe(false);
    expect(m.switchAngle).toBeLessThan(0);
  });
});

describe("UselessMachine — the arm knocks the switch back off", () => {
  it("flips ON, then the arm collides it back to OFF and settles", () => {
    const m = new UselessMachine();
    m.activate();
    // The click-flip animates ON over ~0.1s (no longer instant); step past it.
    for (let i = 0; i < 12; i++) m.update(1 / 60);
    expect(m.switchAngle).toBeGreaterThan(0); // user flipped it ON

    const samples = runUntilIdle(m);
    expect(samples.some((a) => a > 0.2)).toBe(true); // it was ON for a while
    expect(m.isBusy).toBe(false);
    expect(m.switchAngle).toBeLessThan(0); // ended OFF — knocked back
    expect(m.lidAngle).toBeCloseTo(0, 2); // lid closed again
  });

  it("settles the lever within its travel — no fling-past", () => {
    const m = new UselessMachine();
    m.activate();
    const samples = runUntilIdle(m);
    // End-stops keep the lever between OFF and ON the whole time.
    for (const a of samples) {
      expect(a).toBeGreaterThanOrEqual(-0.55);
      expect(a).toBeLessThanOrEqual(0.55);
    }
  });

  it("returns the arm inside the box when finished", () => {
    const m = new UselessMachine();
    m.activate();
    runUntilIdle(m);
    // Folded back to its hidden rest, laid flat across the cavity.
    expect(m.armAngle).toBeCloseTo(ARM_HIDDEN, 1);
  });

  it("ignores clicks while the lever is already ON", () => {
    const m = new UselessMachine();
    m.activate();
    m.update(0.2);
    const lidMid = m.lidAngle;
    m.activate(); // lever already ON → no-op
    m.update(1 / 60);
    expect(m.lidAngle).toBeGreaterThanOrEqual(lidMid); // kept going, not restarted
  });
});

describe("UselessMachine — personality (revenge + gags)", () => {
  /** Step until idle (or timeout). */
  function settle(m: UselessMachine, maxSeconds = 8): void {
    for (let t = 0; t < maxSeconds && m.isBusy; t += 1 / 60) m.update(1 / 60);
  }

  it("a single calm flip plays it straight — no gag", () => {
    const m = new UselessMachine();
    m.activate();
    for (let i = 0; i < 20; i++) m.update(1 / 60);
    expect(m.currentBehavior).toBe("normal");
  });

  it("can be re-pressed before the arm retracts, and reacts with a double-take", () => {
    const m = new UselessMachine();
    m.activate();
    // Run until the arm has knocked it OFF and is heading home (still busy).
    let guard = 0;
    while (m.phase !== "retracting" && guard++ < 600) m.update(1 / 60);
    expect(m.phase).toBe("retracting");
    expect(m.isBusy).toBe(true);
    expect(m.switchAngle).toBeLessThan(0);

    const before = m.revengeLevel;
    m.activate(); // re-press mid-routine — must NOT be ignored
    expect(m.revengeLevel).toBeGreaterThan(before); // provoked
    expect(m.currentBehavior).toBe("doubletake"); // reaction set synchronously
    for (let i = 0; i < 12; i++) m.update(1 / 60);
    expect(m.switchAngle).toBeGreaterThan(0); // the re-flip took effect

    settle(m);
    expect(m.switchAngle).toBeLessThan(0); // still ends OFF
    expect(m.isBusy).toBe(false);
  });

  it("plays a gag instead of a straight flip once wound up — and still ends OFF", () => {
    // rng()=0 → whenever a gag is rolled it fires and picks the first in the pool.
    const m = new UselessMachine({ rng: () => 0 });
    (m as unknown as { revenge: number }).revenge = 0.9; // pre-wound
    m.activate();
    for (let i = 0; i < 20 && m.currentBehavior === "normal"; i++) m.update(1 / 60);
    expect(m.currentBehavior).not.toBe("normal");

    settle(m);
    expect(m.switchAngle).toBeLessThan(0);
  });

  it("every gag completes and leaves the switch OFF — no wedge, no stuck-ON", () => {
    // Drive each behavior directly via the internal builder so every gag — not
    // just the one rng()=0 happens to pick — has end-state coverage.
    const gags: BehaviorName[] = [
      "normal", "peek", "feint", "creep", "pop", "slam", "multitap", "wiggle", "linger", "ignore",
    ];
    for (const g of gags) {
      const m = new UselessMachine() as unknown as {
        activate: () => void;
        update: (dt: number) => void;
        buildResponse: (b: BehaviorName) => unknown[];
        queue: unknown[];
        behavior: BehaviorName;
        justIgnored: boolean;
        isBusy: boolean;
        switchAngle: number;
        lidAngle: number;
      };
      m.activate();
      for (let i = 0; i < 9; i++) m.update(1 / 60); // run the flip so the lever is ON
      m.queue = m.buildResponse(g);
      m.behavior = g;
      m.justIgnored = false;
      // Run until genuinely settled OFF. "ignore" deliberately leaves the lever
      // ON and the controller comes back with a real knock, so wait for both.
      for (let t = 0; t < 10 && !(m.switchAngle < 0 && !m.isBusy); t += 1 / 60) {
        m.update(1 / 60);
      }
      expect(m.switchAngle, `${g} should end OFF`).toBeLessThan(0);
      expect(m.lidAngle, `${g} should end with the lid shut`).toBeCloseTo(0, 1);
    }
  });

  it("revenge bleeds off over time", () => {
    const m = new UselessMachine();
    (m as unknown as { revenge: number }).revenge = 0.8;
    for (let i = 0; i < 120; i++) m.update(1 / 60); // ~2s idle
    expect(m.revengeLevel).toBeLessThan(0.8);
    expect(m.revengeLevel).toBeGreaterThanOrEqual(0);
  });
});
