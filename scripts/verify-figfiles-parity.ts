#!/usr/bin/env -S npx tsx
// WS-5.6 (fortify plan) — the twin-engine parity gate for the ONE figure
// persistence core (src/lib/project/figfiles.ts):
//   1. the SAME fixture fig/ tree loads to the SAME normalized model through
//      flux-core (loadFigModel) and the renderer (loadFigInto) — including an
//      out-of-order index, legacy asset entries, and caption maps;
//   2. the SAME mutation saved through both engines yields BYTE-IDENTICAL
//      fig/ trees (index.json + .bak + every canvas + every caption);
//   3. fresh-label derivation is one function with pinned semantics — the two
//      old behaviors are asserted HERE so the adoption is deliberate/visible.
//   npx tsx scripts/verify-figfiles-parity.ts

import "./lib/cssStub.mjs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

let failures = 0;
const ok = (m: string) => console.log("  ok:", m);
const fail = (m: string) => {
  console.error("  ✗ FAIL:", m);
  failures++;
};
const assert = (c: unknown, m: string) => (c ? ok(m) : fail(m));

// fs-backed FileBridge for the renderer engine (same shim as canvas-divergence).
const bridge = {
  exists: (p: string) => fs.access(p).then(() => true, () => false),
  readText: (p: string) => fs.readFile(p, "utf8"),
  writeText: (p: string, t: string) => fs.writeFile(p, t),
  readFile: async (p: string) => (await fs.readFile(p)).buffer,
  writeFile: (p: string, b: Uint8Array) => fs.writeFile(p, b),
  mkdir: (p: string) => fs.mkdir(p, { recursive: true }).then(() => {}),
};
(globalThis as Record<string, unknown>).window = { fig: bridge };

const core = await import("../flux-core/index");
const { loadFigInto, saveFigFrom } = await import("../src/lib/project/figbridge");
const { project: figProject } = await import("../src/lib/store");
const { resizeFigureFrame } = await import("../src/lib/ops");
const { deriveLabel, planFigSave } = await import("../src/lib/project/figfiles");
const { slugify } = await import("../src/lib/project/types");
const { get } = await import("svelte/store");
type Project = import("../src/lib/types").Project;

// ---- the fixture tree (hand-written: neither engine authored it) --------------
async function writeFixture(root: string) {
  await fs.mkdir(path.join(root, "fig", "canvases"), { recursive: true });
  await fs.mkdir(path.join(root, "fig", "captions"), { recursive: true });
  await fs.writeFile(
    path.join(root, "project.json"),
    JSON.stringify({ formatVersion: "0.1.0", title: "Parity", figures: [] }, null, 2) + "\n",
  );
  // Index: canvases listed OUT OF ORDER (order beats array position), one
  // agent-set supplementary kind, one agent-authored label, LEGACY asset
  // entries (missing name/sizes; one with dpi).
  await fs.writeFile(
    path.join(root, "fig", "index.json"),
    JSON.stringify(
      {
        schemaVersion: "0.1.0",
        canvases: [
          { id: "c2", name: "Page Two", order: 2 },
          { id: "c1", name: "Page One", order: 1 },
        ],
        figures: [
          { id: "figA", name: "Alpha", label: "legacy:Alpha_1", order: 1, kind: "main", canvas: "c1", caption: "Alpha caption." },
          { id: "fig_b_1", name: "Beta", label: "fig-beta", order: 2, kind: "supplementary", canvas: "c2", caption: "" },
        ],
        assets: [
          { id: "asset1", kind: "svg", path: "assets/asset1.svg" }, // legacy: no name/sizes
          { id: "asset2", kind: "png", path: "assets/asset2.png", name: "shot", naturalWidth: 640, naturalHeight: 480, dpi: 144 },
        ],
        palette: ["#112233"],
        colorGroups: [{ id: "g1", name: "Grays", colors: ["#888888"] }],
        textStyles: [],
      },
      null,
      2,
    ) + "\n",
  );
  const fig = (id: string, canvasId: string, name: string, caption?: Record<string, string>) => ({
    id,
    canvasId,
    name,
    x: 10,
    y: 20,
    width: 200,
    height: 150,
    elements: [{ type: "image", id: `image-${id}`, assetId: "asset2", x: -20, y: 15, width: 80, height: 60, rotation: 32, locked: true, hidden: true, crop: { x: 10, y: 20, width: 100, height: 80 } }],
    guides: { x: [-5, 40], y: [20] },
    ...(caption ? { captions: caption } : {}),
  });
  await fs.writeFile(
    path.join(root, "fig", "canvases", "c1.json"),
    JSON.stringify(
      { schemaVersion: "0.1.0", id: "c1", name: "Page One", figures: [fig("figA", "c1", "Alpha", { __figure__: "Alpha caption." })] },
      null,
      2,
    ) + "\n",
  );
  await fs.writeFile(
    path.join(root, "fig", "canvases", "c2.json"),
    JSON.stringify(
      { schemaVersion: "0.1.0", id: "c2", name: "Page Two", figures: [fig("fig_b_1", "c2", "Beta")] },
      null,
      2,
    ) + "\n",
  );
  await fs.writeFile(path.join(root, "fig", "captions", "figA.md"), "Alpha caption.\n");
  await fs.writeFile(path.join(root, "fig", "captions", "fig_b_1.md"), "");
}

