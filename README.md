# Useless Machine

A 3D simulation of a [useless machine](https://en.wikipedia.org/wiki/Useless_machine):
a little box with a switch. Flip the switch on and an arm emerges to flip it
right back off. Rendered with [Three.js](https://threejs.org/) and TypeScript,
bundled by [Vite](https://vite.dev/), served as a static site.

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

## Test

The arm/switch animation is pure scene-graph math, so it can be verified
headlessly — no GPU required:

```bash
npm test         # run the Vitest suite once
npm run test:watch
```

[`src/UselessMachine.test.ts`](src/UselessMachine.test.ts) steps the animation
deterministically and asserts **world-space** relationships: the arm's finger
actually reaches the switch tip during the knock (and tracks it as it flips),
the switch only moves while the finger is touching it, the arm only crosses the
top surface within the lid opening (no clipping the solid frame), and the
machine settles back to a clean idle state.

This catches geometry/animation regressions — "the arm doesn't hit the right
spot" — that are hard to spot by eye. For true *visual* fidelity (materials,
lighting, exact pixels) the complementary approach is headless screenshot tests
(e.g. Playwright rendering the scene at fixed animation timestamps and diffing
against golden images); that lives outside this fast unit suite.

## Deploy

Pushing to `main` triggers the GitHub Actions workflow in
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which builds the
site and publishes `dist/` to GitHub Pages.

> First-time setup: in the repository settings, set **Pages → Build and
> deployment → Source** to **GitHub Actions**.

The production build uses a base path of `/useless-machine/` to match the
project Pages URL. If you rename the repository, update `base` in
[`vite.config.ts`](vite.config.ts).
