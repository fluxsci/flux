// flux-core/slides.ts — the Flux Slide deck format as a Node library (CLI + MCP).
//
// Mirrors the figure side of flux-core/index.ts: load/save a deck through the
// shared pure ops core (src/lib/slide/ops.ts), hold an advisory lock so an agent
// write defers rather than clobbering a live human edit, and journal every
// mutation. "The file is the API" — the GUI (slideBridge.ts) and this module
// read/write the same slides/<id>/deck.json.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import Ajv from "ajv";
import { safeJoin, journal, loadManifest, getClient, renderFigureSvg } from "./index";
import { atomicWrite } from "./fsx";
import { withLock } from "./locks";
import { SCHEMAS } from "./schemas";
import * as slideOps from "../src/lib/slide/ops";
import { exportDeckHtml } from "../src/lib/slide/export/exportDeck";
import type { ExportPayload } from "../src/lib/slide/export/runtime";
import type { FluxPlotManifest } from "../src/lib/plot/types";
import type { Deck, Track } from "../src/lib/slide/types";
import type { ProjectManifest } from "../src/lib/project/types";

const j = (...p: string[]) => path.join(...p);
const stamp = () => new Date().toISOString();

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
async function readJSON<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8")) as T;
}
async function writeText(p: string, t: string): Promise<void> {
  await atomicWrite(p, t); // W2: durable tmp+fsync+rename
}

const deckRel = (deckId: string) => `slides/${deckId}/deck.json`;

/** Resolve a deck's on-disk path: prefer its manifest entry, else the default. */
async function resolveDeckPath(root: string, deckId: string): Promise<string> {
  const m = await loadManifest(root).catch(() => null);
  const entry = (m?.slides ?? []).find((s) => s.id === deckId);
  return safeJoin(root, entry?.path ?? deckRel(deckId));
}

// --------------------------------------------------------------------------
// list / load / save
// --------------------------------------------------------------------------
export interface DeckSummary {
  id: string;
  path: string;
  title: string;
  slides: number;
  order?: number;
}

/** listDecks: the project's decks (from project.json.slides[]), enriched with
 *  each deck's title + slide count (best-effort). */
export async function listDecks(root: string): Promise<DeckSummary[]> {
  const m = await loadManifest(root).catch(() => null);
  const entries = m?.slides ?? [];
  const out: DeckSummary[] = [];
  for (const e of entries) {
    const p = safeJoin(root, e.path ?? deckRel(e.id));
    let title = (e as { title?: string }).title ?? e.id;
    let slides = 0;
    try {
      const deck = await readJSON<Deck>(p);
      title = deck.title ?? title;
      slides = deck.slides?.length ?? 0;
    } catch {
      /* unreadable / missing deck.json — still list the entry */
    }
    out.push({ id: e.id, path: e.path ?? deckRel(e.id), title, slides, order: (e as { order?: number }).order });
  }
  return out;
}

/** loadDeck: read slides/<deckId>/deck.json. */
export async function loadDeck(root: string, deckId: string): Promise<Deck> {
  const p = await resolveDeckPath(root, deckId);
  if (!(await exists(p))) throw new Error(`deck not found: ${deckId} (${path.relative(root, p)})`);
  return readJSON<Deck>(p);
}

/** Ensure a deck is registered in project.json.slides[] (id/path/title/order). */
async function registerDeck(root: string, deck: Deck): Promise<void> {
  const mp = j(root, "project.json");
  if (!(await exists(mp))) return; // a deck can exist standalone of a manifest (tests)
  const m = await readJSON<ProjectManifest>(mp);
  m.slides = Array.isArray(m.slides) ? m.slides : [];
  const rel = deckRel(deck.id);
  const idx = m.slides.findIndex((s) => s.id === deck.id);
  const entry = { id: deck.id, path: rel, title: deck.title, order: idx >= 0 ? (m.slides[idx] as { order?: number }).order ?? idx + 1 : m.slides.length + 1 };
  if (idx >= 0) m.slides[idx] = { ...m.slides[idx], ...entry };
  else m.slides.push(entry);
  m.modified = stamp();
  await writeText(mp, JSON.stringify(m, null, 2) + "\n");
}

/** saveDeck: write deck.json (restamp modified) + register in the manifest, under
 *  the "slides" advisory lock, then journal. */
export async function saveDeck(root: string, deck: Deck, action = "save_deck"): Promise<void> {
  await withLock(root, "slides", getClient(), () => saveDeckUnlocked(root, deck));
  await journal(root, { action, deck: deck.id, slides: deck.slides.length });
}

