// flux-connect end to end (plan §8.14): target resolution, the pack on disk,
// the brief and bundle contracts, ProjectContext links, depth, FluxLib
// discretion, proof codes, global mode, --refresh, stdout-only parts, images and
// the render cache, retention, read-back, and the actual CLI. Hermetic: a
// scratch machine (HOME/XDG/TMPDIR) is set before flux-core loads.
//   node scripts/run-verifies.mjs --tier pure --only verify-connect
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { harness } from "./lib/harness.mjs";
import { isolatedEnv } from "./lib/verifyRuntime.mjs";
import { tsxCli } from "./lib/tsxRun.mjs";

const h = harness("verify-connect");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "verify-connect-")));
const env = isolatedEnv(path.join(scratch, "machine"));
for (const k of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "AI_AGENT", "CODEX_THREAD_ID", "CODEX_CI", "CODEX_SANDBOX", "FLUX_PROJECT", "FLUX_CLIENT", "FLUX_CONNECT_CACHE", "FLUX_CONNECT_FALLBACK"]) delete env[k];
for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
Object.assign(process.env, env);

const core = await import("../flux-core/index");
const conn = await import("../flux-core/connect/index");
const { proofCode, imageCode } = await import("../flux-core/connect/codes");
const { detectAgentIdentity } = await import("../flux-core/agentIdentity");
const { makeNote, serializeEvent } = await import("../src/lib/project/annotations");
const fluxPaths = await import("../electron/fluxPaths.cjs");

const identity = detectAgentIdentity({});
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const read = (p: string) => fs.readFile(p, "utf8");

// ---------------------------------------------------------------------------
// The fixture: 3 documents (one big), 2 canvases, 5 figures, a deck, a Log with
// a checkpoint, annotations and comments, a UserContext with an image and a
// skill, FluxLib with distinctive titles, and a workspace around the project.
// ---------------------------------------------------------------------------
const ws = path.join(scratch, "study");
const root = path.join(ws, "paper");
await fs.mkdir(ws, { recursive: true });
await fs.writeFile(path.join(ws, "pyproject.toml"), '[project]\nname = "study"\n');
await core.scaffold(root, { title: "Sleep Study" });
const realRoot = await fs.realpath(root);

const cfg = fluxPaths.configInfoSync();
const uc = cfg.userContextPath;
await fs.mkdir(path.join(uc, "Skills", "stats-conventions"), { recursive: true });
await fs.writeFile(path.join(uc, "WHO-AM-I.md"), "# Who am I\n\nA neuroscientist who studies sleep.\n");
await fs.writeFile(path.join(uc, "RULES.md"), "# Rules\n\n- Always label axes with units.\n");
await fs.writeFile(path.join(uc, "palette.png"), PNG);
await fs.writeFile(path.join(uc, "Skills", "README.md"), "# Your agent skills\n\nSKILLS-README-BODY\n");
await fs.writeFile(path.join(uc, "Skills", "stats-conventions", "SKILL.md"), "---\nname: stats-conventions\ndescription: How I report statistics.\n---\n\nSKILL-BODY-SECRET\n");
await fs.mkdir(cfg.fluxContextPath, { recursive: true });
await fs.writeFile(path.join(cfg.fluxContextPath, "FLUX.md"), "# Flux primer\n");
await fs.writeFile(path.join(cfg.fluxContextPath, "CONNECT.md"), "# Connected\n");
await fs.mkdir(cfg.fluxLibPath, { recursive: true });
await fs.writeFile(path.join(cfg.fluxLibPath, "library.bib"), "@article{zeb2020,\n  title = {Zebrafish Unique Title Alpha},\n}\n@article{mou2021,\n  title = {Mouse Unique Title Beta},\n}\n@comment{not an entry}\n");

