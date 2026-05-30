# Useless Machine

A 3D simulation of a [useless machine](https://en.wikipedia.org/wiki/Useless_machine):
a little box with a switch. Flip the switch on and an arm emerges to flip it
right back off. Rendered with [Three.js](https://threejs.org/), with the
mechanism driven by a [cannon-es](https://pmndrs.github.io/cannon-es/) rigid-body
**physics simulation** — the arm actually *collides* with the switch to knock it
over. TypeScript, bundled by [Vite](https://vite.dev/), served as a static site.

## Develop

```bash
npm install
npm run dev
```

Open the printed local URL, then click the red switch and orbit with the mouse.

## Build

```bash
npm run build    # type-checks, then emits a static site to dist/
npm run preview  # serve the production build locally
```

## How the mechanism works

The parts are rigid bodies in a [cannon-es](https://pmndrs.github.io/cannon-es/)
world ([`src/UselessMachine.ts`](src/UselessMachine.ts)):

- a **static base** — the walls and the top frame around the lid opening;
- a **dynamic lever** on a hinge, made *bistable* by a restoring torque plus
  hard end-stops, so it snaps to ON or OFF like a real toggle;
- a **dynamic arm** on a hinge, driven by a motor that sweeps it out and back.

When you flip the switch ON, the arm sweeps up through the opening and
**collides** with the lever, knocking it back to OFF. The flip is a consequence
of the collision — not a scripted keyframe — so the solver guarantees the arm
and switch can never interpenetrate. The world runs without gravity: it's a
tabletop mechanism whose every resting state is defined by the motor and the
bistable detent.

## Test

Because the behaviour is a deterministic simulation, it's verified by **stepping
the physics and asserting the outcome** — no GPU, no screenshots to maintain:

```bash
npm test         # run the Vitest suite once
npm run test:watch
```

[`src/UselessMachine.test.ts`](src/UselessMachine.test.ts) drives the sim and
checks behaviour, not pixels: it starts OFF and idle; `activate()` flips it ON;
stepping the world to completion knocks it back to OFF; the lever stays within
its travel (end-stops, no fling-past); the arm returns inside the box; and
clicks are ignored mid-routine.

> Want to eyeball a frame? `?test` mode in [`src/main.ts`](src/main.ts) exposes
> `window.__useless.frameAt(seconds)` and `setView(name)` (`hero`, `side`,
> `top`, `closeup`, …) so you can capture any moment from any angle with a
> throwaway Playwright script — handy for spot checks without committing
> baseline images.

## Deploy

Pushing to `main` triggers the GitHub Actions workflow in
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which builds the
site and publishes `dist/` to GitHub Pages.

> First-time setup: in the repository settings, set **Pages → Build and
> deployment → Source** to **GitHub Actions**.

The production build uses a base path of `/useless-machine/` to match the
project Pages URL. If you rename the repository, update `base` in
[`vite.config.ts`](vite.config.ts).