async function saveDeckUnlocked(root: string, deck: Deck): Promise<void> {
  deck.modified = stamp();
  await writeText(safeJoin(root, deckRel(deck.id)), JSON.stringify(deck, null, 2) + "\n");
  await registerDeck(root, deck);
}

/** W3: run a deck read→mutate→write atomically under the "slides" lock (the load
 *  happens INSIDE the lock, so two agents can't interleave a lost update). */
export async function mutateDeck<T>(
  root: string,
  deckId: string,
  action: string,
  fn: (deck: Deck) => T | Promise<T>,
): Promise<T> {
  let out!: T;
  let slideCount = 0;
  await withLock(root, "slides", getClient(), async () => {
    const deck = await loadDeck(root, deckId);
    out = await fn(deck);
    slideCount = deck.slides.length;
    await saveDeckUnlocked(root, deck);
  });
  await journal(root, { action, deck: deckId, slides: slideCount });
  return out;
}

// --------------------------------------------------------------------------
// verbs (thin wrappers over the pure ops, mirroring index.ts's figure verbs)
// --------------------------------------------------------------------------

/** new-deck: scaffold a fresh deck on disk + register it. */
export async function createDeck(
  root: string,
  opts: { id?: string; title?: string; theme?: string } = {},
): Promise<{ deckId: string; path: string }> {
  const deck = slideOps.createDeck({ id: opts.id, title: opts.title, theme: opts.theme });
  await saveDeck(root, deck, "create_deck");
  return { deckId: deck.id, path: deckRel(deck.id) };
}

/** add-slide: append a slide to a deck. */
export async function addSlide(
  root: string,
  deckId: string,
  opts: { name?: string; layout?: import("../src/lib/slide/types").LayoutId } = {},
): Promise<{ slideId: string }> {
  return mutateDeck(root, deckId, "add_slide", (deck) => {
    const slide = slideOps.addSlide(deck, opts);
    return { slideId: slide.id };
  });
}

// --------------------------------------------------------------------------
// W11b (AGT-6/SLD-6): slide-authoring verbs. The whole Slides pillar was
// CLI-only (5 verbs) with ZERO MCP tools and no way to add content, beats, or
// animations headlessly. These wrap the pure slideOps so an agent can build an
// animated deck with the app closed (and via MCP). Each throws with a clear
// message if the deck/slide/beat target is missing.
// --------------------------------------------------------------------------
const mustSlide = (deck: Deck, slideId: string) => {
  const s = slideOps.slideById(deck, slideId);
  if (!s) throw new Error(`slide not found: ${slideId}`);
  return s;
};

/** delete-slide: remove a slide. Returns the id the GUI would activate next. */
export async function deleteSlide(root: string, deckId: string, slideId: string): Promise<{ nextActiveId: string | null }> {
  return mutateDeck(root, deckId, "delete_slide", (deck) => {
    mustSlide(deck, slideId);
    return slideOps.deleteSlide(deck, slideId);
  });
}

/** duplicate-slide: deep-copy a slide (fresh element/beat/track ids). */
export async function duplicateSlide(root: string, deckId: string, slideId: string): Promise<{ slideId: string }> {
  return mutateDeck(root, deckId, "duplicate_slide", (deck) => {
    mustSlide(deck, slideId);
    const id = slideOps.duplicateSlide(deck, slideId);
    if (!id) throw new Error(`could not duplicate slide ${slideId}`);
    return { slideId: id };
  });
}

/** reorder-slides: set the slide order to exactly `order` (must be a permutation). */
export async function reorderSlides(root: string, deckId: string, order: string[]): Promise<void> {
  await mutateDeck(root, deckId, "reorder_slides", (deck) => {
    slideOps.reorderSlides(deck, order);
  });
}

/** set-slide: patch a slide's name/layout/background/transition/notes/camera. */
export async function setSlide(root: string, deckId: string, slideId: string, patch: slideOps.SetSlidePatch): Promise<void> {
  await mutateDeck(root, deckId, "set_slide", (deck) => {
    mustSlide(deck, slideId);
    slideOps.setSlide(deck, slideId, patch);
  });
}

/** set-theme: switch the deck theme (flux-dark|light|midnight|slate|sepia|contrast). */
export async function setDeckTheme(root: string, deckId: string, theme: string): Promise<void> {
  await mutateDeck(root, deckId, "set_theme", (deck) => {
    slideOps.setTheme(deck, theme);
  });
}

