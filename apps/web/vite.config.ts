import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { VitePWA } from "vite-plugin-pwa";

// Cross-origin isolation headers. Required so the browser exposes
// SharedArrayBuffer + WASM threads, which the audio engine needs to share
// ring buffers between the AudioWorklet thread and workers.
const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export default defineConfig({
  plugins: [
    solid(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      manifest: {
        name: "trippy",
        short_name: "trippy",
        description: "Mobile-first next-generation ACID-style DAW.",
        theme_color: "#0a0a0f",
        background_color: "#0a0a0f",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any maskable",
          },
          {
            src: "/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,wasm,woff2,svg,png}"],
        // The engine wasm can be large — bump the precache size ceiling.
        maximumFileSizeToCacheInBytes: 50 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  server: {
    headers: crossOriginIsolationHeaders,
    port: 5173,
    host: true,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
    port: 4173,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  optimizeDeps: {
    // The wasm-pack output ships its own ESM init; let it through unmodified.
    exclude: ["@trippy/engine"],
  },
  worker: {
    format: "es",
  },
});
