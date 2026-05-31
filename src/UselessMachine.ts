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

// Switch: mounted at the right lip of the opening so the arm can reach it
// straight up through the hole.
export const SWITCH_POS = new THREE.Vector3(0.6, TOP_Y, 0);
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
// Hidden: laid almost flat, pointing -X across the cavity (kept just shy of π so
// the arm-angle reading stays clear of the atan2 branch cut at ±π).
export const ARM_HIDDEN = 3.0;
// Out: swung up to near-vertical so the finger rises through the opening and
// taps the lever from its -X side, pushing it ON → OFF. The whole sweep stays
// within x ∈ [-0.5, 0.5] at deck level, so it never clips the frame.
export const ARM_OUT = 1.5;

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

export type State = "idle" | "opening" | "extending" | "retracting" | "closing";

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

  private state: State = "idle";
  private stateTime = 0;
  private lidAngleValue = 0;
  private isOn = false;
  private accumulator = 0;

  constructor() {
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
    this.armHinge.setMotorMaxForce(18);

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
      new THREE.BoxGeometry(0.09, LEVER_LEN, 0.16),
      new THREE.MeshStandardMaterial({ color: 0xcc2222, roughness: 0.4, metalness: 0.1 }),
    );
    lever.castShadow = true;
    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 20, 16),
      new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.3 }),
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
    body.addShape(new CANNON.Box(new CANNON.Vec3(ARM_HALF, 0.04, 0.065)));
    body.addShape(
      new CANNON.Box(new CANNON.Vec3(0.06, 0.1, 0.08)),
      new CANNON.Vec3(ARM_HALF - 0.05, 0, 0),
    );
    body.angularDamping = 0.4;
    this.world.addBody(body);

    const mat = new THREE.MeshStandardMaterial({ color: 0xcfd2d6, roughness: 0.35, metalness: 0.6 });
    const group = new THREE.Group();
    const bar = new THREE.Mesh(new THREE.BoxGeometry(ARM_LEN, 0.08, 0.13), mat);
    const finger = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 0.16), mat);
    finger.position.set(ARM_HALF - 0.05, 0, 0);
    bar.castShadow = true;
    finger.castShadow = true;
    group.add(bar, finger);
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
    return this.state !== "idle";
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

  /** Current state-machine phase. */
  get phase(): State {
    return this.state;
  }
  /** Seconds spent in the current phase. */
  get phaseTime(): number {
    return this.stateTime;
  }
  /** Whether the user has flipped it ON and the routine hasn't finished. */
  get isOnState(): boolean {
    return this.isOn;
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

  activate(): void {
    if (this.isBusy || this.isOn) return;
    this.isOn = true;
    this.setLever(SWITCH_ON);
    this.state = "opening";
    this.stateTime = 0;
  }

  /** Drive the arm motor toward a target hinge angle (simple P controller). */
  private driveArm(target: number): void {
    // Motor speed is about the hinge axis; with base as body A the sign is
    // inverted relative to our angle convention, hence the leading minus.
    const err = target - this.armAngle;
    const speed = Math.max(-4, Math.min(4, -err * 8));
    this.armHinge.setMotorSpeed(speed);
  }

  /** Bistable detent: torque that snaps the lever to whichever side it's on. */
  private detentLever(): void {
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
    this.runState(dt);

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

  private runState(dt: number): void {
    this.stateTime += dt;
    switch (this.state) {
      case "idle":
        this.driveArm(ARM_HIDDEN);
        break;
      case "opening":
        this.lidAngleValue = Math.min(LID_OPEN, this.lidAngleValue + dt * 6);
        this.driveArm(ARM_HIDDEN);
        if (this.lidAngleValue >= LID_OPEN) this.go("extending");
        break;
      case "extending":
        this.driveArm(ARM_OUT);
        // Keep pushing until the lever is actually knocked past centre (switch
        // angle goes negative → the detent will carry it the rest of the way to
        // OFF), not merely until the arm reaches a fixed angle — otherwise it
        // can retract after a glancing tap and the lever springs back ON.
        if (this.switchAngle < 0 || this.stateTime > 1.6) this.go("retracting");
        break;
      case "retracting":
        this.driveArm(ARM_HIDDEN);
        // Wrap-safe shortest-angle distance: ARM_HIDDEN sits near the atan2 cut
        // at ±π, so a raw subtraction would miss if the motor overshoots past π.
        if (angleClose(this.armAngle, ARM_HIDDEN, 0.2) || this.stateTime > 1.6) this.go("closing");
        break;
      case "closing":
        this.lidAngleValue = Math.max(0, this.lidAngleValue - dt * 6);
        this.driveArm(ARM_HIDDEN);
        if (this.lidAngleValue <= 0) {
          this.go("idle");
          // Stay truthful: only the timeout path can reach here with the lever
          // still ON (a failed knock); don't claim OFF when it isn't.
          this.isOn = this.switchAngle >= 0;
        }
        break;
    }
  }

  private go(state: State): void {
    this.state = state;
    this.stateTime = 0;
  }
}