/** add-text: add a text box to a slide. Returns the new element id. */
export async function addTextToSlide(
  root: string,
  deckId: string,
  slideId: string,
  opts: slideOps.TextBoxOpts,
): Promise<{ elementId: string }> {
  return mutateDeck(root, deckId, "add_text", (deck) => {
    mustSlide(deck, slideId);
    const id = slideOps.addTextBox(deck, slideId, opts);
    if (!id) throw new Error(`could not add text to ${slideId}`);
    return { elementId: id };
  });
}

/** add-math: add a KaTeX math element to a slide. Returns the new element id. */
export async function addMathToSlide(
  root: string,
  deckId: string,
  slideId: string,
  opts: slideOps.MathOpts,
): Promise<{ elementId: string }> {
  return mutateDeck(root, deckId, "add_math", (deck) => {
    mustSlide(deck, slideId);
    const id = slideOps.addMath(deck, slideId, opts);
    if (!id) throw new Error(`could not add math to ${slideId}`);
    return { elementId: id };
  });
}

/** add-embed-figure: place a project figure (by id) onto a slide — its panels
 *  stay addressable, so an agent can animate them. No asset bytes to ingest: the
 *  figure lives in fig/, resolved at render/export. Returns the new element id. */
export async function addEmbedFigureToSlide(
  root: string,
  deckId: string,
  slideId: string,
  opts: slideOps.EmbedFigureOpts,
): Promise<{ elementId: string }> {
  return mutateDeck(root, deckId, "add_embed_figure", (deck) => {
    mustSlide(deck, slideId);
    const id = slideOps.addEmbedFigure(deck, slideId, opts);
    if (!id) throw new Error(`could not embed figure on ${slideId}`);
    return { elementId: id };
  });
}

/** add-beat: append a build beat (a step of the slide's on-click timeline). */
export async function addBeat(
  root: string,
  deckId: string,
  slideId: string,
  opts: slideOps.AddBeatOpts = {},
): Promise<{ beatId: string }> {
  return mutateDeck(root, deckId, "add_beat", (deck) => {
    mustSlide(deck, slideId);
    const beat = slideOps.addBeat(deck, slideId, opts);
    if (!beat) throw new Error(`could not add beat to ${slideId}`);
    return { beatId: beat.id };
  });
}

/** set-animation: add (or replace) an animation track on a beat — the general
 *  mechanism behind every preset (fade/drawOn/stagger/move/morph/camera/…). */
export async function setAnimation(
  root: string,
  deckId: string,
  slideId: string,
  beatId: string,
  track: Track,
): Promise<void> {
  await mutateDeck(root, deckId, "set_animation", (deck) => {
    mustSlide(deck, slideId);
    const ok = slideOps.setAnimation(deck, slideId, beatId, track);
    if (!ok) throw new Error(`beat not found: ${beatId} on ${slideId}`);
  });
}

// --------------------------------------------------------------------------
// export — the portable .html (§7/§8.2), fully headless (no browser)
// --------------------------------------------------------------------------
function assetMime(kind: string): string {
  const m: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  };
  return m[kind] ?? "application/octet-stream";
}

/** Gather everything a deck needs to render offline: deck-local media → data
 *  URIs, semantic plots (incl. morph targets) → inline SVG + manifest, project
 *  figures → standalone SVG (the headless figure render). Best-effort: a missing
 *  asset is simply absent (the element shows its placeholder) — but every gap
 *  that would make the export DIVERGE from the editor is reported in `warnings`
 *  so the caller can surface it instead of shipping a silently-broken file. */
