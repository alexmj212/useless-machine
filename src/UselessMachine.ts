import * as THREE from "three";

/** Lever tilt when the switch is OFF (leans right, away from the lid). */
const SWITCH_OFF = -0.6;
/** Lever tilt when the switch is ON (leans left, toward the lid/arm). */
const SWITCH_ON = 0.6;

/** Lid rotation when fully open. */
const LID_OPEN = 1.95;

/** Arm rotation while hidden inside the box (pointing down). */
const ARM_HIDDEN = -1.65;
/** Arm rotation when extended out to the switch. */
const ARM_CONTACT = 0.02;

const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

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

  private isOn = false;
  private sequence: Phase[] | null = null;
  private phaseIndex = 0;
  private elapsed = 0;

  constructor() {
    this.buildBody();
    this.buildHoleAndLid();
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
    const body = new THREE.Mesh(new THREE.BoxGeometry(3, 1.2, 2), bodyMat);
    body.position.y = 0.6;
    body.castShadow = true;
    body.receiveShadow = true;
    this.root.add(body);
  }

  private buildHoleAndLid(): void {
    // A dark recess that reads as an opening once the lid lifts away.
    const hole = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.12, 1.05),
      new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 1 }),
    );
    hole.position.set(-0.55, 1.16, 0);
    this.root.add(hole);

    // Hinged lid, pivoting about its left edge so the right edge lifts up.
    this.lidPivot.position.set(-1.03, 1.21, 0);
    const lidMat = new THREE.MeshStandardMaterial({
      color: 0x8a6038,
      roughness: 0.7,
      metalness: 0.05,
    });
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.05, 1.05), lidMat);
    lid.position.set(0.475, 0, 0);
    lid.castShadow = true;
    lid.receiveShadow = true;
    this.lidPivot.add(lid);
    this.root.add(this.lidPivot);
  }

  private buildSwitch(): void {
    // Mounting plate on top of the box.
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.06, 0.5),
      new THREE.MeshStandardMaterial({
        color: 0x1c1c1c,
        roughness: 0.5,
        metalness: 0.3,
      }),
    );
    plate.position.set(0.9, 1.22, 0);
    plate.castShadow = true;
    this.root.add(plate);
    this.interactive.push(plate);

    // The pivoting lever.
    this.switchPivot.position.set(0.9, 1.24, 0);
    const leverMat = new THREE.MeshStandardMaterial({
      color: 0xcc2222,
      roughness: 0.4,
      metalness: 0.1,
    });
    const lever = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.18), leverMat);
    lever.position.set(0, 0.25, 0);
    lever.castShadow = true;

    // A pale tip so the toggle direction is easy to read.
    const tip = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 20, 16),
      new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.3 }),
    );
    tip.position.set(0, 0.5, 0);
    tip.castShadow = true;

    this.switchPivot.add(lever, tip);
    this.root.add(this.switchPivot);
    this.interactive.push(lever, tip);
  }

  private buildArm(): void {
    // Arm pivots at the right edge of the opening, at the top surface.
    this.armPivot.position.set(-0.1, 1.2, 0);
    const armMat = new THREE.MeshStandardMaterial({
      color: 0xcfd2d6,
      roughness: 0.35,
      metalness: 0.6,
    });
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.08, 0.14), armMat);
    arm.position.set(0.525, 0, 0);
    arm.castShadow = true;

    // A little finger at the tip that actually nudges the switch. Made tall
    // enough to overlap the lever body cleanly when the arm reaches contact.
    const finger = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.3, 0.14),
      armMat,
    );
    finger.position.set(1.0, 0.05, 0);
    finger.castShadow = true;

    this.armPivot.add(arm, finger);
    this.root.add(this.armPivot);
  }

  /** Whether the machine is mid-animation and should ignore new clicks. */
  get isBusy(): boolean {
    return this.sequence !== null;
  }

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
        duration: 0.45,
        update: (p) => {
          this.lidPivot.rotation.z = lerp(0, LID_OPEN, easeInOut(p));
        },
      },
      // Extend the arm; the finger knocks the switch OFF near the end.
      {
        duration: 0.6,
        update: (p) => {
          const e = easeInOut(p);
          this.armPivot.rotation.z = lerp(ARM_HIDDEN, ARM_CONTACT, e);
          const push = smoothstep(0.55, 0.95, p);
          this.switchPivot.rotation.z = lerp(SWITCH_ON, SWITCH_OFF, push);
        },
      },
      // Brief pause at full reach.
      { duration: 0.12, update: () => {} },
      // Retract the arm.
      {
        duration: 0.55,
        update: (p) => {
          this.armPivot.rotation.z = lerp(ARM_CONTACT, ARM_HIDDEN, easeInOut(p));
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
    // shortest 0.12s phase) means in practice at most one phase ends per frame.
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
