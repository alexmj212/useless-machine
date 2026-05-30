import * as THREE from "three";
import * as CANNON from "cannon-es";
import {
  UselessMachine,
  SWITCH_ON,
  SWITCH_OFF,
  ARM_OUT,
  FIXED_DT,
  type DebugPart,
} from "./UselessMachine.js";
import {
  obbPenetrationDepth,
  sweptThrough,
  type OBB2D,
  type Vec2,
} from "./contact-checks.js";

// ----------------------------------------------------------------------------
// Debug menu: an on-screen instrument panel for diagnosing the animation.
//
// It is built for two audiences at once:
//   - humans, via a collapsible HUD with playback, keypoint and toggle controls;
//   - AI/automation, via `window.__uselessDebug`, a structured API that mirrors
//     every control and surfaces telemetry, the event log, warnings and errors.
//
// Nothing here changes the simulation: the menu only *reads* the machine and
// drives time (scale / pause / step / seek). The collision overlay reflects the
// actual cannon-es shapes, so what you see is the geometry the solver sees.
// ----------------------------------------------------------------------------

/** How the host app exposes its machine + scene to the debug menu. */
export interface DebugHost {
  scene: THREE.Scene;
  /** The machine currently in the scene (may change when `rebuild` is called). */
  getMachine: () => UselessMachine;
  /** Tear down the current machine, build a fresh one, add it to the scene. */
  rebuild: () => UselessMachine;
  /** Render one frame (used while paused / seeking). */
  render: () => void;
}

type Level = "info" | "phase" | "contact" | "warn" | "error";

/**
 * The automation surface exposed at `window.__uselessDebug`. Mirrors the HUD
 * buttons so an AI consumer can drive and inspect the animation headlessly.
 * Typing the assignment against this interface keeps the runtime object honest.
 */
export interface DebugApi {
  ready: boolean;
  keypoints: string[];
  getState: () => Telemetry;
  getLog: () => LogEntry[];
  getWarnings: () => LogEntry[];
  getErrors: () => LogEntry[];
  getContacts: () => string[];
  getBodies: () => {
    name: string;
    position: { x: number; y: number; z: number };
    aabb: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  }[];
  /** Expected-contact verification + pass-through / tunnelling findings. */
  getContactReport: () => ContactReport;
  clearLog: () => void;
  pause: () => void;
  play: () => void;
  /** Advance N nominal (1/60 s) frames while paused; ignores timeScale. */
  step: (n?: number) => void;
  setTimeScale: (x: number) => void;
  seek: (seconds: number) => void;
  seekPhase: (name: string) => void;
  reset: () => void;
  activate: () => void;
  setCollisionBoxes: (on: boolean) => void;
  setPivots: (on: boolean) => void;
  setContactPoints: (on: boolean) => void;
  open: () => void;
  close: () => void;
}

interface LogEntry {
  /** Seconds on the debug wall-clock when this was recorded. */
  t: number;
  level: Level;
  msg: string;
}

interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** A contact location we assert the mechanism must hit during the routine. */
interface ExpectedContact {
  name: string;
  /** Phases during which this contact is allowed to count. */
  during: string[];
  /** Where, in world space, the arm should strike the lever. */
  point: XYZ;
  /** Distance (m) an actual contact may be from `point` and still count. */
  tolerance: number;
}

/** A real contact the solver produced, as reported by cannon-es. */
interface ContactRecord {
  point: XYZ;
  normal: XYZ;
  phase: string;
  phaseTime: number;
}

/** Verdict for one ExpectedContact after a run. */
interface ExpectedResult {
  name: string;
  expectedPoint: XYZ;
  tolerance: number;
  satisfied: boolean;
  closestDistance: number;
  observedPoint: XYZ | null;
}

interface ContactReport {
  expected: ExpectedResult[];
  contactPoints: ContactRecord[];
  /** Deepest arm↔lever overlap seen (OBB SAT). Small = a clean tap. */
  maxPenetrationDepth: number;
  passThrough: boolean;
  tunnelEvents: number;
}

interface Telemetry {
  phase: string;
  phaseTime: number;
  armAngle: number;
  switchAngle: number;
  switchOn: boolean;
  lidAngle: number;
  /** Signed arm↔lever clearance: +ve = gap, −ve = interpenetration (approx). */
  armLeverGap: number;
  /** Precise arm↔lever overlap depth (OBB SAT); 0 when separated. */
  penetration: number;
  activeContacts: string[];
  timeScale: number;
  paused: boolean;
  fps: number;
}

// Phase → representative timeline second, mirroring tests/visual.spec.ts so the
// keypoint buttons land on the same moments the visual suite captures.
const KEYPOINTS: { name: string; t: number }[] = [
  { name: "idle", t: 0 },
  { name: "opening", t: 0.35 },
  { name: "extending", t: 0.9 },
  { name: "contact", t: 1.5 },
  { name: "retracting", t: 2.1 },
  { name: "closing", t: 2.8 },
  { name: "settled", t: 3.6 },
];