/** Model → comparable JSON (drop the engine-specific project name). */
const comparable = (p: Project) => JSON.stringify({ ...p, name: "" }, null, 1);

/** Every file under fig/, path → text (the byte-level tree fingerprint). */
async function figTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(rel: string) {
    for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) await walk(r);
      else out.set(r, await fs.readFile(path.join(root, r), "utf8"));
    }
  }
  await walk("fig");
  return out;
}

const work = await fs.mkdtemp(path.join(os.tmpdir(), "flux-parity-"));
try {
  // ---- 1. load parity ----------------------------------------------------------
  const rootA = path.join(work, "a");
  const rootB = path.join(work, "b");
  await fs.mkdir(rootA);
  await writeFixture(rootA);
  await fs.cp(rootA, rootB, { recursive: true });

  const { project: modelA } = await core.loadFigModel(rootA);
  await loadFigInto(rootB, "");
  const modelB = get(figProject) as Project;

  assert(comparable(modelA) === comparable(modelB), "both engines load the fixture to the IDENTICAL normalized model");
  assert(
    modelA.canvases.map((c) => c.id).join(",") === "c1,c2",
    "canvas order comes from the order FIELD, not array position (sorted load)",
  );
  assert(
    modelA.assets[0].name === "asset1" && modelA.assets[0].naturalWidth === 0 && modelA.assets[1].dpi === 144,
    "legacy asset entries normalize identically (name=id, sizes=0, dpi kept)",
  );

  // ---- 2. save parity: same mutation through both engines → identical trees ----
  const mutate = (p: Project) => {
    resizeFigureFrame(p, p.figures[0].id, { x: -35, y: -25, w: 310, h: 210 });
    p.figures.push({
      id: "added_1", // fixed id so both engines mint the same label
      canvasId: "c2",
      name: "Gamma Figure",
      x: 0,
      y: 0,
      width: 120,
      height: 90,
      elements: [],
      captions: { __figure__: "Gamma caption." },
    } as Project["figures"][number]);
  };

  {
    const m = await core.loadFigModel(rootA);
    mutate(m.project);
    await core.saveFigModel(rootA, m.project, m.index);
  }
  {
    figProject.update((p) => {
      mutate(p);
      return p;
    });
    await saveFigFrom(rootB);
  }

  const treeA = await figTree(rootA);
  const treeB = await figTree(rootB);
  const keysA = [...treeA.keys()].sort();
  const keysB = [...treeB.keys()].sort();
  assert(keysA.join("|") === keysB.join("|"), `both trees contain the same files (${keysA.length})`);
  let diverged = 0;
  for (const k of keysA) {
    if (treeA.get(k) !== treeB.get(k)) {
      diverged++;
      fail(`fig tree diverged at ${k}`);
    }
  }
  if (!diverged) ok("every fig/ file is BYTE-IDENTICAL across the two engines (index, .bak, canvases, captions)");
  const savedIdx = JSON.parse(treeA.get("fig/index.json")!);
  assert(savedIdx.figures[0].label === "legacy:Alpha_1", "agent-authored label preserved through both saves");
  assert(savedIdx.figures[1].kind === "supplementary", "agent-set kind preserved through both saves");
  assert(savedIdx.figures[2].label === "fig-gamma-figure", "fresh figure labeled from its NAME (generated-style id)");
  assert(savedIdx.figures[2].caption === "Gamma caption.", "index caption cache composed from the model (not stale-preserved)");
  assert(treeA.get("fig/captions/added_1.md") === "Gamma caption.\n", "caption .md emitted by the shared plan");

  // Reopen, then save without an edit through both engines. Backups intentionally
  // advance to the accepted index; authored files themselves must stay identical.
  const reopened = await core.loadFigModel(rootA);
  await loadFigInto(rootB, "");
  assert(comparable(reopened.project) === comparable(get(figProject)), "resized frames reopen identically in GUI and headless");
  const frame = reopened.project.figures[0];
  assert(frame.x === -35 && frame.width === 310 && frame.elements[0].x + frame.x === -10,
    "frame resize survives save/reopen with rotated cropped artwork pinned");
  assert(frame.elements[0].locked && frame.elements[0].hidden && frame.guides?.x?.[0] === 40,
    "locked/hidden content, crops and guides survive the frame round trip");
  await core.saveFigModel(rootA, reopened.project, reopened.index);
  await saveFigFrom(rootB);
  const stableA = await figTree(rootA), stableB = await figTree(rootB);
  for (const [key, value] of treeA) if (!key.endsWith('.bak')) {
    assert(stableA.get(key) === value && stableB.get(key) === value, `no-edit reopen/save is byte-stable: ${key}`);
  }

  // A missing or malformed sibling must never turn a partial view into a save
  // that silently drops it. Exercise actual GUI and headless persistence APIs.
  for (const broken of ['missing', 'invalid'] as const) {
    const root = path.join(work, broken);
    await fs.cp(rootA, root, { recursive: true });
    const file = path.join(root, 'fig/canvases/c2.json');
    if (broken === 'missing') await fs.unlink(file); else await fs.writeFile(file, '{bad json');
    const before = await figTree(root);
    let rejected = false;
    try { await core.loadFigModel(root); } catch { rejected = true; }
    assert(rejected, `headless refuses a ${broken} referenced canvas`);
    await loadFigInto(root, '');
    assert(get(figProject).figures.some(f => f.id === 'figA'), `GUI keeps the healthy sibling visible (${broken})`);
    rejected = false;
    try { await saveFigFrom(root, { force: true }); } catch { rejected = true; }
    assert(rejected, `even force-save cannot overwrite an incomplete load (${broken})`);
    assert(JSON.stringify([...await figTree(root)]) === JSON.stringify([...before]), `partial load leaves every disk byte unchanged (${broken})`);
  }
  await loadFigInto(rootB, '');

  // ---- 3. label semantics: one function, pinned against BOTH old behaviors -----
  const oldFigbridge = (f: { id: string; name: string }) => `fig-${slugify(f.name || f.id)}`;
  const oldFluxCore = (f: { id: string; name: string }) => {
    const slugLike = /^[a-z0-9][a-z0-9-]*$/i.test(f.id) && !f.id.includes("_");
    const base = slugLike ? f.id : slugify(f.name || f.id);
    return `fig-${base || f.id}`;
  };
  const cases = [
    { id: "fig_lx8q_1", name: "Dose Response" }, // GUI-generated id (underscores)
    { id: "fig_lx8q_2", name: "" }, // unnamed, generated id
    { id: "barfig", name: "Bar Figure" }, // agent-authored slug id
    { id: "fig_lx8q_3", name: "!!!" }, // name slugifies to ""
  ];
  // The adopted rule IS the old flux-core rule — byte-for-byte.
  for (const c of cases) {
    if (deriveLabel(c) !== oldFluxCore(c)) fail(`adopted rule drifted from flux-core's for ${JSON.stringify(c)}`);
  }
  ok("adopted deriveLabel ≡ the old flux-core rule on every case");
  // GUI-generated ids keep their old labels (underscore ⇒ name-slug) …
  assert(deriveLabel(cases[0]) === "fig-dose-response" && deriveLabel(cases[0]) === oldFigbridge(cases[0]),
    "generated-id figures: label unchanged from the old GUI rule (fig-<name-slug>)");
  // … the deliberate changes are agent slug ids (id-anchored now) …
  assert(deriveLabel(cases[2]) === "fig-barfig" && oldFigbridge(cases[2]) === "fig-bar-figure",
    "slug-id figures: id-anchored label (DELIBERATE change from the old GUI name-slug)");
  // … and garbage names never mint a broken label: slugify itself falls back
  // to "project", so ALL three rules agree here (no behavior change).
  assert(deriveLabel(cases[3]) === "fig-project" && oldFigbridge(cases[3]) === "fig-project",
    'garbage names: slugify\'s own fallback yields "fig-project" in old and adopted rules alike');
  // Prev-label preservation is planFigSave's job, independent of derivation.
  const prevPlan = planFigSave(
    {
      version: 2, name: "", canvases: [{ id: "c1", name: "C" }], palette: [],
      assets: [], figures: [{ id: "figA", canvasId: "c1", name: "Renamed Completely", x: 0, y: 0, width: 1, height: 1, elements: [] }],
    } as unknown as Project,
    { schemaVersion: "0.1.0", canvases: [], figures: [{ id: "figA", name: "Old", label: "fig-anchor", order: 1, kind: "main", canvas: "c1", caption: "" }] },
  );
  assert(JSON.parse(prevPlan.index.text).figures[0].label === "fig-anchor", "existing labels NEVER re-derive (rename-safe anchors)");

  // ---- 4. figure families: custom defs round-trip + identity derivation --------
  {
    const famPlan = planFigSave(
      {
        version: 2, name: "", canvases: [{ id: "c1", name: "C" }], palette: [], assets: [],
        figureFamilies: [{ id: "movie", displayName: "Movie", refTemplate: "Mov. {num}{panel}", captionTemplate: "Movie {num} | " }],
        figures: [
          { id: "figA", canvasId: "c1", name: "x", family: "movie", number: 1, x: 0, y: 0, width: 1, height: 1, elements: [] },
          { id: "fig_b1_2", canvasId: "c1", name: "Growth curves", x: 0, y: 0, width: 1, height: 1, elements: [] },
        ],
      } as unknown as Project,
      null,
    );
    const idx = JSON.parse(famPlan.index.text);
    assert(idx.families?.[0]?.id === "movie", "custom family defs write back explicitly (silent-wipe guard)");
    assert(idx.figures[0].name === "Movie 1" && idx.figures[0].kind === "main", "derived name uses the custom template; kind derives from family");
    assert(idx.figures[1].family === "figure" && idx.figures[1].number === 1 && idx.figures[1].nickname === "Growth curves",
      "family-less figure heals in-plan: figure family + nickname capture");
    assert(idx.figures[1].label === "fig-growth-curves", "nickname feeds the fresh label");
    // Idempotence: replanning the SAME model over the written index is byte-identical.
    const again = planFigSave(
      {
        version: 2, name: "", canvases: [{ id: "c1", name: "C" }], palette: [], assets: [],
        figureFamilies: [{ id: "movie", displayName: "Movie", refTemplate: "Mov. {num}{panel}", captionTemplate: "Movie {num} | " }],
        figures: [
          { id: "figA", canvasId: "c1", name: "x", family: "movie", number: 1, x: 0, y: 0, width: 1, height: 1, elements: [] },
          { id: "fig_b1_2", canvasId: "c1", name: "Growth curves", x: 0, y: 0, width: 1, height: 1, elements: [] },
        ],
      } as unknown as Project,
      idx,
    );
    assert(again.index.text === famPlan.index.text, "family plan is idempotent over its own index");
  }
} finally {
  await fs.rm(work, { recursive: true, force: true });
}

console.log(failures ? `\nFIGFILES PARITY: FAIL (${failures})` : "\nFIGFILES PARITY: PASS");
process.exit(failures ? 1 : 0);
