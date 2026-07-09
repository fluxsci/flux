#!/usr/bin/env -S npx tsx
// figure-v1 Phase 3 (pure) — text-system agent parity:
//   • ops-level named-style verbs (create/from-element/update = LIVE link/
//     rename/delete keeps props/apply) + toggleTextStyle semantics + detach
//   • bridge dispatch parity (toggle_text_style, create/update/delete/apply/
//     list_text_styles, set_style with the new text keys)
//   • flux-core loadFigModel MIGRATION (v1 autoWidth → sizing) + textStyles
//     round-trip through its FigIndexFile (the silent-wipe guard) + Asset.dpi
//     round-trip (previously dropped on load)
//   • the old headless crash: ops.scaleElements over auto-sizing text
//
//  Run: npx tsx scripts/figenh-textstyle-parity.ts
import { get } from "svelte/store";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as store from "../src/lib/store";
import * as ops from "../src/lib/ops";
import { migrateProject, DEFAULT_TEXT_STYLES } from "../src/lib/migrate";
import { dispatchCommand } from "../src/lib/bridge/commands";
import type { Project, TextElement, TextStyle } from "../src/lib/types";

let fails = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log("  ok:", msg);
  else {
    fails++;
    console.error("  FAIL:", msg);
  }
}

const mkText = (id: string, over: Partial<TextElement> = {}): TextElement => ({
  type: "text", id, x: 0, y: 0, width: 120, height: 20, rotation: 0,
  text: "hello world", fontFamily: "Arial", fontSize: 12, fontWeight: 400,
  fontStyle: "normal", align: "left", color: "#111111", sizing: "auto",
  ...over,
});

// ---------------------------------------------------------------------------
// 1) pure migration
// ---------------------------------------------------------------------------
{
  const legacy = {
    version: 1, name: "t", canvases: [{ id: "c1", name: "C" }],
    figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 800, height: 600, background: "#fff",
      elements: [
        { ...mkText("t-on"), sizing: undefined, autoWidth: true },
        { ...mkText("t-off"), sizing: undefined, autoWidth: false },
        { ...mkText("t-v2"), sizing: "auto-h" },
      ] }],
    assets: [], palette: [],
  } as unknown as Project;
  migrateProject(legacy);
  const els = legacy.figures[0].elements as TextElement[];
  assert(els[0].sizing === "auto" && !("autoWidth" in els[0]), "migrate: autoWidth true → sizing auto (+key deleted)");
  assert(els[1].sizing === "fixed" && !("autoWidth" in els[1]), "migrate: autoWidth false → sizing fixed");
  assert(els[2].sizing === "auto-h", "migrate: already-migrated element untouched");
  assert((legacy as { version: number }).version === 2, "migrate: version → 2");
  assert(legacy.textStyles?.length === 2 && legacy.textStyles[0].id === "ts-panel-label", "migrate: seeds Panel Label + Body when absent");
  const again = migrateProject(legacy);
  assert(again.textStyles === legacy.textStyles && again.textStyles?.length === 2, "migrate: idempotent (no re-seed)");
  const cleared = migrateProject({ ...legacy, textStyles: [] } as Project);
  assert(cleared.textStyles?.length === 0, "migrate: an explicitly EMPTIED style list stays empty");
}

// ---------------------------------------------------------------------------
// 2) ops verbs headless (through the live store so undo works like the GUI)
// ---------------------------------------------------------------------------
const proj: Project = {
  version: 2, name: "t", canvases: [{ id: "c1", name: "C" }],
  figures: [{ id: "f1", name: "F", canvasId: "c1", x: 0, y: 0, width: 800, height: 600, background: "#fff",
    elements: [mkText("t1"), mkText("t2", { fontWeight: 700 }), mkText("t3")] }],
  assets: [], palette: [],
};
store.loadProject(proj, null);
store.activeFigureId.set("f1");
const el = (id: string) => get(store.project).figures[0].elements.find((e) => e.id === id) as TextElement;
const styles = () => get(store.project).textStyles ?? [];

assert(styles().length === 2, "normalizeProject seeded the default styles on load");