const TIME_SCALES = [0.1, 0.25, 0.5, 1, 2];
// Seek one physics sub-step at a time so contact sampling sees every sub-step.
const SEEK_STEP = FIXED_DT;
const LOG_CAP = 500;

// Contacts we assert the routine must produce. Calibrated from the real contact
// points of a clean knock (observed ~0.07 m away); tolerance is tight enough
// that a real miss or a hit on the wrong feature fails.
const EXPECTED_CONTACTS: ExpectedContact[] = [
  {
    name: "arm-knocks-lever",
    during: ["extending", "retracting"],
    point: { x: 0.5, y: 1.3, z: 0 },
    tolerance: 0.15,
  },
];

// Arm↔lever overlap (OBB SAT, m) beyond which it's a pass-through, not a tap.
// Sits above a clean knock (~0.06) and below the old plow-through bug (~0.15).
const PASS_THROUGH_DEPTH = 0.1;

const PART_COLORS: Record<string, number> = {
  base: 0x4a90d9,
  lever: 0xe05a5a,
  arm: 0x46d6c4,
};
const CONTACT_COLOR = 0xffd23f; // flash when a body is in a live contact

export class DebugMenu {
  private readonly host: DebugHost;
  private machine: UselessMachine;

  // Playback.
  private timeScale = 1;
  private paused = false;
  private stepsQueued = 0;
  private clock = 0; // debug wall-clock seconds (advances with real frames)
  private fps = 0;

  // Overlay.
  private readonly overlay = new THREE.Group();
  private wireframes: {
    part: DebugPart;
    shapeIndex: number;
    line: THREE.LineSegments;
    baseColor: number;
  }[] = [];
  private readonly pivotMarkers: THREE.Mesh[] = [];
  private readonly expectedMarkers: THREE.Mesh[] = [];
  private actualMarker!: THREE.Mesh;
  private showCollision = false;
  private showContactPoints = false;
  private flashContacts = true;

  // Contacts + invariants.
  private currentWorld: CANNON.World | null = null;
  private parts: DebugPart[] = [];
  private armBody!: CANNON.Body;
  private leverBody!: CANNON.Body;
  private readonly activeContacts = new Set<string>();
  private armTouchedLever = false;
  private lastPhase = "idle";
  private warnCount = 0;
  private errorCount = 0;
  private readonly log: LogEntry[] = [];
  private readonly throttle = new Map<string, number>();

  // Expected-contact + pass-through tracking (reset each run in attach()).
  private expectedResults: ExpectedResult[] = [];
  private contactRecords: ContactRecord[] = [];
  private maxPenetration = 0;
  private passThrough = false;
  private tunnelEvents = 0;
  private prevFingerTip: Vec2 | null = null;

  // DOM.
  private root!: HTMLDivElement;
  private toggleBtn!: HTMLButtonElement;
  private logEl!: HTMLDivElement;
  private telemetryEl!: HTMLPreElement;
  private scrubber!: HTMLInputElement;
  private scrubLabel!: HTMLSpanElement;
  private countsEl!: HTMLSpanElement;
  private readonly scaleButtons = new Map<number, HTMLButtonElement>();
  private pauseBtn!: HTMLButtonElement;
  private collisionToggle!: HTMLInputElement;
  private pivotToggle!: HTMLInputElement;
  private contactToggle!: HTMLInputElement;

  private readonly keyHandler = (e: KeyboardEvent): void => {
    if (e.key === "d" || e.key === "D") {
      this.setOpen(this.root.style.display === "none");
    }
  };

  constructor(host: DebugHost) {
    this.host = host;
    this.machine = host.getMachine();
    this.host.scene.add(this.overlay);
    this.buildPivotMarkers();
    this.buildContactMarkers();
    this.attach(this.machine);
    this.buildDom();
    this.exposeApi();
    this.log_("info", "debug menu ready");
  }

  // --- Per-frame entry point ------------------------------------------------

  /** Advance the sim under debug control and refresh the overlay + HUD. */
  frame(realDt: number): void {
    this.clock += realDt;
    if (realDt > 0) this.fps = this.fps * 0.9 + (1 / realDt) * 0.1;

    let simDt = 0;
    if (this.stepsQueued > 0) {
      simDt = 1 / 60; // one nominal frame per queued step
      this.stepsQueued--;
    } else if (!this.paused) {
      simDt = realDt * this.timeScale;
    }
    if (simDt > 0) this.machine.update(simDt); // contacts sampled via postStep

    this.detectPhaseChange();
    this.checkInvariants();
    this.syncOverlay();
    this.refreshHud();
  }

  // --- Machine attachment ---------------------------------------------------

  /** Point the menu at a (possibly new) machine and rewire contact listeners. */
  private attach(machine: UselessMachine): void {
    this.machine = machine;
    this.parts = machine.debugParts;
    this.armBody = this.parts.find((p) => p.name === "arm")!.body;
    this.leverBody = this.parts.find((p) => p.name === "lever")!.body;
    this.activeContacts.clear();
    this.armTouchedLever = false;
    this.lastPhase = machine.phase;
    this.resetContactTracking();
    machine.world.addEventListener("beginContact", this.onBeginContact);
    machine.world.addEventListener("endContact", this.onEndContact);
    // Sample contacts on every physics sub-step (update() may run several per
    // call) so brief contacts and the deepest penetration are never skipped.
    machine.world.addEventListener("postStep", this.onPostStep);
    this.currentWorld = machine.world;
    this.buildWireframes();
  }

