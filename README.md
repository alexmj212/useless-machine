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
spot" — that are hard to spot by eye.

### Visual regression (Playwright)

For true *visual* fidelity — materials, lighting, shadows, exact pixels — a
Playwright suite renders the real WebGL scene headlessly and diffs it against
committed baseline images:

```bash
npm run test:visual          # compare against baseline screenshots
npm run test:visual:update   # regenerate baselines after an intended change
```

[`tests/visual.spec.ts`](tests/visual.spec.ts) drives the scene through a
deterministic hook (`?test` mode in [`src/main.ts`](src/main.ts) exposes
`window.__useless.frameAt(seconds)` plus `window.__useless.phases`, the
machine's own phase timeline). Each screenshot is taken at a genuine key point
of the routine — resolved from the phase boundaries rather than guessed
fractions of the runtime — so the captured states are exact and correctly
labelled:

| snapshot | animation moment |
| --- | --- |
| `idle` | lid closed, switch off |
| `lid-open` | end of the lid-open phase |
| `arm-reached` | arm out at the switch, still ON |
| `switch-knocked` | lever pushed to OFF |
| `arm-retracted` | arm withdrawn, lid still open |
| `lid-closing` | mid lid-close |

Each moment is captured from **several camera angles** (`hero`, `side`, `top`,
and a switch `closeup`), set via `window.__useless.setView(name)`. A single
angle can hide 3D overlaps — e.g. the arm intersecting the switch plate as it
presses the lever — that are obvious from another, so the contact-critical
frames (`arm-reached`, `switch-knocked`) are shot from extra viewpoints.

There are no real-time races. WebGL is forced onto SwiftShader (software
rendering) in [`playwright.config.ts`](playwright.config.ts) so output is
reproducible across machines with different GPUs.

> **Baselines are environment-specific.** Screenshots rendered on a different
> OS/driver can differ by more than the diff threshold. For CI, regenerate
> baselines inside the matching environment (e.g. the official
> `mcr.microsoft.com/playwright` Docker image) so they compare apples to apples.

## Deploy

Pushing to `main` triggers the GitHub Actions workflow in
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which builds the
site and publishes `dist/` to GitHub Pages.

> First-time setup: in the repository settings, set **Pages → Build and
> deployment → Source** to **GitHub Actions**.

The production build uses a base path of `/useless-machine/` to match the
project Pages URL. If you rename the repository, update `base` in
[`vite.config.ts`](vite.config.ts).
