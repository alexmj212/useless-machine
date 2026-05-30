import { defineConfig } from "vite";

// The repo is hosted as a GitHub Pages project site at
// https://<user>.github.io/useless-machine/, so assets must be served
// from that sub-path in production. Locally (dev) the base is "/".
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/useless-machine/" : "/",
}));
