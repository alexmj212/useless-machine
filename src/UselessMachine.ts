import * as THREE from "three";

// ----------------------------------------------------------------------------
// Geometry
//
// Classic useless-machine layout: the toggle sits on the solid box top to the
// RIGHT, with a hinged lid/opening to its LEFT. The arm pivots inside the box,
// off to the side, sweeps up out of the opening and travels AIRBORNE (above the
// top surface) over to the switch, then presses it from ON to OFF.
//
// Because the arm exits through the hole and is above the top by the time it
// reaches the switch, its body never clips the solid deck between them. The
// reach is off-axis, so contact slides along the lever rather than tracking the
// tip exactly — natural for a "shove it over" motion.
// ----------------------------------------------------------------------------

const SWITCH_POS = new THREE.Vector3(0.78, 1.2, 0);
const LEVER_LEN = 0.34;
const SWITCH_ON = 0.5; // lever tilt (rad) when ON — leans -X, toward the arm
const SWITCH_OFF = -0.5; // lever tilt when OFF — leans +X, away from the arm

/** World position of the lever tip for a given tilt angle. */
const leverTip = (angle: number): THREE.Vector3 =>
  new THREE.Vector3(
    SWITCH_POS.x - LEVER_LEN * Math.sin(angle),
    SWITCH_POS.y + LEVER_LEN * Math.cos(angle),
    0,
  );

const TIP_ON = leverTip(SWITCH_ON);

/** Arm pivot: inside the box, under the opening, to the LEFT of the switch. */
const ARM_PIVOT = new THREE.Vector3(0.5, 0.85, 0);

const armAngleFor = (p: THREE.Vector3): number =>
  Math.atan2(p.y - ARM_PIVOT.y, p.x - ARM_PIVOT.x);

/**
 * Finger reach (pivot → contact point). A small standoff keeps the fingertip
 * pressed against the lever's surface instead of buried inside it.
 */
const CONTACT_STANDOFF = 0.06;
const ARM_REACH = ARM_PIVOT.distanceTo(TIP_ON) - CONTACT_STANDOFF;

/** Length of the fingertip nub at the end of the arm. */
const FINGER_LEN = 0.16;
/** Length of the arm bar (the fingertip extends it the rest of the way). */
const ARM_BAR = ARM_REACH - FINGER_LEN;

/**
 * Where, on the lever at tilt `angle`, the fingertip touches it (the point on
 * the lever segment at distance ARM_REACH from the pivot, nearest the tip).
 * Lets the contact slide down the lever as it is pushed past the arm's reach.
 */
const leverContact = (angle: number): THREE.Vector3 => {
  const base = SWITCH_POS;
  const seg = leverTip(angle).sub(base); // base -> tip
  const f = base.clone().sub(ARM_PIVOT);
  const a = seg.dot(seg);
  const b = 2 * f.dot(seg);
  const c = f.dot(f) - ARM_REACH * ARM_REACH;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return leverTip(angle); // unreachable; aim for the tip
  const t = Math.min(1, Math.max(0, (-b + Math.sqrt(disc)) / (2 * a)));
  return base.clone().add(seg.multiplyScalar(t));
};

const ARM_ON = armAngleFor(TIP_ON); // tip meets the raised (ON) lever tip
const ARM_OFF = armAngleFor(leverContact(SWITCH_OFF)); // pressed to OFF
const ARM_HIDDEN = Math.PI; // arm folded flat (-X), tucked inside the box

/** Lid rotation when fully open. */
const LID_OPEN = 1.95;

/** Duration (seconds) of each animation phase, in order. */
const PHASE_SECONDS = {
  lidOpen: 0.4,
  reach: 0.5,
  knock: 0.4,
  retract: 0.55,
  lidClose: 0.4,
} as const;

