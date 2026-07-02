import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import fs from "node:fs";
import path from "node:path";

// Serve pdf.js's resource dirs (standard_fonts, cmaps, wasm) at /pdfjs/… . pdf.js needs
// these to render non-embedded fonts (else Latin text falls back to the Symbol font and
// renders as Greek), CID/CJK fonts, and JBIG2/JPEG2000 images. In dev we stream them from
// node_modules; on build we copy them into dist/pdfjs/ so they load under Electron file://.
function pdfjsAssets(): Plugin {
  const DIRS = ["standard_fonts", "cmaps", "wasm", "iccs"] as const;
  const srcDir = (d: string) => path.resolve("node_modules/pdfjs-dist", d);
  return {
    name: "flux-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/pdfjs\/(standard_fonts|cmaps|wasm)\/([^?]+)/);
        if (!m || m[2].includes("..")) return next();
        fs.readFile(path.join(srcDir(m[1]), m[2]), (err, buf) => {
          if (err) {
            res.statusCode = 404;
            return res.end();
          }
          if (m[2].endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
          else if (m[2].endsWith(".js") || m[2].endsWith(".mjs")) res.setHeader("Content-Type", "text/javascript");
          res.end(buf);
        });
      });
    },
    writeBundle(options) {
      const out = options.dir || path.resolve("dist");
      for (const d of DIRS) fs.cpSync(srcDir(d), path.join(out, "pdfjs", d), { recursive: true });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [svelte(), pdfjsAssets()],

  // Relative paths so the built bundle loads under Electron's file:// protocol.
  base: "./",

  clearScreen: false,

  // Bundle Web Workers as ES modules — the pdf.js worker (src/lib/pdf/pdfjsWorker.ts,
  // which pre-loads a Uint8Array base64/hex polyfill) is ESM and uses import.meta.
  worker: { format: "es" },

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
    // SHL-20: hidden sourcemaps — emitted for crash triage / stack symbolication but NOT
    // referenced from the bundle, so DevTools doesn't surface source by default in a shipped app.
    sourcemap: "hidden",
  },
});
