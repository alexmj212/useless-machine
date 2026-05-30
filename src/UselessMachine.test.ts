import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { UselessMachine } from "./UselessMachine.js";

const TOP_Y = 1.2; // top surface of the box
const OPEN_X_MIN = -0.5;
const SWITCH_X = 0.78;

/** Shortest distance from point p to the segment a–b. */
function distToSegment(
  p: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
): number {
  const ab = b.clone().sub(a);
  const t = Math.min(
    1,
    Math.max(0, p.clone().sub(a).dot(ab) / ab.dot(ab)),
  );
  return p.distanceTo(a.clone().add(ab.multiplyScalar(t)));
}

interface Sample {
  switchAngle: number;
  finger: THREE.Vector3;
  leverBase: THREE.Vector3;
  leverTip: THREE.Vector3;
  armPivot: THREE.Vector3;
  /** Distance from the arm's finger to the lever it should be touching. */
  contact: number;
}

function runSequence(dt = 1 / 120, maxSeconds = 4): Sample[] {
  const m = new UselessMachine();
  m.activate();
  const samples: Sample[] = [];
  for (let t = 0; t < maxSeconds && m.isBusy; t += dt) {
    m.update(dt);
    const finger = m.fingerWorld();
    const leverBase = m.switchBaseWorld();
    const leverTip = m.switchTipWorld();
    samples.push({
      switchAngle: m.switchAngle,
      finger,
      leverBase,
      leverTip,
      armPivot: m.armPivotWorld(),
      contact: distToSegment(finger, leverBase, leverTip),
    });
  }
  return samples;
}

describe("UselessMachine — idle state", () => {
  it("starts with the switch OFF and not busy", () => {
    const m = new UselessMachine();
    expect(m.isBusy).toBe(false);
    expect(m.switchAngle).toBeLessThan(0);
    expect(m.lidAngle).toBeCloseTo(0, 5);
  });

  it("keeps the arm hidden below the lid at idle", () => {
    const m = new UselessMachine();
    const finger = m.fingerWorld();
    expect(finger.y).toBeLessThan(TOP_Y);
  });
});

describe("UselessMachine — the arm reaches over and presses the switch", () => {
  it("makes the finger touch the lever during the knock", () => {
    const samples = runSequence();
    // The fingertip presses the lever's surface from a small standoff, so it
    // sits ~a fingertip's width from the lever centerline rather than on it.
    const minContact = Math.min(...samples.map((s) => s.contact));
    expect(minContact).toBeLessThan(0.1);
  });

  it("only moves the switch while the finger is on the lever", () => {
    const samples = runSequence();
    const ON = samples[0].switchAngle;
    const leaving = samples.find((s) => Math.abs(s.switchAngle - ON) > 1e-3);
    expect(leaving).toBeDefined();
    expect(leaving!.contact).toBeLessThan(0.14);
  });

  it("stays in contact with the lever throughout the flip", () => {
    const samples = runSequence();
    const ON = samples[0].switchAngle;
    const OFF = samples[samples.length - 1].switchAngle;
    const midFlip = samples.filter(
      (s) => s.switchAngle < ON - 1e-3 && s.switchAngle > OFF + 1e-3,
    );
    expect(midFlip.length).toBeGreaterThan(0);
    for (const s of midFlip) expect(s.contact).toBeLessThan(0.16);
  });
});

describe("UselessMachine — the arm clears the box top", () => {
  it("crosses the top surface through the opening, never past the switch", () => {
    const samples = runSequence();
    for (const s of samples) {
      const a = s.armPivot; // below the top
      const b = s.finger; // may be above the top
      if ((a.y - TOP_Y) * (b.y - TOP_Y) >= 0) continue; // doesn't cross
      const t = (TOP_Y - a.y) / (b.y - a.y);
      const crossX = a.x + t * (b.x - a.x);
      // The arm exits through the hole and presses the switch; it must never
      // punch through the solid deck to the RIGHT of the switch.
      expect(crossX).toBeGreaterThan(OPEN_X_MIN - 0.08);
      expect(crossX).toBeLessThan(SWITCH_X + 0.05);
    }
  });
});

describe("UselessMachine — the sequence settles", () => {
  it("returns to a clean idle state when finished", () => {
    const m = new UselessMachine();
    m.activate();
    for (let t = 0; t < 5 && m.isBusy; t += 1 / 60) m.update(1 / 60);

    expect(m.isBusy).toBe(false);
    expect(m.switchAngle).toBeLessThan(0);
    expect(m.lidAngle).toBeCloseTo(0, 5);
    expect(m.fingerWorld().y).toBeLessThan(TOP_Y);
  });

  it("ignores clicks while busy", () => {
    const m = new UselessMachine();
    m.activate();
    m.update(0.1);
    const lidMid = m.lidAngle;
    m.activate();
    expect(m.lidAngle).toBe(lidMid);
  });
});