// toggleTextStyle: mixed bold → all bold → all regular
store.commit((p) => ops.toggleTextStyle(p, ["t1", "t2"], "bold"));
assert(el("t1").fontWeight === 700 && el("t2").fontWeight === 700, "toggle bold: mixed → ALL bold");
store.commit((p) => ops.toggleTextStyle(p, ["t1", "t2"], "bold"));
assert(el("t1").fontWeight === 400 && el("t2").fontWeight === 400, "toggle bold: all-on → off everywhere");
store.commit((p) => ops.toggleTextStyle(p, ["t1"], "italic"));
assert(el("t1").fontStyle === "italic", "toggle italic on");
store.commit((p) => ops.toggleTextStyle(p, ["t1"], "underline"));
assert(el("t1").underline === true, "toggle underline on");

// create-from-element + link
let stId = "";
store.commit((p) => {
  const st = ops.textStyleFromElement(p, "t1", "Fancy");
  stId = st?.id ?? "";
});
assert(!!stId && styles().some((s) => s.id === stId), "textStyleFromElement creates a project style");
assert(el("t1").styleId === stId, "…and links the source element");
{
  const st = styles().find((s) => s.id === stId)!;
  assert(st.fontStyle === "italic" && st.underline === true && st.color === "#111111", "snapshot captured italic/underline/color");
}

// apply to another element (defined props + link)
store.commit((p) => ops.applyTextStyle(p, ["t2"], stId));
assert(el("t2").styleId === stId && el("t2").fontStyle === "italic" && el("t2").underline === true, "applyTextStyle sets defined props + styleId");

// update = LIVE re-apply to every linked element
store.commit((p) => ops.updateTextStyle(p, stId, { fontSize: 20, fontWeight: 700 }));
assert(el("t1").fontSize === 20 && el("t2").fontSize === 20 && el("t2").fontWeight === 700, "updateTextStyle re-applies to ALL linked elements (live link)");

// manual font edit DETACHES; color detaches only because this style defines color
store.commit((p) => ops.setElementStyle(p, ["t2"], { fontSize: 14 }));
assert(el("t2").styleId === undefined && el("t1").styleId === stId, "manual font edit detaches ONLY the edited element");
store.commit((p) => ops.setElementStyle(p, ["t1"], { color: "#ff0000" }));
assert(el("t1").styleId === undefined, "color edit detaches when the style DEFINES color");
store.commit((p) => ops.applyTextStyle(p, ["t3"], "ts-body"));
store.commit((p) => ops.setElementStyle(p, ["t3"], { color: "#00ff00" }));
assert(el("t3").styleId === "ts-body", "color edit does NOT detach when the style leaves color undefined");
store.commit((p) => ops.setElementStyle(p, ["t3"], { fontFamily: "Georgia" }));
assert(el("t3").styleId === undefined, "…but a font-prop edit always detaches");

// rename + delete (linked keep props, drop link)
store.commit((p) => ops.applyTextStyle(p, ["t1"], stId));
store.commit((p) => ops.renameTextStyle(p, stId, "Fancier"));
assert(styles().find((s) => s.id === stId)?.name === "Fancier", "renameTextStyle");
store.commit((p) => ops.deleteTextStyle(p, stId));
assert(!styles().some((s) => s.id === stId), "deleteTextStyle removes the style");
assert(el("t1").styleId === undefined && el("t1").fontSize === 20, "…linked element KEEPS its look, drops the link");

// setElementStyle text-metric patch drops the stale wrap cache (headless truth)
store.commit((p) => {
  (p.figures[0].elements.find((e) => e.id === "t1") as TextElement).lines = ["stale"];
  ops.setElementStyle(p, ["t1"], { fontSize: 9 });
});
assert(el("t1").lines === undefined, "setElementStyle(font prop) invalidates the derived lines cache");

// addPanelLabel links the seeded ts-panel-label
store.commit((p) => ops.addPanelLabel(p, "f1", { text: "a", x: 0, y: 0 }));
{
  const lbl = get(store.project).figures[0].elements.find((e) => e.type === "text" && e.panelLabel) as TextElement;
  assert(lbl?.styleId === "ts-panel-label", "addPanelLabel links the seeded Panel Label style");
}

