// ----------------------------------------------------------------------------
// Pure 2D collision geometry for the debug menu's contact checks.
//
// The whole mechanism moves in the XY plane (every body rotates only about Z),
// so an oriented box in that plane captures each shape exactly — far more
// accurate than the axis-aligned boxes the broadphase reports, which inflate
// badly once a box is rotated. These functions answer three questions the
// menu needs:
//   - do two shapes overlap, and by how much (SAT penetration depth)?
//   - did a moving point sweep *through* a shape between two frames (tunnelling)?
//   - is a point inside a shape?
// They are deliberately dependency-free and side-effect-free so they can be
// unit-tested directly, without a physics world or a browser.
// ----------------------------------------------------------------------------

export interface Vec2 {
  x: number;
  y: number;
}

/** An oriented bounding box in the XY plane. `angle` rotates its local +X. */
export interface OBB2D {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  angle: number;
}

/** Unit axes of an OBB: `ax` along its local +X, `ay` along its local +Y. */
export function obbAxes(o: OBB2D): { ax: Vec2; ay: Vec2 } {
  const c = Math.cos(o.angle);
  const s = Math.sin(o.angle);
  return { ax: { x: c, y: s }, ay: { x: -s, y: c } };
}

/** The four corners of an OBB, counter-clockwise. */
export function obbCorners(o: OBB2D): Vec2[] {
  const { ax, ay } = obbAxes(o);
  const ex = { x: ax.x * o.hx, y: ax.y * o.hx };
  const ey = { x: ay.x * o.hy, y: ay.y * o.hy };
  return [
    { x: o.cx - ex.x - ey.x, y: o.cy - ex.y - ey.y },
    { x: o.cx + ex.x - ey.x, y: o.cy + ex.y - ey.y },
    { x: o.cx + ex.x + ey.x, y: o.cy + ex.y + ey.y },
    { x: o.cx - ex.x + ey.x, y: o.cy - ex.y + ey.y },
  ];
}

/** Express a world point in an OBB's local frame. */
function toLocal(p: Vec2, o: OBB2D): Vec2 {
  const { ax, ay } = obbAxes(o);
  const dx = p.x - o.cx;
  const dy = p.y - o.cy;
  return { x: dx * ax.x + dy * ax.y, y: dx * ay.x + dy * ay.y };
}

/** Is a world point inside (or on) an OBB? */
export function pointInObb(p: Vec2, o: OBB2D): boolean {
  const l = toLocal(p, o);
  return Math.abs(l.x) <= o.hx && Math.abs(l.y) <= o.hy;
}

const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

/**
 * Separating-axis penetration depth between two OBBs.
 * Returns 0 when they do not overlap, otherwise the minimum translation
 * distance (the smallest overlap across all four candidate axes) — i.e. how
 * deep one box has sunk into the other.
 */
export function obbPenetrationDepth(a: OBB2D, b: OBB2D): number {
  const axA = obbAxes(a);
  const axB = obbAxes(b);
  const axes: Vec2[] = [axA.ax, axA.ay, axB.ax, axB.ay];
  const delta: Vec2 = { x: b.cx - a.cx, y: b.cy - a.cy };

  let min = Infinity;
  for (const n of axes) {
    const rA = a.hx * Math.abs(dot(axA.ax, n)) + a.hy * Math.abs(dot(axA.ay, n));
    const rB = b.hx * Math.abs(dot(axB.ax, n)) + b.hy * Math.abs(dot(axB.ay, n));
    const overlap = rA + rB - Math.abs(dot(delta, n));
    if (overlap <= 0) return 0; // a separating axis exists → no contact
    if (overlap < min) min = overlap;
  }
  return min;
}

/**
 * Does the segment p0→p1 intersect an OBB? (Slab clip in the box's local
 * frame.) Combined with `pointInObb` returning false for both endpoints, a
 * true result means the point swept clean through the box — a tunnelling event
 * a discrete collision check would miss.
 */
export function segmentIntersectsObb(p0: Vec2, p1: Vec2, o: OBB2D): boolean {
  const a = toLocal(p0, o);
  const b = toLocal(p1, o);
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  let tmin = 0;
  let tmax = 1;
  // Clip against the x slab [-hx, hx] then the y slab [-hy, hy].
  const clip = (origin: number, dir: number, lo: number, hi: number): boolean => {
    if (Math.abs(dir) < 1e-12) return origin >= lo && origin <= hi; // parallel
    let t1 = (lo - origin) / dir;
    let t2 = (hi - origin) / dir;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    return tmin <= tmax;
  };

  if (!clip(a.x, dx, -o.hx, o.hx)) return false;
  if (!clip(a.y, dy, -o.hy, o.hy)) return false;
  return tmin <= tmax;
}

/**
 * A point swept *through* a box between two frames: the path crosses the box
 * but neither endpoint is inside it. This is the signature of tunnelling — the
 * shapes passed through each other without ever being caught overlapping.
 */
export function sweptThrough(prev: Vec2, curr: Vec2, o: OBB2D): boolean {
  if (pointInObb(prev, o) || pointInObb(curr, o)) return false;
  return segmentIntersectsObb(prev, curr, o);
}
