// verify-tiff-app (pure tier, Node only): TIFF import IN THE APP, below the window.
//   * the conversion child's protocol end to end (electron/tiffConvert.cjs → the bundled electron/tiffWorker.mjs):
//     probe with a PNG preview, previews under answers (transposed, flipped, de-interleaved), convert with monotone
//     progress at most ten times a second, a result identical to flux-core's convertTiff (the content id);
//   * cancel at several points, a stuck child killed after the grace period, a crashing child: no staging folder,
//     no bundle, and the next request starts a new child;
//   * the IPC family (electron/ipc/tiff.cjs) with its per-window checks: read capability on both file sides (a path
//     needs the window's approval; a drop is its own), tokens, the asset id, publish by one rename, two conversions
//     queued, a project switch or a reopen mid-conversion refused and cleaned, a closed window cleaned;
//   * the in-memory bridge's twin (project/memTiff.ts) through the dev server's real route (scripts/lib/tiffDevRoutes.mjs):
//     the same refusals in the same words, the same content id;
//   * remembered answers: the list rules, the machine's store round trip on both bridges, fingerprint matching and
//     re-validation against another page count.
// Synthetic TIFFs only (scripts/lib/tiffFixtures.ts).   npx tsx scripts/verify-tiff-app.ts
import fs from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { harness } from "./lib/harness.mjs";
import { writeTiff, writeStackFile, rng } from "./lib/tiffFixtures";
import { convertTiff, probeTiff } from "../flux-core/tiffConvert";
import { decodePng } from "../flux-core/fluximgPng";
import { answerRule, applyRule, inferDims, describeAnswer } from "../src/lib/tiff/infer";
import { consultedRules, forgetRule, rememberRule, sanitizeRules } from "../src/lib/tiff/remember";
import { createMemBridge } from "../src/lib/project/memBridge";
import { buildTiffWorker } from "./build-tiff-worker.mjs";
import { createTiffDevRoutes } from "./lib/tiffDevRoutes.mjs";
import * as ops from "../src/lib/tiff/askOps";
import { pathToFileURL } from "node:url";
import type { DimsAnswer } from "../src/lib/tiff/types";

const h = harness("verify-tiff-app");
const require = createRequire(import.meta.url);
const { createTiffConverter, removeStaging } = require("../electron/tiffConvert.cjs");
const { createTiffFamily } = require("../electron/ipc/tiff.cjs");
const { createFileCore } = require("../electron/ipc/files.cjs");
const { CHANNELS } = require("../electron/ipc/contract.cjs");
const files = require("../electron/fluximgFiles.cjs");
const repo = path.resolve(import.meta.dirname, "..");
const workerFile = path.join(repo, "electron/generated/tiffWorker.bundle.mjs");

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "flux-tiff-app-"));
const project = path.join(scratch, "project"), outside = path.join(scratch, "outside");
const assets = path.join(project, "fig", "assets");
await fs.mkdir(path.join(project, "data"), { recursive: true });
await fs.mkdir(outside, { recursive: true });
await fs.writeFile(path.join(project, "project.json"), JSON.stringify({ schemaVersion: "0.7.0" }));

async function rejects(p: Promise<unknown> | (() => Promise<unknown>), re: RegExp, msg: string): Promise<string> {
  try { await (typeof p === "function" ? p() : p); h.fail(`${msg}: expected a refusal matching ${re}, got success`); return ""; }
  catch (e) { const m = e instanceof Error ? e.message : String(e); h.ok(re.test(m), re.test(m) ? msg : `${msg}: expected ${re}, got: ${m}`); return m; }
}
const leftovers = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith(".")) : []);
const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (fn: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 10)); } return true; };

// ---- synthetic files ----------------------------------------------------------------------------------------
const r = rng(7);
/** A metadata-free stack: `t` frames x 2 interleaved channels of different brightness, stored (x, y). */
function twoChannel(t: number, W: number, H: number) {
  return writeTiff({ pages: Array.from({ length: t * 2 }, (_, p) => { const d = new Uint16Array(W * H); for (let i = 0; i < d.length; i++) d[i] = (p % 2 ? 4000 : 400) + Math.floor(r() * 50) + 3 * (i % W); return { width: W, height: H, dtype: "uint16" as const, data: d }; }) });
}
const imagejDesc = (c: number, z: number, t: number) => `ImageJ=1.54f\nimages=${c * z * t}\nchannels=${c}\nslices=${z}\nframes=${t}\nhyperstack=true\nunit=micron\nspacing=0.5\nfinterval=0.1\n`;
const stack = path.join(project, "data", "rec_01.tif");
await fs.writeFile(stack, twoChannel(12, 40, 30));
const family2 = path.join(project, "data", "rec_02.tif"); // same structure, another page count
await fs.writeFile(family2, twoChannel(9, 40, 30));
const ij = path.join(project, "data", "hyper.tif");
await fs.writeFile(ij, writeTiff({ pages: Array.from({ length: 2 * 3 * 2 }, (_, p) => ({ width: 24, height: 16, dtype: "uint8" as const, data: Uint8Array.from({ length: 24 * 16 }, (_, i) => (p * 7 + i) % 251), descriptions: p === 0 ? [imagejDesc(2, 3, 2)] : [], resolution: { x: 2, y: 2, unit: 1 } })) }));
const ext = path.join(outside, "ext.tif");
await fs.writeFile(ext, twoChannel(4, 20, 10));
const jpeg = path.join(project, "data", "jpeg.tif");
await fs.writeFile(jpeg, writeTiff({ pages: [{ width: 8, height: 8, dtype: "uint8", data: new Uint8Array(64), compressionCode: 7 }] }));
// Big enough to cancel at several points: 1200 planes of 192 x 160 uint16, IFDs at the end.
const big = path.join(project, "data", "big.tif");
await writeStackFile(big, { width: 192, height: 160, pages: 1200, dtype: "uint16", fill: (p, plane) => { for (let i = 0; i < plane.length; i++) plane[i] = (p * 31 + i * 7) & 0xfff; } });
const A2: DimsAnswer = { dims: [{ name: "t", size: "rest" }, { name: "c", size: 2 }] };

