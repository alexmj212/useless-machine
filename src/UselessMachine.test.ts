import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { UselessMachine } from "./UselessMachine.js";

const TOP_Y = 1.2; // top surface of the box

/** Run the full activation sequence, sampling state every `dt` seconds. */
function runSequence(dt = 1 / 120, maxSeconds = 4) {
  const m = new UselessMachine();
  m.activate();

  const samples: Array<{
    t: number;
    switchAngle: number;
    gap: number; // distance from finger tip to switch tip
    finger: THREE.Vector3;
    armEnd: THREE.Vector3;
  }> = [];

  const finger = new THREE.Vector3();
  const tip = new THREE.Vector3();
  const armEnd = new THREE.Vector3();
  for (let t = 0; t < maxSeconds && m.isBusy; t += dt) {
    m.update(dt);
    m.fingerWorld(finger);
    m.switchTipWorld(tip);
    m.armEndWorld(armEnd);
    samples.push({
      t,
      switchAngle: m.switchAngle,
      gap: finger.distanceTo(tip),
      finger: finger.clone(),
      armEnd: armEnd.clone(),
    });
  }
  return { machine: m, samples };
}

describe("UselessMachine — idle state", () => {
  it("starts with the switch OFF and not busy", () => {
    const m = new UselessMachine();
    expect(m.isBusy).toBe(false);
    expect(m.switchAngle).toBeLessThan(0); // OFF leans -ve
    expect(m.lidAngle).toBeCloseTo(0, 5);
  });

  it("keeps the arm hidden below the lid at idle", () => {
    const m = new UselessMachine();
    const finger = m.fingerWorld();
    expect(finger.y).toBeLessThan(TOP_Y); // tucked inside the box
    expect(Math.abs(finger.x)).toBeLessThan(1.5); // within the box walls
  });
});

describe("UselessMachine — the arm actually reaches the switch", () => {
  it("brings the finger tip onto the switch tip during the knock", () => {
    const { samples } = runSequence();
    const minGap = Math.min(...samples.map((s) => s.gap));
    // The finger should make near-exact contact with the toggle tip.
    expect(minGap).toBeLessThan(0.06);
  });

  it("only flips the switch while the finger is in contact", () => {
    const { samples } = runSequence();
    const ON = samples[0].switchAngle; // still ON right after activate()
    // First moment the switch leaves the ON position.
    const leaving = samples.find(
      (s) => Math.abs(s.switchAngle - ON) > 1e-3,
    );
    expect(leaving).toBeDefined();
    // At that moment the finger must already be touching the toggle, so the
    // flip reads as caused by the arm rather than happening on its own.
    expect(leaving!.gap).toBeLessThan(0.1);
  });

  it("tracks the toggle tip closely throughout the knock", () => {
    const { samples } = runSequence();
    const ON = samples[0].switchAngle;
    const OFF = samples[samples.length - 1].switchAngle;
    // Frames where the switch is mid-flip (between ON and OFF).
    const midFlip = samples.filter(
      (s) =>
        s.switchAngle < ON - 1e-3 && s.switchAngle > OFF + 1e-3,
    );
    expect(midFlip.length).toBeGreaterThan(0);
    // The finger never strays far from the tip while pushing it.
    for (const s of midFlip) {
      expect(s.gap).toBeLessThan(0.12);
    }
  });
});

describe("UselessMachine — the arm clears the box opening", () => {
  const OPEN_X_MIN = -0.6;
  const OPEN_X_MAX = 0.7;
  const BAND = 0.07; // a point this close to the top plane is passing through it

  it("only crosses the top surface within the hole (finger)", () => {
    const { samples } = runSequence();
    // A point flying high above the closed top is fine; only a point actually
    // crossing the surface (within BAND of it) would clip the solid frame.
    for (const s of samples) {
      if (Math.abs(s.finger.y - TOP_Y) < BAND) {
        expect(s.finger.x).toBeGreaterThan(OPEN_X_MIN - 0.05);
        expect(s.finger.x).toBeLessThan(OPEN_X_MAX + 0.05);
      }
    }
  });

  it("only crosses the top surface within the hole (arm body)", () => {
    const { samples } = runSequence();
    for (const s of samples) {
      if (Math.abs(s.armEnd.y - TOP_Y) < BAND) {
        expect(s.armEnd.x).toBeGreaterThan(OPEN_X_MIN - 0.05);
        expect(s.armEnd.x).toBeLessThan(OPEN_X_MAX + 0.05);
      }
    }
  });
});

describe("UselessMachine — the sequence settles", () => {
  it("returns to a clean idle state when finished", () => {
    const m = new UselessMachine();
    m.activate();
    for (let t = 0; t < 5 && m.isBusy; t += 1 / 60) m.update(1 / 60);

    expect(m.isBusy).toBe(false);
    expect(m.switchAngle).toBeLessThan(0); // ended OFF
    expect(m.lidAngle).toBeCloseTo(0, 5); // lid closed
    const finger = m.fingerWorld();
    expect(finger.y).toBeLessThan(TOP_Y); // arm hidden again
  });

  it("ignores clicks while busy", () => {
    const m = new UselessMachine();
    m.activate();
    m.update(0.1);
    const lidMid = m.lidAngle;
    m.activate(); // should be a no-op
    expect(m.lidAngle).toBe(lidMid);
  });
});