  /** Start a fresh expected-contact / pass-through ledger for a new run. */
  private resetContactTracking(): void {
    this.expectedResults = EXPECTED_CONTACTS.map((s) => ({
      name: s.name,
      expectedPoint: { ...s.point },
      tolerance: s.tolerance,
      satisfied: false,
      closestDistance: Infinity,
      observedPoint: null,
    }));
    this.contactRecords = [];
    this.maxPenetration = 0;
    this.passThrough = false;
    this.tunnelEvents = 0;
    this.prevFingerTip = null;
  }

  /** Drop contact listeners from the current world before it is discarded. */
  private detachListeners(): void {
    if (!this.currentWorld) return;
    this.currentWorld.removeEventListener("beginContact", this.onBeginContact);
    this.currentWorld.removeEventListener("endContact", this.onEndContact);
    this.currentWorld.removeEventListener("postStep", this.onPostStep);
    this.currentWorld = null;
  }

  private onPostStep = (): void => {
    this.sampleContacts();
  };

  private rebuildMachine(): UselessMachine {
    this.detachListeners();
    const m = this.host.rebuild();
    this.attach(m);
    return m;
  }

  /** Release global listeners + scene resources (for teardown / HMR). */
  dispose(): void {
    window.removeEventListener("keydown", this.keyHandler);
    this.detachListeners();
    for (const w of this.wireframes) {
      w.line.geometry.dispose();
      (w.line.material as THREE.Material).dispose();
    }
    for (const m of [...this.pivotMarkers, ...this.expectedMarkers, this.actualMarker]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.host.scene.remove(this.overlay);
  }

  // --- Contact handling -----------------------------------------------------

  private nameOf(body: CANNON.Body): string {
    for (const p of this.parts) if (p.body === body) return p.name;
    return "?";
  }

  private pairKey(a: string, b: string): string {
    return a < b ? `${a}↔${b}` : `${b}↔${a}`;
  }

  private onBeginContact = (e: { bodyA: CANNON.Body; bodyB: CANNON.Body }): void => {
    const a = this.nameOf(e.bodyA);
    const b = this.nameOf(e.bodyB);
    const key = this.pairKey(a, b);
    if (this.activeContacts.has(key)) return;
    this.activeContacts.add(key);
    this.log_("contact", `contact begin  ${key}`);
    if (key === this.pairKey("arm", "lever")) this.armTouchedLever = true;
  };

  private onEndContact = (e: { bodyA: CANNON.Body; bodyB: CANNON.Body }): void => {
    const key = this.pairKey(this.nameOf(e.bodyA), this.nameOf(e.bodyB));
    if (this.activeContacts.delete(key)) this.log_("contact", `contact end    ${key}`);
  };

  // --- Phase + invariant diagnostics ---------------------------------------

  private detectPhaseChange(): void {
    const phase = this.machine.phase;
    if (phase === this.lastPhase) return;

    this.log_("phase", `${this.lastPhase} → ${phase}`);

    if (phase === "extending") {
      this.armTouchedLever = false; // start watching for the knock
    }

    // Leaving extension is the moment of truth: did the arm reach the lever?
    if (this.lastPhase === "extending") {
      if (this.machine.armAngle < ARM_OUT - 0.2) {
        this.warn(
          "arm-stalled",
          `arm stopped at ${this.machine.armAngle.toFixed(2)} rad, short of ` +
            `ARM_OUT ${ARM_OUT} — motor stalled or path blocked`,
        );
      }
      if (!this.armTouchedLever) {
        this.warn(
          "arm-missed",
          "arm retracted without ever contacting the lever — it missed the switch",
        );
      }
    }

    // Back to rest: did we actually flip the switch off, and did every contact
    // we expect actually happen near where it should?
    if (phase === "idle") {
      if (this.machine.switchAngle > 0) {
        this.error(
          "still-on",
          `routine finished but switch is still ON (${this.machine.switchAngle.toFixed(2)} rad) ` +
            "— the machine failed to flip itself off",
        );
      }
      for (const r of this.expectedResults) {
        if (r.satisfied) continue;
        const closest = isFinite(r.closestDistance)
          ? `${r.closestDistance.toFixed(3)} m`
          : "no contact at all";
        this.error(
          "expected-" + r.name,
          `expected contact "${r.name}" never satisfied — closest approach ${closest} ` +
            `(tolerance ${r.tolerance} m)`,
        );
      }
    }

    this.lastPhase = phase;
  }

  private checkInvariants(): void {
    for (const { name, body } of this.parts) {
      const p = body.position;
      if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) {
        this.error("nan-" + name, `${name} body position is non-finite (sim diverged)`);
      }
    }

    const a = this.machine.switchAngle;
    if (a > SWITCH_ON + 0.06 || a < SWITCH_OFF - 0.06) {
      this.warn(
        "lever-range",
        `lever ${a.toFixed(2)} rad is outside its travel [${SWITCH_OFF}, ${SWITCH_ON}] — flung past an end-stop`,
      );
    }

    const gap = this.armLeverGap();
    if (!isFinite(gap)) {
      this.warn("gap-nan", "could not measure arm↔lever clearance (a body is missing)");
    } else if (gap < -0.03) {
      this.warn(
        "interpenetration",
        `arm and lever interpenetrate by ${(-gap).toFixed(3)} (solver let shapes overlap)`,
      );
    }
  }

