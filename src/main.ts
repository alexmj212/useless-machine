import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { UselessMachine } from "./UselessMachine.js";
import "./style.css";

// Deterministic mode for visual tests: time is driven by the test, not a clock,
// and the drawing buffer is preserved so screenshots capture the rendered frame.
const testMode = new URLSearchParams(location.search).has("test");

const app = document.getElementById("app")!;
const hint = document.getElementById("hint");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
camera.position.set(4.5, 3.5, 5.5);
camera.lookAt(0, 1, 0);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  preserveDrawingBuffer: testMode,
});
renderer.setPixelRatio(testMode ? 1 : Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = !testMode;
controls.target.set(0, 1, 0);
controls.maxPolarAngle = Math.PI / 2 - 0.05;
controls.minDistance = 3;
controls.maxDistance = 15;

// Lighting.
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(5, 8, 4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1;
key.shadow.camera.far = 30;
key.shadow.camera.left = -8;
key.shadow.camera.right = 8;
key.shadow.camera.top = 8;
key.shadow.camera.bottom = -8;
scene.add(key);

const fill = new THREE.DirectionalLight(0xaaccff, 0.4);
fill.position.set(-6, 4, -3);
scene.add(fill);

// Ground.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 60),
  new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// The machine.
let machine = new UselessMachine();
scene.add(machine.root);

function render(): void {
  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

if (testMode) {
  setupTestMode();
} else {
  setupInteractive();
}

/** Live mode: click to flip, real-time animation loop. */
function setupInteractive(): void {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  renderer.domElement.addEventListener("click", (event: MouseEvent) => {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(machine.interactive, false);
    if (hits.length > 0 && !machine.isBusy) {
      machine.activate();
      if (hint) hint.style.opacity = "0";
    }
  });

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    machine.update(Math.min(clock.getDelta(), 0.05));
    render();
  });
}

/**
 * Test mode: expose a hook so visual tests can render an exact animation
 * moment deterministically (no real-time clock, no race conditions).
 */
function setupTestMode(): void {
  if (hint) hint.style.display = "none";

  const reset = (): void => {
    scene.remove(machine.root);
    machine = new UselessMachine();
    scene.add(machine.root);
  };

  // Replay the sequence from idle and stop exactly `seconds` in.
  const frameAt = (seconds: number): void => {
    reset();
    machine.activate();
    const step = 1 / 120;
    for (let t = 0; t < seconds; t += step) {
      machine.update(Math.min(step, seconds - t));
    }
    render();
  };

  const idle = (): void => {
    reset();
    render();
  };

  idle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__useless = {
    ready: true,
    sequenceSeconds: UselessMachine.sequenceSeconds,
    phases: UselessMachine.phases,
    frameAt,
    idle,
  };
}
