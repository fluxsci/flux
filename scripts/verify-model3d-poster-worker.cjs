"use strict";
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os"), assert = require("node:assert/strict");
const { createHash } = require("node:crypto");

async function main(h) {
  const { renderModelPosterBatch, modelPosterHtml } = await import("../flux-core/model3dPosters.ts");
  const { validateJob } = require("../electron/model3dPosterWorker.cjs");
  const repo = path.resolve(__dirname, ".."), scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flux-model3d-native-"));
  const artifacts = path.join(repo, "test-results/model3d/poster-worker");
  const previousElectron = process.env.FLUX_MODEL3D_ELECTRON;
  try {
    await fs.mkdir(artifacts, { recursive: true });
    // The test's explicit sandbox opt-in is an executable adapter, never product policy.
    if (process.platform === "linux" && process.env.FLUX_ELECTRON_NO_SANDBOX === "1") {
      const shim = path.join(scratch, "electron-test"), binary = require("electron");
      await fs.writeFile(shim, `#!/bin/sh\nexec '${binary.replaceAll("'", "'\\''")}' --no-sandbox "$@"\n`, { mode: 0o700 });
      process.env.FLUX_MODEL3D_ELECTRON = shim;
    }
    const bytes = await fs.readFile(path.join(repo, "scripts/fixtures/model3d/fluxplot/named-parts.glb"));
    const element = { id: "test-model", type: "model3d", assetId: "plain", x: 0, y: 0, width: 320, height: 240,
      rotation: 0, opacity: 1, orbitAzimuth: 30, orbitElevation: 20, orbitZoom: .9, orbitProjection: "orthographic", orbitFov: 30, fill: "#4385be" };
    const specs = [0, 90].map(az => ({ assetId: "plain", w: 320, h: 240, element: { ...element, orbitAzimuth: az } }));
    const requests = specs.map((spec, i) => ({ key: `m3d-${String(i + 1).padStart(14, "0")}`, spec }));
    const modelBytes = id => { assert.equal(id, "plain"); return bytes; };
    const metrics = [];
    const { createCanvas, loadImage } = require("@napi-rs/canvas");
    const pixels = async bytes => { const c = createCanvas(320, 240), ctx = c.getContext("2d"); ctx.drawImage(await loadImage(bytes), 0, 0); return ctx.getImageData(0, 0, 320, 240).data; };
    for (const platform of process.platform === "linux" ? ["headless", "x11"] : [undefined]) {
      const outDir = path.join(scratch, platform || "native");
      const result = await renderModelPosterBatch(requests, { outDir, modelBytes, ozonePlatform: platform });
      assert.equal(result.results.length, 2);
      assert.ok(result.renderer.length > 3);
      assert.ok(result.spawnMs > 0);
      metrics.push({ platform, ...result, results: result.results.map(({ path: _path, ...item }) => item) });
      h.ok(true, `${platform || "native"}: positive WebGL2 boot, two real PNG posters (${result.renderer})`);
      const a = await fs.readFile(result.results[0].path), b = await fs.readFile(result.results[1].path);
      const rgba = await pixels(a);
      const covered = Array.from({ length: 320 * 240 }, (_, i) => rgba[i * 4 + 3]).filter(alpha => alpha > 10).length;
      assert.ok(covered > 320 * 240 * .02 && covered < 320 * 240 * .9, `model pixels with transparent margin (${covered} covered)`);
      assert.notDeepEqual(a, b, "different views of an asymmetric mesh produce different image bytes");
      for (const [i, file] of result.results.entries()) await fs.copyFile(file.path, path.join(artifacts, `${platform || "native"}-${i}.png`));
      // A second process gives both a warm filesystem spawn measurement and determinism evidence.
      const repeat = await renderModelPosterBatch([requests[0]], { outDir, modelBytes, ozonePlatform: platform });
      assert.deepEqual(await fs.readFile(repeat.results[0].path), a, "same renderer/state/size deterministically reproduce the PNG");
      metrics.push({ platform, repeat: true, ...repeat, results: repeat.results.map(({ path: _path, ...item }) => item) });
    }
    // Fresh browser rendering makes parity evidence independent of stale artifacts.
    const { launch, errors } = await import("./lib/driver.mjs");
    const { browser, page } = await launch({ width: 320, height: 240 });
    try {
      const runtime = await fs.readFile(path.join(repo, "dist/flux-model3d-runtime.js"), "utf8");
      await page.setContent(modelPosterHtml(runtime, requests, { plain: bytes.toString("base64") }));
      const response = await page.evaluate(async () => { await window.fluxModel3dPosterReady; return window.fluxModel3dPoster.render(0); });
      const browserBytes = Buffer.from(response.png, "base64"), reference = await pixels(browserBytes);
      const comparisons = {};
      for (const platform of process.platform === "linux" ? ["headless", "x11"] : ["native"]) {
        const nativeBytes = await fs.readFile(path.join(artifacts, `${platform}-0.png`)), actual = await pixels(nativeBytes);
        let sum = 0, changed = 0, max = 0;
        for (let i = 0; i < actual.length; i += 4) {
          let pixelMax = 0;
          for (let c = 0; c < 4; c++) { const delta = Math.abs(reference[i + c] - actual[i + c]); sum += delta; pixelMax = Math.max(pixelMax, delta); max = Math.max(max, delta); }
          if (pixelMax > 2) changed++;
        }
        const parity = comparisons[platform] = { mean: sum / actual.length, changedRatio: changed / (actual.length / 4), max };
        assert.ok(parity.mean < .5 && parity.changedRatio < .005, `${platform} browser/native pixel parity ${JSON.stringify(parity)}`);
        h.ok(true, `fresh browser/${platform} parity (mean ${parity.mean}, changed ${parity.changedRatio})`);
      }
      assert.deepEqual(errors(page), []);
      await fs.writeFile(path.join(artifacts, "browser-reference.png"), browserBytes);
      await fs.writeFile(path.join(artifacts, "browser-parity.json"), JSON.stringify(comparisons, null, 2) + "\n");
    } finally { await browser.close(); }
    const controller = new AbortController(); controller.abort();
    await assert.rejects(renderModelPosterBatch(requests, { outDir: path.join(scratch, "cancelled"), modelBytes, signal: controller.signal }), /cancelled/);
    assert.equal(await fs.stat(path.join(scratch, "cancelled")).catch(() => null), null);
    h.ok(true, "cancel before spawn publishes no output");
    const active = new AbortController();
    await assert.rejects(renderModelPosterBatch(Array.from({ length: 20 }, (_, i) => ({ ...requests[0], key: `m3d-${String(i + 100).padStart(14, "0")}` })), {
      outDir: path.join(scratch, "cancel-active"), modelBytes, signal: active.signal,
      onProgress: message => { if (message.phase === "rendering") active.abort(); },
    }), /cancelled/);
    assert.equal(await fs.stat(path.join(scratch, "cancel-active")).catch(() => null), null);
    h.ok(true, "cancel after a rendered frame waits for worker exit and publishes no partial batch");
    await assert.rejects(renderModelPosterBatch(requests, { outDir: path.join(scratch, "timeout"), modelBytes, deadlineMs: 1 }), /timed out/);
    assert.equal(await fs.stat(path.join(scratch, "timeout")).catch(() => null), null);
    h.ok(true, "deadline termination publishes no output");
    const waiting = new AbortController();
    let startRead;
    const readStarted = new Promise(resolve => { startRead = resolve; });
    let cancelledSource = false;
    const stalled = renderModelPosterBatch(requests, {
      outDir: path.join(scratch, "stalled"), signal: waiting.signal,
      modelBytes: (_id, signal) => { startRead(); signal.addEventListener("abort", () => { cancelledSource = true; }, {once:true}); return new Promise(() => {}); },
    });
    await readStarted; waiting.abort();
    await assert.rejects(stalled, /cancelled/);
    assert.ok(cancelledSource, "byte reader receives the batch cancellation signal");
    await assert.rejects(renderModelPosterBatch(requests, { outDir: path.join(scratch, "stalled-deadline"), deadlineMs: 25, modelBytes: () => new Promise(() => {}) }), /timed out/);
    assert.equal(await fs.stat(path.join(scratch, "stalled")).catch(() => null), null);
    assert.equal(await fs.stat(path.join(scratch, "stalled-deadline")).catch(() => null), null);
    h.ok(true, "cancellation and deadline also interrupt a stalled model byte read");
    assert.throws(() => validateJob({ version: 1, html: "/etc/passwd", requests: [{ key: requests[0].key, w: 320, h: 240 }] }, scratch), /path/);
    assert.throws(() => validateJob({ version: 1, html: path.join(scratch, "poster.html"), requests: [{ key: "../escape", w: 320, h: 240 }] }, scratch), /key/);
    h.ok(true, "worker refuses out-of-job HTML and output traversal");
    const html = modelPosterHtml("window.FluxModel3dRuntime={};", [{ ...requests[0], spec: { ...specs[0], assetId: "</script><script>bad()</script>" } }], {});
    assert.equal((html.match(/<script>/g) || []).length, 2);
    const scripts = [...html.matchAll(/<script>(.*?)<\/script>/gs)].map(match => match[1]);
    for (const script of scripts) assert.ok(html.includes(createHash("sha256").update(script).digest("base64")));
    assert.ok(html.includes("connect-src 'none'"));
    h.ok(true, "untrusted payload cannot terminate scripts; CSP hashes exact bytes and forbids connections");
    // Exercise the native request allowlist independently of the page CSP. This
    // page intentionally has no CSP, catches fetch refusal and returns a valid PNG.
    const { createServer } = require("node:http"), { TestProcessScope } = await import("./lib/testProcess.mjs");
    let requestsReceived = 0;
    const server = createServer((_req, res) => { requestsReceived++; res.setHeader("Access-Control-Allow-Origin", "*"); res.end("unexpected"); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const scope = new TestProcessScope();
    try {
      const attackDir = path.join(scratch, "allowlist"), attackHtml = path.join(attackDir, "poster.html"), attackJob = path.join(attackDir, "job.json");
      await fs.mkdir(attackDir);
      await fs.writeFile(attackHtml, `<script>window.fluxModel3dPosterReady=Promise.resolve({renderer:'allowlist-test',readyMs:0});window.fluxModel3dPoster={async render(){await fetch('http://127.0.0.1:${server.address().port}/forbidden').catch(()=>{});const c=document.createElement('canvas');c.width=2;c.height=2;return{png:c.toDataURL().split(',')[1],metrics:{}}}}</script>`);
      await fs.writeFile(attackJob, JSON.stringify({ version: 1, html: attackHtml, requests: [{ key: requests[0].key, w: 2, h: 2 }] }));
      const binary = process.env.FLUX_MODEL3D_ELECTRON || require("electron");
      const child = scope.spawn(path.join(repo, "electron/entry.cjs"), process.platform === "linux" ? ["--ozone-platform=headless"] : [], {
        command: binary, nodeArgs: [], cwd: repo, deadlineMs: 30000,
        env: { ...process.env, FLUX_MODEL3D_POSTER_WORKER: "1", FLUX_MODEL3D_POSTER_JOB: attackJob },
      });
      const result = await scope.waitExit(child);
      assert.notEqual(result.code, 0);
      assert.match(child.stdout, /forbidden resource/);
      assert.equal(requestsReceived, 0);
      h.ok(true, "native allowlist blocks an actual loopback request even without a page CSP");
    } finally { await scope.dispose(); await new Promise(resolve => server.close(resolve)); }
    await fs.writeFile(path.join(artifacts, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
  } finally {
    if (previousElectron === undefined) delete process.env.FLUX_MODEL3D_ELECTRON; else process.env.FLUX_MODEL3D_ELECTRON = previousElectron;
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
import("./lib/harness.mjs").then(async ({ harness }) => {
  const h = harness("verify-model3d-poster-worker");
  try { await main(h); } catch (error) { console.error(error); h.fail(String(error.message || error)); }
  await h.done();
});
