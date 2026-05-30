import * as THREE from "three";

// ----------------------------------------------------------------------------
// Geometry
//
// The switch lever pivots at SWITCH_POS; its tip traces an arc of radius
// LEVER_LEN. The toggle leans toward the lid (-X) when ON and away (+X) when
// OFF. We want the arm's finger to physically meet the toggle tip and carry it
// from ON to OFF.
//
// Trick: put the arm pivot on the perpendicular bisector of the ON-tip and
// OFF-tip (i.e. directly below the switch on X). Then BOTH tip positions lie on
// the same circle around the arm pivot, so a single sweeping arm can touch the
// tip at ON, at OFF, and (very nearly) everywhere between. The arm and switch
// angles are driven from a shared progress value so the finger tracks the tip.
// ----------------------------------------------------------------------------

const SWITCH_POS = new THREE.Vector3(0.5, 1.24, 0);
const LEVER_LEN = 0.45;
const SWITCH_ON = 0.5; // lever tilt (rad) when ON — leans -X, toward the lid
const SWITCH_OFF = -0.5; // lever tilt when OFF — leans +X

/** World position of the lever tip for a given tilt angle. */
const leverTip = (angle: number): THREE.Vector3 =>
  new THREE.Vector3(
    SWITCH_POS.x - LEVER_LEN * Math.sin(angle),
    SWITCH_POS.y + LEVER_LEN * Math.cos(angle),
    0,
  );

const TIP_ON = leverTip(SWITCH_ON);
const TIP_OFF = leverTip(SWITCH_OFF);

/** Arm pivot sits on the X of the switch (the tips' perpendicular bisector). */
const ARM_PIVOT = new THREE.Vector3(SWITCH_POS.x, 0.5, 0);

/** Finger sweep radius — equidistant to both tips by construction. */
const ARM_LEN = ARM_PIVOT.distanceTo(TIP_ON);

const armAngleFor = (tip: THREE.Vector3): number =>
  Math.atan2(tip.y - ARM_PIVOT.y, tip.x - ARM_PIVOT.x);

const ARM_ON = armAngleFor(TIP_ON); // finger coincides with the ON tip
const ARM_OFF = armAngleFor(TIP_OFF); // finger coincides with the OFF tip
const ARM_HIDDEN = Math.PI; // arm folded flat (-X) inside the box

/**
 * The arm body sweeps in a plane offset in +Z from the switch, so it passes
 * BESIDE the switch base rather than through it; only the finger reaches back
 * to Z = 0 to touch the toggle.
 */
const ARM_Z = 0.18;

/** Lid rotation when fully open. */
const LID_OPEN = 1.95;

// Top opening, framed by solid panels so the arm has a real hole to pass.
// Wide enough on +X to contain every point where the arm crosses the top.
const OPEN_X_MIN = -0.6;
const OPEN_X_MAX = 0.7;
const OPEN_Z_HALF = 0.55;

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
  private readonly fingerMarker = new THREE.Object3D(); // contact point, Z = 0
  private readonly armEndMarker = new THREE.Object3D(); // arm body end, Z = ARM_Z
  private readonly tipMarker = new THREE.Object3D();

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
    // Mounting plate. Shallow in Z so it stays clear of the arm's sweep plane.
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.06, 0.16),
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
    // Pivot is offset in +Z; the finger reaches back to Z = 0 to touch the
    // toggle, so the arm body never collides with the switch base.
    this.armPivot.position.set(ARM_PIVOT.x, ARM_PIVOT.y, ARM_Z);
    const armMat = new THREE.MeshStandardMaterial({
      color: 0xcfd2d6,
      roughness: 0.35,
      metalness: 0.6,
    });
    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(ARM_LEN, 0.07, 0.13),
      armMat,
    );
    arm.position.set(ARM_LEN / 2, 0, 0);
    arm.castShadow = true;

    // Cross-piece bridging the arm plane (Z = ARM_Z) back to the toggle plane.
    const reach = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.09, ARM_Z + 0.04),
      armMat,
    );
    reach.position.set(ARM_LEN - 0.05, 0.02, -ARM_Z / 2);
    reach.castShadow = true;

    // The finger nub that meets the toggle, at Z = 0 (the switch plane).
    const finger = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, 0.14), armMat);
    finger.position.set(ARM_LEN - 0.05, 0.06, -ARM_Z);
    finger.castShadow = true;

    this.fingerMarker.position.set(ARM_LEN, 0, -ARM_Z); // world Z = 0
    this.armEndMarker.position.set(ARM_LEN, 0, 0); // world Z = ARM_Z

    this.armPivot.add(arm, reach, finger, this.fingerMarker, this.armEndMarker);
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

  /** World position of the arm body's far end (in the arm's sweep plane). */
  armEndWorld(target = new THREE.Vector3()): THREE.Vector3 {
    this.root.updateMatrixWorld(true);
    return this.armEndMarker.getWorldPosition(target);
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

  private startSequence(): void {
    this.sequence = [
      // Open the lid.
      {
        duration: 0.4,
        update: (p) => {
          this.lidPivot.rotation.z = lerp(0, LID_OPEN, easeInOut(p));
        },
      },
      // Reach out: swing the arm up to where it meets the ON toggle tip.
      {
        duration: 0.5,
        update: (p) => {
          this.armPivot.rotation.z = lerp(ARM_HIDDEN, ARM_ON, easeInOut(p));
        },
      },
      // Knock it: arm and switch advance on a shared progress so the finger
      // stays on the toggle tip as it carries it from ON to OFF.
      {
        duration: 0.4,
        update: (p) => {
          const e = easeInOut(p);
          this.armPivot.rotation.z = lerp(ARM_ON, ARM_OFF, e);
          this.switchPivot.rotation.z = lerp(SWITCH_ON, SWITCH_OFF, e);
        },
      },
      // Retract the arm back inside.
      {
        duration: 0.55,
        update: (p) => {
          this.armPivot.rotation.z = lerp(ARM_OFF, ARM_HIDDEN, easeInOut(p));
        },
      },
      // Close the lid.
      {
        duration: 0.4,
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
