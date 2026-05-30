import { describe, it, expect } from "vitest";
import {
  obbCorners,
  pointInObb,
  obbPenetrationDepth,
  segmentIntersectsObb,
  sweptThrough,
  type OBB2D,
} from "./contact-checks.js";

const box = (cx: number, cy: number, hx: number, hy: number, angle = 0): OBB2D => ({
  cx,
  cy,
  hx,
  hy,
  angle,
});

describe("contact-checks · pointInObb", () => {
  it("includes the centre and excludes a far point", () => {
    const o = box(0, 0, 1, 0.5);
    expect(pointInObb({ x: 0, y: 0 }, o)).toBe(true);
    expect(pointInObb({ x: 5, y: 0 }, o)).toBe(false);
  });

  it("respects rotation", () => {
    const o = box(0, 0, 1, 0.1, Math.PI / 2); // a tall thin box (rotated 90°)
    expect(pointInObb({ x: 0, y: 0.9 }, o)).toBe(true); // inside the long axis
    expect(pointInObb({ x: 0.9, y: 0 }, o)).toBe(false); // outside the short axis
  });
});

describe("contact-checks · obbCorners", () => {
  it("returns the axis-aligned corners of an unrotated box", () => {
    const c = obbCorners(box(0, 0, 1, 0.5));
    expect(c).toContainEqual({ x: -1, y: -0.5 });
    expect(c).toContainEqual({ x: 1, y: 0.5 });
  });
});

describe("contact-checks · obbPenetrationDepth", () => {
  it("is zero for clearly separated boxes", () => {
    expect(obbPenetrationDepth(box(0, 0, 1, 1), box(5, 0, 1, 1))).toBe(0);
  });

  it("measures the overlap of two axis-aligned boxes", () => {
    // Centres 1.5 apart, half-widths 1 each → 0.5 overlap on X.
    const d = obbPenetrationDepth(box(0, 0, 1, 1), box(1.5, 0, 1, 1));
    expect(d).toBeCloseTo(0.5, 6);
  });

  it("returns ~0 for boxes that merely touch", () => {
    expect(obbPenetrationDepth(box(0, 0, 1, 1), box(2, 0, 1, 1))).toBeCloseTo(0, 6);
  });

  it("does not over-report for a rotated box that an AABB test would (falsely) flag", () => {
    // Two unit squares 1.3 apart on X. Rotating one 45° shrinks its X-extent
    // (its AABB would grow to ~1.41 and overlap), but the true OBBs are apart.
    expect(obbPenetrationDepth(box(0, 0, 0.5, 0.5), box(1.3, 0, 0.5, 0.5, Math.PI / 4))).toBe(0);
  });
});

describe("contact-checks · segmentIntersectsObb & sweptThrough", () => {
  const target = box(0, 0, 0.5, 0.5);

  it("detects a segment passing straight through", () => {
    expect(segmentIntersectsObb({ x: -2, y: 0 }, { x: 2, y: 0 }, target)).toBe(true);
  });

  it("rejects a segment that misses", () => {
    expect(segmentIntersectsObb({ x: -2, y: 2 }, { x: 2, y: 2 }, target)).toBe(false);
  });

  it("flags a tunnelling sweep (both endpoints outside, path crosses)", () => {
    expect(sweptThrough({ x: -2, y: 0 }, { x: 2, y: 0 }, target)).toBe(true);
  });

  it("does not flag a sweep that ends inside (that is a normal contact, not a tunnel)", () => {
    expect(sweptThrough({ x: -2, y: 0 }, { x: 0, y: 0 }, target)).toBe(false);
  });

  it("does not flag a sweep that stays clear", () => {
    expect(sweptThrough({ x: -2, y: 2 }, { x: 2, y: 2 }, target)).toBe(false);
  });
});
