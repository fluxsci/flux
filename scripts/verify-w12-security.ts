#!/usr/bin/env -S npx tsx
// presence: main-process / build-config source shapes — not headless-drivable (WS-7.5).
// W12 — Security & path safety. Two layers:
//  (1) flux-core path safety (AGT-5) — tested for real: safeId/safeJoin reject traversal, and
//      the verb boundaries (create-figure / compose-figure) refuse a crafted `--id ../../x`
//      BEFORE any write, so nothing lands outside the project tree.
//  (2) Electron hardening (SHL-3/6/8) lives in the main process (navigation deny, fsGuard on
//      exists/readdir + export/recipe paths, 0600 secrets, signal teardown) — not reachable from
//      a tsx harness, so we presence-assert the specific hardening in the source as a regression
//      gate (paired with `node --check` on the CJS files in the workstream).
//   Run: npx tsx scripts/verify-w12-security.ts
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as core from "../flux-core/index";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}
async function throws(fn: () => Promise<unknown> | unknown, re: RegExp, msg: string) {
  try {
    await fn();
  } catch (e) {
    assert(re.test(String((e as Error).message)), `${msg} (threw: ${(e as Error).message})`);
    return;
  }
  throw new Error(`FAIL: ${msg} — expected a throw, got none`);
}
async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "flux-w12-"));
try {
  await core.scaffold(root, { title: "W12" });

  // --- safeId: the id-at-a-path-segment validator -----------------------------------------
  assert(core.safeId("figure", "growth") === "growth", "safeId passes a plain id");
  assert(core.safeId("figure", "fig-x_2.v1") === "fig-x_2.v1", "safeId passes filename-safe punctuation");
  for (const bad of ["../x", "a/b", "a\\b", "..", ".", ".hidden", ""]) {
    await throws(() => core.safeId("figure", bad), /unsafe figure id|no path separators/, `safeId rejects ${JSON.stringify(bad)}`);
  }

  // --- safeJoin: the escape backstop ------------------------------------------------------
  await throws(() => core.safeJoin(root, "../etc/passwd"), /escapes project root/, "safeJoin rejects a traversal rel");
  await throws(() => core.safeJoin(root, "fig/../../x"), /escapes project root/, "safeJoin rejects a mid-path traversal");
  assert(core.safeJoin(root, "fig/canvases/x.json").startsWith(path.resolve(root)), "safeJoin keeps an in-root rel");

  // --- verb boundaries refuse a crafted id, and nothing escapes ---------------------------
  const leak = path.resolve(root, "..", "flux-w12-LEAK");
  await throws(() => core.createFigure(root, { id: "../flux-w12-LEAK/evil" }), /unsafe figure id/, "create-figure refuses a traversal --id");
  await throws(() => core.createFigure(root, { canvasId: "../flux-w12-LEAK/evil" }), /unsafe canvas id/, "create-figure refuses a traversal --canvas");

  const plot = path.join(root, "plots", "p.svg");
  await fs.mkdir(path.dirname(plot), { recursive: true });
  await fs.writeFile(plot, `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"></svg>`);
  await throws(() => core.composeFigure(root, [plot], { id: "../flux-w12-LEAK/evil" }), /unsafe figure id/, "compose-figure refuses a traversal --id");
  assert(!(await exists(leak)) && !(await exists(leak + "/evil")), "no file leaked outside the project root");

  // --- a legit id still works and writes UNDER the root -----------------------------------
  const { figureId } = await core.createFigure(root, { id: "growth", canvasId: "c1" });
  assert(figureId === "growth", "legit create-figure returns the id");
  assert(await exists(path.join(root, "fig", "canvases", "c1.json")), "legit canvas file written under fig/canvases/");

  // --- (2) Electron hardening presence (main-process code the tsx harness can't drive) -----
  const mainCjs = await fs.readFile(path.join(import.meta.dirname, "..", "electron", "main.cjs"), "utf8");
  const bridgeCjs = await fs.readFile(path.join(import.meta.dirname, "..", "electron", "bridgeServer.cjs"), "utf8");
  const has = (hay: string, needle: string, msg: string) => assert(hay.includes(needle), msg);
  has(mainCjs, 'win.webContents.on("will-navigate"', "SHL-3: will-navigate deny handler present");
  has(mainCjs, "setWindowOpenHandler", "SHL-3: window-open handler present");
  // WS-9.4b: the FILES family lives in electron/ipc/files.cjs — same anchors, new home.
  const filesCjs = await fs.readFile(path.join(import.meta.dirname, "..", "electron", "ipc", "files.cjs"), "utf8");
  const guardBody = filesCjs.split("function fsGuard(p)")[1]?.split("\n  }")[0] ?? "";
  assert(guardBody.length > 0 && !guardBody.includes('getPath("home")'), "SHL-6: $HOME dropped from the fsGuard allowlist");
  assert(!(mainCjs.split("roots: () => [")[1]?.split("]")[0] ?? "").includes('getPath("home")'), "SHL-6: main's lent roots exclude $HOME too");
  assert(/ipc\.handle\("fs:exists",[^)]*\)\s*=>\s*\{\s*\n\s*fsGuard\(p\)/.test(filesCjs), "SHL-6: fs:exists now guarded");
  assert(/ipc\.handle\("fs:readdir",[^)]*\)\s*=>\s*\{\s*\n\s*fsGuard\(p\)/.test(filesCjs), "SHL-6: fs:readdir now guarded");
  has(mainCjs, "fsGuard(recipePath)", "SHL-6: recipe:run contains recipePath");
  has(mainCjs, "unsafe deckId", "SHL-6: slides:exportDeck sanitizes deckId");
  // WS-9.4b: keys.json + proxy-cred writes live in the NETWORK family module.
  const networkCjs = await fs.readFile(path.join(import.meta.dirname, "..", "electron", "ipc", "network.cjs"), "utf8");
  assert(/chmod\(fluxKeysPath\(\), 0o600\)/.test(networkCjs), "SHL-8: keys.json written owner-only");
  has(networkCjs, "{ mode: 0o600 }", "SHL-8: proxy credentials written owner-only");
  has(mainCjs, 'process.on(sig', "SHL-8: SIGINT/SIGTERM teardown registered");
  has(bridgeCjs, "mode: 0o600", "SHL-8: bridge.json written owner-only");
  has(bridgeCjs, "mode: 0o700", "SHL-8: bridge dir created owner-only");

  // --- WS-9.2: SSRF — resolved-IP validation + redirect re-validation ----------------------
  const netFetchCjs = await fs.readFile(path.join(import.meta.dirname, "..", "electron", "netFetch.cjs"), "utf8");
  const resolveDoiCjs = await fs.readFile(path.join(import.meta.dirname, "..", "electron", "resolveDoi.cjs"), "utf8");
  has(netFetchCjs, "function assertPublicResolved", "9.2: DNS-resolution validator present");
  has(netFetchCjs, "webRequest.onBeforeRequest", "9.2: partition-level SSRF gate installed (validates every redirect hop)");
  has(netFetchCjs, "ERR_BLOCKED_BY_CLIENT", "9.2: cancelled hops surface as a blocked error");
  // session.fetch CANCELS manual redirects ("Redirect was cancelled"), so netFetch keeps
  // redirect:"follow" and the webRequest gate does the per-hop validation — the follow is
  // legitimate ONLY together with the gate (asserted above).
  has(resolveDoiCjs, "assertPublicResolved", "9.2: resolveDoi imports the DNS validator");
  assert(!resolveDoiCjs.includes('redirect: "follow"'), '9.2: resolveDoi no longer auto-follows (manual hop loop)');
  has(resolveDoiCjs, 'redirect: "manual"', "9.2: resolveDoi hops manually, re-validating each Location");

  // --- WS-9.3: fsGuard deny-by-default + approval lifecycle ---------------------------------
  assert(!filesCjs.includes("if (!currentRoot) return") && !mainCjs.includes("if (!currentRoot) return; // nothing to protect"),
    "9.3: the launch-window allow-everything early-return is GONE (deny-by-default)");
  has(mainCjs, "fileCore.clearApprovals()", "9.3: dialog approvals cleared on project switch/goHome");
  has(filesCjs, 'ipc.handle("fs:beginOpen"', "9.3: beginOpen pre-registers the root being loaded");
  has(filesCjs, 'existsSync(path.join(ab, "project.json"))', "9.3: beginOpen only accepts a real Flux project");
  has(mainCjs, "pendingRoot = null;", "9.3: the pending slot is cleared on registration (single slot)");

  // --- WS-9.1: Content-Security-Policy ------------------------------------------------------
  const indexHtml = await fs.readFile(path.join(import.meta.dirname, "..", "index.html"), "utf8");
  has(indexHtml, 'http-equiv="Content-Security-Policy"', "9.1: CSP meta present in index.html");
  assert(!/script-src[^;]*'unsafe-inline'/.test(indexHtml), "9.1: script-src never allows unsafe-inline");
  has(indexHtml, "ws://localhost:1420", "9.1: source meta is the DEV variant (HMR websocket allowed)");
  has(mainCjs, "onHeadersReceived", "9.1: dev-server responses get the CSP as a header too");
  const viteConfig = await fs.readFile(path.join(import.meta.dirname, "..", "vite.config.ts"), "utf8");
  has(viteConfig, "flux-csp-strict", "9.1: the build strips the loopback entries (strict variant)");
  // The preview iframe's constant inline scripts are hash-allowlisted — recompute
  // from source so an edit can't silently break the paginated preview.
  {
    const rm = await fs.readFile(
      path.join(import.meta.dirname, "..", "src", "shell", "modes", "paper", "render", "renderManuscript.ts"),
      "utf8",
    );
    const { createHash } = await import("node:crypto");
    for (const name of ["PAGINATOR", "LIVE_SCROLL"]) {
      const m = rm.match(new RegExp("const " + name + " = `([\\s\\S]*?)`;"));
      assert(m, `9.1: ${name} inline script found in renderManuscript.ts`);
      const hash = "sha256-" + createHash("sha256").update(m![1], "utf8").digest("base64");
      assert(indexHtml.includes(`'${hash}'`), `9.1: CSP hash for ${name} is FRESH (${hash})`);
      assert(mainCjs.includes(`'${hash}'`), `9.1: dev-header CSP carries the ${name} hash too`);
    }
  }
  // dist/ is present on any machine that has run `npm run build` (the startup
  // gate also asserts the SERVED strict policy) — verify when available.
  const distIndex = path.join(import.meta.dirname, "..", "dist", "index.html");
  if (await exists(distIndex)) {
    const dist = await fs.readFile(distIndex, "utf8");
    has(dist, 'http-equiv="Content-Security-Policy"', "9.1: CSP meta present in dist/index.html");
    assert(!dist.includes("ws://localhost:1420"), "9.1: dist policy is STRICT (no dev loopback entries)");
  } else {
    console.log("  ok: (dist/index.html absent — strict-variant check runs in verify-startup)");
  }

  console.log("\nW12 SECURITY VERIFY: PASS");
} finally {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(path.resolve(root, "..", "flux-w12-LEAK"), { recursive: true, force: true });
}
