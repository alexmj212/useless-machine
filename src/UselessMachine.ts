import * as THREE from "three";
import * as CANNON from "cannon-es";

// ----------------------------------------------------------------------------
// A physically simulated useless machine.
//
// Instead of keyframing exact contact angles, the parts are rigid bodies:
//  - a static base (walls + the top frame around the lid opening),
//  - a dynamic toggle lever on a hinge, made BISTABLE by a restoring torque so
//    it snaps to ON or OFF,
//  - a dynamic arm on a hinge, driven by a motor to sweep out and back.
// The arm KNOCKS the lever by colliding with it — the flip is a consequence of
// the collision, not a scripted animation, so nothing can interpenetrate.
//
// The world runs without gravity: this is a tabletop mechanism, and the motor +
// bistable detent define every resting state, so gravity would only add noise.
// ----------------------------------------------------------------------------

const Z_AXIS = new CANNON.Vec3(0, 0, 1);

// Box shell.
const TOP_Y = 1.2;
const OPEN_X_MIN = -0.5;
const OPEN_X_MAX = 0.5;
const OPEN_Z_HALF = 0.5;

// Switch: mounted well to the +X side of the opening, clear of the lid. When ON
// it leans -X, but stays right of the opening edge (x > 0.5) so the lid panel —
// which sweeps up out of the hole — never passes through it. The arm reaches it
// with an extended knocker that juts out over the deck (see below).
export const SWITCH_POS = new THREE.Vector3(0.9, TOP_Y, 0);
const LEVER_LEN = 0.5;
const LEVER_HALF = LEVER_LEN / 2;
export const SWITCH_ON = 0.5; // lever tilt (rad): +ve leans -X, over the opening
export const SWITCH_OFF = -0.5; // -ve leans +X, onto the deck

// Arm: pivots low in the box, beneath the right edge of the opening, so a SHORT
// upward sweep clears the hole cleanly. The pivot must sit near the floor — a
// mid-height pivot makes the arm's circular path dip below the box floor and
// punch up through the solid deck instead of emerging through the opening.
export const ARM_PIVOT = new THREE.Vector3(0.45, 0.3, 0);
const ARM_LEN = 1.05;
const ARM_HALF = ARM_LEN / 2;
// The knocker is an L: a head that juts off the shaft tip toward the shaft's
// local -Y. At ARM_OUT the shaft is vertical (local -Y points world +X), so the
// head reaches sideways over the deck to the switch — the shaft can stay inside
// the opening while the head pokes the lever, which sits past the opening edge.
const KNOCKER_LEN = 0.5;
const KNOCKER_HALF = KNOCKER_LEN / 2;
// Hidden: laid almost flat, pointing -X across the cavity (kept just shy of π so
// the arm-angle reading stays clear of the atan2 branch cut at ±π).
export const ARM_HIDDEN = 3.0;
// Out: shaft swung to vertical (π/2) so it rises straight through the opening at
// x = ARM_PIVOT.x (inside the hole, never clipping the frame) while the knocker
// head reaches +X to tap the lever from its -X side, pushing it ON → OFF.
export const ARM_OUT = Math.PI / 2;

export const LID_OPEN = 1.95;

/** A rendered group kept in sync with a physics body each frame. */
interface Linked {
  mesh: THREE.Object3D;
  body: CANNON.Body;
}

// Angle of the body's local +X axis in the XY plane (single-valued in our
// range — avoids the quaternion double-cover that 2*atan2(z,w) suffers).
const _basisX = new CANNON.Vec3(1, 0, 0);
const _basisY = new CANNON.Vec3(0, 1, 0);
const _x = new CANNON.Vec3();
const _y = new CANNON.Vec3();
const armAngleOf = (q: CANNON.Quaternion): number => {
  q.vmult(_basisX, _x);
  return Math.atan2(_x.y, _x.x);
};
// Lever tilt from its local +Y axis (0 = upright, +ve leans -X).
const leverAngleOf = (q: CANNON.Quaternion): number => {
  q.vmult(_basisY, _y);
  return Math.atan2(-_y.x, _y.y);
};
// Are two angles within `tol` of each other, measured the short way around the
// circle (so a value just past +π and one just past −π count as adjacent)?
const angleClose = (a: number, b: number, tol: number): boolean =>
  Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < tol;