// Documents: methods (outlined), big (never in the core bundle), and the main notes.
await fs.writeFile(path.join(root, "paper", "methods.qmd"), "---\ntitle: Methods\n---\n\n# Methods\n\n## Animals\n\nMETHODS-BODY-SENTENCE mice were housed.\n\n## Imaging\n\nTwo-photon imaging.\n");
const bigBody = Array.from({ length: 800 }, (_, i) => `Paragraph ${i} of the big draft with BIG-DOC-BODY words repeated many times over.`).join("\n\n");
await fs.writeFile(path.join(root, "paper", "big.qmd"), `---\ntitle: Big draft\n---\n\n# Introduction\n\n${bigBody}\n\n# Discussion\n\nEnd.\n`);
await core.addComment(root, { quote: "Two-photon imaging", body: "Which objective?", docRel: "paper/methods.qmd" });

// ProjectContext: links one level (a.md → b.md is depth 2), an image, a missing
// written link, a backticked name that does not exist (not a link), and a
// linked file larger than the default linked budget (trimmed).
await fs.mkdir(path.join(root, "notes"), { recursive: true });
await fs.writeFile(path.join(root, "notes", "a.md"), "# Plan A\n\nPLAN-A-BODY. See [b](b.md).\n\n````md\n```python\nprint('nested fence')\n```\n~~~\ntilde fence\n~~~\n````\n");
await fs.writeFile(path.join(root, "notes", "b.md"), "# Plan B\n\nPLAN-B-DEPTH-TWO.\n");
await fs.writeFile(path.join(root, "notes", "sketch.png"), PNG);
const huge = "# Huge notes\n\n## Part one\n\n" + "HUGE-OPENING-WORDS ".repeat(1600) + "\n\n## Part two\n\n" + "HUGE-TAIL-MARKER ".repeat(12000) + "\n";
await fs.writeFile(path.join(root, "notes", "huge.md"), huge);
await fs.writeFile(
  path.join(root, "Context", "ProjectContext.qmd"),
  `---\ntitle: "Project context — Sleep Study"\n---\n\n## Background\n\nWe ask how sleep reshapes synapses.\n\n## Key files and links\n\n- [plan](../notes/a.md)\n- [huge notes](../notes/huge.md)\n- ![sketch](../notes/sketch.png)\n- [gone](../notes/gone.md)\n- code name \`missing-script.py\`\n`,
);
await fs.writeFile(path.join(root, "Context", "RULES.md"), "# Project rules\n\n- Use SI units.\n");

// Log: an early entry, a checkpoint, two later entries; plus legacy sections above ## Log.
await fs.writeFile(path.join(root, "Context", "NOTEBOOK.md"), "# Project notebook\n\n## Decisions\n\nLEGACY-DECISION kept from the old workflow.\n\n## Log\n\n");
await core.writeLog(root, { text: "EARLY-ENTRY body", title: "Early", identity });
await core.writeLog(root, { text: "Summary so far", title: "Midpoint", checkpoint: true, identity });
await core.writeLog(root, { text: "LATE-ONE body", title: "Late one", identity });
await core.writeLog(root, { text: "LATE-TWO body", title: "Late two", identity });

// Figures: 5 over 2 canvases, from real plot SVGs.
await fs.mkdir(path.join(root, "plots"), { recursive: true });
const plotSvg = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160"><rect width="240" height="160" fill="#fffcf0"/><circle cx="80" cy="80" r="50" fill="${fill}"/></svg>`;
for (const [i, c] of ["#205ea6", "#ad8301", "#66800b", "#a02f6f", "#bc5215"].entries()) await fs.writeFile(path.join(root, "plots", `p${i}.svg`), plotSvg(c));
await core.mutateFigModel(root, "verify_add_canvas", ({ project }) => {
  if (!project.canvases.some((c) => c.id === "canvas-2")) project.canvases.push({ id: "canvas-2", name: "Supplement" });
});
const figs: string[] = [];
for (let i = 0; i < 5; i++) {
  const r = await core.composeFigure(root, [path.join(root, "plots", `p${i}.svg`)], { id: `f${i}`, ...(i >= 3 ? { canvasId: "canvas-2" } : {}) });
  figs.push(r.figureId);
}
await core.setCaption(root, figs[0], "Sleep reshapes synapses. **a**, Overview.");
await core.createDeck(root, { id: "talk", title: "Lab talk" });
await core.addSlide(root, "talk", { name: "Title" });
await core.addSlide(root, "talk", { name: "Results" });