  /** Signed clearance between the arm's finger shape and the lever shape. */
  private armLeverGap(): number {
    if (!this.armBody || !this.leverBody) return NaN;
    // Arm shape 1 is the finger; lever shape 0 is the bar.
    const fingerIdx = this.armBody.shapes.length > 1 ? 1 : 0;
    const armBox = this.worldAabb(this.armBody, fingerIdx);
    const leverBox = this.worldAabb(this.leverBody, 0);
    return aabbGap(armBox, leverBox);
  }

  /** Union of every shape's world AABB for a body (its full extent). */
  private bodyAabb(body: CANNON.Body): { min: CANNON.Vec3; max: CANNON.Vec3 } {
    const min = new CANNON.Vec3(Infinity, Infinity, Infinity);
    const max = new CANNON.Vec3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < body.shapes.length; i++) {
      const { min: mn, max: mx } = this.worldAabb(body, i);
      min.x = Math.min(min.x, mn.x);
      min.y = Math.min(min.y, mn.y);
      min.z = Math.min(min.z, mn.z);
      max.x = Math.max(max.x, mx.x);
      max.y = Math.max(max.y, mx.y);
      max.z = Math.max(max.z, mx.z);
    }
    return { min, max };
  }

  private worldAabb(body: CANNON.Body, shapeIndex: number): { min: CANNON.Vec3; max: CANNON.Vec3 } {
    const shape = body.shapes[shapeIndex];
    const offset = body.shapeOffsets[shapeIndex];
    const orient = body.shapeOrientations[shapeIndex];
    const worldPos = new CANNON.Vec3();
    body.quaternion.vmult(offset, worldPos);
    worldPos.vadd(body.position, worldPos);
    const worldQuat = body.quaternion.mult(orient);
    const min = new CANNON.Vec3();
    const max = new CANNON.Vec3();
    shape.calculateWorldAABB(worldPos, worldQuat, min, max);
    return { min, max };
  }

  // --- Precise contact analysis (expected points + pass-through) ------------
  //
  // NB: the OBB helpers assume each shape has identity local orientation (true
  // here — only body offsets are non-trivial). A rotated shape would need that
  // folded into the angle.

  /** The body's rotation about Z (its planar orientation). */
  private bodyZAngle(body: CANNON.Body): number {
    const x = new CANNON.Vec3();
    body.quaternion.vmult(new CANNON.Vec3(1, 0, 0), x);
    return Math.atan2(x.y, x.x);
  }

  /** World-space XY centre of one of a body's shapes. */
  private shapeCenter2D(body: CANNON.Body, idx: number): Vec2 {
    const wp = new CANNON.Vec3();
    body.quaternion.vmult(body.shapeOffsets[idx], wp);
    wp.vadd(body.position, wp);
    return { x: wp.x, y: wp.y };
  }

  private get fingerIndex(): number {
    return this.armBody.shapes.length > 1 ? 1 : 0;
  }

  private fingerObb(): OBB2D {
    const idx = this.fingerIndex;
    const he = (this.armBody.shapes[idx] as CANNON.Box).halfExtents;
    const c = this.shapeCenter2D(this.armBody, idx);
    return { cx: c.x, cy: c.y, hx: he.x, hy: he.y, angle: this.bodyZAngle(this.armBody) };
  }

  private leverObb(): OBB2D {
    const he = (this.leverBody.shapes[0] as CANNON.Box).halfExtents;
    const c = this.shapeCenter2D(this.leverBody, 0);
    return { cx: c.x, cy: c.y, hx: he.x, hy: he.y, angle: this.bodyZAngle(this.leverBody) };
  }

  /** Leading point of the finger — the vertex that should strike the lever. */
  private fingerTip(): Vec2 {
    const idx = this.fingerIndex;
    const he = (this.armBody.shapes[idx] as CANNON.Box).halfExtents;
    const c = this.shapeCenter2D(this.armBody, idx);
    const a = this.bodyZAngle(this.armBody);
    return { x: c.x + Math.cos(a) * he.x, y: c.y + Math.sin(a) * he.x };
  }

  private penetrationDepth(): number {
    if (!this.armBody || !this.leverBody) return 0;
    return obbPenetrationDepth(this.fingerObb(), this.leverObb());
  }

  /**
   * Run the precise contact checks for the current physics state. Driven by the
   * world "postStep" event so it sees every sub-step of the knock:
   *   - records the real cannon-es contact points (the vertices that touched);
   *   - measures overlap depth and flags pass-through (shapes sinking in);
   *   - flags tunnelling (finger swept through the lever with no contact).
   */
  private sampleContacts(): void {
    if (!this.armBody || !this.leverBody) return;
    const lever = this.leverObb();

    const depth = this.penetrationDepth();
    if (depth > this.maxPenetration) this.maxPenetration = depth;
    if (depth > PASS_THROUGH_DEPTH) {
      this.passThrough = true;
      this.error(
        "passthrough",
        `arm has sunk ${depth.toFixed(3)} m into the lever — shapes passing through each other`,
      );
    }

    const tip = this.fingerTip();
    if (this.prevFingerTip && sweptThrough(this.prevFingerTip, tip, lever)) {
      this.tunnelEvents++;
      this.error(
        "tunnel",
        "arm finger swept clean through the lever (tunnelling — collision missed)",
      );
    }
    this.prevFingerTip = tip;

    // Real contact points the solver produced this sub-step.
    for (const eq of this.machine.world.contacts) {
      const pair =
        (eq.bi === this.armBody && eq.bj === this.leverBody) ||
        (eq.bi === this.leverBody && eq.bj === this.armBody);
      if (!pair) continue;
      const wp = new CANNON.Vec3();
      eq.bi.position.vadd(eq.ri, wp);
      this.recordContact({ x: wp.x, y: wp.y, z: wp.z }, { x: eq.ni.x, y: eq.ni.y, z: eq.ni.z });
    }
  }

  private recordContact(point: XYZ, normal: XYZ): void {
    this.contactRecords.push({
      point,
      normal,
      phase: this.machine.phase,
      phaseTime: this.machine.phaseTime,
    });
    if (this.contactRecords.length > 200) this.contactRecords.shift();

    for (const r of this.expectedResults) {
      const spec = EXPECTED_CONTACTS.find((s) => s.name === r.name);
      if (!spec) continue;
      const dist = Math.hypot(
        point.x - r.expectedPoint.x,
        point.y - r.expectedPoint.y,
        point.z - r.expectedPoint.z,
      );
      if (dist < r.closestDistance) {
        r.closestDistance = dist;
        r.observedPoint = { ...point };
      }
      if (!r.satisfied && dist <= r.tolerance && spec.during.includes(this.machine.phase)) {
        r.satisfied = true;
        this.log_(
          "contact",
          `expected "${r.name}" met at (${point.x.toFixed(2)}, ${point.y.toFixed(2)}), ` +
            `${dist.toFixed(3)} m from target`,
        );
      }
    }
  }

  private contactReport(): ContactReport {
    return {
      expected: this.expectedResults.map((r) => ({
        ...r,
        expectedPoint: { ...r.expectedPoint },
        observedPoint: r.observedPoint ? { ...r.observedPoint } : null,
      })),
      contactPoints: this.contactRecords.map((r) => ({
        point: { ...r.point },
        normal: { ...r.normal },
        phase: r.phase,
        phaseTime: r.phaseTime,
      })),
      maxPenetrationDepth: this.maxPenetration,
      passThrough: this.passThrough,
      tunnelEvents: this.tunnelEvents,
    };
  }

  // --- Collision overlay ----------------------------------------------------

  private buildPivotMarkers(): void {
    for (const pivot of this.machine.debugPivots) {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xffff00, wireframe: true }),
      );
      marker.position.copy(pivot.position);
      marker.visible = false;
      this.overlay.add(marker);
      this.pivotMarkers.push(marker);
    }
  }

  private buildContactMarkers(): void {
    // Yellow rings mark where each expected contact *should* land.
    for (const spec of EXPECTED_CONTACTS) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(spec.tolerance, 0.012, 8, 28),
        new THREE.MeshBasicMaterial({ color: 0xffd23f }),
      );
      ring.position.set(spec.point.x, spec.point.y, spec.point.z);
      ring.visible = false;
      this.overlay.add(ring);
      this.expectedMarkers.push(ring);
    }
    // A green dot snaps to the most recent actual contact point.
    this.actualMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 12, 10),
      new THREE.MeshBasicMaterial({ color: 0x4ade80 }),
    );
    this.actualMarker.visible = false;
    this.overlay.add(this.actualMarker);
  }

  private buildWireframes(): void {
    for (const w of this.wireframes) {
      this.overlay.remove(w.line);
      w.line.geometry.dispose();
      (w.line.material as THREE.Material).dispose();
    }
    this.wireframes = [];

    for (const part of this.parts) {
      const color = PART_COLORS[part.name] ?? 0xffffff;
      part.body.shapes.forEach((shape, shapeIndex) => {
        if (!(shape instanceof CANNON.Box)) return;
        const he = shape.halfExtents;
        const geom = new THREE.BoxGeometry(he.x * 2, he.y * 2, he.z * 2);
        const edges = new THREE.EdgesGeometry(geom);
        geom.dispose();
        const line = new THREE.LineSegments(
          edges,
          new THREE.LineBasicMaterial({ color }),
        );
        line.visible = this.showCollision;
        this.overlay.add(line);
        this.wireframes.push({ part, shapeIndex, line, baseColor: color });
      });
    }
  }

  private syncOverlay(): void {
    this.syncWireframes();
    this.syncContactMarkers();
  }

  private syncContactMarkers(): void {
    for (const m of this.expectedMarkers) m.visible = this.showContactPoints;
    const last = this.contactRecords[this.contactRecords.length - 1];
    if (this.showContactPoints && last) {
      this.actualMarker.position.set(last.point.x, last.point.y, last.point.z);
      this.actualMarker.visible = true;
    } else {
      this.actualMarker.visible = false;
    }
  }

  private syncWireframes(): void {
    if (!this.showCollision) return;
    const inContact = (name: string): boolean => {
      for (const key of this.activeContacts) if (key.includes(name)) return true;
      return false;
    };
    const _p = new CANNON.Vec3();
    for (const { part, shapeIndex, line, baseColor } of this.wireframes) {
      const body = part.body;
      const offset = body.shapeOffsets[shapeIndex];
      const orient = body.shapeOrientations[shapeIndex];
      body.quaternion.vmult(offset, _p);
      _p.vadd(body.position, _p);
      const q = body.quaternion.mult(orient);
      line.position.set(_p.x, _p.y, _p.z);
      line.quaternion.set(q.x, q.y, q.z, q.w);
      const lit = this.flashContacts && part.name !== "base" && inContact(part.name);
      (line.material as THREE.LineBasicMaterial).color.setHex(lit ? CONTACT_COLOR : baseColor);
    }
  }

  // --- Playback controls ----------------------------------------------------

  private setPaused(paused: boolean): void {
    this.paused = paused;
    this.pauseBtn.textContent = paused ? "▶ Play" : "⏸ Pause";
  }

  private setTimeScale(scale: number): void {
    this.timeScale = scale;
    for (const [s, btn] of this.scaleButtons) {
      btn.classList.toggle("dbg-active", s === scale);
    }
  }

  /**
   * Deterministically rebuild and step to `seconds`, then hold the frame.
   * Diagnostics (phase transitions, contacts, invariants) run on every sub-step
   * so the log reflects the whole replay — this is the surface an AI inspects,
   * so it must see the same warnings a live run would produce. The log is
   * cleared first so each seek yields a clean, self-contained record.
   */
  private seek(seconds: number): void {
    this.setPaused(true);
    this.clearLog();
    const m = this.rebuildMachine();
    if (seconds > 0) {
      m.activate();
      for (let t = 0; t < seconds; t += SEEK_STEP) {
        m.update(Math.min(SEEK_STEP, seconds - t)); // contacts sampled via postStep
        this.detectPhaseChange();
        this.checkInvariants();
      }
    }
    this.syncOverlay();
    this.host.render();
    this.refreshHud();
    this.log_("info", `seek → ${seconds.toFixed(2)}s  (phase=${m.phase})`);
  }

  private reset(): void {
    this.rebuildMachine();
    this.setPaused(false);
    this.clearLog();
    this.syncOverlay();
    this.host.render();
    this.log_("info", "machine reset");
  }

  // --- Logging --------------------------------------------------------------

  private log_(level: Level, msg: string): void {
    const entry: LogEntry = { t: this.clock, level, msg };
    this.log.push(entry);
    if (this.log.length > LOG_CAP) this.log.shift();
    if (level === "warn") this.warnCount++;
    if (level === "error") this.errorCount++;
    this.appendLogRow(entry);
  }

  /** Warn at most once per ~1s per key, so frame-rate checks don't spam. */
  private warn(key: string, msg: string): void {
    if (this.throttled(key)) return;
    this.log_("warn", msg);
  }

  private error(key: string, msg: string): void {
    if (this.throttled(key)) return;
    this.log_("error", msg);
  }

  private throttled(key: string): boolean {
    const last = this.throttle.get(key) ?? -Infinity;
    if (this.clock - last < 1) return true;
    this.throttle.set(key, this.clock);
    return false;
  }

  private clearLog(): void {
    this.log.length = 0;
    this.warnCount = 0;
    this.errorCount = 0;
    this.throttle.clear();
    if (this.logEl) this.logEl.textContent = "";
    this.refreshCounts();
  }

  // --- Telemetry ------------------------------------------------------------

  private telemetry(): Telemetry {
    const m = this.machine;
    return {
      phase: m.phase,
      phaseTime: m.phaseTime,
      armAngle: m.armAngle,
      switchAngle: m.switchAngle,
      switchOn: m.switchAngle > 0,
      lidAngle: m.lidAngle,
      armLeverGap: this.armLeverGap(),
      penetration: this.penetrationDepth(),
      activeContacts: [...this.activeContacts],
      timeScale: this.timeScale,
      paused: this.paused,
      fps: this.fps,
    };
  }

  // --- DOM ------------------------------------------------------------------

  private buildDom(): void {
    this.toggleBtn = el("button", "dbg-fab", "🐞 Debug") as HTMLButtonElement;
    this.toggleBtn.title = "Toggle debug menu (D)";
    this.toggleBtn.onclick = () => this.setOpen(true);
    document.body.appendChild(this.toggleBtn);

    this.root = el("div", "dbg-panel") as HTMLDivElement;
    this.root.style.display = "none";

    // Header.
    const header = el("div", "dbg-header");
    header.appendChild(el("span", "dbg-title", "Useless Machine · Debug"));
    const close = el("button", "dbg-x", "✕") as HTMLButtonElement;
    close.onclick = () => this.setOpen(false);
    header.appendChild(close);
    this.root.appendChild(header);

    // Playback row.
    const play = this.section("Playback");
    this.pauseBtn = btn("⏸ Pause", () => this.setPaused(!this.paused));
    play.appendChild(this.pauseBtn);
    play.appendChild(btn("⏭ Step", () => {
      this.setPaused(true);
      this.stepsQueued++;
    }));
    play.appendChild(btn("⟳ Reset", () => this.reset()));
    play.appendChild(btn("⚡ Flip switch", () => {
      this.setPaused(false);
      this.machine.activate();
    }));

    const scales = this.section("Speed");
    for (const s of TIME_SCALES) {
      const b = btn(`${s}×`, () => this.setTimeScale(s));
      this.scaleButtons.set(s, b);
      scales.appendChild(b);
    }

    // Keypoints.
    const keys = this.section("Keypoints");
    for (const kp of KEYPOINTS) {
      keys.appendChild(btn(kp.name, () => this.seek(kp.t)));
    }
    const scrubRow = el("div", "dbg-row");
    this.scrubber = document.createElement("input");
    this.scrubber.type = "range";
    this.scrubber.min = "0";
    this.scrubber.max = String(Math.max(...KEYPOINTS.map((k) => k.t)) + 0.4);
    this.scrubber.step = "0.02";
    this.scrubber.value = "0";
    this.scrubber.className = "dbg-scrub";
    this.scrubber.oninput = () => {
      const v = parseFloat(this.scrubber.value);
      this.scrubLabel.textContent = `${v.toFixed(2)}s`;
      this.seek(v);
    };
    this.scrubLabel = el("span", "dbg-scrub-label", "0.00s") as HTMLSpanElement;
    scrubRow.appendChild(this.scrubber);
    scrubRow.appendChild(this.scrubLabel);
    this.root.appendChild(scrubRow);

    // Toggles.
    const toggles = this.section("Overlay");
    this.collisionToggle = checkbox("Collision boxes", false, (on) => {
      this.showCollision = on;
      for (const w of this.wireframes) w.line.visible = on;
      this.syncOverlay();
      this.host.render();
    });
    this.pivotToggle = checkbox("Hinge pivots", false, (on) => {
      for (const m of this.pivotMarkers) m.visible = on;
      this.host.render();
    });
    this.contactToggle = checkbox("Contact points", false, (on) => {
      this.showContactPoints = on;
      this.syncContactMarkers();
      this.host.render();
    });
    toggles.appendChild(this.collisionToggle.parentElement!);
    toggles.appendChild(this.pivotToggle.parentElement!);
    toggles.appendChild(this.contactToggle.parentElement!);
    toggles.appendChild(
      checkbox("Flash on contact", true, (on) => {
        this.flashContacts = on;
      }).parentElement!,
    );

    // Telemetry.
    this.section("Telemetry");
    this.telemetryEl = el("pre", "dbg-telemetry", "") as HTMLPreElement;
    this.root.appendChild(this.telemetryEl);

    // Log.
    const logHeader = this.section("Event log");
    this.countsEl = el("span", "dbg-counts", "") as HTMLSpanElement;
    logHeader.appendChild(this.countsEl);
    logHeader.appendChild(btn("Clear", () => this.clearLog()));
    this.logEl = el("div", "dbg-log") as HTMLDivElement;
    this.root.appendChild(this.logEl);

    document.body.appendChild(this.root);

    window.addEventListener("keydown", this.keyHandler);

    this.setTimeScale(1);
    this.refreshCounts();
  }

  private section(label: string): HTMLDivElement {
    const row = el("div", "dbg-row") as HTMLDivElement;
    row.appendChild(el("span", "dbg-label", label));
    this.root.appendChild(row);
    return row;
  }

  private setOpen(open: boolean): void {
    this.root.style.display = open ? "block" : "none";
    this.toggleBtn.style.display = open ? "none" : "block";
  }

  private appendLogRow(entry: LogEntry): void {
    if (!this.logEl) return;
    const atBottom =
      this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 8;
    const row = el("div", `dbg-log-row dbg-${entry.level}`);
    row.textContent = `${entry.t.toFixed(2)}  ${entry.level.toUpperCase().padEnd(7)} ${entry.msg}`;
    this.logEl.appendChild(row);
    while (this.logEl.childElementCount > 200) this.logEl.firstChild!.remove();
    if (atBottom) this.logEl.scrollTop = this.logEl.scrollHeight;
    this.refreshCounts();
  }

  private refreshCounts(): void {
    if (!this.countsEl) return;
    this.countsEl.textContent = `⚠ ${this.warnCount}  ✖ ${this.errorCount}`;
    this.countsEl.classList.toggle("dbg-has-error", this.errorCount > 0);
    this.countsEl.classList.toggle("dbg-has-warn", this.errorCount === 0 && this.warnCount > 0);
  }

  private refreshHud(): void {
    if (this.root.style.display === "none") return;
    const t = this.telemetry();
    this.telemetryEl.textContent =
      `phase     ${t.phase}  (${t.phaseTime.toFixed(2)}s)\n` +
      `switch    ${t.switchOn ? "ON " : "OFF"}  ${t.switchAngle.toFixed(3)} rad\n` +
      `arm       ${t.armAngle.toFixed(3)} rad\n` +
      `lid       ${t.lidAngle.toFixed(3)} rad\n` +
      `arm↔lever ${t.armLeverGap >= 0 ? "gap " : "PEN "}${Math.abs(t.armLeverGap).toFixed(3)}\n` +
      `overlap   ${t.penetration.toFixed(3)} m${t.penetration > PASS_THROUGH_DEPTH ? "  ⚠ pass-through" : ""}\n` +
      `contacts  ${t.activeContacts.length ? t.activeContacts.join(", ") : "none"}\n` +
      `time      ${t.timeScale}×  ${t.paused ? "(paused)" : ""}\n` +
      `fps       ${t.fps.toFixed(0)}`;
  }

  // --- AI / automation API --------------------------------------------------

  private exposeApi(): void {
    const api: DebugApi = {
      ready: true,
      keypoints: KEYPOINTS.map((k) => k.name),
      // Telemetry + diagnostics.
      getState: () => this.telemetry(),
      getLog: () => this.log.map((e) => ({ ...e })),
      getWarnings: () => this.log.filter((e) => e.level === "warn").map((e) => ({ ...e })),
      getErrors: () => this.log.filter((e) => e.level === "error").map((e) => ({ ...e })),
      getContacts: () => [...this.activeContacts],
      getContactReport: () => this.contactReport(),
      getBodies: () =>
        this.parts.map((p) => {
          const { min, max } = this.bodyAabb(p.body);
          return {
            name: p.name,
            position: { x: p.body.position.x, y: p.body.position.y, z: p.body.position.z },
            aabb: {
              min: { x: min.x, y: min.y, z: min.z },
              max: { x: max.x, y: max.y, z: max.z },
            },
          };
        }),
      clearLog: () => this.clearLog(),
      // Playback.
      pause: () => this.setPaused(true),
      play: () => this.setPaused(false),
      step: (n = 1) => {
        this.setPaused(true);
        this.stepsQueued += Math.max(1, n);
      },
      setTimeScale: (x: number) => this.setTimeScale(x),
      seek: (seconds: number) => this.seek(seconds),
      seekPhase: (name: string) => {
        const kp = KEYPOINTS.find((k) => k.name === name);
        if (kp) this.seek(kp.t);
      },
      reset: () => this.reset(),
      activate: () => {
        this.setPaused(false);
        this.machine.activate();
      },
      // Overlay.
      setCollisionBoxes: (on: boolean) => {
        this.collisionToggle.checked = on;
        this.collisionToggle.dispatchEvent(new Event("change"));
      },
      setPivots: (on: boolean) => {
        this.pivotToggle.checked = on;
        this.pivotToggle.dispatchEvent(new Event("change"));
      },
      setContactPoints: (on: boolean) => {
        this.contactToggle.checked = on;
        this.contactToggle.dispatchEvent(new Event("change"));
      },
      open: () => this.setOpen(true),
      close: () => this.setOpen(false),
    };
    (window as unknown as { __uselessDebug: DebugApi }).__uselessDebug = api;
  }
}

// --- Small DOM + geometry helpers -------------------------------------------

function el(tag: string, className: string, text = ""): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function btn(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "dbg-btn";
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

function checkbox(
  label: string,
  checked: boolean,
  onChange: (on: boolean) => void,
): HTMLInputElement {
  const wrap = document.createElement("label");
  wrap.className = "dbg-check";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.onchange = () => onChange(input.checked);
  wrap.appendChild(input);
  wrap.appendChild(document.createTextNode(" " + label));
  return input;
}

/** Signed separation between two AABBs: +ve = gap, −ve = penetration depth. */
function aabbGap(
  a: { min: CANNON.Vec3; max: CANNON.Vec3 },
  b: { min: CANNON.Vec3; max: CANNON.Vec3 },
): number {
  const sx = Math.max(a.min.x - b.max.x, b.min.x - a.max.x);
  const sy = Math.max(a.min.y - b.max.y, b.min.y - a.max.y);
  const sz = Math.max(a.min.z - b.max.z, b.min.z - a.max.z);
  if (sx <= 0 && sy <= 0 && sz <= 0) return Math.max(sx, sy, sz); // overlapping
  return Math.hypot(Math.max(sx, 0), Math.max(sy, 0), Math.max(sz, 0));
}