export const FIXED_DT = 1 / 120; // physics timestep

// The arm's choreography is a queue of segments; each carries a phase label so
// the debug overlay and contact checks keep working. "extending" is always the
// real collision knock; the rest are dressing for the gags.
export type State =
  | "idle"
  | "flipping"
  | "opening"
  | "peeking" // arm pokes out / feints before committing
  | "extending" // the real knock — drives into the lever until it flips
  | "flourish" // extra jabs (multi-tap)
  | "retracting"
  | "taunting" // wiggle / linger after the knock
  | "closing"
  | "doubletake" // the freeze-and-look reaction to a re-press
  | "ignoring"; // lid peeks and shuts with no arm (the tease)

/** The personality the arm picks for a single response. */
export type BehaviorName =
  | "normal"
  | "peek"
  | "feint"
  | "creep"
  | "pop"
  | "slam"
  | "multitap"
  | "wiggle"
  | "linger"
  | "ignore"
  | "doubletake";

// How long the user's click-flip (OFF → ON) takes to animate. Short and snappy —
// a real toggle flicks over, it doesn't glide.
const FLIP_TIME = 0.1;

// Motion rates. ARM_SPEED / LID_SPEED are the baseline; gags scale them.
const ARM_SPEED = 4; // motor speed clamp (rad/s)
const LID_SPEED = 6; // lid open/close rate (rad/s)
const PEEK_ANGLE = 2.1; // arm pokes just out of the hole, short of the switch
const FEINT_ANGLE = 1.9; // a little further, then it retreats — the fake-out
const REACT_COCK = 2.3; // recoil pose for the double-take — clear of the switch
const REACT_LOOK = 0.55; // how long it "looks" at you before swatting (a long beat)
const LID_PEEK = 0.9; // partial lid lift for the "ignore" tease

// --- Hidden "revenge" meter ------------------------------------------------
// Flipping the switch winds the machine up; the more you provoke it (especially
// re-flipping before the arm is home) the likelier — and nastier — the next gag.
// It bleeds off over time and whenever a gag is spent. 0 = perfectly composed.
const REVENGE_FLIP = 0.2; // a calm flip nudges it (one flip alone stays composed)
const REVENGE_REFLIP = 0.4; // a flip while the arm is still out really provokes it
const REVENGE_DECAY = 0.03; // per second, slowly drifting back toward composure
const REVENGE_GAG_FLOOR = 0.2; // at/below this it always plays it straight
const REVENGE_SPEND = 0.4; // a fired gag vents this much pressure
const REVENGE_TIER_2 = 0.45; // unlocks feint / multi-tap
const REVENGE_TIER_3 = 0.6; // unlocks the slam (and an angrier re-press swat)

/** One step of the arm/lid choreography. `step` returns true when it's done. */
interface Segment {
  phase: State;
  step: (dt: number) => boolean;
}

/** A physics body paired with a human-readable name, for debug overlays. */
export interface DebugPart {
  name: string;
  body: CANNON.Body;
}

/** A hinge axis location, for drawing pivot markers in the debug overlay. */
export interface DebugPivot {
  name: string;
  position: THREE.Vector3;
}

