import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Optional local bridge for OBS Browser Source: `npm run overlay:bridge`.
// The proxy is same-origin, so the overlay page never talks to localhost directly.
const bridgeProxy = {
  "/overlay-ws": {
    target: "ws://127.0.0.1:17800",
    ws: true,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    proxy: bridgeProxy,
  },
  preview: {
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: bridgeProxy,
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        studio: "index.html",
        overlay: "overlay.html",
      },
    },
  },
});
