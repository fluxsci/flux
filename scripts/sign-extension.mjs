// Sign the "Add to FluxLib" extension with Mozilla, for self-distribution.
//
// Signing is what makes the add-on installable PERMANENTLY in release Firefox: an unsigned
// extension can only be side-loaded temporarily and is dropped on restart. We sign UNLISTED —
// Mozilla signs the file but never lists it publicly, which is free, needs no review queue,
// and leaves distribution to us (Flux ships the .xpi and the Library panel opens it).
//
// YOU sign; users never do. One signed build installs for anyone.
//
// Run:
//   export WEB_EXT_API_KEY='user:12345678:123'      # JWT issuer
//   export WEB_EXT_API_SECRET='…'                   # JWT secret
//   npm run sign:extension
//
// Credentials come from https://addons.mozilla.org/developers/addon/api/key/ — they are
// account secrets, so they live in your environment and never in this repo.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcManifest = path.join(root, "extension", "manifest.json");
const dist = path.join(root, "extension", "dist");
const out = path.join(root, "extension", "signed");

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
  die(
    `Mozilla API credentials are missing.

  1. Sign in at https://addons.mozilla.org/developers/ and accept the developer agreement.
  2. Generate credentials at https://addons.mozilla.org/developers/addon/api/key/
  3. Then, in this shell:

       export WEB_EXT_API_KEY='user:12345678:123'
       export WEB_EXT_API_SECRET='…'
       npm run sign:extension

  Keep the secret out of the repo — it is an account credential, not a project setting.`,
  );
}

// AMO rejects a version it has already seen, so every signing run must carry a new one. The
// version lives in the SOURCE manifest and is committed: a signed build should be identifiable
// in the history, not a mystery artifact.
const manifest = JSON.parse(await readFile(srcManifest, "utf8"));
const bump = (v) => {
  const p = String(v || "0.1.0").split(".").map((n) => parseInt(n, 10) || 0);
  while (p.length < 3) p.push(0);
  p[2] += 1;
  return p.join(".");
};
const next = process.env.FLUX_EXT_VERSION || bump(manifest.version);
manifest.version = next;
await writeFile(srcManifest, JSON.stringify(manifest, null, 2) + "\n");
console.log(`• version → ${next}`);

// Rebuild so dist matches the bumped source (and re-copies the shared rule modules).
await new Promise((res, rej) => {
  const p = spawn(process.execPath, [path.join(root, "scripts", "build-extension.mjs")], { stdio: "inherit" });
  p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`build failed (${c})`))));
});
if (!existsSync(path.join(dist, "manifest.json"))) die("extension/dist is missing — the build didn't produce anything.");
await mkdir(out, { recursive: true });

console.log("• uploading to Mozilla for signing (usually a minute or two)…");
const code = await new Promise((res) => {
  const p = spawn(
    "npx",
    ["--yes", "web-ext", "sign", "--channel=unlisted", `--source-dir=${dist}`, `--artifacts-dir=${out}`, "--no-input"],
    { stdio: "inherit", cwd: root, env: process.env },
  );
  p.on("exit", (c) => res(c ?? 1));
});

if (code !== 0) {
  die(`web-ext sign failed (exit ${code}).

  Common causes:
    • the credentials are wrong or expired — regenerate them at
      https://addons.mozilla.org/developers/addon/api/key/
    • this version was already uploaded — run again (the version auto-bumps), or set
      FLUX_EXT_VERSION=x.y.z
    • the add-on id (${manifest.browser_specific_settings?.gecko?.id}) belongs to another account`);
}

console.log(`\n✓ signed → ${path.relative(root, out)}/`);
console.log("  Flux's Library → Web capture → Install for Firefox now opens it.");
console.log("  Commit the version bump; the .xpi itself is gitignored (ship it with the app).");
