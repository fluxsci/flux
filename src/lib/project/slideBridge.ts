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
import { createDeck as createDeckModel } from "../slide/ops";
import { deck as deckStore, loadDeckModel, deckDirty } from "../slide/store";
import { cachePlot, hasPlotDom, plotManifests } from "../plot/store";
import type { FluxPlotManifest } from "../plot/types";
import { readFigSource } from "./figbridge";
import { figureToSvg } from "../export";
import { bytesToDataUrl } from "../assets";

export interface DeckListItem {
  id: string;
  path: string;
  title: string;
  slides: number;
}

const stamp = () => new Date().toISOString();
const deckRel = (deckId: string) => `slides/${deckId}/deck.json`;

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
  const entries = m?.slides ?? [];
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
    if (await fig.exists(joinPath(root, rel)))
      return JSON.parse(await fig.readText(joinPath(root, rel))) as Deck;
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
  const rel = deckRel(deck.id);
  const idx = m.slides.findIndex((s) => s.id === deck.id);
  const order = idx >= 0 ? m.slides[idx].order ?? idx + 1 : m.slides.length + 1;
  const entry = { id: deck.id, path: rel, title: deck.title, order };
  if (idx >= 0) m.slides[idx] = { ...m.slides[idx], ...entry };
  else m.slides.push(entry);
  await writeManifest(root, m);
}

/** Persist the live deck to slides/<id>/deck.json (+ register in the manifest). */
export async function saveDeckFrom(root: string): Promise<void> {
  const fig = fileBridge();
  const d = get(deckStore);
  if (!fig || !d) return;
  d.modified = stamp();
  await fig.mkdir(joinPath(root, "slides", d.id));
  await fig.mkdir(joinPath(root, "slides", d.id, "assets"));
  await fig.writeText(joinPath(root, deckRel(d.id)), JSON.stringify(d, null, 2) + "\n");
  await registerDeck(root, d);
  // WS6: provenance for the human's save (Electron only; mem/demo bridge no-ops).
  const host = (globalThis as { fig?: { journalAppend?: (e: unknown) => void } }).fig;
  host?.journalAppend?.({ action: "save_deck", target: d.id, client: "human" });
  deckDirty.set(false);
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
  figures: { id: string; title: string }[];
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
      .map((f) => ({ id: f.id, title: f.name ?? f.id }));
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

export interface DeckAssetResolvers {
  assetUrl: (assetId: string) => string | undefined;
  figureSvg: (figureId: string) => string | undefined;
}

/** Preload the assets a deck needs to render: deck-local media → data URLs,
 *  semantic plots → the plot cache (so render's mountPlot finds them), and the
 *  project's figures → standalone SVG (for embedFigure). Returns sync resolvers. */
export async function loadDeckAssets(root: string, deck: Deck): Promise<DeckAssetResolvers> {
  const fig = fileBridge();
  const assetData: Record<string, string> = {};

  // 1. deck-local media (slides/<id>/assets/*) → data URLs.
  if (fig) {
    for (const a of deck.assets ?? []) {
      if (!a.path) continue;
      try {
        const bytes = new Uint8Array(await fig.readFile(joinPath(root, "slides", deck.id, a.path)));
        assetData[a.id] = bytesToDataUrl(bytes, mimeForKind(a.kind));
      } catch {
        /* missing media — element shows a placeholder */
      }
    }
  }

  // 2. semantic plots referenced by plot elements → the plot cache.
  if (fig) {
    const plots = deck.slides.flatMap((s) => s.elements).filter((e): e is Extract<SlideElement, { type: "plot" }> => e.type === "plot");
    for (const el of plots) {
      if (!el.source?.svgPath) continue;
      const haveDom = hasPlotDom(el.assetId);
      const haveManifest = !!get(plotManifests)[el.assetId];
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
        /* unreadable plot — element shows a placeholder */
      }
    }
  }

  // 3. project figures (for embedFigure) → standalone SVG via figureToSvg.
  let figSvgCache: Record<string, string> = {};
  const needsFigures = deck.slides.some((s) => s.elements.some((e) => e.type === "embedFigure"));
  if (needsFigures && fig) {
    try {
      const src = await readFigSource(root);
      for (const [fid, f] of Object.entries(src.figures)) {
        figSvgCache[fid] = figureToSvg(f, (aid) => src.assetData[aid]);
      }
    } catch {
      /* no fig/ — embedFigure shows a placeholder */
    }
  }

  return {
    assetUrl: (id) => assetData[id],
    figureSvg: (fid) => figSvgCache[fid],
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
