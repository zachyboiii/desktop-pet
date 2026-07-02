import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Two entry points -> two windows: the dashboard (index.html) and the
// transparent pet overlay (pet.html). Tauri serves these on the dev server
// in dev and from dist/ in production.
export default defineConfig({
  plugins: [react()],
  // Tauri expects a fixed port and no auto-clear so its CLI can attach.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    target: "esnext",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        pet: resolve(__dirname, "pet.html"),
      },
    },
  },
});
