import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [svelte()],

  // Relative paths so the built bundle loads under Electron's file:// protocol.
  base: "./",

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Bind to IPv4 loopback explicitly. On macOS `localhost` resolves to IPv6
    // (::1) first, which left `wait-on tcp:127.0.0.1` in electron:dev hanging
    // forever (so Electron never launched). Pinning 127.0.0.1 here + in the
    // electron:dev URL keeps dev working on both macOS and Linux.
    host: "127.0.0.1",
  },

  // Produce relative asset paths so the bundled webview can load them.
  build: {
    target: "esnext",
    sourcemap: false,
  },
});