// Top opening, framed by solid panels so the arm has a real hole to pass.
// To the LEFT of the switch; its right lip nearly reaches the switch base so
// the arm crosses the top within the hole.
const OPEN_X_MIN = -0.5;
const OPEN_X_MAX = 0.62;
const OPEN_Z_HALF = 0.5;

const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

interface Phase {
  duration: number;
  update: (p: number) => void;
}

/**
 * The useless machine: a wooden box with a toggle switch and a hidden arm.
 * Flip the switch ON and the lid opens, an arm reaches out, knocks the switch
 * back OFF, then retreats and the lid closes.
 */
export class UselessMachine {
  readonly root = new THREE.Group();
  /** Meshes the raycaster should treat as "the switch" for click detection. */
  readonly interactive: THREE.Object3D[] = [];

  private readonly switchPivot = new THREE.Group();
  private readonly lidPivot = new THREE.Group();
  private readonly armPivot = new THREE.Group();

  // Empty markers used to read exact world positions (rendering + tests).
  private readonly fingerMarker = new THREE.Object3D(); // arm tip
  private readonly tipMarker = new THREE.Object3D(); // lever tip

  private isOn = false;
  private sequence: Phase[] | null = null;
  private phaseIndex = 0;
  private elapsed = 0;

  constructor() {
    this.buildBody();
    this.buildLid();
    this.buildSwitch();
    this.buildArm();

    this.switchPivot.rotation.z = SWITCH_OFF;
    this.armPivot.rotation.z = ARM_HIDDEN;
  }

