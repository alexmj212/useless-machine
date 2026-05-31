import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { UselessMachine } from "./UselessMachine.js";
import { DebugMenu } from "./DebugMenu.js";
import "./style.css";

const params = new URLSearchParams(location.search);
// Deterministic mode for visual tests: time is driven by the test, not a clock,
// and the drawing buffer is preserved so screenshots capture the rendered frame.
const testMode = params.has("test");
// Overlay mode: a fully transparent canvas with no ground, so the machine floats
// on its own — for compositing into a stream/OBS browser source. The lighting
// (incl. the environment probe) is identical; only the backdrop is dropped.
const overlay = params.has("overlay");
// Debug mode: attach the debug menu (FAB + panel + automation API). Off by
// default so the live page is just the machine; opt in with ?debug.
const debugEnabled = params.has("debug");

const app = document.getElementById("app")!;

const scene = new THREE.Scene();
scene.background = overlay ? null : new THREE.Color(0x14161a);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  100,
);
camera.position.set(4.5, 3.5, 5.5);
camera.lookAt(0, 1, 0);

const renderer = new THREE.WebGLRenderer({
  // MSAA. Browsers may downgrade it when combined with `alpha` (overlay mode),
  // but Chromium — the OBS browser-source engine — honours both, so it's safe
  // for our target.
  antialias: true,
  // `alpha` lets the canvas composite over whatever is behind it in overlay mode.
  alpha: overlay,
  preserveDrawingBuffer: testMode,
});
renderer.setPixelRatio(testMode ? 1 : Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// Filmic tone mapping rolls off the metal highlights instead of clipping them to
// flat white, so the silver parts read as rounded metal rather than blown-out.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
if (overlay) renderer.setClearColor(0x000000, 0);
app.appendChild(renderer.domElement);

// An image-based light probe so the polished metal (lever, arm) actually picks
// up reflections and reads as metal — without it, a near-1 metalness surface goes
// near-black except where a light hits it directly. RoomEnvironment is a neutral
// studio-ish cuboid; we bake it to a PMREM and use it ONLY as scene.environment
// (lighting/reflections), never as scene.background — the backdrop is untouched.
const pmrem = new THREE.PMREMGenerator(renderer);
const roomEnv = new RoomEnvironment();
scene.environment = pmrem.fromScene(roomEnv, 0.04).texture;
// One-shot bake: the PMREM texture lives on in scene.environment, but the
// generator and the source room scene are done — free their GPU/CPU resources.
roomEnv.dispose();
pmrem.dispose();

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = !testMode;
controls.target.set(0, 1, 0);
controls.maxPolarAngle = Math.PI / 2 - 0.05;
controls.minDistance = 3;
controls.maxDistance = 15;

// Lighting. The environment probe now supplies most of the soft ambient fill, so
// the explicit ambient is dialled back — otherwise the two stack and ACES washes
// the image flat. The key light still does the shaping and casts the shadow.
scene.add(new THREE.AmbientLight(0xffffff, 0.25));
const key = new THREE.DirectionalLight(0xffffff, 2.0);
key.position.set(5, 8, 4);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1;
key.shadow.camera.far = 30;
key.shadow.camera.left = -8;
key.shadow.camera.right = 8;
key.shadow.camera.top = 8;
key.shadow.camera.bottom = -8;
// Soften the contact shadow's edge; `bias` curbs Peter-panning and `normalBias`
// curbs the self-shadow acne the thin lid/frame panels show at grazing angles.
key.shadow.radius = 4;
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key);

const fill = new THREE.DirectionalLight(0xaaccff, 0.35);
fill.position.set(-6, 4, -3);
scene.add(fill);

// Ground (a shadow-catching deck). Dropped in overlay mode so the machine floats
// on a transparent canvas with nothing behind or beneath it.
if (!overlay) {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
}

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

// ?test takes over the whole animation loop (deterministic, test-driven), so
// ?debug is ignored when both are present — the debug menu only attaches in the
// live interactive path.
if (testMode) {
  setupTestMode();
} else {
  setupInteractive();
}

/** Live mode: click to flip, real-time animation loop, debug menu attached. */
function setupInteractive(): void {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  const pointsAtSwitch = (event: MouseEvent): boolean => {
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObjects(machine.interactive, false).length > 0;
  };

  renderer.domElement.addEventListener("click", (event: MouseEvent) => {
    // No isBusy guard: re-pressing mid-routine is the whole point now. activate()
    // debounces itself (it no-ops while the lever is already ON or mid-flip).
    if (pointsAtSwitch(event)) {
      machine.activate();
    }
  });

  // Cursor affordances: a pointer over the (idle) switch so it reads as
  // clickable, a grab cursor over the rest of the scene (it orbits), and
  // grabbing while a drag is in progress. We skip the hover raycast mid-drag —
  // OrbitControls owns the cursor then, and the result would be discarded.
  renderer.domElement.style.cursor = "grab";
  let dragging = false;
  renderer.domElement.addEventListener("pointerdown", () => {
    dragging = true;
    renderer.domElement.style.cursor = "grabbing";
  });
  window.addEventListener("pointerup", () => {
    dragging = false;
  });
  renderer.domElement.addEventListener("pointermove", (event: MouseEvent) => {
    if (dragging) return;
    // Clickable whenever the lever is OFF (you can flip it ON), even while the
    // arm is still out — that's a re-press. Showing "grab" while it's ON avoids
    // implying a no-op click.
    renderer.domElement.style.cursor =
      pointsAtSwitch(event) && !machine.isOnState ? "pointer" : "grab";
  });

  // The debug menu (behind ?debug) reads the machine and drives time; it never
  // alters the sim. When it's off we step the machine ourselves so the live page
  // carries no debug machinery at all.
  const debug = debugEnabled
    ? new DebugMenu({
        scene,
        getMachine: () => machine,
        rebuild: () => {
          scene.remove(machine.root);
          machine = new UselessMachine();
          scene.add(machine.root);
          return machine;
        },
        render,
      })
    : undefined;

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (debug) debug.frame(dt);
    else machine.update(dt);
    render();
  });

  // Under Vite HMR, tear the menu down so its global listeners don't stack.
  import.meta.hot?.dispose(() => debug?.dispose());
}

/**
 * Test mode: expose a hook so visual tests can render an exact animation
 * moment deterministically (no real-time clock, no race conditions).
 */
function setupTestMode(): void {
  // Named camera angles so visual tests can inspect each moment from several
  // viewpoints — overlaps/clipping that one angle hides are obvious in another.
  const views: Record<string, { pos: [number, number, number]; target: [number, number, number] }> = {
    hero: { pos: [4.5, 3.5, 5.5], target: [0, 1, 0] },
    front: { pos: [0.4, 2.4, 7], target: [0.4, 1.15, 0] },
    side: { pos: [6.8, 2.6, 1.4], target: [0.6, 1.25, 0] },
    top: { pos: [0.5, 8.5, 0.8], target: [0.5, 1.0, 0] },
    closeup: { pos: [2.4, 2.2, 2.6], target: [0.78, 1.4, 0] },
  };

  const setView = (name: string): void => {
    const v = views[name] ?? views.hero;
    camera.position.set(...v.pos);
    controls.target.set(...v.target);
    render();
  };

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

  setView("hero");
  idle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__useless = {
    ready: true,
    views: Object.keys(views),
    setView,
    frameAt,
    idle,
  };
}