// Annotations: two notes in the ledger (one routed to a named session).
const ledger = path.join(root, ".meta", "feedback.ndjson");
await fs.appendFile(ledger, serializeEvent(makeNote("Make the bars thicker #figure", { surface: "figure", activeFigureId: "f0" }, "app")));
await fs.appendFile(ledger, serializeEvent(makeNote("Tighten this paragraph", { surface: "paper", doc: { path: "paper/methods.qmd", from: 40, to: 60, quote: "mice were housed" } }, "app", { session: { id: "s-heron", name: "heron" } })));

/** Every file under the project with its sha: connect must not change any. */
async function tree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (rel: string) => {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else out.set(r, sha(await fs.readFile(path.join(dir, r))));
    }
  };
  await walk("");
  return out;
}

try {
  h.section("target resolution");
  {
    const sub = path.join(root, "paper");
    h.eq(await conn.resolveConnectTarget(sub, scratch), { mode: "project", root: realRoot }, "a path inside a project walks up to its root");
    h.eq(await conn.resolveConnectTarget(undefined, path.join(root, "notes")), { mode: "project", root: realRoot }, "omitted target: the project around cwd");
    h.eq(await conn.resolveConnectTarget(undefined, scratch), { mode: "global" }, "omitted target outside any project: global");
    h.eq(await conn.resolveConnectTarget("global", root), { mode: "global" }, "global is global even inside a project");
    const err = async (t: string, cwd = scratch) => conn.resolveConnectTarget(t, cwd).then(() => "", (e) => String((e as Error).message));
    h.ok((await err("setup")).includes("flux-connect command"), "reserved word setup is refused with the escape (./setup)");
    h.ok((await err(path.join(scratch, "nope"))).includes("does not exist"), "a missing path is reported");
    await fs.mkdir(path.join(scratch, "elsewhere"), { recursive: true });
    h.ok((await err(path.join(scratch, "elsewhere"))).includes("is not inside a Flux project"), "a path outside every project is refused");
  }

  h.section("core pack: the brief");
  const before = await tree(root);
  const r = await conn.connect({ target: root, identity });
  const after = await tree(root);
  h.ok(before.size === after.size && [...before].every(([k, v]) => after.get(k) === v), "connect writes nothing into the project");
  h.ok(!!r.briefPath && !!r.bundlePath && !!r.manifestPath && !r.stdoutOnly, "pack written to the primary cache");
  h.ok(r.briefPath!.startsWith(path.join(fluxPaths.userDataDir(), "connect") + path.sep), "pack lives under <userDataDir>/connect/");
  const brief = r.brief;
  h.ok(brief.length <= 10_000, `brief ≤ 10,000 chars (${brief.length})`);
  h.ok(brief.startsWith(`# FLUX-CONNECT BRIEF · project "Sleep Study" · pack ${r.packId} · `), "brief opens with its sentinel header");
  h.ok(brief.trimEnd().endsWith(`END OF FLUX-CONNECT BRIEF ${r.packId}`), "brief ends with its END sentinel");
  const ends = [...brief.matchAll(new RegExp(`^— end §(\\d) · ${r.packId} —$`, "gm"))].map((m) => m[1]);
  h.eq(ends, ["0", "1", "2", "3", "4"], "every brief section ends with its marker (§3 present: something was trimmed)");
  h.eq(await read(r.briefPath!), brief, "brief.md is the returned brief");
  const lineCount = Number(/This brief has (\d+) lines/.exec(brief)?.[1]);
  h.eq(lineCount, brief.split("\n").length, "the stated line count is exact");
  for (const p of [...brief.matchAll(/`(\/[^`\s]+)`/g)].map((m) => m[1]).filter((p) => !p.includes("<")))
    h.ok(fsSync.existsSync(p), `referenced path exists: ${p.replace(scratch, "…")}`);
  h.ok(brief.includes("Expected: 8 section codes (A, B, C, D, E, F, G, H) and 2 image codes."), "receipt template states the expected codes");
  h.ok(brief.includes("Open: 2 annotations · 1 comment"), "receipt template carries the open-item counts");
  h.ok(brief.includes("ProjectContext (+2 linked)"), "receipt counts the linked text files read (a.md in full, huge.md partial)");
  const codes = ["A", "B", "C", "D", "E", "F", "G", "H"].map((s) => proofCode(r.packId, `section:${s}`));
  h.ok(codes.every((c) => !brief.includes(c)), "no proof code appears in the brief");
  h.ok(/## 3 · Trimmed[\s\S]*notes\/huge\.md/.test(brief), "the over-budget linked file is listed in §3");
  h.ok(brief.includes("**stats-conventions** — How I report statistics."), "the user's skills are listed by name and description");

  h.section("core pack: the bundle");
  const bundle = await read(r.bundlePath!);
  for (const s of ["A", "B", "C", "D", "E", "F", "G", "H"]) h.ok(bundle.includes(`— §${s} code ${proofCode(r.packId, `section:${s}`)} —`), `§${s} ends with its code`);
  h.ok(!bundle.includes("## §I ") && !bundle.includes("## §J "), "core has no full-depth sections");
  const toc = [...bundle.matchAll(/^- §([A-Z]) .* — lines (\d+)–(\d+)$/gm)];
  const blines = bundle.split("\n");
  h.ok(toc.length === 8 && toc.every((m) => blines[Number(m[2]) - 1].startsWith(`## §${m[1]} · `) && blines[Number(m[3]) - 1].startsWith(`— §${m[1]} code `)), "the contents' line numbers point at each section's start and code");
  // Every included file's header sha matches its source.
  const sources: Record<string, string> = {
    "UserContext/WHO-AM-I.md": path.join(uc, "WHO-AM-I.md"),
    "UserContext/RULES.md": path.join(uc, "RULES.md"),
    "Context/ProjectContext.qmd": path.join(root, "Context", "ProjectContext.qmd"),
    "notes/a.md": path.join(root, "notes", "a.md"),
    "Context/RULES.md": path.join(root, "Context", "RULES.md"),
  };
  for (const [disp, abs] of Object.entries(sources)) {
    const m = new RegExp("### `" + disp.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "` · \\d+ lines · sha ([0-9a-f]{8})").exec(bundle);
    h.ok(!!m && m[1] === sha(await fs.readFile(abs)).slice(0, 8), `${disp}: header sha matches the source`);
  }
  h.ok(!bundle.includes("SKILL-BODY-SECRET") && !bundle.includes("SKILLS-README-BODY"), "skill bodies and the Skills README are not bundled");
  h.ok(bundle.includes(path.join(uc, "palette.png")), "UserContext images are listed with absolute paths");
  // Dynamic fence: a.md contains a four-backtick fence, so its block needs five.
  h.ok(/^`{5}markdown\n# Plan A[\s\S]*?^`{5}$/m.test(bundle) && bundle.includes("~~~\ntilde fence\n~~~"), "the dynamic fence survives nested ``` and ~~~ content intact");
  h.ok(bundle.includes("PLAN-A-BODY") && !bundle.includes("PLAN-B-DEPTH-TWO"), "links followed one level under core");
  h.ok(bundle.includes("HUGE-OPENING-WORDS") && !bundle.includes("HUGE-TAIL-MARKER") && /notes\/huge\.md` .* OUTLINE \+ OPENING ONLY/.test(bundle), "the big linked file: outline + opening only");
  h.ok(/`notes\/gone\.md` — ⚠ link does not resolve/.test(bundle), "a written link that does not resolve is flagged");
  h.ok(/`notes\/sketch\.png` — image: view it/.test(bundle) && brief.includes(path.join(realRoot, "notes", "sketch.png")), "a linked image is listed in the bundle and put in the brief's look-list");
  h.ok(!/^- `missing-script\.py`/m.test(bundle), "a backticked name that does not exist is not listed as a link");
  h.ok(!bundle.includes("METHODS-BODY-SENTENCE") && !bundle.includes("BIG-DOC-BODY"), "core: no non-linked document body in the bundle");
  h.ok(/`paper\/methods\.qmd` — "Methods" · \d+ words · \d+ lines · has comments/.test(bundle) && /- Animals \(line \d+\)/.test(bundle), "core: each document is indexed with words, comments and its outline");
  h.ok(/`paper\/big\.qmd` — "Big draft"/.test(bundle) && /- Introduction \(line \d+\)/.test(bundle), "core: the big document is in the index");
  const libSection = bundle.slice(bundle.indexOf("## §B"), bundle.indexOf("## §C"));
  h.ok(libSection.includes("2 references") && !/Unique Title|zeb2020|mou2021/.test(libSection) && !/Unique Title/.test(bundle), "FluxLib §B: what/where/how, no paper titles or keys anywhere");
  h.ok(/\*\*f0\*\* "Figure \d[^"]*" · canvas canvas-1 — Sleep reshapes synapses/.test(bundle) && /canvas-2 "Supplement": f3, f4/.test(bundle), "§C lists figures with caption leads and both canvases");
  h.ok(/\*\*talk\*\* "Lab talk" — 1\. Title \(1 step\) · .*3\. Results \(1 step\)/.test(bundle), "§C lists the deck with slide names and steps");
  h.ok(bundle.includes("`study/`") === false && bundle.includes("pyproject.toml"), "§C describes the analysis workspace around the project");
  const logSection = bundle.slice(bundle.indexOf("## §F"), bundle.indexOf("## §G"));
  h.ok(logSection.includes('from the latest checkpoint "Checkpoint: Midpoint"') && logSection.includes("LATE-TWO body") && !logSection.includes("EARLY-ENTRY body"), "§F: from the latest checkpoint in full");
  h.ok(/- \d{4}-\d\d-\d\d \d\d:\d\d — Early\n/.test(logSection), "§F: every entry is in the title index");
  h.ok(logSection.includes("Legacy notebook sections") && logSection.includes("LEGACY-DECISION"), "§F: legacy notebook sections are included and labelled");
  const g = bundle.slice(bundle.indexOf("## §G"), bundle.indexOf("## §H"));
  h.ok(g.includes("Do not act on these unless the user asks.") && g.includes("Make the bars thicker") && g.includes("Which objective?") && g.includes("route @heron"), "§G lists open annotations and comments with routes");

  h.section("images and the render cache");
  h.eq(r.images.length, 2, "core renders one overview per canvas");
  for (const [i, img] of r.images.entries()) {
    const b = await fs.readFile(img.path);
    h.ok(b.subarray(0, 8).equals(PNG) && b.length > 1000, `image ${i} is a real PNG`);
  }
  h.ok(r.images[1].label.startsWith('canvas "Supplement": f3 ') && r.images[1].label.includes("f4"), "an image label names its canvas and figures");
  h.eq(r.renderCache, { hits: 0, misses: 2 }, "first run renders both canvases");
  const r2 = await conn.connect({ target: root, identity });
  h.eq(r2.renderCache, { hits: 2, misses: 0 }, "second run: both canvases from the cache");
  const i1 = await fs.readFile(r.images[0].path), i2 = await fs.readFile(r2.images[0].path);
  h.ok(!i1.equals(i2), "each pack stamps its own proof code onto the cached render");
  const nr = await conn.connect({ target: root, identity, noRender: true });
  h.ok(nr.images.length === 0 && nr.brief.includes("Figure images are not available this time"), "--no-render: no images, and the brief says so");

  h.section("proof codes");
  const proof = [...codes, imageCode(r.packId, 0), imageCode(r.packId, 1)].join(" ");
  h.ok((await conn.checkPackReceipt(r.packId, proof)).complete, "the right codes are accepted");
  const partial = await conn.checkPackReceipt(r.packId, codes.slice(0, 5).join(" ") + " ZZZZ");
  h.ok(!partial.complete && partial.sections.filter((s) => !s.ok).map((s) => s.id).join("") === "FGH" && partial.images.every((i) => !i.ok), "missing and wrong codes are flagged per section and image");

  h.section("read-back");
  h.eq((await conn.readPack(r.packId, { section: "brief" })).text, brief, "read_pack brief");
  const d1 = await conn.readPack(r.packId, { section: "D" });
  let d = d1.text.replace(/^\(section D, part 1 of \d+\)\n/, "");
  for (let n = 2; n <= d1.parts; n++) d += "\n" + (await conn.readPack(r.packId, { section: "D", part: n })).text.replace(/^\(section D, part \d+ of \d+\)\n/, "");
  h.ok(d.startsWith("## §D · ") && d.includes("We ask how sleep reshapes synapses.") && d.trimEnd().endsWith(`— §D code ${proofCode(r.packId, "section:D")} —`), `read_pack one section in ${d1.parts} part(s), ending in its code`);
  const first = await conn.readPack(r.packId, { part: 1 });
  let joined = first.text.replace(/^\(bundle part 1 of \d+\)\n/, "");
  for (let n = 2; n <= first.parts; n++) joined += "\n" + (await conn.readPack(r.packId, { part: n })).text.replace(/^\(bundle part \d+ of \d+\)\n/, "");
  h.eq(joined, bundle, "sequential parts reassemble the bundle exactly");
  h.ok(await conn.readPack("zzzzzzzzzz").then(() => false, () => true), "an unknown pack is refused");
  const img = await conn.packImage(r.packId, 1);
  h.ok(img.png.subarray(0, 8).equals(PNG) && img.count === 2, "get_pack_image returns the PNG");
  h.ok(await conn.packImage(r.packId, 2).then(() => false, () => true), "an out-of-range image index is refused");

  h.section("full depth");
  const full = await conn.connect({ target: root, identity, depth: "full" });
  const fb = await read(full.bundlePath!);
  h.ok(fb.includes("## §I · Documents (in full)") && fb.includes("METHODS-BODY-SENTENCE") && fb.includes("BIG-DOC-BODY"), "full includes every document");
  h.ok(fb.includes("PLAN-B-DEPTH-TWO"), "full follows links beyond one level");
  h.ok(fb.includes("## §J · ") && fb.includes("Sleep reshapes synapses. **a**, Overview."), "full includes full captions");
  h.eq(full.images.length, 2 + 5, "full renders both canvases and every figure");
  h.ok(full.brief.includes("Expected: 10 section codes (A, B, C, D, E, F, G, H, I, J) and 7 image codes."), "full's receipt expects its sections and images");

  h.section("global mode");
  const gl = await conn.connect({ target: "global", identity });
  const gb = await read(gl.bundlePath!);
  h.ok(gl.mode === "global" && gl.root === null && gl.brief.includes("✓ flux-connected · global · pack"), "global brief and receipt");
  h.ok(gb.includes("## §K · Known projects") && gb.includes(`"Sleep Study" — \`${realRoot}\``), "global lists the known projects (recorded by the project connects)");
  h.ok(!gb.includes("## §C") && !gb.includes("## §F"), "global has no project sections");
  h.ok(gl.brief.includes("Known projects on this machine, newest first") && gl.brief.includes(`"Sleep Study" — \`${realRoot}\``), "the global brief lists the known projects too");

  h.section("--refresh reports exactly what changed");
  {
    const base = await conn.connect({ target: root, identity });
    void base;
    await fs.appendFile(path.join(root, "paper", "methods.qmd"), "\nAn added line.\nAnother added line.\n");
    await core.writeLog(root, { text: "FRESH-ENTRY body", title: "Fresh", identity });
    await core.resolveComment(root, "Two-photon imaging", { docRel: "paper/methods.qmd" });
    const rf = await conn.connect({ target: root, identity, refresh: true });
    const det = rf.refresh?.details ?? "";
    h.ok(!!rf.refresh && rf.refresh.changes === 3, `three changes reported (${rf.refresh?.changes})`);
    h.ok(/`paper\/methods\.qmd` \+3\/−0/.test(det) && det.includes("+ An added line."), "the edited document with its line counts (a blank line counts) and the changed lines");
    h.ok(det.includes("### New Log entries") && det.includes("FRESH-ENTRY body"), "the new Log entry in full");
    h.ok(det.includes("### Closed since you looked") && /resolved/.test(det), "the resolved comment");
    h.ok(!det.includes("ProjectContext edited") && !det.includes("Rules edited") && !det.includes("### Figures"), "nothing else is reported");
    const again = await conn.connect({ target: root, identity, refresh: true });
    h.eq(again.refresh?.changes, 0, "a second refresh right after finds nothing new");
  }

  h.section("retention");
  for (let i = 0; i < 3; i++) await conn.connect({ target: root, identity, noRender: true });
  const packsDir = path.dirname(path.dirname(r.bundlePath!));
  h.eq((await fs.readdir(packsDir)).length, 5, "the newest 5 packs per project are kept");

  h.section("stdout-only mode");
  {
    const ro = path.join(scratch, "ro");
    await fs.mkdir(path.join(ro, "a"), { recursive: true });
    await fs.mkdir(path.join(ro, "b"), { recursive: true });
    await fs.chmod(path.join(ro, "a"), 0o500);
    await fs.chmod(path.join(ro, "b"), 0o500);
    process.env.FLUX_CONNECT_CACHE = path.join(ro, "a", "connect");
    process.env.FLUX_CONNECT_FALLBACK = path.join(ro, "b", "connect");
    try {
      const so = await conn.connect({ target: root, identity });
      h.ok(so.stdoutOnly && so.briefPath === null && so.images.length === 0, "nothing writable: stdout-only, no pack dir, no images");
      const cmd = /get part N with `flux connect "[^"]+" --part N --pack (\w+) --sources (\w+)`/.exec(so.brief);
      h.ok(!!cmd && cmd[1] === so.packId, "the brief says how to get the other parts");
      h.ok(!!so.firstPart && so.firstPart.startsWith(`# FLUX-CONNECT BUNDLE · pack ${so.packId} · part 1 of `), "part 1 follows the brief");
      const count = Number(/part 1 of (\d+)/.exec(so.firstPart!)![1]);
      const again1 = await conn.connectPart({ target: root, identity, part: 1, pack: so.packId, sources: cmd![2] });
      h.eq(again1, so.firstPart, "a recomputed part 1 is identical (deterministic)");
      const all = [so.firstPart!];
      for (let n = 2; n <= count; n++) all.push(await conn.connectPart({ target: root, identity, part: n, pack: so.packId, sources: cmd![2] }));
      h.ok(all.every((p) => p.length <= 20_000 + 200), "every part is ≤ 20,000 chars (+ header)");
      h.ok(all.join("\n").includes(`— §H code ${proofCode(so.packId, "section:H")} —`), "the parts carry the last section's code");
      await fs.appendFile(path.join(root, "Context", "RULES.md"), "- One more rule.\n");
      h.ok(await conn.connectPart({ target: root, identity, part: 1, pack: so.packId, sources: cmd![2] }).then(() => false, (e) => /out of date/.test(String(e))), "a part refuses once a source changed");
    } finally {
      delete process.env.FLUX_CONNECT_CACHE;
      delete process.env.FLUX_CONNECT_FALLBACK;
      await fs.chmod(path.join(ro, "a"), 0o700);
      await fs.chmod(path.join(ro, "b"), 0o700);
    }
    process.env.FLUX_CONNECT_CACHE = path.join(ro, "a", "connect");
    await fs.chmod(path.join(ro, "a"), 0o500);
    try {
      const fbk = await conn.connect({ target: root, identity, noRender: true });
      h.ok(!fbk.stdoutOnly && fbk.briefPath!.startsWith(os.tmpdir() + path.sep) && fbk.problems.some((p) => p.includes("not writable")), "an unwritable primary falls back to the tmp cache and says so");
    } finally {
      delete process.env.FLUX_CONNECT_CACHE;
      await fs.chmod(path.join(ro, "a"), 0o700);
    }
  }

  h.section("template ProjectContext");
  {
    const fresh = path.join(scratch, "fresh");
    await core.scaffold(fresh, { title: "Fresh" });
    const fr = await conn.connect({ target: fresh, identity, noRender: true });
    h.ok(fr.brief.includes("ProjectContext is still the template — want me to help fill it in?"), "a template ProjectContext is called out in the receipt");
    await fs.rm(path.join(fresh, "Context", "ProjectContext.qmd"));
    const miss = await conn.connect({ target: fresh, identity, noRender: true });
    const mb = await read(miss.bundlePath!);
    h.ok(miss.brief.includes("no ProjectContext yet") && mb.includes("`Context/ProjectContext.qmd` does not exist.") && !/### `Context\/ProjectContext\.qmd`/.test(mb), "a missing ProjectContext is named (and not rendered as an empty file)");
    h.ok(!/MISSION|Project\/MISSION/.test(miss.brief + mb), "no mention of any retired layout");
  }

  h.section("the actual CLI");
  {
    const cli = (...args: string[]) => spawnSync(process.execPath, [tsxCli(), path.join(repo, "flux-cli.ts"), "connect", ...args], { encoding: "utf8", env: process.env, cwd: scratch });
    const out = cli(root, "--no-render");
    h.ok(out.status === 0 && out.stdout.startsWith("# FLUX-CONNECT BRIEF") && out.stdout.trimEnd().endsWith("END OF FLUX-CONNECT BRIEF " + /pack (\w+)/.exec(out.stdout)?.[1]), "`flux connect <path>` prints the brief");
    const js = JSON.parse(cli(root, "--no-render", "--json").stdout);
    h.ok(typeof js.packId === "string" && js.root === realRoot && fsSync.existsSync(js.bundlePath) && !("cursor" in js), "--json prints the pack paths");
    // The early packs are pruned by now (5 kept): check the one the CLI just made (no images).
    const cliProof = ["A", "B", "C", "D", "E", "F", "G", "H"].map((x) => proofCode(js.packId, `section:${x}`)).join(" ");
    const ok = cli("--check-receipt", js.packId, cliProof);
    h.ok(ok.status === 0 && ok.stdout.includes("✓ complete"), "--check-receipt accepts a complete proof (exit 0)");
    const bad = cli("--check-receipt", js.packId, "WXYZ");
    h.ok(bad.status === 1 && bad.stdout.includes("✗ incomplete"), "--check-receipt flags an incomplete proof (exit 1)");
    const gone = cli(path.join(scratch, "elsewhere"));
    h.ok(gone.status !== 0 && gone.stderr.includes("is not inside a Flux project"), "a path outside a project fails with the diagnosis");
  }
} finally {
  await h.done(async () => {
    await fs.chmod(path.join(scratch, "ro", "a"), 0o700).catch(() => {});
    await fs.chmod(path.join(scratch, "ro", "b"), 0o700).catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true });
  });
}