  private buildBody(): void {
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0x7a5230,
      roughness: 0.75,
      metalness: 0.05,
    });
    const add = (geo: THREE.BoxGeometry, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, bodyMat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.root.add(m);
    };

    // Bottom and four walls (no solid top — the top is a frame around a hole).
    add(new THREE.BoxGeometry(3, 0.1, 2), 0, 0.05, 0);
    add(new THREE.BoxGeometry(0.1, 1.2, 2), 1.45, 0.6, 0);
    add(new THREE.BoxGeometry(0.1, 1.2, 2), -1.45, 0.6, 0);
    add(new THREE.BoxGeometry(3, 1.2, 0.1), 0, 0.6, 0.95);
    add(new THREE.BoxGeometry(3, 1.2, 0.1), 0, 0.6, -0.95);

    // Top frame leaving an opening at [OPEN_X_MIN, OPEN_X_MAX] x [-Zh, +Zh].
    const topY = 1.175;
    const leftW = OPEN_X_MIN - -1.5;
    add(new THREE.BoxGeometry(leftW, 0.05, 2), -1.5 + leftW / 2, topY, 0);
    const rightW = 1.5 - OPEN_X_MAX;
    add(new THREE.BoxGeometry(rightW, 0.05, 2), 1.5 - rightW / 2, topY, 0);
    const openW = OPEN_X_MAX - OPEN_X_MIN;
    const openCx = (OPEN_X_MIN + OPEN_X_MAX) / 2;
    const sideD = 1.0 - OPEN_Z_HALF;
    add(
      new THREE.BoxGeometry(openW, 0.05, sideD),
      openCx,
      topY,
      OPEN_Z_HALF + sideD / 2,
    );
    add(
      new THREE.BoxGeometry(openW, 0.05, sideD),
      openCx,
      topY,
      -(OPEN_Z_HALF + sideD / 2),
    );

    // Dark liner across the cavity floor so the opening reads as depth.
    const liner = new THREE.Mesh(
      new THREE.BoxGeometry(2.7, 0.04, 1.7),
      new THREE.MeshStandardMaterial({ color: 0x101012, roughness: 1 }),
    );
    liner.position.set(0, 0.12, 0);
    liner.receiveShadow = true;
    this.root.add(liner);
  }

  private buildLid(): void {
    // Hinged at the opening's left edge; the far edge lifts up to open.
    this.lidPivot.position.set(OPEN_X_MIN, 1.205, 0);
    const lidMat = new THREE.MeshStandardMaterial({
      color: 0x8a6038,
      roughness: 0.7,
      metalness: 0.05,
    });
    const openW = OPEN_X_MAX - OPEN_X_MIN;
    const lid = new THREE.Mesh(
      new THREE.BoxGeometry(openW, 0.05, OPEN_Z_HALF * 2 + 0.04),
      lidMat,
    );
    lid.position.set(openW / 2, 0, 0);
    lid.castShadow = true;
    lid.receiveShadow = true;
    this.lidPivot.add(lid);
    this.root.add(this.lidPivot);
  }

  private buildSwitch(): void {
    // Mounting plate, sitting on the solid box top beside (right of) the lid.
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.06, 0.36),
      new THREE.MeshStandardMaterial({
        color: 0x1c1c1c,
        roughness: 0.5,
        metalness: 0.3,
      }),
    );
    plate.position.set(SWITCH_POS.x, 1.22, 0);
    plate.castShadow = true;
    this.root.add(plate);
    this.interactive.push(plate);

    // The pivoting lever.
    this.switchPivot.position.copy(SWITCH_POS);
    const leverMat = new THREE.MeshStandardMaterial({
      color: 0xcc2222,
      roughness: 0.4,
      metalness: 0.1,
    });
    const lever = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, LEVER_LEN, 0.16),
      leverMat,
    );
    lever.position.set(0, LEVER_LEN / 2, 0);
    lever.castShadow = true;

    // A pale knob so the toggle direction is easy to read.
    const knob = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 20, 16),
      new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.3 }),
    );
    knob.position.set(0, LEVER_LEN, 0);
    knob.castShadow = true;

    this.tipMarker.position.set(0, LEVER_LEN, 0);

    this.switchPivot.add(lever, knob, this.tipMarker);
    this.root.add(this.switchPivot);
    this.interactive.push(lever, knob);
  }

  private buildArm(): void {
    // Pivots inside the box to the left of the switch; sweeps up through the
    // opening and reaches over to the toggle.
    this.armPivot.position.copy(ARM_PIVOT);
    const armMat = new THREE.MeshStandardMaterial({
      color: 0xcfd2d6,
      roughness: 0.35,
      metalness: 0.6,
    });
    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(ARM_BAR, 0.07, 0.13),
      armMat,
    );
    arm.position.set(ARM_BAR / 2, 0, 0);
    arm.castShadow = true;

    // The fingertip that presses the toggle: a pad on the arm's axis at the
    // very end, pointing forward toward the switch. Staying on-axis keeps it
    // above the switch plate (the contact point is high on the lever) instead
    // of dipping into it.
    const finger = new THREE.Mesh(
      new THREE.BoxGeometry(FINGER_LEN, 0.13, 0.16),
      armMat,
    );
    finger.position.set(ARM_BAR + FINGER_LEN / 2, 0, 0);
    finger.castShadow = true;

    this.fingerMarker.position.set(ARM_REACH, 0, 0);

    this.armPivot.add(arm, finger, this.fingerMarker);
    this.root.add(this.armPivot);
  }

  // --- State queries (used by the render loop and by tests) ----------------

  /** Whether the machine is mid-animation and should ignore new clicks. */
  get isBusy(): boolean {
    return this.sequence !== null;
  }

  get switchAngle(): number {
    return this.switchPivot.rotation.z;
  }

  get armAngle(): number {
    return this.armPivot.rotation.z;
  }

  get lidAngle(): number {
    return this.lidPivot.rotation.z;
  }

  /** World position of the arm's finger tip. */
  fingerWorld(target = new THREE.Vector3()): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.fingerMarker.getWorldPosition(target);
  }

  /** World position of the switch lever's tip. */
  switchTipWorld(target = new THREE.Vector3()): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.tipMarker.getWorldPosition(target);
  }

  /** World position of the switch lever's base (its pivot). */
  switchBaseWorld(target = new THREE.Vector3()): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.switchPivot.getWorldPosition(target);
  }

  /** World position of the arm's pivot. */
  armPivotWorld(target = new THREE.Vector3()): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.armPivot.getWorldPosition(target);
  }

  // --- Animation ------------------------------------------------------------

  /**
   * Call when the user clicks the switch. Flips it ON and kicks off the
   * lid → arm → flip-back → retract → close routine. No-op while busy.
   */
  activate(): void {
    if (this.isBusy || this.isOn) return;
    this.isOn = true;
    this.switchPivot.rotation.z = SWITCH_ON;
    this.startSequence();
  }

  /** Total length of the activation sequence, in seconds. */
  static get sequenceSeconds(): number {
    return Object.values(PHASE_SECONDS).reduce((a, b) => a + b, 0);
  }

  /**
   * The animation phases with their absolute start/end times (seconds). Lets
   * callers (e.g. visual tests) seek to the exact key moments of the routine
   * rather than guessing at fractions of the total runtime.
   */
  static get phases(): ReadonlyArray<{
    name: string;
    start: number;
    end: number;
    mid: number;
  }> {
    let t = 0;
    return Object.entries(PHASE_SECONDS).map(([name, duration]) => {
      const start = t;
      t += duration;
      return { name, start, end: t, mid: start + duration / 2 };
    });
  }

  private startSequence(): void {
    this.sequence = [
      // Open the lid.
      {
        duration: PHASE_SECONDS.lidOpen,
        update: (p) => {
          this.lidPivot.rotation.z = lerp(0, LID_OPEN, easeInOut(p));
        },
      },
      // Reach out: swing the arm up to where it meets the ON toggle tip.
      {
        duration: PHASE_SECONDS.reach,
        update: (p) => {
          this.armPivot.rotation.z = lerp(ARM_HIDDEN, ARM_ON, easeInOut(p));
        },
      },
      // Knock it: arm and switch advance on a shared progress so the finger
      // stays on the toggle tip as it carries it from ON to OFF.
      {
        duration: PHASE_SECONDS.knock,
        update: (p) => {
          const e = easeInOut(p);
          this.armPivot.rotation.z = lerp(ARM_ON, ARM_OFF, e);
          this.switchPivot.rotation.z = lerp(SWITCH_ON, SWITCH_OFF, e);
        },
      },
      // Retract the arm back inside.
      {
        duration: PHASE_SECONDS.retract,
        update: (p) => {
          this.armPivot.rotation.z = lerp(ARM_OFF, ARM_HIDDEN, easeInOut(p));
        },
      },
      // Close the lid.
      {
        duration: PHASE_SECONDS.lidClose,
        update: (p) => {
          this.lidPivot.rotation.z = lerp(LID_OPEN, 0, easeInOut(p));
        },
      },
    ];
    this.phaseIndex = 0;
    this.elapsed = 0;
  }

  /** Advance the animation. `dt` is seconds since the last frame. */
  update(dt: number): void {
    if (!this.sequence) return;

    this.elapsed += dt;
    let phase = this.sequence[this.phaseIndex];

    // Roll forward through any phases this frame completed. Correct for
    // multi-phase skips, but the caller's dt clamp (<= 0.05s, below the
    // shortest 0.4s phase) means in practice at most one phase ends per frame.
    while (phase && this.elapsed >= phase.duration) {
      phase.update(1);
      this.elapsed -= phase.duration;
      this.phaseIndex++;
      phase = this.sequence[this.phaseIndex];
    }

    if (!phase) {
      // Sequence finished; settle to a clean idle state.
      this.lidPivot.rotation.z = 0;
      this.armPivot.rotation.z = ARM_HIDDEN;
      this.switchPivot.rotation.z = SWITCH_OFF;
      this.sequence = null;
      this.isOn = false;
      return;
    }

    phase.update(this.elapsed / phase.duration);
  }
}
