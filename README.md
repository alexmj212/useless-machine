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

## Deploy

Pushing to `main` triggers the GitHub Actions workflow in
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which builds the
site and publishes `dist/` to GitHub Pages.

> First-time setup: in the repository settings, set **Pages → Build and
> deployment → Source** to **GitHub Actions**.

The production build uses a base path of `/useless-machine/` to match the
project Pages URL. If you rename the repository, update `base` in
[`vite.config.ts`](vite.config.ts).