// the old headless crash: scaleElements over auto-sizing text (applyAutoWidth
// used to hit document.createElement under Node)
store.commit((p) => ops.scaleElements(p, ["t1"], 0.5));
assert(Math.abs(el("t1").fontSize - 4.5) < 1e-9, "ops.scaleElements halves text fontSize headless without crashing (9→4.5)");

// ---------------------------------------------------------------------------
// 3) bridge dispatch parity
// ---------------------------------------------------------------------------
// both carry underline=true from section 2 → all-on toggles OFF everywhere
await dispatchCommand({ type: "toggle_text_style", ids: ["t1", "t2"], which: "underline" });
assert(el("t1").underline === false && el("t2").underline === false, "bridge toggle_text_style writes through ops (all-on → off)");

const created = (await dispatchCommand({ type: "create_text_style", name: "AgentStyle", fromElementId: "t1" })) as { style: TextStyle };
assert(created?.style?.name === "AgentStyle" && styles().some((s) => s.id === created.style.id), "bridge create_text_style (from element)");
await dispatchCommand({ type: "apply_text_style", styleId: created.style.id, ids: ["t2", "t3"] });
assert(el("t2").styleId === created.style.id && el("t3").styleId === created.style.id, "bridge apply_text_style links targets");
await dispatchCommand({ type: "update_text_style", styleId: created.style.id, patch: { name: "AgentStyle2", fontWeight: 700 } });
assert(styles().find((s) => s.id === created.style.id)?.name === "AgentStyle2" && el("t2").fontWeight === 700, "bridge update_text_style renames + live-applies");
const listed = (await dispatchCommand({ type: "list_text_styles" })) as { styles: TextStyle[]; scope: string };
assert(listed.scope === "project" && listed.styles.some((s) => s.id === created.style.id), "bridge list_text_styles (project scope)");
await dispatchCommand({ type: "set_style", ids: ["t3"], patch: { underline: true, lineHeight: 1.6, sizing: "fixed" } });
assert(el("t3").underline === true && el("t3").lineHeight === 1.6 && el("t3").sizing === "fixed", "bridge set_style carries underline/lineHeight/sizing");
await dispatchCommand({ type: "delete_text_style", styleId: created.style.id });
assert(!styles().some((s) => s.id === created.style.id) && el("t2").fontWeight === 700, "bridge delete_text_style (props kept)");
let threw = false;
try {
  await dispatchCommand({ type: "apply_text_style", styleId: "ts-nope", ids: ["t1"] });
} catch {
  threw = true;
}
assert(threw, "bridge apply_text_style rejects an unknown styleId loudly");

