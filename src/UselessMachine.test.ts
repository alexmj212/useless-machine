import { describe, it, expect } from "vitest";
import { UselessMachine, ARM_HIDDEN } from "./UselessMachine.js";

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

  it("ignores clicks while busy", () => {
    const m = new UselessMachine();
    m.activate();
    m.update(0.2);
    const lidMid = m.lidAngle;
    m.activate(); // no-op mid-routine
    m.update(1 / 60);
    expect(m.lidAngle).toBeGreaterThanOrEqual(lidMid); // kept opening, not restarted
  });
});
