// W13 build step: bundle the headless CLI (flux-cli.ts + flux-core + pure deps)
// into a single self-contained dist/flux-cli.mjs. This:
//   • fixes packaged slide export (SHL-1) — electron/main.cjs spawns this bundle
//     instead of `tsx flux-cli.ts`, which can't run in a packaged app (tsx is a
//     devDependency, flux-cli.ts isn't shipped, and the cwd is inside app.asar);
//   • gives agents a real `flux` binary (AGT-9) — no 0.9s `npx tsx` cold start and
//     no dependency on a repo clone.
//
// esbuild itself is marked external: the only code path that imports it is the
// dev-only fresh-compute fallback in exportDeck.ts, which never runs in a packaged
// app (the prebaked dist/slide-export-assets.json is loaded instead).
//
// Run as part of `npm run build` (after `vite build`, so dist/ exists).

import { build } from "esbuild";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(repoRoot, "dist", "flux-cli.mjs");

const result = await build({
  entryPoints: [path.join(repoRoot, "flux-cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  external: [
    // Dev-only fresh-compute fallback in exportDeck.ts; never reached packaged.
    "esbuild",
    // Native module (.node), lazily imported only by the render-figure-PNG verb
    // (flux-core/index.ts). Can't be bundled; not on the slide-export path.
    "@resvg/resvg-js",
    // pdf.js legacy build runs `new DOMMatrix()` at module load (needs a native
    // canvas polyfill) — bundling it would crash the CLI at load for every verb.
    // Lazily imported in flux-core/fulltext.ts, so it stays out of the load path.
    "pdfjs-dist",
    "pdfjs-dist/legacy/build/pdf.mjs",
  ],
  banner: {
    // CJS interop shims some bundled deps (require/__dirname/__filename) expect
    // under ESM output. The shebang is fixed up after the build (below): esbuild
    // preserves the entry file's own `#!/usr/bin/env -S npx tsx`, which we replace
    // with a plain-node shebang so the bundle runs standalone.
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "import { fileURLToPath as __f2p } from 'node:url';",
      "import { dirname as __dn } from 'node:path';",
      "const require = __cr(import.meta.url);",
      "const __filename = __f2p(import.meta.url);",
      "const __dirname = __dn(__filename);",
    ].join("\n"),
  },
  legalComments: "none",
  logLevel: "warning",
});
void result;

// Normalize the shebang to line 1 (Node only strips a shebang on line 1). esbuild
// carries over flux-cli.ts's `#!/usr/bin/env -S npx tsx`; make it plain node.
let src = await readFile(outfile, "utf8");
src = src.replace(/^#![^\n]*\n/, "");
await writeFile(outfile, `#!/usr/bin/env node\n${src}`);
await chmod(outfile, 0o755);

console.log(`✓ dist/flux-cli.mjs (${(statSync(outfile).size / 1024 / 1024).toFixed(1)} MB)`);