// ---------------------------------------------------------------------------
// 4) flux-core: loadFigModel migration + textStyles/dpi round-trip on disk
// ---------------------------------------------------------------------------
const core = await import("../flux-core/index");
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "flux-p3-parity-"));
try {
  await core.scaffold(TMP, { title: "P3 parity" });
  // hand-write a V1-shaped canvas (autoWidth text) + an index with a dpi asset
  const idx = JSON.parse(await fs.readFile(path.join(TMP, "fig/index.json"), "utf8"));
  idx.canvases = [{ id: "canvas-1", name: "Canvas 1", order: 1 }];
  idx.figures = [{ id: "fig-1", name: "Fig", label: "fig-1", order: 1, kind: "main", canvas: "canvas-1", caption: "" }];
  idx.assets = [{ id: "a-png", kind: "png", path: "assets/a-png.png", name: "a", naturalWidth: 600, naturalHeight: 300, dpi: 300 }];
  delete idx.textStyles; // pre-P3 index
  await fs.writeFile(path.join(TMP, "fig/index.json"), JSON.stringify(idx, null, 2));
  await fs.mkdir(path.join(TMP, "fig/canvases"), { recursive: true });
  await fs.writeFile(
    path.join(TMP, "fig/canvases/canvas-1.json"),
    JSON.stringify({
      schemaVersion: "0.1.0", id: "canvas-1", name: "Canvas 1",
      figures: [{ id: "fig-1", name: "Fig", canvasId: "canvas-1", x: 0, y: 0, width: 800, height: 600, background: "#fff",
        elements: [
          { type: "text", id: "leg-1", x: 0, y: 0, width: 100, height: 20, rotation: 0, text: "legacy", fontFamily: "Arial", fontSize: 12, fontWeight: 400, fontStyle: "normal", align: "left", color: "#000", autoWidth: false },
        ] }],
    }, null, 2),
  );

  const m1 = await core.loadFigModel(TMP);
  const leg = m1.project.figures[0].elements[0] as TextElement;
  assert(leg.sizing === "fixed" && !("autoWidth" in leg), "flux-core loadFigModel migrates autoWidth → sizing");
  assert(m1.project.textStyles?.length === 2, "flux-core load seeds default styles for a pre-P3 index");
  assert(m1.project.assets[0]?.dpi === 300, "flux-core load keeps Asset.dpi (round-trip fix)");

  // mutate through flux-core verbs → persist → reload
  const made = await core.createTextStyle(TMP, { name: "CoreStyle", fontFamily: "Georgia", fontSize: 16, fontWeight: 700, fontStyle: "italic", underline: true });
  await core.applyTextStyle(TMP, ["leg-1"], made.style.id);
  const idx2 = JSON.parse(await fs.readFile(path.join(TMP, "fig/index.json"), "utf8"));
  assert(Array.isArray(idx2.textStyles) && idx2.textStyles.some((s: TextStyle) => s.id === made.style.id), "textStyles persisted in fig/index.json (explicit writeback)");
  assert(idx2.textStyles.some((s: TextStyle) => s.id === "ts-panel-label"), "…including the seeded defaults");
  assert(idx2.assets?.[0]?.dpi === 300, "Asset.dpi survives the save round-trip");

  const m2 = await core.loadFigModel(TMP);
  const leg2 = m2.project.figures[0].elements[0] as TextElement;
  assert(leg2.styleId === made.style.id && leg2.fontFamily === "Georgia" && leg2.fontSize === 16, "reload: applied style props + link round-trip");
  assert(leg2.underline === true, "reload: the style's underline landed");
  assert(leg2.lines === undefined, "headless edits never persist a wrap cache");

  const list = await core.listTextStyles(TMP);
  assert(list.some((s) => s.id === made.style.id && s.name === "CoreStyle"), "flux-core listTextStyles");
  await core.updateTextStyle(TMP, made.style.id, { fontSize: 22 });
  const m3 = await core.loadFigModel(TMP);
  assert((m3.project.figures[0].elements[0] as TextElement).fontSize === 22, "flux-core updateTextStyle live-applies + persists");

  // a B/I/U toggle is a manual font edit → detaches the link (GUI parity)
  await core.toggleTextStyle(TMP, ["leg-1"], "underline"); // on → off
  const m3b = await core.loadFigModel(TMP);
  const leg3 = m3b.project.figures[0].elements[0] as TextElement;
  assert(leg3.underline === false && leg3.styleId === undefined, "headless underline toggle round-trips + detaches the style link");

  await core.deleteTextStyle(TMP, made.style.id);
  const m4 = await core.loadFigModel(TMP);
  assert(!(m4.project.textStyles ?? []).some((s) => s.id === made.style.id), "flux-core deleteTextStyle persists");
  assert((m4.project.figures[0].elements[0] as TextElement).fontSize === 22, "…deleted style's look survives on the element");

  // addFigText parity wrapper
  const t = await core.addFigText(TMP, "fig-1", { text: "core text", x: 5, y: 5, fontSize: 10, sizing: "auto-h", width: 80 });
  const m5 = await core.loadFigModel(TMP);
  const added = m5.project.figures[0].elements.find((e) => e.id === t.id) as TextElement;
  assert(added?.text === "core text" && added.sizing === "auto-h" && added.width === 80, "flux-core addFigText (sizing + box honored)");
} finally {
  await fs.rm(TMP, { recursive: true, force: true });
}

// keep DEFAULT_TEXT_STYLES import used (it IS the seed contract)
assert(DEFAULT_TEXT_STYLES[0].fontSize === 32 / 3 && DEFAULT_TEXT_STYLES[1].fontSize === 28 / 3, "seed defaults are journal-spec 8pt/7pt (canvas px ×4/3)");

console.log(fails === 0 ? "\nTEXTSTYLE PARITY: ALL PASS" : `\nTEXTSTYLE PARITY: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
