// Sign the "Add to FluxLib" extension with Mozilla, for self-distribution.
//
// Signing is what makes the add-on installable PERMANENTLY in release Firefox: an unsigned
// extension can only be side-loaded temporarily and is dropped on restart. We sign UNLISTED —
// Mozilla signs the file but never lists it publicly, which is free, needs no review queue,
// and leaves distribution to us (Flux ships the .xpi and the Library panel opens it).
//
// YOU sign; users never do. One signed build installs for anyone. The add-on id belongs to the
// AMO account that first uploaded it; any other account gets "Forbidden" at upload, so either
// that account signs or is added as an owner of the add-on on AMO.
//
// Run:
//   export WEB_EXT_API_KEY='user:12345678:123'      # JWT issuer
//   export WEB_EXT_API_SECRET='…'                   # JWT secret
//   npm run sign:extension
//
// Credentials come from https://addons.mozilla.org/developers/addon/api/key/ — they are
// account secrets, so they live in your environment and never in this repo.
//
// The version bump is transactional (scripts/lib/extensionVersion.mjs): the source manifest
// keeps its new number ONLY when Mozilla hands a signed file back. A failed or interrupted
// attempt puts the manifest back exactly as it was and rebuilds dist/ to match, so the next
// attempt starts from the same base and verify-extension-build keeps telling the truth.
import { readFile, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bumpPatch, withVersionBump, restoreManifestSync } from "./lib/extensionVersion.mjs";

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

const build = () =>
  new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(root, "scripts", "build-extension.mjs")], { stdio: "inherit" });
    p.on("exit", (c) => (c === 0 ? res() : rej(new Error(`build failed (${c})`))));
  });

// web-ext is fetched on demand rather than installed, but NOT through a bare
// `npx`: win32 has no such executable, only `npx.cmd`, and modern Node refuses
// to spawn a .cmd without a shell — the trap scripts/lib/tsxRun.mjs documents,
// which made this script die with ENOENT before it ever reached Mozilla.
// `npm run` hands every script npm's own JS entry point, so run THIS node
// against that and let npm fetch the tool. Falling back to npx.cmd under a
// shell covers someone invoking the file directly.
const sign = () => {
  const webExtArgs = ["web-ext", "sign", "--channel=unlisted", `--source-dir=${dist}`, `--artifacts-dir=${out}`, "--no-input"];
  const npmCli = process.env.npm_execpath;
  const viaNpm = !!npmCli && npmCli.endsWith(".js");
  return new Promise((res) => {
    const p = viaNpm
      ? spawn(process.execPath, [npmCli, "exec", "--yes", "--", ...webExtArgs], { stdio: "inherit", cwd: root, env: process.env })
      : spawn("npx", ["--yes", ...webExtArgs], { stdio: "inherit", cwd: root, env: process.env, shell: process.platform === "win32" });
    p.on("exit", (c) => res(c ?? 1));
  });
};

// AMO rejects a version it has already seen, so every signing run must carry a new one. The
// version lives in the SOURCE manifest and is committed: a signed build should be identifiable
// in the history, not a mystery artifact.
const originalText = await readFile(srcManifest, "utf8");
const current = JSON.parse(originalText);
const next = process.env.FLUX_EXT_VERSION || bumpPatch(current.version);

// Ctrl+C during the minute-long upload must not strand the bump either. The handler is
// synchronous, so it restores the manifest and removes the now-mismatched dist/ (the bundle
// gate says "build first" for a missing dist, which is the truth) instead of rebuilding.
process.once("SIGINT", () => {
  restoreManifestSync(srcManifest, originalText);
  rmSync(dist, { recursive: true, force: true });
  console.error(`\n✗ interrupted — extension/manifest.json restored to ${current.version}; run npm run build:extension before the bundle gates\n`);
  process.exit(130);
});

let signedVersion;
try {
  signedVersion = await withVersionBump(
    srcManifest,
    next,
    async (version) => {
      console.log(`• version → ${version}`);
      // Rebuild so dist matches the bumped source (and re-copies the shared rule modules).
      await build();
      if (!existsSync(path.join(dist, "manifest.json"))) throw new Error("extension/dist is missing — the build didn't produce anything.");
      await mkdir(out, { recursive: true });
      console.log("• uploading to Mozilla for signing (usually a minute or two)…");
      const code = await sign();
      if (code !== 0) throw new Error(`web-ext sign failed (exit ${code})`);
      return version;
    },
    {
      onRestore: async (previous) => {
        console.error(`• extension/manifest.json restored to ${previous}; rebuilding dist/ to match`);
        await build().catch((e) => console.error(`  (rebuild failed: ${e.message} — run npm run build:extension)`));
      },
    },
  );
} catch (e) {
  die(`${e.message}.

  Nothing was kept: the source manifest is back at ${current.version}, so the next attempt
  bumps to ${next} again. Common causes:
    • the credentials are wrong or expired — regenerate them at
      https://addons.mozilla.org/developers/addon/api/key/
    • the add-on id (${current.browser_specific_settings?.gecko?.id}) belongs to another
      AMO account — that account signs, or adds yours as an owner of the add-on
    • Mozilla accepted the upload but the run still failed afterwards, so ${next} is now
      taken on AMO — set FLUX_EXT_VERSION=${bumpPatch(next)} (or higher) and run again`);
}

// Exactly ONE .xpi survives. They used to accumulate, and since the directory is committed
// (Firefox users on a checkout have no other way to get a signed add-on) that meant shipping
// dead builds — and for a while the Library's "Install for Firefox" button served the OLDEST
// of them. The freshly signed one is the only one anybody should ever be offered.
const kept = (await readdir(out)).filter((f) => f.endsWith(".xpi") && f.includes(`-${signedVersion}.`));
if (!kept.length) die(`web-ext reported success but no ${signedVersion} .xpi is in ${path.relative(root, out)}/ — nothing removed; inspect the directory.`);
for (const f of await readdir(out)) {
  if (f.endsWith(".xpi") && !kept.includes(f)) {
    await rm(path.join(out, f));
    console.log(`• removed superseded ${f}`);
  }
}

console.log(`\n✓ signed ${signedVersion} → ${path.relative(root, out)}/`);
console.log("  Flux's Library → Web capture → Install for Firefox now opens it.");
console.log("  COMMIT BOTH the version bump and the .xpi — a checkout is how everyone else gets it.");
