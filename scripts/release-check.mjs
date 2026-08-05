#!/usr/bin/env node
// Phase 5.2 — pre-release gate. Run this BEFORE pushing a vX.Y.Z tag; it proves the
// exact things that have shipped broken before (stale dist/, an unbundled MCP, a
// packaged CLI that can't run outside the repo):
//   1. package.json version (and, if RELEASE_TAG is set, that the tag matches it)
//   2. no high/critical dependency advisories in either tree (root + lighttable)
//   3. a clean build emits all three dist artifacts
//   4. the CLI + MCP bundles actually run (reuses the bundle tier + verify-r3-agent)
//   5. electron-builder --dir packs, and the UNPACKED CLI runs from an unrelated cwd
//
// Usage:  node scripts/release-check.mjs [--skip-pack]
//   --skip-pack  runs everything except the (slow) electron-builder pack + unpacked drive.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { assertNodeVersion } from "./lib/nodeCheck.mjs";

assertNodeVersion("release-check"); // WS-0b: never cut a release from an off-CI runtime

const root = process.cwd();
const skipPack = process.argv.includes("--skip-pack");
let fails = 0;
const step = (m) => console.log(`\n▶ ${m}`);
const ok = (c, m) => {
  console.log(`  ${c ? "✓" : "✗"} ${m}`);
  if (!c) fails++;
};

// walk a tree, returning the first file whose absolute path ends with `suffix`.
function findBySuffix(dir, suffix) {
  let out = null;
  const walk = (d) => {
    if (out) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.replace(/\\/g, "/").endsWith(suffix)) out = p;
    }
  };
  walk(dir);
  return out;
}

// 1. version / tag
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
step(`version — package.json is ${version}`);
const tag = (process.env.RELEASE_TAG || "").trim();
if (tag) ok(tag.replace(/^v/, "") === version, `RELEASE_TAG ${tag} matches package.json version ${version}`);
else console.log("  (no RELEASE_TAG in env — skipping tag↔version check)");

// 2. dependency advisories. `main` carried 13 of them (9 high) with nothing
// watching, found only because someone ran `npm audit fix` by hand — and a
// release is the moment they reach users. Read the JSON counts rather than the
// exit code, so a registry/network failure reports itself instead of passing.
step("audit — no high/critical advisories in either tree");
for (const [label, cwd] of [
  ["root", root],
  ["lighttable", path.join(root, "lighttable")],
]) {
  if (!existsSync(path.join(cwd, "package-lock.json"))) {
    ok(false, `${label}: package-lock.json present`);
    continue;
  }
  const res = spawnSync("npm", ["audit", "--audit-level=high", "--json"], { encoding: "utf8", cwd });
  let counts = null;
  try {
    counts = JSON.parse(res.stdout || "{}").metadata?.vulnerabilities ?? null;
  } catch {
    /* unparseable — reported just below */
  }
  if (!counts) {
    ok(false, `${label}: npm audit reachable (registry error or unparseable output)`);
    continue;
  }
  const blocking = (counts.high ?? 0) + (counts.critical ?? 0);
  ok(
    blocking === 0,
    `${label}: ${blocking} high/critical (${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low)`,
  );
}

// 3. clean build
step("clean build — vite + gen-export-assets + CLI/MCP bundles");
try {
  execSync("npm run build", { stdio: "inherit", cwd: root });
  ok(true, "npm run build completed");
} catch {
  ok(false, "npm run build completed");
  console.log("\n✗ build failed — do not tag");
  process.exit(1);
}

// 4. artifacts
step("artifacts — the packaged spawn paths must exist");
for (const f of ["dist/flux-cli.mjs", "dist/flux-mcp.mjs", "dist/slide-export-assets.json"]) {
  ok(existsSync(path.join(root, f)), `built ${f}`);
}

