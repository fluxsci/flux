import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// The source index.html carries the DEV CSP (loopback ws/http for Vite HMR).
// Builds ship the STRICT variant — same policy with the loopback entries dropped
// (the packaged app loads file://).
function cspStrict(): Plugin {
  return {
    name: "lt-csp-strict",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace(/connect-src 'self'[^;]*;/, "connect-src 'self';");
    },
  };
}

export default defineConfig({
  plugins: [svelte(), cspStrict()],
  // Relative paths so the built bundle loads under Electron's file:// protocol.
  base: "./",
  clearScreen: false,
  server: { port: 1440, strictPort: true, host: "127.0.0.1" },
  build: { target: "esnext" },
});