export async function gatherDeckPayload(
  root: string,
  deckId: string,
): Promise<{ payload: ExportPayload; warnings: string[] }> {
  const deck = await loadDeck(root, deckId);
  const assets: Record<string, string> = {};
  const plots: Record<string, { svg: string; manifest: FluxPlotManifest }> = {};
  const figures: Record<string, string> = {};
  const warnings: string[] = [];

  for (const a of deck.assets ?? []) {
    if (!a.path) continue;
    try {
      const buf = await fs.readFile(safeJoin(root, j("slides", deck.id, a.path)));
      assets[a.id] = `data:${assetMime(a.kind)};base64,${buf.toString("base64")}`;
    } catch { warnings.push(`media asset "${a.id}" missing (${a.path}) — its element will show a placeholder`); }
  }

  const manifest = await loadManifest(root).catch(() => null);
  const plotIndex = ((manifest as unknown as { plots?: { id: string; path?: string; svgPath?: string; manifestPath?: string }[] })?.plots) ?? [];
  const collectPlot = async (assetId: string, svgPath?: string, manifestPath?: string) => {
    if (plots[assetId]) return;
    const entry = plotIndex.find((p) => p.id === assetId);
    // Insertable plot ids ARE their path under plots/ minus ".svg", so the
    // convention fallback makes bare-assetId references (morph targets) work.
    const sp = svgPath ?? entry?.svgPath ?? entry?.path ?? j("plots", `${assetId}.svg`);
    // Sibling convention: NN.svg ↔ NN.fluxplot.json — the SAME fallback the app's
    // loadDeckAssets uses. Without it the export sees an empty manifest, group
    // parts (ticks/points/gridlines) never expand, and animations silently no-op
    // in the exported file while previewing fine in the editor.
    const mp = manifestPath ?? entry?.manifestPath ?? sp.replace(/\.svg$/i, ".fluxplot.json");
    try {
      const svg = await fs.readFile(safeJoin(root, sp), "utf8");
      let m: FluxPlotManifest | undefined;
      try { m = JSON.parse(await fs.readFile(safeJoin(root, mp), "utf8")) as FluxPlotManifest; } catch { /* optional sidecar */ }
      plots[assetId] = { svg, manifest: m ?? ({ axes: [], series: [] } as unknown as FluxPlotManifest) };
    } catch { warnings.push(`plot "${assetId}" not found (${sp}) — it will be missing from the export`); }
  };

  for (const s of deck.slides) {
    for (const el of s.elements) {
      if (el.type === "plot") await collectPlot(el.assetId, el.source?.svgPath, el.source?.manifestPath);
      else if (el.type === "embedFigure") {
        try { figures[el.figureId] = await renderFigureSvg(root, el.figureId); } catch {
          warnings.push(`figure "${el.figureId}" could not be rendered — its element will show a placeholder`);
        }
      }
    }
    for (const b of s.beats) for (const t of b.tracks) {
      if (t.preset === "morph" && t.to?.assetId) await collectPlot(t.to.assetId);
    }
  }

  // Parity audit: a part-targeting track whose plot has no parts tree cannot
  // resolve group parts in the export (resolveTargets falls back to the literal
  // id). The editor may still have looked animated via a cached manifest.
  const partWarned = new Set<string>();
  for (const s of deck.slides) {
    for (const b of s.beats) for (const t of b.tracks) {
      if (!t.part) continue;
      const el = s.elements.find((e) => e.id === t.target);
      if (!el || el.type !== "plot" || partWarned.has(el.assetId)) continue;
      const g = plots[el.assetId];
      if (g && !(g.manifest as unknown as { parts?: unknown }).parts) {
        partWarned.add(el.assetId);
        warnings.push(`plot "${el.assetId}" has part-level animations but no parts tree in its manifest — those animations will not play in the export`);
      }
    }
  }
  return { payload: { deck, plots, figures, assets }, warnings };
}

/** export-deck: gather + emit the self-contained .html (defaults to
 *  exports/<deckId>.html). Journals the export. */
export async function exportDeck(
  root: string,
  deckId: string,
  opts: { out?: string } = {},
): Promise<{ path: string; bytes: number; warnings: string[] }> {
  const { payload, warnings: gatherWarnings } = await gatherDeckPayload(root, deckId);
  const { html, bytes, warnings } = await exportDeckHtml(payload);
  const out = opts.out ?? safeJoin(root, j("exports", `${deckId}.html`));
  await writeText(out, html);
  await journal(root, { action: "export_deck", deck: deckId, bytes });
  return { path: out, bytes, warnings: [...gatherWarnings, ...warnings] };
}

export interface ValidateDeckResult {
  ok: boolean;
  checked: number;
  errors: string[];
}

/** validate-deck: check one deck (or every deck) against the bundled deck schema. */
export async function validateDeck(root: string, deckId?: string): Promise<ValidateDeckResult> {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const v = ajv.compile(SCHEMAS.deck);
  const errors: string[] = [];
  let checked = 0;
  const checkOne = async (id: string) => {
    const rel = deckRel(id);
    const p = safeJoin(root, rel);
    if (!(await exists(p))) {
      errors.push(`${rel}: missing`);
      return;
    }
    checked++;
    let data: unknown;
    try {
      data = JSON.parse(await fs.readFile(p, "utf8"));
    } catch (e) {
      errors.push(`${rel}: not valid JSON (${(e as Error).message})`);
      return;
    }
    if (!v(data)) for (const e of v.errors ?? []) errors.push(`${rel}: ${e.instancePath || "(root)"} ${e.message ?? "invalid"}`);
  };
  if (deckId) {
    await checkOne(deckId);
  } else {
    for (const d of await listDecks(root)) await checkOne(d.id);
  }
  return { ok: errors.length === 0, checked, errors };
}