// 5. bundle smokes
step("bundle handshakes — the bundles actually run");
const help = spawnSync("node", ["dist/flux-cli.mjs", "help"], { encoding: "utf8", cwd: root });
ok(
  help.status === 0 && /(compose-figure|search-text|lib-add)/.test(`${help.stdout}${help.stderr}`),
  "CLI bundle runs `help` and lists verbs",
);
// Drift gate (moma feedback #2/#3): the bundle must be stamped with THIS
// checkout's commit — a stale dist/ shipped once and cost an agent session.
const ver = spawnSync("node", ["dist/flux-cli.mjs", "version"], { encoding: "utf8", cwd: root });
try {
  const b = JSON.parse(ver.stdout || "{}");
  const head = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
  ok(
    ver.status === 0 && b.entry === "bundle" && String(b.commit).replace(/-dirty$/, "") === head,
    `CLI bundle is stamped with HEAD (${b.commit ?? "?"} vs ${head})`,
  );
} catch {
  ok(false, "CLI bundle reports parseable `version` output");
}
ok(
  spawnSync("node", ["scripts/run-verifies.mjs", "--tier", "bundle"], { stdio: "inherit", cwd: root }).status === 0,
  "bundle verify tier passes (verify-w13-cli)",
);
ok(
  spawnSync("npx", ["tsx", "scripts/verify-r3-agent.ts"], { stdio: "inherit", cwd: root }).status === 0,
  "MCP handshake passes against dev + built bundle (verify-r3-agent)",
);

// 6. pack + drive the unpacked CLI from an unrelated cwd
if (skipPack) {
  console.log("\n(--skip-pack: not running electron-builder or the unpacked drive)");
} else {
  step("electron-builder --dir — pack and drive the UNPACKED cli");
  try {
    execSync("npm run pack", { stdio: "inherit", cwd: root });
    ok(true, "npm run pack completed");
  } catch {
    ok(false, "npm run pack completed");
  }
  const unpackedCli = findBySuffix(path.join(root, "release"), "app.asar.unpacked/dist/flux-cli.mjs");
  ok(!!unpackedCli, "packaged app ships app.asar.unpacked/dist/flux-cli.mjs");
  // The MCP bundle must be unpacked beside it (packaged Ask-Claude spawns it — defect A3).
  ok(
    !!findBySuffix(path.join(root, "release"), "app.asar.unpacked/dist/flux-mcp.mjs"),
    "packaged app ships app.asar.unpacked/dist/flux-mcp.mjs",
  );
  if (unpackedCli) {
    // The electron binary sits at the app root (…/<app>/, the dir that holds `resources`).
    const marker = "resources" + path.sep;
    const idx = unpackedCli.indexOf(marker);
    const appDir = idx >= 0 ? unpackedCli.slice(0, idx).replace(/[/\\]+$/, "") : path.dirname(unpackedCli);
    const binName = process.platform === "darwin" ? null : ["flux", "Flux", pkg.name].find((n) => existsSync(path.join(appDir, n)));
    const electronBin =
      process.platform === "darwin"
        ? findBySuffix(path.join(root, "release"), ".app/Contents/MacOS/Flux")
        : binName
          ? path.join(appDir, binName)
          : null;
    if (!electronBin || !existsSync(electronBin)) {
      // Non-fatal: the important gate (bundles run) passed; just flag for a manual check.
      console.log("  ⚠ couldn't locate the packaged electron binary — verify the unpacked CLI by hand");
    } else {
      const r = spawnSync(electronBin, [unpackedCli, "help"], {
        cwd: "/tmp", // an UNRELATED cwd — the packaged CLI must not depend on the repo
        encoding: "utf8",
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      ok(r.status === 0 && /compose-figure/.test(`${r.stdout}${r.stderr}`), "packaged CLI runs from /tmp via ELECTRON_RUN_AS_NODE");
    }
  }
}

console.log(fails ? `\n✗ ${fails} check(s) FAILED — do not tag this commit` : "\n✓ release-check passed — safe to tag");
process.exit(fails ? 1 : 0);
