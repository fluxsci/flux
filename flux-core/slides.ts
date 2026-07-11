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
import { safeJoin, journal, loadManifest, getClient, renderFigureSvg, figureMembersOf, ensureDom } from "./index";
import { atomicWrite } from "./fsx";
import { withLock } from "./locks";
import { SCHEMAS } from "./schemas";
import { preparePlot, buildPartIndex } from "../src/lib/plot/parse";
import * as slideOps from "../src/lib/slide/ops";
import { animateElement, animatePart, listMorphCandidates } from "../src/lib/slide/autobuild";
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

/** loadDeck: read slides/<deckId>/deck.json (migrated to the current element
 *  model — legacy `type:"svg"` elements become semantic plots, same seam the
 *  GUI's loadDeckModel runs; any mutateDeck round-trip persists it). */
export async function loadDeck(root: string, deckId: string): Promise<Deck> {
  const p = await resolveDeckPath(root, deckId);
  if (!(await exists(p))) throw new Error(`deck not found: ${deckId} (${path.relative(root, p)})`);
  // WS-4.4: the one chokepoint (migration + track-id backfill), shared with
  // the GUI seams — flux-core used to skip ensureTrackIds.
  return slideOps.normalizeDeck(await readJSON<Deck>(p));
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

/** set-beat: patch a beat's label / advance mode (click|with-prev|auto) / autoDelayMs. */
export async function setBeat(
  root: string,
  deckId: string,
  slideId: string,
  beatId: string,
  patch: { label?: string; advance?: "click" | "with-prev" | "auto"; autoDelayMs?: number },
): Promise<void> {
  await mutateDeck(root, deckId, "set_beat", (deck) => {
    mustSlide(deck, slideId);
    slideOps.setBeat(deck, slideId, beatId, patch);
  });
}

/** reorder-beats: set a slide's beat order (beat 0, the resting state, is pinned). */
export async function reorderBeats(root: string, deckId: string, slideId: string, order: string[]): Promise<void> {
  await mutateDeck(root, deckId, "reorder_beats", (deck) => {
    mustSlide(deck, slideId);
    slideOps.reorderBeats(deck, slideId, order);
  });
}

/** move-track: move a track (by id) into another beat on the same slide. */
export async function moveTrack(
  root: string,
  deckId: string,
  slideId: string,
  trackId: string,
  toBeatId: string,
  at?: number,
): Promise<void> {
  await mutateDeck(root, deckId, "move_track", (deck) => {
    mustSlide(deck, slideId);
    const ok = slideOps.moveTrackToBeat(deck, slideId, trackId, toBeatId, at);
    if (!ok) throw new Error(`track ${trackId} or beat ${toBeatId} not found on ${slideId}`);
  });
}

/** duplicate-track: deep-copy a track in place. Returns the new track id. */
export async function duplicateTrack(
  root: string,
  deckId: string,
  slideId: string,
  trackId: string,
): Promise<{ trackId: string }> {
  return mutateDeck(root, deckId, "duplicate_track", (deck) => {
    mustSlide(deck, slideId);
    const id = slideOps.duplicateTrack(deck, slideId, trackId);
    if (!id) throw new Error(`track not found: ${trackId} on ${slideId}`);
    return { trackId: id };
  });
}

/** reorder-tracks: set one beat's track (lane) order. */
export async function reorderTracks(
  root: string,
  deckId: string,
  slideId: string,
  beatId: string,
  order: string[],
): Promise<void> {
  await mutateDeck(root, deckId, "reorder_tracks", (deck) => {
    mustSlide(deck, slideId);
    slideOps.reorderTracks(deck, slideId, beatId, order);
  });
}

/** set-track-enabled: disable/enable a track (disabled = kept but not played). */
export async function setTrackEnabled(
  root: string,
  deckId: string,
  slideId: string,
  trackId: string,
  enabled: boolean,
): Promise<void> {
  await mutateDeck(root, deckId, "set_track_enabled", (deck) => {
    mustSlide(deck, slideId);
    const ok = slideOps.setTrackEnabled(deck, slideId, trackId, enabled);
    if (!ok) throw new Error(`track not found: ${trackId} on ${slideId}`);
  });
}

/** set-part-visibility: a plot part's resting tri-state — show | animate | mask.
 *  Mask/show DISABLE the part's tracks (they survive for a later re-animate). */
export async function setPartVisibility(
  root: string,
  deckId: string,
  elementId: string,
  part: string,
  mode: "show" | "animate" | "mask",
): Promise<void> {
  await mutateDeck(root, deckId, "set_part_visibility", (deck) => {
    slideOps.setPartVisibility(deck, elementId, part, mode);
  });
}

/** set-part-style: merge a style patch (stroke/fill/strokeWidth/opacity/fontSize/
 *  fontFamily/fontWeight/hidden…) into one plot part's override — the slide X-ray
 *  cockpit's write path. Null values delete keys. */
export async function setPartStyle(
  root: string,
  deckId: string,
  elementId: string,
  part: string,
  patch: Record<string, string | number | boolean | null>,
): Promise<void> {
  await mutateDeck(root, deckId, "set_part_style", (deck) => {
    slideOps.setPartStyle(deck, elementId, part, patch);
  });
}

/** animate-part: ensure ONE plot part animates in — re-enables existing tracks
 *  (preserving authored timing) or adds the plot's suggested default reveal.
 *  Needs the plot's manifest to suggest well; resolved from the element's svg
 *  sidecar like the export gatherer. Returns the beat index used. */
export async function animatePartVerb(
  root: string,
  deckId: string,
  slideId: string,
  elementId: string,
  part: string,
  beatIndex?: number,
): Promise<{ beatIndex: number }> {
  return mutateDeck(root, deckId, "animate_part", async (deck) => {
    mustSlide(deck, slideId);
    const found = slideOps.findElement(deck, elementId);
    if (!found || found.el.type !== "plot") throw new Error(`plot element not found: ${elementId}`);
    const el = found.el as { assetId: string; source?: { svgPath?: string; manifestPath?: string } };
    let manifest: FluxPlotManifest | undefined;
    const sp = el.source?.svgPath ?? j("plots", `${el.assetId}.svg`);
    const mp = el.source?.manifestPath ?? sp.replace(/\.svg$/i, ".fluxplot.json");
    try { manifest = JSON.parse(await fs.readFile(safeJoin(root, mp), "utf8")) as FluxPlotManifest; } catch { /* suggest without hints */ }
    const bi = animatePart(deck, slideId, elementId, part, manifest, beatIndex);
    if (bi < 0) throw new Error(`slide not found: ${slideId}`);
    return { beatIndex: bi };
  });
}

/** animate-element: give a whole element (text box / shape / image / math /
 *  line…) an enter or exit animation with per-kind defaults — the non-plot
 *  analog of animate-part. `part` narrows to a named node inside the element:
 *  on an embedFigure, "group:<groupId>" targets one of the figure's named
 *  groups (ids via the figure-side list_groups / groups digest) with the P9
 *  defaults (enter fade / exit fadeOut). Returns the beat index + track id. */
export async function animateElementVerb(
  root: string,
  deckId: string,
  slideId: string,
  elementId: string,
  opts: { beatIndex?: number; exit?: boolean; preset?: Track["preset"]; wholeBox?: boolean; part?: string } = {},
): Promise<{ beatIndex: number; trackId: string }> {
  return mutateDeck(root, deckId, "animate_element", (deck) => {
    mustSlide(deck, slideId);
    const r = animateElement(deck, slideId, elementId, opts);
    if (!r) throw new Error(`element not found: ${elementId} on ${slideId}`);
    return r;
  });
}

/** set-morph: author a data-space morph from a plot element to any project plot.
 *  Refuses structurally-incompatible pairs (same gate the GUI + player use). */
export async function setMorph(
  root: string,
  deckId: string,
  slideId: string,
  beatId: string,
  elementId: string,
  toAssetId: string,
  opts: { duration?: number; force?: boolean } = {},
): Promise<void> {
  await mutateDeck(root, deckId, "set_morph", async (deck) => {
    mustSlide(deck, slideId);
    const found = slideOps.findElement(deck, elementId);
    if (!found || found.el.type !== "plot") throw new Error(`plot element not found: ${elementId}`);
    if (!opts.force) {
      const el = found.el as { assetId: string; source?: { svgPath?: string; manifestPath?: string } };
      const readManifest = async (assetId: string, svgPath?: string, manifestPath?: string) => {
        const sp = svgPath ?? j("plots", `${assetId}.svg`);
        const mp = manifestPath ?? sp.replace(/\.svg$/i, ".fluxplot.json");
        try { return JSON.parse(await fs.readFile(safeJoin(root, mp), "utf8")) as FluxPlotManifest; } catch { return undefined; }
      };
      const A = await readManifest(el.assetId, el.source?.svgPath, el.source?.manifestPath);
      const B = await readManifest(toAssetId);
      const [cand] = listMorphCandidates(A, [{ assetId: toAssetId, manifest: B }]);
      if (!cand?.compatible) throw new Error(`morph ${el.assetId} → ${toAssetId}: structurally incompatible (no shared tweenable series). Pass force to author anyway.`);
    }
    // WS-4.4: persist explicit target paths when the project manifest knows
    // them, so later loads/exports never guess `plots/<id>.svg`.
    const man = (await loadManifest(root).catch(() => null)) as unknown as {
      plots?: { id: string; path?: string; svgPath?: string; manifestPath?: string }[];
    } | null;
    const entry = man?.plots?.find((p) => p.id === toAssetId);
    const svgPath = entry?.svgPath ?? entry?.path;
    const ok = slideOps.setMorphTrack(deck, slideId, beatId, elementId, toAssetId, {
      duration: opts.duration,
      ...(svgPath ? { svgPath } : {}),
      ...(entry?.manifestPath ? { manifestPath: entry.manifestPath } : {}),
    });
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
  const figureMembers: Record<string, Record<string, { type: string; name?: string; assetId?: string }>> = {};
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
      // The SAME preparePlot seam the app's cachePlot (and the export runtime's
      // boot) runs: a sidecar-less vanilla svg gets a DERIVED manifest, a real
      // one gets orphan augmentation — so the payload manifest matches what the
      // runtime will compute, and the parity audit below sees the truth. The
      // export snapshot MAY carry a derived manifest (the never-persist rule is
      // about project sidecars, not this self-contained payload; the runtime
      // re-derives identically from the same bytes anyway).
      await ensureDom();
      m = preparePlot(svg, m).manifest ?? m;
      plots[assetId] = { svg, manifest: m ?? ({ axes: [], series: [] } as unknown as FluxPlotManifest) };
    } catch { warnings.push(`plot "${assetId}" not found (${sp}) — it will be missing from the export`); }
  };

  for (const s of deck.slides) {
    for (const el of s.elements) {
      if (el.type === "plot") await collectPlot(el.assetId, el.source?.svgPath, el.source?.manifestPath);
      else if (el.type === "embedFigure") {
        // Group-scoped embeds are keyed "fid::gid" — the SAME convention the
        // live loadDeckAssets cache and the export runtime resolver use.
        const key = el.groupId ? `${el.figureId}::${el.groupId}` : el.figureId;
        if (!figures[key]) {
          try { figures[key] = await renderFigureSvg(root, el.figureId, el.groupId ? { groupId: el.groupId } : undefined); } catch {
            warnings.push(`figure "${el.figureId}" could not be rendered — its element will show a placeholder`);
          }
        }
        // Member metadata + member plot manifests: "el:<mid>" / "el:<mid>/<partId>"
        // tracks need them offline. Member plots live under fig/assets/ (their
        // svg is already inside the figure markup — the manifest is what the
        // player's part fan-out reads, keyed by assetId in payload.plots).
        if (!figureMembers[el.figureId]) {
          try {
            const members = await figureMembersOf(root, el.figureId);
            figureMembers[el.figureId] = members;
            for (const m of Object.values(members)) {
              if (!m.assetId || plots[m.assetId]) continue;
              try {
                const svg = await fs.readFile(safeJoin(root, j("fig", "assets", `${m.assetId}.svg`)), "utf8");
                let man: FluxPlotManifest | undefined;
                try { man = JSON.parse(await fs.readFile(safeJoin(root, j("fig", "assets", `${m.assetId}.fluxplot.json`)), "utf8")) as FluxPlotManifest; } catch { /* optional sidecar */ }
                await ensureDom();
                man = preparePlot(svg, man).manifest ?? man;
                plots[m.assetId] = { svg, manifest: man ?? ({ axes: [], series: [] } as unknown as FluxPlotManifest) };
              } catch { /* member plot manifest is best-effort */ }
            }
          } catch { /* member metadata is best-effort */ }
        }
      }
    }
    for (const b of s.beats) for (const t of b.tracks) {
      if (t.preset === "morph" && t.to?.assetId)
        await collectPlot(t.to.assetId, t.to.svgPath as string | undefined, t.to.manifestPath as string | undefined);
    }
  }

  // Parity audit: a part-targeting track whose part id the gathered manifest
  // does not cover cannot resolve to real nodes in the export (resolveTargets
  // falls back to the literal id). Every gathered plot HAS a manifest now
  // (derived when the sidecar is gone), so the honest check is id coverage:
  // e.g. a fluxplot deck whose .fluxplot.json vanished derives a manifest
  // WITHOUT the manifest-only group ids (axis.x.ticks, …) its tracks target —
  // the editor may still have looked animated via a cached manifest.
  const partIdx = new Map<string, Record<string, unknown>>();
  const coveredPart = (assetId: string, part: string): boolean => {
    if (!partIdx.has(assetId)) partIdx.set(assetId, buildPartIndex(plots[assetId]?.manifest));
    return part in partIdx.get(assetId)!;
  };
  const partWarned = new Set<string>();
  for (const s of deck.slides) {
    for (const b of s.beats) for (const t of b.tracks) {
      if (!t.part) continue;
      const el = s.elements.find((e) => e.id === t.target);
      if (!el || el.type !== "plot" || partWarned.has(el.assetId)) continue;
      const g = plots[el.assetId];
      if (g && !coveredPart(el.assetId, t.part)) {
        partWarned.add(el.assetId);
        warnings.push(`plot "${el.assetId}" has part-level animations (e.g. "${t.part}") its manifest does not cover — no parts tree for them, so those animations will not play in the export (is the .fluxplot.json sidecar missing?)`);
      }
    }
  }
  return { payload: { deck, plots, figures, assets, ...(Object.keys(figureMembers).length ? { figureMembers } : {}) }, warnings };
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
