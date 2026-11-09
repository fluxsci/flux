// "Is every linked plot source current?" must cost no READ when nothing changed.
//
// The check ran at project open and on every change under plots/. It read each linked source twice
// plus its saved copy and round-tripped every manifest through JSON on the calling thread: on the
// owner's scratch project (113 linked plots, 34 MB manifests) 1.8 GB crossed the bridge and the
// editor froze for seconds each time one plot was regenerated (2026-11-09). A proof — the identity
// (path, size, mtime) of the source files and of the saved copy when they were last PROVEN equal by
// content — now lets an unchanged source skip every read. This gate holds what makes that sound.
import { harness } from "./lib/harness.mjs";
import { planSourceUpdates, proveSourceUpdates, writeSourceUpdates, SOURCE_PROOF_SETTLE_MS, type SourceProofs, type SourceUpdate } from "../src/lib/plot/sourceSync";
import type { Figure, Project } from "../src/lib/types";

const h = harness("verify-source-proofs");
const root = "/proj";
const svg = (color: string, w = 200) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="100"><rect width="${w}" height="100" fill="${color}"/></svg>`;
const manifest = (version: number) => JSON.stringify({ schemaVersion: "0.1.0", axes: [], series: [], version });

/** An in-memory disk with stat identity and a read ledger. `clock` is the filesystem's and the planner's time. */
function disk(opts: { stat?: boolean; coarse?: boolean } = {}) {
  const files = new Map<string, { text: string; mtimeMs: number }>();
  let clock = 1_700_000_000_123.456, reads: string[] = [];
  let onRead: ((path: string) => void) | null = null;
  const stamp = () => (opts.coarse ? Math.floor(clock / 1000) * 1000 : clock);
  const api = {
    files, reads: () => reads, clearReads: () => { reads = []; }, advance: (ms: number) => { clock += ms; }, now: () => clock,
    write: (path: string, text: string) => { clock += 7.25; files.set(path, { text, mtimeMs: stamp() }); },
    touch: (path: string) => { clock += 7.25; files.get(path)!.mtimeMs = stamp(); },
    onRead: (fn: ((path: string) => void) | null) => { onRead = fn; },
    io: {
      readText: async (path: string) => { reads.push(path); const f = files.get(path); if (!f) throw new Error("ENOENT " + path); onRead?.(path); return f.text; },
      exists: async (path: string) => files.has(path),
      ...(opts.stat === false ? {} : { stat: async (path: string) => { const f = files.get(path); return f ? { size: f.text.length, mtimeMs: f.mtimeMs } : null; } }),
    },
  };
  return api;
}
function proofStore(): SourceProofs & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: k => map.get(k), set: (k, v) => { map.set(k, v); }, delete: k => { map.delete(k); } };
}
const plot = (id: string, assetId: string, svgPath: string) => ({ id, type: "plot", assetId, x: 0, y: 0, width: 200, height: 100, rotation: 0, source: { svgPath } }) as unknown as Figure["elements"][number];
function project(n: number): Project {
  const assets = [], elements = [];
  for (let i = 0; i < n; i++) { assets.push({ id: `a${i}`, name: `p${i}.svg`, kind: "svg" as const, path: `assets/a${i}.svg`, naturalWidth: 200, naturalHeight: 100 }); elements.push(plot(`e${i}`, `a${i}`, `plots/p${i}.svg`)); }
  return { version: 2, name: "proofs", canvases: [{ id: "c", name: "C" }], figures: [{ id: "f", name: "Figure 1", canvasId: "c", x: 0, y: 0, width: 400, height: 300, background: "#fff", elements } as unknown as Figure], assets } as unknown as Project;
}
function seed(d: ReturnType<typeof disk>, n: number) {
  for (let i = 0; i < n; i++) {
    d.write(`${root}/plots/p${i}.svg`, svg("red")); d.write(`${root}/plots/p${i}.fluxplot.json`, manifest(1));
    d.write(`${root}/fig/assets/a${i}.svg`, svg("red")); d.write(`${root}/fig/assets/a${i}.fluxplot.json`, JSON.stringify(JSON.parse(manifest(1)), null, 2));
  }
}
const commit = async (d: ReturnType<typeof disk>, updates: readonly SourceUpdate[], p: Project) =>
  writeSourceUpdates(root, updates, { writeText: async (path, text) => { d.write(path, text); }, remove: async path => { d.files.delete(path); } }, p);

h.section("A. unchanged sources cost no read");
{
  const d = disk(), proofs = proofStore(), p = project(6); seed(d, 6);
  const first = await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
  h.eq([first.checked, first.updates.length, first.statuses.every(s => s.status === "current")], [6, 0, true], "first check: 6 sources compared by content, all current");
  h.ok(d.reads().length >= 6 * 6, `the first check reads every bundle (${d.reads().length} reads)`);
  h.eq(proofs.map.size, 6, "each source proven current leaves a proof");
  d.clearReads();
  const second = await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
  h.eq(d.reads(), [], "second check reads NOTHING");
  h.eq([second.checked, second.updates.length, second.statuses.map(s => s.status).join()], [6, 0, Array(6).fill("current").join()], "…and reports the same statuses");
}

h.section("B. exactly the changed source is read, and its update is proven on commit");
{
  const d = disk(), proofs = proofStore(), p = project(6); seed(d, 6);
  await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
  d.write(`${root}/plots/p3.svg`, svg("blue")); d.clearReads();
  const plan = await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
  h.eq(plan.updates.map(u => u.assetId), ["a3"], "one regenerated plot → one update");
  h.ok(d.reads().length > 0 && d.reads().every(path => /p3\.|a3\./.test(path)), `only that plot's files are read (${[...new Set(d.reads().map(r => r.split("/").pop()))].join(", ")})`);
  h.ok(!proofs.map.has("fig:a3"), "a source with a pending update holds no proof");
  await commit(d, plan.updates, p);
  await proveSourceUpdates(plan.updates, d.io, proofs, d.now);
  h.ok(proofs.map.has("fig:a3"), "the committed update is proven current");
  d.clearReads();
  const after = await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
  h.eq([d.reads(), after.updates.length], [[], 0], "the check after the commit reads nothing");
  // The source changed again between the read and the commit: the commit must NOT be taken as proof.
  d.write(`${root}/plots/p4.svg`, svg("green"));
  const racing = await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
  d.write(`${root}/plots/p4.svg`, svg("black")); // the generator wrote again
  await commit(d, racing.updates, p);
  await proveSourceUpdates(racing.updates, d.io, proofs, d.now);
  h.ok(!proofs.map.has("fig:a4"), "a source rewritten after it was read is not proven by the commit");
  const again = await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
  h.eq(again.updates.map(u => u.assetId), ["a4"], "…and the next check finds the newer source");
}

