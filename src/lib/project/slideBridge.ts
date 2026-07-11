// ---------------------------------------------------------------------------
// slideBridge — adapter between the slide editor's in-memory deck and the
// project's `slides/` subsystem (the closest model is figbridge.ts, but a deck
// is one self-contained file: `slides/<deckId>/deck.json`, plus a deck-local
// `assets/` dir). The deck is the source of truth; project.json.slides[] is the
// index. The user/agent can hand-edit deck.json — the app live-reloads it.
// ---------------------------------------------------------------------------

import { get } from "svelte/store";
import { fileBridge, joinPath, type ProjectManifest } from "./types";
import type { Deck, SlideElement } from "../slide/types";
import { createDeck as createDeckModel, normalizeDeck } from "../slide/ops";
import { validateDeckFile } from "./validate";
import { quarantineCopy } from "./quarantine";
import { pushToast } from "../toast";
import { isNewerSchema, newerSchemaMessage } from "./types";
import { DECK_SCHEMA_VERSION } from "../slide/types";
import { deck as deckStore, loadDeckModel, deckDirty, deckEditGen, figureGroups, figureMembers, type FigureMemberInfo } from "../slide/store";
import { cachePlot, hasPlotDom, plotManifests } from "../plot/store";
import { isDerivedManifest } from "../plot/derive";
import type { FluxPlotManifest } from "../plot/types";
import { readFigSource } from "./figbridge";
import { ConflictError } from "../autosave";
import { figureToSvg } from "../export";
import { figureGroupTree, membersDeep, effectiveHidden, type FigureGroupNode } from "../groups";
import { elementBBox } from "../geometry";
import { bytesToDataUrl } from "../assets";

export interface DeckListItem {
  id: string;
  path: string;
  title: string;
  slides: number;
}

const stamp = () => new Date().toISOString();
const deckRel = (deckId: string) => `slides/${deckId}/deck.json`;

// WS-5.4: decks had NO divergence guard at all — the fig/ subsystem's baseline
// mechanism, mirrored. Keyed by absolute deck path (deck ids repeat across
// projects); seeded at read, adopted after every save. saveDeckFrom compares
// disk against it and throws ConflictError instead of clobbering an external
// (agent/CLI) edit; the shared autosave controller treats that as
// stay-dirty-no-retry and SlideMode surfaces the reload/overwrite banner.
const deckBaseline = new Map<string, string>();

async function readDeckText(
  fig: NonNullable<ReturnType<typeof fileBridge>>,
  absPath: string,
): Promise<string> {
  try {
    return (await fig.exists(absPath)) ? await fig.readText(absPath) : "";
  } catch {
    return "";
  }
}

/** WS-5.4: has this deck's file changed on disk since we read/wrote it? */
export async function deckDiskDiverged(root: string, deckId: string): Promise<boolean> {
  const fig = fileBridge();
  if (!fig) return false;
  const m = await readManifest(root);
  const rel = m?.slides?.find((s) => s.id === deckId)?.path ?? deckRel(deckId);
  const abs = joinPath(root, rel);
  const baseline = deckBaseline.get(abs);
  if (baseline == null) return false;
  return (await readDeckText(fig, abs)) !== baseline;
}

async function readManifest(root: string): Promise<ProjectManifest | null> {
  const fig = fileBridge();
  if (!fig) return null;
  try {
    const p = joinPath(root, "project.json");
    if (await fig.exists(p)) return JSON.parse(await fig.readText(p)) as ProjectManifest;
  } catch {
    /* unreadable manifest */
  }
  return null;
}

async function writeManifest(root: string, m: ProjectManifest): Promise<void> {
  const fig = fileBridge();
  if (!fig) return;
  m.modified = stamp();
  await fig.writeText(joinPath(root, "project.json"), JSON.stringify(m, null, 2) + "\n");
}

/** The project's decks (from project.json.slides[]), enriched with title + slide
 *  count (best-effort). */