try {
  h.section("the bundle: built by the shared hooks, Node built-ins only");
  await buildTiffWorker();
  h.ok(existsSync(workerFile), "electron/generated/tiffWorker.bundle.mjs exists after the build");
  const text = await fs.readFile(workerFile, "utf8");
  const imports = [...text.matchAll(/(?:^|\n)import[^"']*["']([^"']+)["']/g)].map((m) => m[1]);
  h.ok(imports.every((s) => s.startsWith("node:")), `the child imports only Node's own modules (${[...new Set(imports)].join(", ")})`);
  for (const f of ["scripts/gen-slide-embed-assets.mjs", "scripts/build-cli.mjs"]) h.ok((await fs.readFile(path.join(repo, f), "utf8")).includes("buildTiffWorker()"), `${f} builds it (the figure raster worker's hooks)`);
  const builder = await fs.readFile(path.join(repo, "electron-builder.yml"), "utf8");
  const unpack = builder.slice(builder.indexOf("asarUnpack:"));
  h.ok(/^\s+- electron\/\*\*\/\*$/m.test(builder.slice(0, builder.indexOf("asarUnpack:"))) && /- electron\/generated\/tiffWorker\.bundle\.mjs/.test(unpack) && /- electron\/generated\/tiffThumb\.bundle\.mjs/.test(unpack), "the packaged app ships both bundles (electron/**) and unpacks them (a Node-mode child cannot read asar)");

  h.section("the child: probe, previews, convert");
  const conv = createTiffConverter({ workerFile, cwd: repo });
  let t0 = performance.now();
  const pr = await conv.request("probe", { path: stack }).promise;
  const probeMs = performance.now() - t0;
  const direct = await probeTiff(stack);
  h.eq(pr.probe.fingerprint, direct.probe.fingerprint, "the child's probe is flux-core's probe (same fingerprint)");
  h.eq(pr.proposals.map((p: { summary: string }) => p.summary), direct.proposals.map((p) => p.summary), "…and the same ranked proposals");
  h.ok(!pr.proposals[0].ready, `a metadata-free stack is not ready: "${pr.proposals[0].summary}" (${pr.proposals[0].confidence})`);
  const png0 = decodePng(Buffer.from(pr.preview.channels[0].png, "base64"));
  h.ok(pr.preview.channels.length === 2 && png0.width === 40 && png0.height === 30 && png0.width <= 512, `the probe carries the top proposal's pictures: ${pr.preview.channels.length} channels, PNG ${png0.width} x ${png0.height} (${probeMs.toFixed(0)} ms with the child's start)`);
  t0 = performance.now();
  const pt = await conv.request("preview", { path: stack, answer: { ...A2, transpose: true } }).promise;
  const pvMs = performance.now() - t0;
  h.ok(pt.channels[0].width === 30 && pt.channels[0].height === 40 && pt.plane.width === 30, `transposed, the pictures turn (${pt.channels[0].width} x ${pt.channels[0].height}) in ${pvMs.toFixed(1)} ms`);
  h.ok(pvMs < 100, `a re-preview of an ordinary file is under 100 ms (${pvMs.toFixed(1)} ms)`);
  h.ok(pt.channels[0].window[1] < 1000 && pt.channels[1].window[0] > 3000, `de-interleaved, each channel is its own pages (windows ${pt.channels.map((c: { window: number[] }) => c.window.map(Math.round).join("–")).join(" / ")})`);
  const pf = await conv.request("preview", { path: stack, answer: { ...A2, flipX: true } }).promise;
  h.ok(pf.channels[0].png !== pr.preview.channels[0].png, "flipped, the picture changes");
  const bad = await conv.request("preview", { path: stack, answer: { dims: [{ name: "t", size: 5 }] } }).promise;
  h.ok(bad.fallback && bad.channels.length === 1, "an answer that does not fit still gets a picture: the representative page, marked");
  const out1 = path.join(scratch, "conv1", "a.fluximg");
  await fs.mkdir(path.dirname(out1));
  const prog: Array<{ phase: string; fraction: number; elapsedMs: number }> = [];
  const res1 = await conv.request("convert", { path: big, answer: { dims: [{ name: "t", size: "rest" }] }, out: out1, name: "big", sourcePath: "data/big.tif" }, { onProgress: (p: never) => prog.push(p) }).promise;
  const ref = await convertTiff(big, { dims: [{ name: "t", size: "rest" }] }, path.join(scratch, "conv1", "ref.fluximg"), { name: "big", sourcePath: "data/big.tif" });
  h.eq(res1.sha256, ref.sha256, "the child's bundle is flux-core's convertTiff bundle (the same content id)");
  h.eq(res1.manifest, ref.manifest, "…and the same manifest");
  h.ok(prog.length >= 2 && prog.every((p, i) => i === 0 || p.fraction >= prog[i - 1].fraction) && prog.at(-1)!.fraction === 1, `progress is monotone and ends at 1 (${prog.length} updates; ${prog.map((p) => p.phase[0]).join("")})`);
  const span = prog.at(-1)!.elapsedMs - prog[0].elapsedMs;
  h.ok(prog.length <= span / 100 + 3, `…at most ten a second (${prog.length} in ${span} ms)`);

  h.section("the child: cancel at several points, a stuck child, a crash");
  for (const [label, when] of [["at once", 0], ["at the first progress", 1], ["in the store pass", -1]] as const) {
    const out = path.join(scratch, `cancel-${when}`, "c.fluximg");
    await fs.mkdir(path.dirname(out));
    let job: { id: number; promise: Promise<unknown> } | null = null, seen = 0;
    job = conv.request("convert", { path: big, answer: { dims: [{ name: "t", size: "rest" }] }, out }, { onProgress: (p: { phase: string }) => { seen++; if ((when === 1 && seen === 1) || (when === -1 && p.phase === "store")) conv.cancel(job!.id); } });
    if (when === 0) conv.cancel(job.id);
    const pid = conv.pid;
    await rejects(job.promise, /cancelled/, `cancelled ${label}: the request ends as cancelled`);
    h.eq({ left: leftovers(path.dirname(out)), out: existsSync(out) }, { left: [], out: false }, `…no staging folder, no bundle`);
    h.ok(alive(pid), "…and a polite cancel leaves the child running for the next request");
  }
  {
    // A child that does not answer its cancel (stopped) is killed after the grace period; the caller cleans up.
    const quick = createTiffConverter({ workerFile, cwd: repo, graceMs: 300 });
    const out = path.join(scratch, "stuck", "s.fluximg");
    await fs.mkdir(path.dirname(out));
    let stopped = false;
    const job = quick.request("convert", { path: big, answer: { dims: [{ name: "t", size: "rest" }] }, out }, { onProgress: () => { if (!stopped) { stopped = true; process.kill(quick.pid!, "SIGSTOP"); quick.cancel(job.id); } } });
    const pid = quick.pid;
    await rejects(job.promise, /cancelled/, "a stuck child's job ends as cancelled after the grace period");
    h.ok(await waitFor(() => !alive(pid)), "…the stuck child is gone");
    await removeStaging(out);
    h.eq(leftovers(path.dirname(out)), [], "…and removeStaging leaves nothing behind it");
    const again = await quick.request("probe", { path: stack }).promise;
    h.ok(again.probe && quick.pid !== pid, "the next request starts a new child");
    quick.close();
  }
  {
    const out = path.join(scratch, "crash", "k.fluximg");
    await fs.mkdir(path.dirname(out));
    let killed = false;
    const job = conv.request("convert", { path: big, answer: { dims: [{ name: "t", size: "rest" }] }, out }, { onProgress: () => { if (!killed) { killed = true; process.kill(conv.pid!, "SIGKILL"); } } });
    const pid = conv.pid;
    const m = await rejects(job.promise, /killed|exit/, "a child killed mid-conversion: the request fails (it never hangs)");
    void m;
    await removeStaging(out);
    h.eq(leftovers(path.dirname(out)), [], "…its staging folder is removed by the caller");
    h.ok(!alive(pid) && !!(await conv.request("probe", { path: stack }).promise).probe, "…and the next request starts a new child");
  }
  conv.close();

  h.section("IPC family: channels, read capability, tokens, publish");
  const handlers = new Map<string, (...args: any[]) => any>();
  const sends: Array<[string, any]> = [];
  const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false, send: (ch: string, v: object) => sends.push([ch, { ...v, at: performance.now() }]) });
  let currentRoot = project, generation = 1;
  const fileCore = createFileCore({ app: { getPath: (kind: string) => path.join(scratch, `app-${kind}`) }, dialog: {}, shell: {}, roots: () => [project], windowFor: () => null });
  const rulesFile = path.join(scratch, "FluxConfig", "presets", "tiff-answers.json");
  const fam = createTiffFamily({ app: { isPackaged: false }, appRoot: repo, rootFor: () => currentRoot, generationFor: () => generation, fsReadGuard: fileCore.fsReadGuard, globalRulesFile: () => rulesFile });
  fam.registerHandlers({ handle: (n: string, fn: (...args: any[]) => any) => handlers.set(n, fn) });
  const declared = CHANNELS.filter((c: { channel: string; kind: string }) => c.channel.startsWith("tiff:") && c.kind === "invoke").map((c: { channel: string }) => c.channel).sort();
  h.eq([...handlers.keys()].sort(), declared, `the family registers exactly the declared tiff:* channels (${declared.length})`);
  h.ok(CHANNELS.some((c: { channel: string; kind: string }) => c.channel === "tiff:progress" && c.kind === "push"), "tiff:progress is a declared push");
  const call = (n: string, payload: unknown) => Promise.resolve().then(() => handlers.get(`tiff:${n}`)!({ sender }, payload));
  const p1 = await call("probe", { root: project, sourcePath: "data/rec_01.tif" });
  h.ok(typeof p1.token === "string" && p1.sourcePath === "data/rec_01.tif" && !p1.external && p1.preview.channels.length === 2, "a project-relative TIFF probes (token, recorded path, pictures)");
  await rejects(call("probe", { root: project, sourcePath: ext }), /refused path/, "a TIFF outside the project needs the window's read capability");
  const pd = await call("probeDropped", { root: project, sourcePath: ext });
  h.ok(pd.external && pd.sourcePath === ext, "…a DROP is its own capability (tiff:probeDropped: only the preload reaches it)");
  fileCore.approveDir(sender.id, ext);
  h.ok(!!(await call("probe", { root: project, sourcePath: ext })).token, "…and a dialog's approval grants it");
  await rejects(call("probe", { root: outside, sourcePath: "data/rec_01.tif" }), /project changed/, "a root other than the window's project is refused");
  await rejects(call("preview", { root: project, token: "nope", answer: A2 }), /no longer open/, "a token this window never got is refused");
  const pv = await call("preview", { root: project, token: p1.token, answer: { ...A2, transpose: true } });
  h.ok(pv.channels[0].width === 30, "previews name the token, never a path");
  await rejects(call("convert", { root: project, token: p1.token, answer: A2, assetId: "../x", jobId: "j0" }), /Invalid image asset id/, "the asset id is checked as for a bundle import");
  const c1 = await call("convert", { root: project, token: p1.token, answer: A2, assetId: "img-two", jobId: "j1" });
  h.ok(c1.path === "assets/img-two.fluximg" && existsSync(path.join(assets, "img-two.fluximg", "fluximg.json")) && c1.method === "convert", "convert publishes fig/assets/<id>.fluximg by one rename");
  const viaCore = await convertTiff(stack, A2, path.join(scratch, "ref-two.fluximg"), { name: "rec_01", sourcePath: "data/rec_01.tif" });
  h.eq(c1.sha256, viaCore.sha256, "…with flux-core's content id for the same file and answer");
  const imported = await files.importBundle({ root: project, sourcePath: path.join(assets, "img-two.fluximg"), assetId: "img-two-copy" });
  h.eq(imported.sha256, c1.sha256, "…which is the id a bundle import of the published folder computes (dedupe works)");
  h.ok(Array.isArray(c1.notes), `the result carries the writer's notes (${c1.notes.length} for integer data)`);
  h.eq(leftovers(assets), [], "nothing hidden is left in fig/assets");
  await rejects(call("convert", { root: project, token: p1.token, answer: A2, assetId: "img-two", jobId: "j2" }), /already exists/, "an asset id in use is refused");
  await rejects(call("convert", { root: project, token: p1.token, answer: { dims: [{ name: "t", size: 5 }] }, assetId: "img-bad", jobId: "j3" }), /does not fit/, "an answer that does not fit is the core's refusal, in words");
  const pj = await call("probe", { root: project, sourcePath: "data/jpeg.tif" });
  h.ok(pj.probe.refusals.length === 1 && /JPEG/i.test(pj.probe.refusals[0].message) && pj.preview === null, `a JPEG-compressed TIFF is refused at the probe: "${pj.probe.refusals[0]?.message}"`);
  await rejects(call("probe", { root: project, sourcePath: "data/missing.tif" }), /does not exist/, "a missing file is named");
  await rejects(call("probe", { root: project, sourcePath: "project.json" }), /not a TIFF/, "a file that is not a TIFF is refused by its name");
  await rejects(call("probe", { root: project, sourcePath: "../outside/ext.tif" }), /outside the project/, "a relative path that climbs out of the project is refused");

  h.section("IPC family: queue, cancel, project change, closed window");
  const pb = await call("probe", { root: project, sourcePath: "data/big.tif" });
  sends.length = 0;
  const qa = call("convert", { root: project, token: pb.token, answer: { dims: [{ name: "t", size: "rest" }] }, assetId: "img-qa", jobId: "qa" });
  const qb = call("convert", { root: project, token: p1.token, answer: A2, assetId: "img-qb", jobId: "qb" });
  const [ra, rb] = await Promise.all([qa, qb]);
  const order = sends.filter(([ch]) => ch === "tiff:progress").map(([, v]) => v);
  const firstB = order.findIndex((v) => v.jobId === "qb" && v.phase), lastA = order.map((v) => v.jobId).lastIndexOf("qa");
  h.ok(order.some((v) => v.jobId === "qb" && v.queued === 1), "a second conversion of the window queues (its progress says so)");
  h.ok(firstB > lastA && !!ra.sha256 && !!rb.sha256, "…and runs once the first has finished; both publish");
  const qaStamps = order.filter((v) => v.jobId === "qa" && v.elapsedMs !== undefined).map((v) => v.at);
  h.ok(qaStamps.length >= 2 && qaStamps.every((v, i) => i === 0 || v - qaStamps[i - 1] >= 95), `progress reaches the window at most ten times a second (${qaStamps.length} updates, gaps ≥ ${Math.min(...qaStamps.slice(1).map((v, i) => v - qaStamps[i])).toFixed(0)} ms)`);
  // Cancel while running, and while queued.
  const cr = call("convert", { root: project, token: pb.token, answer: { dims: [{ name: "t", size: "rest" }] }, assetId: "img-cr", jobId: "cr" });
  const cq = call("convert", { root: project, token: p1.token, answer: A2, assetId: "img-cq", jobId: "cq" });
  await new Promise((r) => setTimeout(r, 30));
  await call("cancel", "cq");
  await rejects(cq, /cancelled/, "a queued conversion cancelled never starts");
  await waitFor(() => sends.some(([, v]) => v.jobId === "cr" && v.phase));
  await call("cancel", "cr");
  await rejects(cr, /cancelled/, "a running conversion cancelled ends as cancelled");
  h.eq({ left: leftovers(assets), cr: existsSync(path.join(assets, "img-cr.fluximg")), cq: existsSync(path.join(assets, "img-cq.fluximg")) }, { left: [], cr: false, cq: false }, "…no staging folder, no bundle");
  // The project is reopened mid-conversion: refused, cleaned.
  sends.length = 0;
  const cg = call("convert", { root: project, token: pb.token, answer: { dims: [{ name: "t", size: "rest" }] }, assetId: "img-cg", jobId: "cg" });
  await waitFor(() => sends.some(([, v]) => v.jobId === "cg" && v.phase));
  generation++;
  await rejects(cg, /cancelled|project changed/, "a reopen (watch generation) mid-conversion stops it");
  h.eq({ left: leftovers(assets), cg: existsSync(path.join(assets, "img-cg.fluximg")) }, { left: [], cg: false }, "…and leaves nothing");
  const p2 = await call("probe", { root: project, sourcePath: "data/big.tif" });
  sends.length = 0;
  const cs = call("convert", { root: project, token: p2.token, answer: { dims: [{ name: "t", size: "rest" }] }, assetId: "img-cs", jobId: "cs" });
  await waitFor(() => sends.some(([, v]) => v.jobId === "cs" && v.phase));
  currentRoot = outside;
  await rejects(cs, /cancelled|project changed/, "a project switch mid-conversion stops it");
  currentRoot = project;
  h.eq({ left: leftovers(assets), cs: existsSync(path.join(assets, "img-cs.fluximg")) }, { left: [], cs: false }, "…and leaves nothing");
  // Publication is refused when the project changed between the end of the work and the rename.
  {
    const p3 = await call("probe", { root: project, sourcePath: "data/rec_01.tif" });
    const owner = fam._owner(sender.id);
    const real = owner.converter.request;
    owner.converter.request = (op: string, payload: unknown, o: unknown) => { const j = real(op, payload, o); return { id: j.id, promise: j.promise.then((v: unknown) => { if (op === "convert") generation++; return v; }) }; };
    await rejects(call("convert", { root: project, token: p3.token, answer: A2, assetId: "img-late", jobId: "late" }), /project changed/, "a finished conversion is not published into a project that was reopened meanwhile");
    owner.converter.request = real;
    h.eq({ left: leftovers(assets), late: existsSync(path.join(assets, "img-late.fluximg")) }, { left: [], late: false }, "…its staging folder is removed");
  }
  // A closed window: its jobs are cancelled and cleaned; its child exits.
  {
    const p4 = await call("probe", { root: project, sourcePath: "data/big.tif" });
    sends.length = 0;
    const cw = call("convert", { root: project, token: p4.token, answer: { dims: [{ name: "t", size: "rest" }] }, assetId: "img-cw", jobId: "cw" });
    await waitFor(() => sends.some(([, v]) => v.jobId === "cw" && v.phase));
    const pid = fam._owner(sender.id).converter.pid;
    sender.emit("destroyed");
    await rejects(cw, /cancelled/, "a window closed mid-conversion cancels it");
    h.eq({ left: leftovers(assets), cw: existsSync(path.join(assets, "img-cw.fluximg")) }, { left: [], cw: false }, "…leaves nothing");
    h.ok(await waitFor(() => !alive(pid), 8000), "…and its child exits");
  }

  h.section("remembered answers: list rules, fingerprints, re-validation");
  const probeA = (await probeTiff(stack)).probe, probeB = (await probeTiff(family2)).probe;
  h.eq(probeA.fingerprint, probeB.fingerprint, "two files of one family share a fingerprint whatever their page count (24 and 18 pages)");
  const rule = answerRule({ ...A2, dims: [{ name: "t", size: 12 }, { name: "c", size: 2 }], transpose: true, pixelSize: { x: 0.25, unit: "µm" }, time: { rate: 80 } }, probeA);
  h.eq(rule.answer.dims[0].size, "rest", "a remembered rule keeps the slowest size open (\"the rest\")");
  const top = inferDims(probeB, { rules: [rule] })[0];
  h.ok(top.from === "remembered" && top.ready && top.summary.startsWith("t 9 × c 2"), `a file of the family is answered at once: "${top.summary}"`);
  const odd = path.join(project, "data", "rec_03.tif");
  await fs.writeFile(odd, writeTiff({ pages: Array.from({ length: 9 }, () => ({ width: 40, height: 30, dtype: "uint16" as const, data: new Uint16Array(1200) })) }));
  const probeOdd = (await probeTiff(odd)).probe;
  h.ok(probeOdd.fingerprint === probeA.fingerprint && !inferDims(probeOdd, { rules: [rule] }).some((p) => p.from === "remembered"), "…a rule that does not fit another page count (9 pages, c 2) is not offered");
  h.ok(applyRule(rule, probeOdd).problems.length > 0, `…and says why: "${applyRule(rule, probeOdd).problems[0]}"`);
  const ijProbe = (await probeTiff(ij)).probe;
  h.ok(!inferDims(ijProbe, { rules: [rule] }).some((p) => p.from === "remembered"), "a rule of another structure is never applied");
  let list = rememberRule([], rule, describeAnswer(probeA, rule.answer), "2026-11-21");
  list = rememberRule(list, rule, "again", "2026-11-22");
  h.eq(list.length, 1, "remembering a fingerprint again replaces its rule");
  h.eq(sanitizeRules(JSON.parse(JSON.stringify({ rules: [...list, { rule: 2 }, { rule: 1, fingerprint: "zz", answer: {} }, null] }))), list, "a stored list reads back; malformed entries are dropped, never thrown on");
  h.eq(forgetRule(list, rule.fingerprint), [], "a rule is forgotten by its fingerprint");
  const machine = rememberRule([], { ...rule, answer: { ...rule.answer, transpose: false } }, "machine", "x");
  h.eq(consultedRules(list, machine).length, 1, "a project's rule wins over the machine's for the same fingerprint");
  h.ok(consultedRules(list, machine)[0].answer.transpose === true, "…(the project's is consulted)");
  await call("setRules", list);
  h.eq(sanitizeRules(await call("rules", undefined)), list, "the machine's store (FluxConfig presets/tiff-answers.json) round-trips through tiff:rules / tiff:setRules");
  h.ok(rulesFile.includes(`${path.sep}presets${path.sep}`) && existsSync(rulesFile), "…in FluxConfig's presets folder");
  fam.shutdown();

  h.section("the asking surface's edits (askOps), the no-data suggestion, the rail's picture, the CLI's rules");
  {
    const P = probeA;
    let x: DimsAnswer = { dims: [{ name: "t", size: "rest" }, { name: "c", size: 2 }], time: { rate: 80 }, channels: [{ name: "a" }, { name: "b" }] };
    h.eq(ops.resolvedSizes(P, x), [12, 2], "sizes resolve \"the rest\" from the page count");
    x = ops.moveDim(P, x, 1, 0);
    h.eq(x.dims.map((d) => d.name), ["c", "t"], "a page key drags to another place (slowest first)");
    h.eq(ops.nextName(x, 0), "", "c cycles on to a free name (t is taken)");
    h.eq(ops.nextName({ dims: [{ name: "t", size: "rest" }] }, 0), "z", "t cycles to z");
    h.ok(ops.nameProblem(x, 0, "x") !== null && ops.nameProblem(x, 0, "Trial") !== null && ops.nameProblem(x, 0, "t") !== null && ops.nameProblem(x, 0, "trial") === null, "a free name must be lower-case, not x or y, not taken");
    const r1 = ops.renameDim(P, x, 1, "z");
    h.ok(!r1.time && !!r1.channels, "renaming t away drops the time settings (tidy), channels stay");
    const r2 = ops.renameDim(P, x, 0, "trial");
    h.eq(r2.channels, [{ name: "a" }], "with no c there is one channel: only the first channel's settings stay");
    const sz = ops.setDimSize(P, { dims: [{ name: "t", size: "rest" }, { name: "c", size: 2 }] }, 1, "rest");
    h.eq(sz.dims.map((d) => d.size), [12, "rest"], "making a key the rest fixes the old rest at its value: at most one rest");
    h.eq(ops.addDim(P, { dims: [] }).dims, [{ name: "t", size: "rest" }], "the first added key is t, the rest");
    h.eq(ops.addDim(P, { dims: [{ name: "t", size: 24 }] }).dims, [{ name: "t", size: "rest" }, { name: "z", size: 2 }], "a second key goes fastest; the slowest becomes the rest");
    h.eq(ops.removeDim(P, { dims: [{ name: "t", size: "rest" }, { name: "c", size: 2 }] }, 0).dims, [{ name: "c", size: "rest" }], "removing the rest hands the rest on");
    h.eq(ops.toggle(ops.toggle({ dims: [] }, "transpose"), "transpose"), { dims: [] }, "toggles go on and off without leftovers");
    h.eq(ops.setTime({ dims: [{ name: "t", size: "rest" }], time: { rate: 80, t0: 2 } }, "interval", 0.0125).time, { interval: 0.0125, unit: "s", t0: 2 }, "rate to interval keeps t0");
    h.eq(ops.setChannel(P, { dims: [{ name: "t", size: "rest" }, { name: "c", size: 2 }] }, 1, { name: "red", color: "#ff0000" }).channels, [{}, { name: "red", color: "#ff0000" }], "a channel chip names and colours its channel");
    h.eq([ops.parseNumber("0.25"), ops.parseNumber(".5"), ops.parseNumber("1e-3"), ops.parseNumber("−1"), ops.parseNumber("x"), ops.parseNumber("")], [0.25, 0.5, 0.001, -1, null, null], "numbers typed in place");
    h.eq(ops.nextColour(null), "#00ff00", "a chip's colour cycles from gray to green, …");
    // A float stack with -1 written where nothing was scanned.
    const nd = path.join(project, "data", "holes.tif");
    await fs.writeFile(nd, writeTiff({ pages: Array.from({ length: 4 }, (_, p) => ({ width: 32, height: 24, dtype: "float32" as const, data: Float32Array.from({ length: 768 }, (_, i) => (i % 32 < 8 ? -1 : 10 + p + (i % 7))) })) }));
    const cv = createTiffConverter({ workerFile, cwd: repo });
    const ndp = await cv.request("probe", { path: nd }).promise;
    h.ok(ndp.preview.frequentMin?.value === -1 && ndp.preview.frequentMin.share > 0.2, `a frequent round minimum on a float plane is offered as "no data" (${JSON.stringify(ndp.preview.frequentMin)})`);
    const ndq = await cv.request("preview", { path: nd, answer: { dims: [{ name: "z", size: "rest" }], nodata: -1 } }).promise;
    h.ok(ndq.frequentMin === null && ndq.channels[0].window[0] >= 10, "…and once answered it is no data: the window ignores it");
    cv.close();
    const thumbMod = await import(pathToFileURL(path.join(repo, "electron/generated/tiffThumb.bundle.mjs")).href);
    const th = await thumbMod.tiffThumbPng(stack, 256);
    const dec = decodePng(th.png);
    h.ok(dec.width === 40 && dec.height === 30, `the rail's picture of a TIFF is a PNG of its middle plane (${dec.width} x ${dec.height})`);
    const engine = await fs.readFile(path.join(repo, "electron/plotThumbEngine.mjs"), "utf8");
    h.ok(/TIFF_RE\.test\(abs\)/.test(engine) && engine.includes("./generated/tiffThumb.bundle.mjs"), "the thumbnail engine draws TIFFs through that bundle");
    const thumbsIpc = await fs.readFile(path.join(repo, "electron/ipc/plotThumbs.cjs"), "utf8");
    const acceptRe = new RegExp(/const ACCEPT_RE = (\/.*\/);/.exec(thumbsIpc)![1].slice(1, -1));
    h.ok(acceptRe.test("svg,png,glb,mp4,mov,fluximg,tif,tiff") && acceptRe.test("svg,png,glb,fluximg,tif,tiff"), "the rail's accept lists with TIFFs pass the main process's accept rule");
    for (const f of ["src/lib/plotsRail/LeftRail.svelte", "src/lib/plotsRail/PlotsRail.svelte", "src/lib/plotsRail/GalleryPane.svelte"]) h.ok(/fluximg,tif,tiff/.test(await fs.readFile(path.join(repo, f), "utf8")), `${f} lists TIFFs`);
    // The CLI reads the project's remembered rules the way the app does.
    const { rememberedRules } = await import("../flux-core/tiffPlace");
    const pjPath = path.join(project, "project.json");
    const before = await fs.readFile(pjPath, "utf8");
    await fs.writeFile(pjPath, JSON.stringify({ ...JSON.parse(before), tiffRules: list }));
    const cliRules = await rememberedRules(project);
    h.ok(cliRules.some((r) => r.fingerprint === rule.fingerprint), "the CLI's place-image reads the project's remembered rules (project.json tiffRules)");
    h.ok(inferDims(probeB, { rules: cliRules })[0].from === "remembered", "…so a file of the family converts there without flags");
    await fs.writeFile(pjPath, before);
  }

  h.section("the in-memory bridge: the dev server's real route, the same refusals, the same content id");
  const routes = createTiffDevRoutes({ workerFile });
  const server = http.createServer((req, res) => { void routes.handler(req, res, () => { res.statusCode = 404; res.end(); }); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const mem = createMemBridge(), mroot = "/memproject";
    mem._setTiffEndpoint(`http://127.0.0.1:${port}`);
    mem._files.set(`${mroot}/project.json`, new TextEncoder().encode(JSON.stringify({ schemaVersion: "0.7.0" })));
    mem._files.set(`${mroot}/data/rec_01.tif`, new Uint8Array(await fs.readFile(stack)));
    mem._files.set(`${mroot}/data/big.tif`, new Uint8Array(await fs.readFile(big)));
    mem._files.set(`${mroot}/project.json.tif`, new Uint8Array(4));
    mem._dirs.add(`${mroot}/data/folder.tif`);
    await mem.watchRoot!(mroot);
    const mp = await mem.probeTiff!({ root: mroot, sourcePath: "data/rec_01.tif" });
    h.eq(mp.probe.fingerprint, p1.probe.fingerprint, "the memory bridge's probe is the child's");
    const mc = await mem.convertTiff!({ root: mroot, token: mp.token, answer: A2, assetId: "img-two", jobId: "m1" });
    // The bundle records its source's size and mtime: give the disk file the fixture's mtime and convert it natively.
    const mm = (await mem.stat!(`${mroot}/data/rec_01.tif`))!.mtimeMs;
    await fs.utimes(stack, mm / 1000, mm / 1000);
    const nref = await convertTiff(stack, A2, path.join(scratch, "ref-mem.fluximg"), { name: "rec_01", sourcePath: "data/rec_01.tif" });
    h.eq(mc.sha256, nref.sha256, "the memory bridge's conversion has the native content id");
    h.ok([...mem._files.keys()].some((k) => k === `${mroot}/fig/assets/img-two.fluximg/fluximg.json`), "…and its files are in the fixture's fig/assets");
    const mpv = await mem.previewTiff!({ root: mroot, token: mp.token, answer: { ...A2, transpose: true } });
    h.eq(mpv.channels.map((c) => [c.width, c.height]), pv.channels.map((c: { width: number; height: number }) => [c.width, c.height]), "…its previews are the native ones");
    // Same refusals, same words.
    const nativeFam = createTiffFamily({ app: { isPackaged: false }, appRoot: repo, rootFor: () => project, generationFor: () => 1, fsReadGuard: fileCore.fsReadGuard });
    const nh = new Map<string, (...args: any[]) => any>();
    nativeFam.registerHandlers({ handle: (n: string, fn: (...args: any[]) => any) => nh.set(n, fn) });
    const s2 = Object.assign(new EventEmitter(), { id: 9, isDestroyed: () => false, send: () => {} });
    const ncall = (n: string, payload: unknown) => Promise.resolve().then(() => nh.get(`tiff:${n}`)!({ sender: s2 }, payload));
    await fs.mkdir(path.join(project, "data", "folder.tif"), { recursive: true });
    await fs.writeFile(path.join(project, "project.json.tif"), "x");
    const ntok = (await ncall("probe", { root: project, sourcePath: "data/rec_01.tif" })).token;
    const cases: Array<[string, Record<string, unknown>]> = [
      ["probe", { sourcePath: "" }], ["probe", { sourcePath: "data/notes.txt" }], ["probe", { sourcePath: "../elsewhere/x.tif" }],
      ["probe", { sourcePath: "data/missing.tif" }], ["probe", { sourcePath: "data/folder.tif" }], ["probe", { sourcePath: 42 }],
      ["preview", { token: "nope", answer: A2 }], ["preview", { token: "@TOK", answer: null }],
      ["convert", { token: "@TOK", answer: A2, assetId: "../x", jobId: "z1" }], ["convert", { token: "@TOK", answer: A2, assetId: "ok-id", jobId: "bad id!" }],
      ["convert", { token: "@TOK", answer: A2, assetId: "img-two", jobId: "z2" }], ["convert", { token: "nope", answer: A2, assetId: "z", jobId: "z3" }],
    ];
    for (const [kind, req] of cases) {
      const fill = (tok: string) => Object.fromEntries(Object.entries(req).map(([k, v]) => [k, v === "@TOK" ? tok : v]));
      const native = await ncall(kind, { root: project, ...fill(ntok) }).then(() => "(ok)", (e: Error) => e.message);
      const memReq = { root: mroot, ...fill(mp.token) } as never;
      const memory = await (kind === "probe" ? mem.probeTiff!(memReq) : kind === "preview" ? mem.previewTiff!(memReq) : mem.convertTiff!(memReq)).then(() => "(ok)", (e: Error) => e.message);
      const same = native.replace(project, "<root>") === memory.replace(mroot, "<root>");
      h.ok(native !== "(ok)" && same, same ? `${kind} ${JSON.stringify(req).slice(0, 70)}: both refuse "${native.slice(0, 70)}"` : `${kind} ${JSON.stringify(req)}: native "${native}" vs memory "${memory}"`);
    }
    nativeFam.shutdown();
    await rejects(mem.probeTiff!({ root: "/elsewhere", sourcePath: "data/rec_01.tif" }), /project changed/, "memory probes are bound to the open project");
    // Cancel through the memory bridge: the route's child stops, nothing lands in the fixture.
    const mb = await mem.probeTiff!({ root: mroot, sourcePath: "data/big.tif" });
    let started = false;
    const off = mem.onTiffProgress!((p) => { if (p.jobId === "mc" && p.phase && !started) { started = true; void mem.cancelTiff!("mc"); } });
    await rejects(mem.convertTiff!({ root: mroot, token: mb.token, answer: { dims: [{ name: "t", size: "rest" }] }, assetId: "img-mc", jobId: "mc" }), /cancelled/, "a cancel through the memory bridge ends the conversion");
    off();
    h.ok(![...mem._files.keys()].some((k) => k.includes("img-mc")), "…and nothing lands in the fixture");
    // A project switch mid-conversion in the fixture.
    const mb2 = await mem.probeTiff!({ root: mroot, sourcePath: "data/big.tif" });
    let switched = false;
    const off2 = mem.onTiffProgress!((p) => { if (p.jobId === "ms" && p.phase && !switched) { switched = true; void mem.watchRoot!("/other"); } });
    await rejects(mem.convertTiff!({ root: mroot, token: mb2.token, answer: { dims: [{ name: "t", size: "rest" }] }, assetId: "img-ms", jobId: "ms" }), /cancelled|project changed/, "a project switch in the fixture stops a conversion");
    off2();
    h.ok(![...mem._files.keys()].some((k) => k.includes("img-ms")), "…and nothing lands");
    await mem.writeTiffRules!(list);
    h.eq(sanitizeRules(await mem.readTiffRules!()), list, "the fixture's machine store round-trips too");
    await new Promise((r) => setTimeout(r, 200));
    h.eq(readdirSync(os.tmpdir()).filter((n) => n.startsWith("flux-dev-tiff-")).flatMap((d) => { try { return readdirSync(path.join(os.tmpdir(), d), { recursive: true }).map(String).filter((f) => f.includes("out-")); } catch { return []; } }), [], "the dev route keeps no converted output once it is handed over");
  } finally {
    routes.close();
    server.close();
  }
} catch (error) {
  h.fail(`unexpected: ${error instanceof Error ? error.stack : String(error)}`);
}
await h.done(async () => { await fs.rm(scratch, { recursive: true, force: true }); });