export class UselessMachine {
  readonly root = new THREE.Group();
  readonly interactive: THREE.Object3D[] = [];
  readonly world = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, 0) });

  private readonly base: CANNON.Body;
  private readonly lever: CANNON.Body;
  private readonly arm: CANNON.Body;
  private readonly armHinge: CANNON.HingeConstraint;
  private readonly lidPivot = new THREE.Group();
  private readonly links: Linked[] = [];

  private lidAngleValue = 0;
  private accumulator = 0;

  // Arm/lid choreography: a queue of segments processed front-to-back.
  private queue: Segment[] = [];
  private stateTime = 0; // seconds in the current segment
  private behavior: BehaviorName = "normal"; // what the current response is

  // The user's flip animates independently of the arm, so a re-press can land
  // mid-routine and overlap the arm's reaction.
  private userFlipping = false;
  private userFlipT = 0;
  private userFlipFrom = SWITCH_OFF;

  private revenge = 0;
  private justIgnored = false; // don't play the "ignore" tease twice in a row
  private readonly rng: () => number;

  constructor(opts: { rng?: () => number } = {}) {
    this.rng = opts.rng ?? Math.random;
    this.world.broadphase = new CANNON.NaiveBroadphase();
    const solver = new CANNON.GSSolver();
    solver.iterations = 30;
    this.world.solver = solver;

    this.base = new CANNON.Body({ type: CANNON.Body.STATIC });
    this.buildBody();
    this.world.addBody(this.base);

    this.lever = this.buildLever();
    this.arm = this.buildArm();
    this.armHinge = this.hinge(this.arm, ARM_PIVOT, new CANNON.Vec3(-ARM_HALF, 0, 0));
    this.armHinge.enableMotor();
    // Enough force to honour the faster gag speeds (slam/pop); the per-call
    // speed clamp in driveArm is what actually shapes each motion.
    this.armHinge.setMotorMaxForce(26);

    this.buildLid();
    this.setLever(SWITCH_OFF);
    this.setArm(ARM_HIDDEN);
  }

  // --- Construction --------------------------------------------------------

  private addStaticBox(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
  ): void {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    this.base.addShape(
      new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)),
      new CANNON.Vec3(x, y, z),
    );
  }

  private buildBody(): void {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x7a5230,
      roughness: 0.75,
      metalness: 0.05,
    });
    // Bottom + four walls.
    this.addStaticBox(3, 0.1, 2, 0, 0.05, 0, mat);
    this.addStaticBox(0.1, 1.2, 2, 1.45, 0.6, 0, mat);
    this.addStaticBox(0.1, 1.2, 2, -1.45, 0.6, 0, mat);
    this.addStaticBox(3, 1.2, 0.1, 0, 0.6, 0.95, mat);
    this.addStaticBox(3, 1.2, 0.1, 0, 0.6, -0.95, mat);

    // Top frame leaving the opening.
    const topY = 1.175;
    const leftW = OPEN_X_MIN + 1.5;
    this.addStaticBox(leftW, 0.05, 2, -1.5 + leftW / 2, topY, 0, mat);
    const rightW = 1.5 - OPEN_X_MAX;
    this.addStaticBox(rightW, 0.05, 2, 1.5 - rightW / 2, topY, 0, mat);
    const openW = OPEN_X_MAX - OPEN_X_MIN;
    const openCx = (OPEN_X_MIN + OPEN_X_MAX) / 2;
    const sideD = 1.0 - OPEN_Z_HALF;
    this.addStaticBox(openW, 0.05, sideD, openCx, topY, OPEN_Z_HALF + sideD / 2, mat);
    this.addStaticBox(openW, 0.05, sideD, openCx, topY, -(OPEN_Z_HALF + sideD / 2), mat);

    // Dark cavity floor (visual only).
    const liner = new THREE.Mesh(
      new THREE.BoxGeometry(2.7, 0.04, 1.7),
      new THREE.MeshStandardMaterial({ color: 0x101012, roughness: 1 }),
    );
    liner.position.set(0, 0.12, 0);
    liner.receiveShadow = true;
    this.root.add(liner);
  }

  private buildLever(): CANNON.Body {
    // Mount plate (visual only).
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(0.32, 0.06, 0.34),
      new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.5, metalness: 0.3 }),
    );
    plate.position.set(SWITCH_POS.x, 1.22, 0);
    plate.castShadow = true;
    this.root.add(plate);
    this.interactive.push(plate);

    // The lever body, hinged at its base (SWITCH_POS).
    const body = new CANNON.Body({ mass: 0.3 });
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.05, LEVER_HALF, 0.08)));
    body.angularDamping = 0.6;
    this.world.addBody(body);
    this.hinge(body, SWITCH_POS, new CANNON.Vec3(0, -LEVER_HALF, 0));

    const group = new THREE.Group();
    const lever = new THREE.Mesh(
      // A cylindrical toggle rod (axis along local +Y, matching the lever body).
      // The radius matches the collision box's half-width in the contact
      // direction, so the visible rod and the physics shape line up where it
      // counts. Slightly tapered, wider at the base, like a real toggle.
      new THREE.CylinderGeometry(0.045, 0.055, LEVER_LEN, 24),
      // Brushed silver. metalness is kept moderate (like the arm) so the light
      // base colour reads as silver — at near-1.0 metalness with no environment
      // map a metal goes near-black except for direct highlights.
      new THREE.MeshStandardMaterial({ color: 0xccd0d6, roughness: 0.35, metalness: 0.6 }),
    );
    lever.castShadow = true;
    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 20, 16),
      // Polished silver ball-top — a touch shinier than the shaft.
      new THREE.MeshStandardMaterial({ color: 0xdee1e5, roughness: 0.2, metalness: 0.7 }),
    );
    knob.position.set(0, LEVER_HALF, 0);
    knob.castShadow = true;
    group.add(lever, knob);
    this.root.add(group);
    this.interactive.push(lever, knob);
    this.links.push({ mesh: group, body });
    return body;
  }

  private buildArm(): CANNON.Body {
    const body = new CANNON.Body({ mass: 1 });
    // Shape 0: the shaft, along local +X.
    body.addShape(new CANNON.Box(new CANNON.Vec3(ARM_HALF, 0.04, 0.065)));
    // Shape 1: the knocker head, hanging off the shaft tip in local -Y so it
    // reaches sideways to the switch when the shaft is vertical. (The debug
    // overlay treats shape index 1 as the contacting "finger".)
    body.addShape(
      new CANNON.Box(new CANNON.Vec3(0.05, KNOCKER_HALF, 0.08)),
      new CANNON.Vec3(ARM_HALF, -KNOCKER_HALF, 0),
    );
    body.angularDamping = 0.4;
    this.world.addBody(body);

    const mat = new THREE.MeshStandardMaterial({ color: 0xcfd2d6, roughness: 0.35, metalness: 0.6 });
    const group = new THREE.Group();
    const bar = new THREE.Mesh(new THREE.BoxGeometry(ARM_LEN, 0.08, 0.13), mat);
    const knocker = new THREE.Mesh(new THREE.BoxGeometry(0.1, KNOCKER_LEN, 0.16), mat);
    knocker.position.set(ARM_HALF, -KNOCKER_HALF, 0);
    bar.castShadow = true;
    knocker.castShadow = true;
    group.add(bar, knocker);
    this.root.add(group);
    this.links.push({ mesh: group, body });
    return body;
  }

  private buildLid(): void {
    this.lidPivot.position.set(OPEN_X_MIN, 1.205, 0);
    const openW = OPEN_X_MAX - OPEN_X_MIN;
    const lid = new THREE.Mesh(
      new THREE.BoxGeometry(openW, 0.05, OPEN_Z_HALF * 2 + 0.04),
      new THREE.MeshStandardMaterial({ color: 0x8a6038, roughness: 0.7, metalness: 0.05 }),
    );
    lid.position.set(openW / 2, 0, 0);
    lid.castShadow = true;
    lid.receiveShadow = true;
    this.lidPivot.add(lid);
    this.root.add(this.lidPivot);
  }

  private hinge(body: CANNON.Body, pivotWorld: THREE.Vector3, pivotLocal: CANNON.Vec3): CANNON.HingeConstraint {
    const hc = new CANNON.HingeConstraint(this.base, body, {
      pivotA: new CANNON.Vec3(pivotWorld.x, pivotWorld.y, pivotWorld.z),
      axisA: Z_AXIS,
      pivotB: pivotLocal,
      axisB: Z_AXIS,
      collideConnected: false,
    });
    this.world.addConstraint(hc);
    return hc;
  }

  /** Place the lever body at a tilt angle about its hinge. */
  private setLever(angle: number): void {
    const q = new CANNON.Quaternion().setFromAxisAngle(Z_AXIS, angle);
    this.lever.quaternion.copy(q);
    const dir = new CANNON.Vec3(-Math.sin(angle), Math.cos(angle), 0);
    this.lever.position.set(
      SWITCH_POS.x + dir.x * LEVER_HALF,
      SWITCH_POS.y + dir.y * LEVER_HALF,
      0,
    );
    this.lever.velocity.setZero();
    this.lever.angularVelocity.setZero();
  }

  /** Place the arm body at a sweep angle about its hinge. */
  private setArm(angle: number): void {
    const q = new CANNON.Quaternion().setFromAxisAngle(Z_AXIS, angle);
    this.arm.quaternion.copy(q);
    const dir = new CANNON.Vec3(Math.cos(angle), Math.sin(angle), 0);
    this.arm.position.set(
      ARM_PIVOT.x + dir.x * ARM_HALF,
      ARM_PIVOT.y + dir.y * ARM_HALF,
      0,
    );
    this.arm.velocity.setZero();
    this.arm.angularVelocity.setZero();
  }

  // --- State queries -------------------------------------------------------

  get isBusy(): boolean {
    return this.queue.length > 0 || this.userFlipping;
  }
  get switchAngle(): number {
    return leverAngleOf(this.lever.quaternion);
  }
  get armAngle(): number {
    return armAngleOf(this.arm.quaternion);
  }
  get lidAngle(): number {
    return this.lidAngleValue;
  }

  // --- Debug introspection (read-only; does not affect the simulation) ------

  /** Current state-machine phase (the front segment, or idle/flipping). */
  get phase(): State {
    if (this.queue.length > 0) return this.queue[0].phase;
    return this.userFlipping ? "flipping" : "idle";
  }
  /** Seconds spent in the current phase. */
  get phaseTime(): number {
    return this.stateTime;
  }
  /** Whether the lever is currently ON. */
  get isOnState(): boolean {
    return this.switchAngle > 0;
  }
  /** Hidden revenge meter (0 = composed, 1 = livid). Exposed for the debug HUD. */
  get revengeLevel(): number {
    return this.revenge;
  }
  /** The personality driving the current response. */
  get currentBehavior(): BehaviorName {
    return this.behavior;
  }
  /** Labeled physics bodies so a debug overlay can draw their collision shapes. */
  get debugParts(): DebugPart[] {
    return [
      { name: "base", body: this.base },
      { name: "lever", body: this.lever },
      { name: "arm", body: this.arm },
    ];
  }
  /** Hinge pivot locations (world space) for pivot markers. */
  get debugPivots(): DebugPivot[] {
    return [
      { name: "arm-hinge", position: ARM_PIVOT.clone() },
      { name: "lever-hinge", position: SWITCH_POS.clone() },
    ];
  }

  // --- Simulation ----------------------------------------------------------

  /**
   * The user flips the switch ON. A click only means "turn it ON", so it's
   * ignored while the lever is already ON or mid-flip. Crucially this works
   * mid-routine: flip it back ON while the arm is still out and the arm reacts
   * (a double-take, then another swat), and the revenge meter climbs faster.
   */
  activate(): void {
    if (this.userFlipping || this.switchAngle > 0.05) return;
    const interrupting = this.queue.length > 0; // the arm is still dealing with us
    this.beginUserFlip();
    this.revenge = Math.min(1, this.revenge + (interrupting ? REVENGE_REFLIP : REVENGE_FLIP));
    if (interrupting) this.injectReaction();
  }

  private beginUserFlip(): void {
    this.userFlipping = true;
    this.userFlipT = 0;
    this.userFlipFrom = this.switchAngle;
  }

  /**
   * Debug only: force a specific behavior on demand, bypassing the revenge roll.
   * Flips the lever ON if needed (so the knock has something to hit) and replaces
   * whatever the arm was doing. Used by the debug menu's per-variation buttons.
   */
  debugPlay(b: BehaviorName): void {
    if (this.switchAngle < 0 && !this.userFlipping) this.beginUserFlip();
    this.behavior = b;
    this.justIgnored = false;
    this.stateTime = 0;
    this.queue = b === "doubletake" ? this.buildReaction("doubletake") : this.buildResponse(b);
  }

  /** Kinematically sweep the lever toward ON (smoothstep) while a flip is live. */
  private stepUserFlip(dt: number): void {
    if (!this.userFlipping) return;
    this.userFlipT += dt;
    const t = Math.min(1, this.userFlipT / FLIP_TIME);
    const s = t * t * (3 - 2 * t);
    this.setLever(this.userFlipFrom + (SWITCH_ON - this.userFlipFrom) * s);
    if (t >= 1) this.userFlipping = false;
  }

  /** Drive the arm motor toward a target hinge angle (simple P controller). */
  private driveArm(target: number, maxSpeed = ARM_SPEED): void {
    // Motor speed is about the hinge axis; with base as body A the sign is
    // inverted relative to our angle convention, hence the leading minus.
    const err = target - this.armAngle;
    const speed = Math.max(-maxSpeed, Math.min(maxSpeed, -err * 8));
    this.armHinge.setMotorSpeed(speed);
  }

  /** Bistable detent: torque that snaps the lever to whichever side it's on. */
  private detentLever(): void {
    // While the click-flip animates, the lever is driven kinematically; the
    // detent would pull it back toward OFF until it crosses centre, so hold off.
    if (this.userFlipping) return;
    const a = this.switchAngle;
    const target = a >= 0 ? SWITCH_ON : SWITCH_OFF;
    const torque = -6 * (a - target) - 0.5 * this.lever.angularVelocity.z;
    this.lever.torque.z += torque;
  }

  /** Hard end-stops at ON / OFF so the lever can't fling past its travel. */
  private clampLever(): void {
    const a = this.switchAngle;
    if (a > SWITCH_ON) this.setLever(SWITCH_ON);
    else if (a < SWITCH_OFF) this.setLever(SWITCH_OFF);
  }

  update(dt: number): void {
    dt = Math.min(dt, 1 / 30);
    if (this.revenge > 0) this.revenge = Math.max(0, this.revenge - REVENGE_DECAY * dt);
    this.stepUserFlip(dt);
    this.runQueue(dt);

    // Fixed-timestep loop, hand-rolled rather than world.step's accumulator
    // overload (which consults performance.now() and can drop sub-steps —
    // nondeterministic). The detent torque is re-applied each step because
    // cannon-es clears body.torque after integrating.
    this.accumulator = Math.min(this.accumulator + dt, FIXED_DT * 8);
    while (this.accumulator >= FIXED_DT) {
      this.detentLever();
      this.world.step(FIXED_DT);
      this.clampLever();
      this.accumulator -= FIXED_DT;
    }

    // CANNON Vec3/Quaternion are structurally {x,y,z[,w]} so THREE's copy()
    // reads them directly.
    for (const { mesh, body } of this.links) {
      mesh.position.copy(body.position as unknown as THREE.Vector3);
      mesh.quaternion.copy(body.quaternion as unknown as THREE.Quaternion);
    }
    this.lidPivot.rotation.z = this.lidAngleValue;
  }

  // --- Choreography controller ---------------------------------------------

  /** Advance the segment queue, kicking off a fresh response when the arm is
   *  free and the lever is sitting ON (a flip, or the ON left over by a tease). */
  private runQueue(dt: number): void {
    if (this.queue.length === 0 && !this.userFlipping && this.switchAngle > 0) {
      this.startResponse();
    }
    if (this.queue.length === 0) {
      this.driveArm(ARM_HIDDEN);
      this.stateTime = 0;
      return;
    }
    this.stateTime += dt;
    if (this.queue[0].step(dt)) {
      this.queue.shift();
      this.stateTime = 0;
    }
  }

  private startResponse(): void {
    const b = this.chooseBehavior();
    this.behavior = b;
    if (b !== "normal") this.revenge = Math.max(0, this.revenge - REVENGE_SPEND);
    this.justIgnored = b === "ignore";
    this.queue = this.buildResponse(b);
  }

  /** Roll the revenge meter to decide whether this response is a gag, and which.
   *  Below the floor it always plays it straight; higher revenge unlocks the
   *  nastier gags and weights toward them. */
  private chooseBehavior(): BehaviorName {
    const chance = (this.revenge - REVENGE_GAG_FLOOR) / (1 - REVENGE_GAG_FLOOR);
    if (chance <= 0 || this.rng() >= chance) return "normal";
    const pool: BehaviorName[] = ["peek", "creep", "pop", "wiggle", "linger"];
    if (!this.justIgnored) pool.push("ignore");
    if (this.revenge > REVENGE_TIER_2) pool.push("feint", "multitap");
    if (this.revenge > REVENGE_TIER_3) pool.push("slam", "slam", "multitap"); // weight the nasty ones
    return pool[Math.floor(this.rng() * pool.length)];
  }

  /** Assemble the segment list for a behavior. */
  private buildResponse(b: BehaviorName): Segment[] {
    if (b === "ignore") return this.ignoreSegments();

    const lidSpeed = b === "pop" ? LID_SPEED * 1.7 : LID_SPEED;
    const q: Segment[] = [this.segLid(LID_OPEN, lidSpeed, "opening")];

    // Rise flourishes before the knock.
    if (b === "peek") {
      q.push(this.segArm(PEEK_ANGLE, ARM_SPEED, "peeking"));
      q.push(this.segWait(0.4, "peeking", PEEK_ANGLE));
    } else if (b === "feint") {
      q.push(this.segArm(FEINT_ANGLE, ARM_SPEED * 1.3, "peeking"));
      q.push(this.segArm(ARM_HIDDEN, ARM_SPEED * 1.3, "peeking")); // retreat — the fake-out
      q.push(this.segWait(0.3, "peeking", ARM_HIDDEN));
    }

    q.push(...this.knockAndExit(b));
    return q;
  }

  /** The knock and everything after it (flourish, exit, retract, close) — shared
   *  by fresh responses and by the re-press reaction. */
  private knockAndExit(b: BehaviorName): Segment[] {
    const armSpeed = b === "creep" ? ARM_SPEED * 0.45 : b === "pop" ? ARM_SPEED * 1.6 : ARM_SPEED;
    const knockSpeed =
      b === "slam" ? ARM_SPEED * 1.6 : b === "doubletake" ? ARM_SPEED * 1.3 : armSpeed;
    const closeSpeed = b === "slam" ? LID_SPEED * 2.4 : b === "pop" ? LID_SPEED * 1.7 : LID_SPEED;

    const q: Segment[] = [this.segArm(ARM_OUT, knockSpeed, "extending", true)];

    if (b === "multitap") {
      q.push(this.segMultiTap(13, 1.0, "flourish")); // a frantic machine-gun burst
    }

    if (b === "wiggle") {
      q.push(this.segWiggle(1.9, 0.28, 2.5, 0.7, ARM_SPEED * 1.5, "taunting")); // taunting waggle
    } else if (b === "linger") {
      q.push(this.segWait(0.6, "taunting", ARM_OUT)); // hangs out, "looking at you"
    }

    q.push(this.segArm(ARM_HIDDEN, armSpeed, "retracting"));
    q.push(this.segLid(0, closeSpeed, "closing"));
    return q;
  }

  /** The tease: crack the lid and just... hold it there a good while, as if
   *  peering out and finding nothing. Then shut it (you think it gave up) — and
   *  immediately snap it open and flip the switch off, fast. */
  private ignoreSegments(): Segment[] {
    const fast = LID_SPEED * 2.4;
    return [
      this.segLid(LID_PEEK, LID_SPEED, "ignoring"), // crack open...
      this.segWait(0.8, "ignoring", ARM_HIDDEN), // ...and linger, pretending not to notice
      this.segLid(0, fast, "ignoring"), // ...shut again (you think it's done)
      this.segLid(LID_OPEN, fast, "opening"), // gotcha — throw it open
      ...this.knockAndExit("pop"), // and snap it off, fast
    ];
  }

  /** Re-press reaction: recoil clear of the switch (so your flip-up actually
   *  lands instead of bonking the arm), hold a long beat to "look", then swat
   *  it again. The swat flavor is re-rolled from the *current* revenge every
   *  re-press, so spamming it visibly escalates (plain → multi-tap → slam).
   *  Replaces the rest of the queue. */
  private injectReaction(): void {
    const flavor = this.rollReactionFlavor();
    this.behavior = flavor;
    this.justIgnored = false;
    // NB: a re-press only *adds* revenge (REVENGE_REFLIP) — unlike a rolled gag
    // it never spends any. Impatient re-pressing is meant to wind it right up.
    this.stateTime = 0; // the reaction replaces a mid-flight segment — restart the clock
    this.queue = this.buildReaction(flavor);
  }

  /** The double-take reaction: reopen the lid (no-op if already open — guards a
   *  re-press during "closing"), recoil clear of the lever so your flip lands,
   *  hold the long "look", then swat in the given flavor. */
  private buildReaction(flavor: BehaviorName): Segment[] {
    return [
      this.segLid(LID_OPEN, LID_SPEED * 1.5, "opening"),
      this.segArm(REACT_COCK, ARM_SPEED * 1.5, "doubletake"), // recoil, clearing the lever
      this.segWait(REACT_LOOK, "doubletake", REACT_COCK), // the long "look"
      ...this.knockAndExit(flavor),
    ];
  }

  /** Pick the swat flavor for a re-press, escalating with revenge. Always at
   *  least a plain double-take; the nastier flavors unlock as it winds up. */
  private rollReactionFlavor(): BehaviorName {
    const pool: BehaviorName[] = ["doubletake"];
    if (this.revenge > REVENGE_TIER_2) pool.push("multitap", "wiggle");
    if (this.revenge > REVENGE_TIER_3) pool.push("slam", "slam", "multitap");
    return pool[Math.floor(this.rng() * pool.length)];
  }

  // --- Segment factories ----------------------------------------------------

  /** Drive the lid toward an angle at `speed`; done on arrival. Arm held home. */
  private segLid(target: number, speed: number, phase: State): Segment {
    return {
      phase,
      step: (dt) => {
        this.driveArm(ARM_HIDDEN);
        const d = target - this.lidAngleValue;
        const move = speed * dt;
        if (Math.abs(d) <= move) {
          this.lidAngleValue = target;
          return true;
        }
        this.lidAngleValue += Math.sign(d) * move;
        return false;
      },
    };
  }

  /** Drive the arm toward `target`; done on arrival, on a knock (untilFlip), or
   *  after a safety timeout so a botched knock can never wedge the queue. */
  private segArm(target: number, speed: number, phase: State, untilFlip = false): Segment {
    return {
      phase,
      step: () => {
        this.driveArm(target, speed);
        if (untilFlip && this.switchAngle < 0) return true;
        if (angleClose(this.armAngle, target, 0.12)) return true;
        if (this.stateTime > 2) {
          // The knock somehow never landed (physics regression / wedge). Give up
          // gracefully — force the lever OFF — rather than re-firing forever.
          if (untilFlip && this.switchAngle > 0) this.setLever(SWITCH_OFF);
          return true;
        }
        return false;
      },
    };
  }

  /** Hold the arm at `armHold` for `duration` seconds. */
  private segWait(duration: number, phase: State, armHold: number): Segment {
    return {
      phase,
      step: () => {
        this.driveArm(armHold);
        return this.stateTime >= duration;
      },
    };
  }

  /** Oscillate the arm around `base` for a taunting waggle. */
  private segWiggle(
    base: number,
    amp: number,
    cycles: number,
    duration: number,
    maxSpeed: number,
    phase: State,
  ): Segment {
    return {
      phase,
      step: () => {
        const t = Math.min(1, this.stateTime / duration);
        this.driveArm(base + amp * Math.sin(2 * Math.PI * cycles * t), maxSpeed);
        return this.stateTime >= duration;
      },
    };
  }

  /** A frantic machine-gun burst: snap the arm between the strike pose and a
   *  small lift `jabs` times in `duration`, well above the deck so it never
   *  clips the frame (the lever has already snapped clear). */
  private segMultiTap(jabs: number, duration: number, phase: State): Segment {
    const half = duration / (jabs * 2); // each jab is a strike + a lift
    return {
      phase,
      step: () => {
        const i = Math.floor(this.stateTime / half);
        this.driveArm(i % 2 === 0 ? ARM_OUT : ARM_OUT + 0.2, ARM_SPEED * 5);
        return this.stateTime >= duration;
      },
    };
  }
}