export async function listProjectDecks(root: string): Promise<DeckListItem[]> {
  const fig = fileBridge();
  const m = await readManifest(root);
  // Respect the registry's `order` (C19) — a stable deck order, newest appended
  // last (registerDeck assigns order = slides.length + 1) unless the user sorts.
  const entries = [...(m?.slides ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const out: DeckListItem[] = [];
  for (const e of entries) {
    const rel = e.path ?? deckRel(e.id);
    let title = e.title ?? e.id;
    let slides = 0;
    try {
      if (fig && (await fig.exists(joinPath(root, rel)))) {
        const d = JSON.parse(await fig.readText(joinPath(root, rel))) as Deck;
        title = d.title ?? title;
        slides = d.slides?.length ?? 0;
      }
    } catch {
      /* still list the entry even if the deck file is unreadable */
    }
    out.push({ id: e.id, path: rel, title, slides });
  }
  return out;
}

/** Read a deck file (without touching the live store). */
export async function readDeck(root: string, deckId: string): Promise<Deck | null> {
  const fig = fileBridge();
  if (!fig) return null;
  const m = await readManifest(root);
  const rel = m?.slides?.find((s) => s.id === deckId)?.path ?? deckRel(deckId);
  try {
    if (await fig.exists(joinPath(root, rel))) {
      const text = await fig.readText(joinPath(root, rel));
      const rawDeck = JSON.parse(text) as Deck;
      // WS-5.2 forward-version guard FIRST (before migration/validation): a
      // newer deck must not be normalized down or judged by our schema.
      if (isNewerSchema(rawDeck.schemaVersion, DECK_SCHEMA_VERSION)) {
        pushToast("error", `Deck "${deckId}" written by a newer Flux — skipped`, {
          detail: newerSchemaMessage(rel, rawDeck.schemaVersion, DECK_SCHEMA_VERSION),
        });
        return null;
      }
      // WS-4.4: normalize at the read seam (migration + track ids) — every
      // consumer (load-into-editor, duplicate, export) sees the current model.
      const deck = normalizeDeck(rawDeck);
      // WS-5.1 load gate: an invalid deck is quarantined (bytes preserved) and
      // skipped — never half-loaded into the editor.
      const errs = validateDeckFile(deck);
      if (errs.length) {
        const q = await quarantineCopy(fig, joinPath(root, rel), text);
        pushToast("error", `Deck "${deckId}" failed validation — skipped`, {
          detail: `${errs.slice(0, 5).join("\n")}${q ? `\nOriginal preserved at ${q}` : ""}`,
        });
        return null;
      }
      deckBaseline.set(joinPath(root, rel), text); // WS-5.4: what we believe is on disk
      return deck;
    }
  } catch {
    /* unreadable */
  }
  return null;
}

/** Load a deck into the live editor store (clobbers the current deck). */
export async function loadDeckInto(root: string, deckId: string): Promise<Deck | null> {
  const d = await readDeck(root, deckId);
  if (d) loadDeckModel(d);
  return d;
}

/** Ensure a deck is registered in project.json.slides[] (id/path/title/order). */
async function registerDeck(root: string, deck: Deck): Promise<void> {
  const m = await readManifest(root);
  if (!m) return;
  m.slides = Array.isArray(m.slides) ? m.slides : [];
  const idx = m.slides.findIndex((s) => s.id === deck.id);
  // WS-5.4: preserve a manifest-customized path — readDeck resolves through the
  // manifest, so forcing the default here split reads and writes across files.
  const rel = (idx >= 0 ? m.slides[idx].path : undefined) ?? deckRel(deck.id);
  const order = idx >= 0 ? m.slides[idx].order ?? idx + 1 : m.slides.length + 1;
  const entry = { id: deck.id, path: rel, title: deck.title, order };
  if (idx >= 0) m.slides[idx] = { ...m.slides[idx], ...entry };
  else m.slides.push(entry);
  await writeManifest(root, m);
}

/** Persist the live deck to slides/<id>/deck.json (+ register in the manifest). */
export async function saveDeckFrom(root: string, opts: { force?: boolean } = {}): Promise<void> {
  const fig = fileBridge();
  const d = get(deckStore);
  if (!fig || !d) return;
  // WS-5.4 conflict guard (fig/'s W7 mechanism, mirrored): refuse to clobber a
  // deck.json that changed on disk since we read/wrote it. `force` = the
  // banner's Overwrite. NOTE the abs path must match readDeck's seed — resolve
  // through the manifest the same way.
  const m0 = await readManifest(root);
  const rel = m0?.slides?.find((s) => s.id === d.id)?.path ?? deckRel(d.id);
  const abs = joinPath(root, rel);
  const baseline = deckBaseline.get(abs);
  if (!opts.force && baseline != null && (await readDeckText(fig, abs)) !== baseline) {
    throw new ConflictError("deck changed on disk");
  }
  const genAtStart = deckEditGen.n; // W4: only clear dirty if no edit lands mid-save
  d.modified = stamp();
  await fig.mkdir(joinPath(root, "slides", d.id));
  await fig.mkdir(joinPath(root, "slides", d.id, "assets"));
  const text = JSON.stringify(d, null, 2) + "\n";
  await fig.writeText(abs, text);
  deckBaseline.set(abs, text); // adopt what we just wrote
  await registerDeck(root, d);
  // WS6: provenance for the human's save (Electron only; mem/demo bridge no-ops).
  const host = (globalThis as { fig?: { journalAppend?: (e: unknown) => void } }).fig;
  host?.journalAppend?.({ action: "save_deck", target: d.id, client: "human" });
  // W4: an edit landing during the writes above keeps deckDirty; the autosave
  // controller's trailing save persists it instead of it being silently dropped.
  if (deckEditGen.n === genAtStart) deckDirty.set(false);
}

/** Write imported media (a dropped/pasted image) into a deck's assets/ dir and
 *  return the deck-relative path (e.g. "assets/photo-2.png") to store on the new
 *  DeckAsset. De-dupes the filename so re-importing never clobbers. The caller
 *  then registers the asset + element (one commitDeck) and refreshes resolvers. */
export async function writeDeckAsset(
  root: string,
  deckId: string,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  const fig = fileBridge();
  if (!fig) throw new Error("no file bridge (web/demo mode cannot import media)");
  const dir = joinPath(root, "slides", deckId, "assets");
  await fig.mkdir(dir);
  const dot = filename.lastIndexOf(".");
  const stem = (dot > 0 ? filename.slice(0, dot) : filename) || "image";
  const ext = dot > 0 ? filename.slice(dot) : "";
  let name = `${stem}${ext}`;
  for (let i = 1; await fig.exists(joinPath(dir, name)); i++) name = `${stem}-${i}${ext}`;
  await fig.writeFile(joinPath(dir, name), bytes);
  return `assets/${name}`;
}

// --- export (E): self-contained offline .html, via the main process -----------
/** True when the host can export a deck. The engine is Node-only (esbuild + fs),
 *  so export is desktop-only — gated on the bridge method existing (absent in the
 *  web/mem demo). */
export function canExportDeck(): boolean {
  const f = fileBridge() as { exportDeck?: unknown } | null;
  return typeof f?.exportDeck === "function";
}

/** Export a deck to a self-contained offline .html via the main process. Returns
 *  the written path; throws with the reason on failure (or if unavailable). */
export async function exportDeck(root: string, deckId: string): Promise<string> {
  const f = fileBridge() as {
    exportDeck?: (r: string, d: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  } | null;
  if (!f?.exportDeck) throw new Error("Export is only available in the desktop app.");
  const res = await f.exportDeck(root, deckId);
  if (!res?.ok || !res.path) throw new Error(res?.error || "Export failed.");
  return res.path;
}

// --- insertables (what the editor's Insert menu can drop on a slide) ---------
export interface Insertables {
  figures: {
    id: string;
    title: string;
    /** Named groups inside the figure, insertable as their own live embeds
     *  (figure-v1). label carries the nesting breadcrumb; w/h = the group's
     *  bbox in figure units, for aspect-true placement. */
    groups: { id: string; label: string; w: number; h: number }[];
  }[];
  plots: { id: string; title: string; svgPath?: string; manifestPath?: string }[];
  images: { id: string; kind: string; path: string }[];
}

/** Enumerate the project's reusable content a slide can embed: composed figures,
 *  semantic plots, and raster/vector images (from project.json). Titles fall back
 *  to ids. Empty groups simply don't appear in the menu. */
export async function listInsertables(root: string): Promise<Insertables> {
  // Plots, figures, and images are ALL filesystem-discovered — project.json is
  // not the source of truth (its figures[] is a stale rollup; plots/assets aren't
  // in it at all). Read images leniently from the manifest assets array.
  const m = (await readManifest(root)) as unknown as {
    assets?: { id: string; kind: string; path: string }[];
  } | null;

  // Figures: the composed figures the figure viewer shows, from fig/index.json —
  // the SAME readFigSource loadDeckAssets uses below (NOT project.json.figures).
  let figures: Insertables["figures"] = [];
  try {
    const src = await readFigSource(root);
    figures = src.indexFigures
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((f) => {
        // Named groups → insertable rows (breadcrumb label, bbox for sizing).
        const groups: Insertables["figures"][number]["groups"] = [];
        const figure = src.figures[f.id];
        if (figure) {
          const walk = (nodes: FigureGroupNode[], crumb: string[]) => {
            for (const g of nodes) {
              const members = membersDeep(figure, g.id).filter((e) => !effectiveHidden(figure, e));
              if (members.length) {
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                for (const e of members) {
                  const b = elementBBox(e);
                  x0 = Math.min(x0, b.x);
                  y0 = Math.min(y0, b.y);
                  x1 = Math.max(x1, b.x + b.w);
                  y1 = Math.max(y1, b.y + b.h);
                }
                groups.push({
                  id: g.id,
                  label: [...crumb, g.name].join(" › "),
                  w: Math.max(1, x1 - x0),
                  h: Math.max(1, y1 - y0),
                });
              }
              walk(g.groups, [...crumb, g.name]);
            }
          };
          walk(figureGroupTree(figure), []);
        }
        return { id: f.id, title: f.name ?? f.id, groups };
      });
  } catch {
    /* no fig/ dir — no figures to insert */
  }

  // Plots: walk plots/ for *.svg (semantic = has a .fluxplot.json sibling), the
  // same recursive scan PlotImporter uses. Project-relative svg/manifest paths so
  // loadDeckAssets can read + cache them; id = the path under plots/ (stable+unique).
  const plots: Insertables["plots"] = [];
  const fig = fileBridge();
  if (fig?.readdir) {
    const visit = async (dir: string, rel: string, depth: number) => {
      if (depth > 6 || plots.length > 2000) return;
      let es: { name: string; dir: boolean }[];
      try { es = await fig.readdir!(dir); } catch { return; }
      const names = new Set(es.map((e) => e.name));
      for (const e of es) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.dir) await visit(joinPath(dir, e.name), r, depth + 1);
        else if (/\.svg$/i.test(e.name)) {
          const base = r.replace(/\.svg$/i, "");
          const semantic = names.has(e.name.replace(/\.svg$/i, ".fluxplot.json"));
          plots.push({
            id: base, title: base.split("/").pop() ?? base,
            svgPath: `plots/${base}.svg`,
            manifestPath: semantic ? `plots/${base}.fluxplot.json` : undefined,
          });
        }
      }
    };
    await visit(joinPath(root, "plots"), "", 0);
    plots.sort((a, b) => a.title.localeCompare(b.title));
  }

  const images = (m?.assets ?? [])
    .filter((a) => /^(png|jpg|jpeg|gif|webp|svg)$/.test(a.kind))
    .map((a) => ({ id: a.id, kind: a.kind, path: a.path }));
  return { figures, plots, images };
}

// --- asset loading (so plots / figures / images render on the stage) ---------
function mimeForKind(kind: string): string {
  switch (kind) {
    case "svg": return "image/svg+xml";
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "mov": return "video/quicktime";
    default: return "application/octet-stream";
  }
}

/** WS-4.4: a resolution gap surfaced instead of swallowed — mirrors flux-core
 *  gatherDeckPayload's warnings so GUI and headless agree on what's broken. */
export interface DeckDiag {
  severity: "warning" | "error";
  assetId?: string;
  path?: string;
  reason: string;
}

export interface DeckAssetResolvers {
  assetUrl: (assetId: string) => string | undefined;
  /** groupId scopes the markup to one named group (group embeds). */
  figureSvg: (figureId: string, groupId?: string) => string | undefined;
  /** Everything that could not be resolved (missing media/plot/manifest/fig). */
  diagnostics: DeckDiag[];
}

/** Preload the assets a deck needs to render: deck-local media → data URLs,
 *  semantic plots → the plot cache (so render's mountPlot finds them), and the
 *  project's figures → standalone SVG (for embedFigure). Returns sync resolvers. */
export async function loadDeckAssets(root: string, deck: Deck): Promise<DeckAssetResolvers> {
  const fig = fileBridge();
  const assetData: Record<string, string> = {};
  const diagnostics: DeckDiag[] = [];

  // 1. deck-local media (slides/<id>/assets/*) → data URLs. Every svg asset is
  // ALSO cached as an inline semantic plot (derived manifest inside cachePlot),
  // so a plot element referencing a deck-local svg (incl. legacy `type:"svg"`
  // elements converted at load) renders live DOM instead of a placeholder —
  // the slide mirror of io.ts openProject / figbridge loadFigInto (P4).
  if (fig) {
    for (const a of deck.assets ?? []) {
      if (!a.path) continue;
      try {
        const bytes = new Uint8Array(await fig.readFile(joinPath(root, "slides", deck.id, a.path)));
        assetData[a.id] = bytesToDataUrl(bytes, mimeForKind(a.kind));
        if (a.kind === "svg" && !hasPlotDom(a.id)) {
          cachePlot(a.id, new TextDecoder().decode(bytes));
        }
      } catch {
        diagnostics.push({
          severity: "warning",
          assetId: a.id,
          path: a.path,
          reason: `media asset "${a.id}" missing (${a.path}) — its element will show a placeholder`,
        });
      }
    }
  }

  // 2. semantic plots referenced by plot elements → the plot cache.
  if (fig) {
    // A DERIVED manifest (synthesized at cachePlot for a manifest-less svg)
    // does not count as "have" here: the real .fluxplot.json sidecar must
    // still be found + backfilled over it, or a plot cached before its
    // manifest loaded would never heal (Auto-animate stays disabled).
    const haveReal = (assetId: string) => {
      const m = get(plotManifests)[assetId];
      return !!m && !isDerivedManifest(m);
    };
    const plots = deck.slides.flatMap((s) => s.elements).filter((e): e is Extract<SlideElement, { type: "plot" }> => e.type === "plot");
    for (const el of plots) {
      if (!el.source?.svgPath) continue;
      const haveDom = hasPlotDom(el.assetId);
      const haveManifest = haveReal(el.assetId);
      if (haveDom && haveManifest) continue; // fully cached — nothing to do
      try {
        // Prefer an explicit manifestPath; otherwise fall back to the
        // `.fluxplot.json` SIBLING of the SVG — the exact convention the plot
        // importer uses to flag a plot "semantic". Decks authored before
        // manifestPath was persisted carry only svgPath, so without this their
        // plots cache with no manifest and Auto-animate reports "no build
        // manifest" even though the sidecar sits right next to the SVG.
        const manifestPath = el.source.manifestPath ?? el.source.svgPath.replace(/\.svg$/i, ".fluxplot.json");
        let manifest: FluxPlotManifest | undefined;
        try { manifest = JSON.parse(await fig.readText(joinPath(root, manifestPath))) as FluxPlotManifest; } catch { /* no sidecar — a non-semantic plot */ }
        if (!haveDom) {
          // first time: parse the SVG + register dom + manifest together.
          const svgText = await fig.readText(joinPath(root, el.source.svgPath));
          cachePlot(el.assetId, svgText, manifest as FluxPlotManifest);
        } else if (manifest) {
          // dom is already cached (e.g. authored by code that didn't load the
          // manifest); backfill JUST the manifest without re-parsing the SVG, so
          // an in-app reload heals an already-loaded plot without a restart.
          plotManifests.update((m) => ({ ...m, [el.assetId]: manifest as FluxPlotManifest }));
        }
      } catch {
        diagnostics.push({
          severity: "warning",
          assetId: el.assetId,
          path: el.source.svgPath,
          reason: `plot "${el.assetId}" unreadable (${el.source.svgPath}) — its element will show a placeholder`,
        });
      }
    }

    // 2b. morph TARGETS referenced only by tracks (to.assetId) — they never
    // appear as elements, so without this the compat gate sees no manifest and
    // the morph silently holds at A in preview while the export (which gathers
    // them) would play it. One player, two hosts — both need the same inputs.
    // Insertable plot ids ARE their path under plots/ minus ".svg", hence the
    // convention fallback for targets picked from the project at large.
    const morphTargets = new Map<string, { svgPath?: string; manifestPath?: string }>();
    for (const s of deck.slides) for (const b of s.beats) for (const t of b.tracks) {
      if (t.preset === "morph" && t.to?.assetId)
        morphTargets.set(t.to.assetId, {
          svgPath: t.to.svgPath as string | undefined,
          manifestPath: t.to.manifestPath as string | undefined,
        });
    }
    for (const [assetId, authored] of morphTargets) {
      if (hasPlotDom(assetId) && haveReal(assetId)) continue;
      const el = plots.find((p) => p.assetId === assetId);
      // WS-4.4 resolution order: track-authored paths → the element's source →
      // the legacy `plots/<id>.svg` guess (last resort only).
      const svgPath = authored.svgPath ?? el?.source?.svgPath ?? `plots/${assetId}.svg`;
      const manifestPath =
        authored.manifestPath ?? el?.source?.manifestPath ?? svgPath.replace(/\.svg$/i, ".fluxplot.json");
      try {
        let manifest: FluxPlotManifest | undefined;
        try { manifest = JSON.parse(await fig.readText(joinPath(root, manifestPath))) as FluxPlotManifest; } catch { /* no sidecar */ }
        if (!hasPlotDom(assetId)) {
          const svgText = await fig.readText(joinPath(root, svgPath));
          cachePlot(assetId, svgText, manifest as FluxPlotManifest);
        } else if (manifest) {
          plotManifests.update((m) => ({ ...m, [assetId]: manifest as FluxPlotManifest }));
        }
      } catch {
        diagnostics.push({
          severity: "warning",
          assetId,
          path: svgPath,
          reason: `morph target "${assetId}" unresolvable (${svgPath}) — the morph will hold at A`,
        });
      }
    }
  }

  // 3. project figures (for embedFigure) → standalone SVG via figureToSvg,
  // PLUS each figure's group tree into the figureGroups store (P9) so the
  // animator's PartsTree can expand an embedFigure into its named groups —
  // the same one-refresh flow that seeds plotManifests for plot parts. The
  // exported svg already carries the matching `<g id="<figId>__group:<gid>">`
  // wrappers (export.ts), so a group row's track resolves in the live stage,
  // the present player, AND the offline export without further plumbing.
  let figSvgCache: Record<string, string> = {};
  const figGroupTrees: Record<string, FigureGroupNode[]> = {};
  const figMemberInfo: Record<string, Record<string, FigureMemberInfo>> = {};
  const needsFigures = deck.slides.some((s) => s.elements.some((e) => e.type === "embedFigure"));
  if (needsFigures && fig) {
    try {
      const src = await readFigSource(root);
      for (const [fid, f] of Object.entries(src.figures)) {
        figSvgCache[fid] = figureToSvg(f, (aid) => src.assetData[aid]);
        figGroupTrees[fid] = figureGroupTree(f);
        // Member metadata + member plot MANIFESTS: the PartsTree lists a
        // group's members and expands member plots into their part trees;
        // "el:<mid>/<partId>" tracks fan out through the manifest. Don't
        // clobber a live figure-mode cache (hasPlotDom) — just fill gaps.
        const members: Record<string, FigureMemberInfo> = {};
        for (const e of f.elements) {
          const info: FigureMemberInfo = { type: e.type };
          if (e.name) info.name = e.name;
          if (e.type === "plot") {
            info.assetId = e.assetId;
            if (!hasPlotDom(e.assetId)) {
              try {
                const sp = joinPath(root, "fig", "assets", `${e.assetId}.svg`);
                if (await fig.exists(sp)) {
                  let manifest: FluxPlotManifest | undefined;
                  try {
                    const mp = joinPath(root, "fig", "assets", `${e.assetId}.fluxplot.json`);
                    if (await fig.exists(mp)) manifest = JSON.parse(await fig.readText(mp)) as FluxPlotManifest;
                  } catch { /* sidecar optional — cachePlot derives */ }
                  cachePlot(e.assetId, await fig.readText(sp), manifest);
                }
              } catch { /* member plot cache is best-effort */ }
            }
          }
          members[e.id] = info;
        }
        figMemberInfo[fid] = members;
      }
      // Group-scoped embeds (figure-v1): pre-render each (figure, group) pair
      // the deck actually uses, keyed "fid::gid" (same convention as the
      // offline-export payload in flux-core gatherDeckPayload).
      for (const s of deck.slides)
        for (const el of s.elements) {
          if (el.type !== "embedFigure" || !el.groupId) continue;
          const key = `${el.figureId}::${el.groupId}`;
          const f = src.figures[el.figureId];
          if (f && !figSvgCache[key])
            figSvgCache[key] = figureToSvg(f, (aid) => src.assetData[aid], undefined, undefined, { groupId: el.groupId });
        }
    } catch {
      diagnostics.push({
        severity: "warning",
        reason: "fig/ could not be read — embedFigure elements will show placeholders",
      });
    }
  }
  figureGroups.set(figGroupTrees);
  figureMembers.set(figMemberInfo);

  return {
    assetUrl: (id) => assetData[id],
    figureSvg: (fid, gid) => figSvgCache[gid ? `${fid}::${gid}` : fid],
    diagnostics,
  };
}

/** Create a new deck in the project (write + register), and load it into the
 *  editor. Returns the new deck. */
export async function createDeckInProject(
  root: string,
  opts: { title?: string; theme?: string } = {},
): Promise<Deck> {
  const fig = fileBridge();
  const d = createDeckModel({ title: opts.title, theme: opts.theme });
  if (fig) {
    await fig.mkdir(joinPath(root, "slides", d.id));
    await fig.mkdir(joinPath(root, "slides", d.id, "assets"));
    await fig.writeText(joinPath(root, deckRel(d.id)), JSON.stringify(d, null, 2) + "\n");
    await registerDeck(root, d);
  }
  loadDeckModel(d);
  return d;
}

/** Duplicate a deck on disk (new id + " copy" title, assets copied) and register
 *  it. Returns the new deck id. Does NOT load it — the caller switches decks. */
export async function duplicateDeckInProject(root: string, srcId: string): Promise<string | null> {
  const fig = fileBridge();
  const src = await readDeck(root, srcId);
  if (!fig || !src) return null;
  const dupe: Deck = structuredClone(src);
  dupe.id = createDeckModel({ title: src.title }).id; // fresh deck id
  dupe.title = `${src.title} copy`;
  dupe.created = stamp();
  dupe.modified = stamp();
  await fig.mkdir(joinPath(root, "slides", dupe.id));
  await fig.mkdir(joinPath(root, "slides", dupe.id, "assets"));
  // copy each deck-local asset file (paths are deck-relative, same names)
  for (const a of dupe.assets ?? []) {
    try {
      const bytes = new Uint8Array(await fig.readFile(joinPath(root, "slides", srcId, a.path)));
      await fig.writeFile(joinPath(root, "slides", dupe.id, a.path), bytes);
    } catch { /* skip an unreadable asset — the deck still opens */ }
  }
  await fig.writeText(joinPath(root, deckRel(dupe.id)), JSON.stringify(dupe, null, 2) + "\n");
  await registerDeck(root, dupe);
  return dupe.id;
}

/** Remove a deck from the project registry (project.json.slides[]). The deck's
 *  files are left on disk (the bridge has no file-remove) — a safe, reversible
 *  "remove from project". No-op if it's the only deck. */
export async function deleteDeckFromProject(root: string, deckId: string): Promise<boolean> {
  const fig = fileBridge();
  const m = await readManifest(root);
  if (!fig || !m) return false;
  const slides = Array.isArray(m.slides) ? m.slides : [];
  if (slides.length <= 1) return false; // never remove the last deck
  m.slides = slides.filter((s) => s.id !== deckId);
  if (m.slides.length === slides.length) return false; // nothing removed
  await writeManifest(root, m);
  return true;
}