h.section("C. any identity change is compared by content again");
{
  const d = disk(), proofs = proofStore(), p = project(3); seed(d, 3);
  await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
  const cases: [string, () => void, number][] = [
    ["a touched source (same bytes, new mtime)", () => d.touch(`${root}/plots/p1.svg`), 0],
    ["a saved copy edited outside the app", () => d.write(`${root}/fig/assets/a1.svg`, svg("purple")), 1],
    ["a manifest that appeared beside the saved copy's twin", () => d.write(`${root}/plots/p1.fluxplot.json`, manifest(2)), 1],
    ["a recipe added to the source", () => d.write(`${root}/plots/p1.recipe.json`, JSON.stringify({ command: "python" })), 1],
  ];
  for (const [label, change, updates] of cases) {
    change(); d.clearReads();
    const plan = await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
    h.ok(d.reads().length > 0 && d.reads().every(path => /p1\.|a1\./.test(path)), `${label}: that source is read again, the others are not`);
    h.eq(plan.updates.length, updates, `${label}: ${updates} update(s)`);
    if (plan.updates.length) { await commit(d, plan.updates, p); await proveSourceUpdates(plan.updates, d.io, proofs, d.now); }
    else h.ok(proofs.map.has("fig:a1"), `${label}: proven again after the comparison`);
  }
  // A relinked source (another path) never matches the old proof.
  const q = project(3); ((q.figures[0].elements[1] as unknown as { source: { svgPath: string } }).source).svgPath = "plots/other.svg";
  d.write(`${root}/plots/other.svg`, svg("red")); d.write(`${root}/plots/other.fluxplot.json`, manifest(2)); d.clearReads();
  await planSourceUpdates(root, q, d.io, { proofs, now: d.now });
  h.ok(d.reads().some(path => path.endsWith("/plots/other.svg")), "a relinked source is read: the old path's proof does not carry over");
}

h.section("D. a proof needs a stable identity");
{
  // The source is rewritten while it is being read.
  const d = disk(), proofs = proofStore(), p = project(1); seed(d, 1);
  let fired = false;
  d.onRead(path => { if (!fired && path.endsWith("/fig/assets/a0.svg")) { fired = true; d.touch(`${root}/plots/p0.svg`); } });
  await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
  h.ok(fired && !proofs.map.has("fig:a0"), "an identity that moved during the comparison is not recorded");
  d.onRead(null);
  await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
  h.ok(proofs.map.has("fig:a0"), "the next quiet comparison records it");
}
{
  // Whole-second timestamps: a rewrite inside the same tick keeps the mtime.
  const d = disk({ coarse: true }), proofs = proofStore(), p = project(1); seed(d, 1);
  await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
  h.ok(!proofs.map.has("fig:a0"), "a recent whole-second mtime is not yet proof");
  d.clearReads(); await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
  h.ok(d.reads().length > 0, "…so the next check still compares by content");
  d.advance(SOURCE_PROOF_SETTLE_MS + 1500);
  await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
  h.ok(proofs.map.has("fig:a0"), "past the settle window the identity is proof");
  d.clearReads(); await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
  h.eq(d.reads(), [], "…and then nothing is read");
}

h.section("E. without stat (browser fixtures, older bridges) nothing changes");
{
  const d = disk({ stat: false }), proofs = proofStore(), p = project(2); seed(d, 2);
  await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
  d.clearReads(); const plan = await planSourceUpdates(root, p, d.io, { proofs, now: d.now });
  h.ok(d.reads().length >= 2 * 6 && proofs.map.size === 0, "every check compares by content and records no proof");
  h.eq(plan.statuses.map(s => s.status), ["current", "current"], "statuses as before");
  // No proofs passed: the planner is the old planner.
  const e = disk(); seed(e, 2); await planSourceUpdates(root, p, e.io); e.clearReads(); await planSourceUpdates(root, p, e.io);
  h.ok(e.reads().length >= 2 * 6, "no proof store → every check reads (callers opt in)");
}
await h.done();
