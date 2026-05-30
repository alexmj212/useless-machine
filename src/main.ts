import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { UselessMachine } from "./UselessMachine.js";
import "./style.css";

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

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
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
const machine = new UselessMachine();
scene.add(machine.root);

// Click-to-flip via raycasting against the switch.
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function onClick(event: MouseEvent): void {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(machine.interactive, false);
  if (hits.length > 0 && !machine.isBusy) {
    machine.activate();
    if (hint) hint.style.opacity = "0";
  }
}
renderer.domElement.addEventListener("click", onClick);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();
function animate(): void {
  const dt = Math.min(clock.getDelta(), 0.05);
  machine.update(dt);
  controls.update();
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);
