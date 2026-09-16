// Figure data for the manuscript: resolves @fig refs, numbers them, and renders
// figures to self-contained SVG (reusing figureToSvg) for hover cards + embeds.
// Reads fig/ from disk via readFigSource — never touches the figure-editor store
// (Flux_Paper_Plan.md B-data layer).

import { get, writable } from "svelte/store";
import { createFigureReferenceResolver } from "../../../../lib/figureReferences";
import type { Asset, Element, Figure, FigureFamilyDef, Project } from "../../../../lib/types";
import { figureToSvg } from "../../../../lib/export";
import { svgFontCss } from "../../../../lib/svgFonts";
import { buildPlotMarkup } from "../../../../lib/plot/inlineMarkup";
import type { FluxPlotManifest } from "../../../../lib/plot/types";
import { dataUrlToBytes } from "../../../../lib/assets";
import { assetDisplaySize } from "../../../../lib/ops";
import { effectiveHidden } from "../../../../lib/groups";
import { readFigSource } from "../../../../lib/project/figbridge";
import { fileBridge } from "../../../../lib/project/types";
import { EMBED_RE } from "../science/figureAttrs";
import { styledFamilyDef, type ResolvedJournalStyle } from "../../../../lib/style/journalStyle";
import {
  familyById,
  familyRank,
  formatCaptionLabel,
  formatFamilyRef,
} from "../../../../lib/figfamily";

export { panelSpec, figRefText } from "./figText";

export interface FigureRef {
  id: string;
  label: string; // e.g. "fig-growth" (includes the fig- prefix, Quarto-style)
  name: string; // derived display name ("Supplementary Figure 4")
  nickname?: string; // human title (primary label in pickers)
  family: string; // family id; "tbl"/"eq" on the fabricated table/eq refs
  number: number; // position within family (figfamily.ts — contiguous 1..N)
  display: string; // whole-figure in-text text: "Fig. S4" / "Mov. 3" / "Table 2"
  captionLabel: string; // caption lead: "Figure S4 | " ("" for tbl/eq)
  order: number; // global index order (jump/sort secondary key)
  canvas: string;
  caption: string;
  panels: string[]; // ordered panel letters ["a","b",…]; [] if unknown (F7)
}

export const figureRefs = writable<FigureRef[]>([]);

/** Canvas list (id + display name, canonical order) for the canvas-scope
 *  dropdown in BOTH figure pickers — insert (FigurePicker, issue #10) and
 *  cross-reference (FigRefPicker). Refreshed with every loadFigures. */
export const figureCanvases = writable<{ id: string; name: string }[]>([]);

// PAP-22: index refs by label so the cite/cross-ref chip widgets resolve in O(1) instead of a
// linear `find` per chip per rebuild (chips rebuild on every keystroke/scroll over the visible
// range). Kept in sync by subscribing to the store, so every set — load, seed — refreshes it.
let resolveFigureToken = createFigureReferenceResolver<FigureRef>([]);
figureRefs.subscribe((refs) => {
  resolveFigureToken = createFigureReferenceResolver(refs);
});

let figuresById: Record<string, Figure> = {};
let assetData: Record<string, string> = {};
let assetManifests: Record<string, FluxPlotManifest> = {};
let assetMeta: Asset[] = []; // dims + dpi for crop rendering (assetDisplaySize)
// Custom family definitions from the project (built-ins live in figfamily.ts).
let familyDefs: FigureFamilyDef[] = [];
// Renders cache per figure per fig-revision (loadFigures clears). Failures
// cache as undefined so one broken figure costs one warning, not one per
// keystroke of picker/embed rebuilds.
const renderCache = new Map<string, string | undefined>();
// Blob URLs of the display renders, for <img> consumers (embeds, hover cards,
// pickers, the margin view). An <img> is the cheap way to SHOW a figure: zero
// DOM nodes in the editor, no live stylesheet per plot, one raster cached by
// Chromium per size — where an inlined 5k-node SVG re-parsed, re-invalidated
// rule sets and restyled on every CodeMirror viewport re-entry (2026-09-16:
// 60–130 ms long tasks while scrolling a 34-line manuscript). Same revision
// lifetime as renderCache; revoked together.
const imageUrlCache = new Map<string, string | undefined>();
// The PREVIOUS revision's URLs, kept alive until a fresh render replaces each
// one: an embed shows the last picture instantly after a figure edit and swaps
// when the new render lands (revoking here would blank every embed for the
// duration of the re-render).
const staleImageUrls = new Map<string, string | undefined>();
// Bumped on every figure reload; widgets compare it instead of render strings.
let figuresRev = 0;
const imageRevision = writable(0);
let loadedRoot: string | null = null;
let loadGeneration = 0;
export function getFiguresRev(): number {
  return figuresRev;
}
function revokeImageUrls(reset = false): void {
  figuresRev++;
  for (const [id, url] of staleImageUrls) if (reset || !figuresById[id]) {
    if (url) URL.revokeObjectURL(url);
    staleImageUrls.delete(id);
  }
  for (const [id, url] of imageUrlCache) {
    const prev = staleImageUrls.get(id);
    if (prev && prev !== url) URL.revokeObjectURL(prev);
    if (reset || !figuresById[id]) { if (url) URL.revokeObjectURL(url); }
    else staleImageUrls.set(id, url);
  }
  imageUrlCache.clear();
  imageRevision.set(figuresRev); // Every mounted image follows source revisions, even with the same id.
}
/** Figure box in canvas px from the MODEL (no render needed) — what an embed
 *  reserves before its picture is ready. */
export function figureDims(id: string): { w: number; h: number } | undefined {
  const fig = figuresById[id];
  return fig ? { w: fig.width, h: fig.height } : undefined;
}

export async function loadFigures(root: string | null): Promise<void> {
  if (!root) return; // demo / no project — leave whatever was seeded
  const generation = ++loadGeneration;
  const src = await readFigSource(root);
  if (generation !== loadGeneration) return;
  figuresById = src.figures;
  assetData = src.assetData;
  assetManifests = src.assetManifests;
  assetMeta = src.assets;
  familyDefs = src.families;
  renderCache.clear();
  revokeImageUrls(loadedRoot !== root);
  loadedRoot = root;
  figureCanvases.set(src.canvases);
  // Flux-figure is the source of truth: identity is (family, number) —
  // structured fields healed by the loader, never parsed out of the name —
  // so renaming/renumbering there relabels every chip/embed/hover/export
  // live. Pickers/completions list main figures first, then supplementary,
  // extended-data, customs, each in number order.
  const refs = [...src.indexFigures]
    .sort(
      (a, b) =>
        familyRank(a.family, familyDefs) - familyRank(b.family, familyDefs) ||
        a.number - b.number,
    )
    .map((f) => {
      const def = familyById(f.family, familyDefs);
      return {
        id: f.id,
        label: f.label,
        name: f.name,
        ...(f.nickname ? { nickname: f.nickname } : {}),
        family: f.family,
        number: f.number,
        display: formatFamilyRef(def, f.number),
        captionLabel: formatCaptionLabel(def, f.number),
        order: f.order,
        canvas: f.canvas,
        caption: f.caption,
        panels: f.panels ?? [],
      };
    });
  figureRefs.set(refs);
}

/** Resolve a `@fig-…` label, including sub-panel refs (`fig-x-a` → "Fig. 1a").
 *  Returns the family-formatted in-text `display` text ("Fig. S4a–c", "Mov. 3",
 *  "Table 2") — figfamily templates own the wording, callers render it verbatim.
 *  WS-4.2: table/equation cross-refs resolve against the PER-EDITOR numbering
 *  instance passed in `nums` (chips/hover/caret thread it from the facet);
 *  callers that only ever see fig-… labels (render, materialize) omit it. */
export function resolveFigure(
  label: string,
  nums?: { tbl: Map<string, number>; eq: Map<string, number> },
): { ref: FigureRef; display: string; panel?: string } | null {
  const found = resolveFigureToken(label);
  if (found) {
    const panel = found.panelSpec?.replace(/-/g, "–");
    return {
      ref: found.ref,
      display: panel ? formatFamilyRef(familyById(found.ref.family, familyDefs), found.ref.number, panel) : found.ref.display,
      ...(panel ? { panel } : {}),
    };
  }
  // Table cross-refs are numbered inline (by the table renderer), not from the
  // figure project — resolve them against the numbering registry.
  if (label.startsWith("tbl-")) {
    const n = nums?.tbl.get(label);
    if (n != null) {
      const display = `Table ${n}`;
      return {
        ref: { id: "", label, name: "", family: "tbl", number: n, display, captionLabel: "", order: n, canvas: "", caption: "", panels: [] },
        display,
      };
    }
    return null;
  }
  // Equation cross-refs (2.1): labeled `$$ … $$ {#eq-id}` blocks number by
  // appearance (science/math.ts publishes the registry; the export scans the
  // same rule via science/refNumbers).
  if (label.startsWith("eq-")) {
    const n = nums?.eq.get(label);
    if (n != null) {
      const display = `Eq. ${n}`;
      return {
        ref: { id: "", label, name: "", family: "eq", number: n, display, captionLabel: "", order: n, canvas: "", caption: "", panels: [] },
        display,
      };
    }
    return null;
  }

  return null;
}

/** label → resolved family identity for the export transform (exportQmd.ts):
 *  the same numbers the editor shows, never re-derived from embed order.
 *
 *  THE export-only projection. Passing a journal style here gives the exported
 *  file that venue's figure wording ("Supplementary Fig. 1"), while the
 *  editor's own `figureRefs` — built above from the UNSTYLED defs — keeps
 *  Flux's house form. The NUMBERS are identical either way, so writer and
 *  output can differ in wording without ever disagreeing about which figure is
 *  which (verify-writer-neutral pins this). */
export function exportCtxFigures(
  style?: ResolvedJournalStyle | null,
): Map<string, { family: FigureFamilyDef; number: number; panels: string[] }> {
  const out = new Map<string, { family: FigureFamilyDef; number: number; panels: string[] }>();
  for (const r of get(figureRefs)) {
    if (!out.has(r.label)) {
      out.set(r.label, {
        family: styledFamilyDef(style, familyById(r.family, familyDefs)),
        number: r.number,
        panels: r.panels,
      });
    }
  }
  return out;
}

// DOM-mounted copies of a figure carry a paper NAMESPACE on every plot-internal
// id. The figure editor's live canvas prefixes plot ids with the ELEMENT id
// (plot/mount.ts); without the namespace, a paper embed of the same plot held
// alive in a hidden mode (ModeContent keep-alive, visibility:hidden) duplicates
// those ids — and Chromium resolves `url(#clipPath)` to the FIRST id in the
// document while composing clip geometry from RENDERED children only, so a
// hidden twin's clipPath is EMPTY and every data mark clipped by it vanishes
// from the VISIBLE editor (2026-08-13: the "blank plots, axes only" report;
// pixel repro in verify-clip-collision). "pap" can never equal an element id.
const PAPER_SVG_NS = "pap";

// Inline a placed plot with its per-part overrides baked (the shared
// inlineMarkup pipeline — same output as flux-core's renderFigureSvg and the
// figure editor's own canvas). Anything that stops the inline — png-backed
// asset, missing bytes, parse failure — falls back to figureToSvg's raw
// <image> draw for THAT plot only, never the whole figure.
function plotMarkupFor(el: Element, ns?: string): string | undefined {
  if (el.type !== "plot") return undefined;
  const url = assetData[el.assetId];
  if (!url || !url.startsWith("data:image/svg+xml")) return undefined;
  try {
    const text = new TextDecoder().decode(dataUrlToBytes(url));
    const frame = ns ? { ...el, id: `${ns}__${el.id}` } : el;
    return buildPlotMarkup(text, frame, el.overrides, assetManifests[el.assetId]) ?? undefined;
  } catch (e) {
    console.warn(`paper: plot inline failed for asset "${el.assetId}" — drawing the raster fallback`, e);
    return undefined;
  }
}

function renderFigureInternal(id: string, ns?: string, preparedPlots?: Map<Element, string | undefined>): string | undefined {
  const fig = figuresById[id];
  if (!fig) return undefined;
  try {
    return figureToSvg(
      fig,
      (aid) => assetData[aid],
      (el) => preparedPlots ? preparedPlots.get(el) : plotMarkupFor(el, ns),
      // Crop rendering for <image>-backed elements: intrinsic content size in
      // assetDisplaySize units — the crop window's own coordinate space.
      (aid) => assetDisplaySize({ assets: assetMeta } as Project, aid) ?? undefined,
    );
  } catch (e) {
    // One broken figure must never take down a whole surface: the FigurePicker
    // mounts EVERY figure's render, so an uncaught throw here was a silently
    // dead picker (2026-08-12 report). Degrade to "no preview" and say why.
    console.warn(`paper: figure render failed for "${id}" — no preview`, e);
    journalRenderError(id, e);
    return undefined;
  }
}

/** The DISPLAY render (embeds, hover cards, pickers, margin view, in-app
 *  preview/PDF): cached per figure per fig-revision, plot ids namespaced. */
export function renderFigureSvg(id: string): string | undefined {
  if (renderCache.has(id)) return renderCache.get(id);
  const svg = renderFigureInternal(id, PAPER_SVG_NS);
  renderCache.set(id, svg);
  return svg;
}

/** Preparing every plot in one idle callback still blocks input: the real
 *  21-panel project spent 131 ms in that task. Reuse the same plot builder and
 *  final figure serializer, but yield between plots once a slice reaches 6 ms.
 *  The synchronous export API retains its exact output and cache semantics. */
async function renderFigureSvgInSlices(id: string, rev: number): Promise<string | undefined> {
  if (renderCache.has(id)) return renderCache.get(id);
  const fig = figuresById[id];
  if (!fig) return undefined;
  const plots = new Map<Element, string | undefined>();
  let start = performance.now();
  for (const el of fig.elements) {
    if (el.type !== "plot" || effectiveHidden(fig, el)) continue;
    plots.set(el, plotMarkupFor(el, PAPER_SVG_NS));
    if (performance.now() - start >= 6) {
      await new Promise<void>(resolve => {
        if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 250 });
        else setTimeout(resolve, 0);
      });
      if (rev !== figuresRev) return undefined;
      start = performance.now();
    }
  }
  if (rev !== figuresRev) return undefined;
  const svg = renderFigureInternal(id, PAPER_SVG_NS, plots);
  renderCache.set(id, svg);
  return svg;
}

/** The display render as an <img> source (blob URL; cached per figure per
 *  fig-revision alongside renderFigureSvg). Consumers that only SHOW a figure
 *  use this — never inline the svg string into the editor document. */
export async function renderFigureImageUrl(id: string): Promise<string | undefined> {
  if (imageUrlCache.has(id)) return imageUrlCache.get(id);
  const rev = figuresRev;
  let svg = await renderFigureSvgInSlices(id, rev);
  if (svg) {
    // An SVG image has no access to fonts loaded by its containing document.
    const fonts = await svgFontCss(svg);
    if (fonts) svg = svg.replace(">", `><style>${fonts}</style>`);
  }
  if (rev !== figuresRev) return undefined;
  let url: string | undefined;
  if (svg) {
    url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      const probe = new Image();
      probe.src = url;
      await probe.decode(); // Keep the last good picture until the new one can actually paint.
    } catch {
      URL.revokeObjectURL(url);
      url = undefined;
    }
  }
  if (rev !== figuresRev) { if (url) URL.revokeObjectURL(url); return undefined; }
  imageUrlCache.set(id, url);
  const stale = staleImageUrls.get(id);
  if (stale && stale !== url) URL.revokeObjectURL(stale);
  staleImageUrls.delete(id);
  return url;
}

/** The picture an <img> can show RIGHT NOW without rendering: the current
 *  revision's URL if it exists, else the previous revision's. */
export function cachedFigureImageUrl(id: string): string | undefined {
  return imageUrlCache.has(id) ? imageUrlCache.get(id) : staleImageUrls.get(id);
}

// ---- the idle render queue -------------------------------------------------
// A figure render can exceed 100 ms of main thread (parse every plot, bake overrides,
// serialize). After a figure edit the paper's chips refresh and every embed,
// picker and hover card would re-render synchronously inside the IPC reply —
// 170 ms for a two-figure manuscript (2026-09-16), while the user was still
// panning in Figure. Renders now queue: one figure at a time, preparing its
// plots in short idle slices; listeners
// swap their <img> when it lands. Nothing renders that nobody is looking at.
const renderWaiters = new Map<string, Set<(url: string | undefined) => void>>();
// Each waiter may name the element it feeds; a figure whose every waiter sits in
// a hidden pane (ModeContent keep-alive: `.mc.hidden`, visibility:hidden) is not
// rendered until that pane is shown again — an edit made in Figure must not
// re-render the hidden Paper's embeds behind the user's next pan. ModeContent
// dispatches `flux:pane-shown` on reveal; the queue drains then.
const waiterEl = new WeakMap<(url: string | undefined) => void, globalThis.Element>(); // DOM Element — `Element` here is the figure model type
function waiterVisible(cb: (url: string | undefined) => void): boolean {
  const el = waiterEl.get(cb);
  if (!el) return true; // no element → a plain request, render it
  if (!el.isConnected) return false; // a detached <img> wants nothing
  return !el.closest(".mc.hidden");
}
if (typeof window !== "undefined") {
  window.addEventListener("flux:pane-shown", () => {
    if (renderWaiters.size) scheduleRenderDrain();
  });
}
let renderScheduled = false;
let renderRunning = false;
function scheduleRenderDrain(): void {
  if (renderScheduled || renderRunning) return;
  renderScheduled = true;
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(drainRenderQueue, { timeout: 250 });
  else setTimeout(drainRenderQueue, 16);
}
async function drainRenderQueue(): Promise<void> {
  renderScheduled = false;

  for (const [id, waiters] of renderWaiters) {
    // Drop waiters whose element is gone; skip figures nobody visible wants.
    for (const w of waiters) if (waiterEl.has(w) && !waiterEl.get(w)!.isConnected) waiters.delete(w);
    if (!waiters.size) {
      renderWaiters.delete(id);
      continue;
    }
    if (![...waiters].some(waiterVisible)) {
      continue;
    }
    renderWaiters.delete(id);
    const rev = figuresRev;
    renderRunning = true;
    try {
      const url = await renderFigureImageUrl(id); // ONE figure per slice
      if (rev === figuresRev) for (const w of waiters) w(url);
    } finally {
      renderRunning = false;
    }
    break;
  }
  if ([...renderWaiters.values()].some((set) => [...set].some(waiterVisible))) scheduleRenderDrain();
}
/** Resolve to the current revision's URL, rendering in an idle slice if needed.
 *  `el` (the <img> being fed) lets the queue defer while its pane is hidden. */
export function requestFigureImageUrl(id: string, cb: (url: string | undefined) => void, el?: globalThis.Element): () => void {
  if (imageUrlCache.has(id)) {
    cb(imageUrlCache.get(id));
    return () => {};
  }
  if (el) waiterEl.set(cb, el);
  let set = renderWaiters.get(id);
  if (!set) renderWaiters.set(id, (set = new Set()));
  set.add(cb);
  scheduleRenderDrain();
  return () => {
    set!.delete(cb);
    if (!set!.size && renderWaiters.get(id) === set) renderWaiters.delete(id);
  };
}

/** Bind an <img> to a figure: shows the cached or previous picture at once,
 *  reserves the model box (no layout shift), and swaps in the fresh render when
 *  the idle queue delivers it. Returns a cancel. */
export function bindFigureImage(img: HTMLImageElement, id: string): () => void {
  let cancel = () => {};
  let inView = typeof IntersectionObserver === "undefined";
  let live = true;
  // Do not carry another figure/project's image into an unrendered selection.
  img.removeAttribute("src");
  const show = (url: string | undefined) => {
    if (!live) return;
    if (url) {
      if (img.src !== url) img.src = url;
      img.alt = "";
      img.removeAttribute("title");
      img.dataset.figureState = "ready";
    } else {
      img.removeAttribute("src");
      img.alt = "Figure preview unavailable";
      img.title = "Figure preview unavailable";
      img.dataset.figureState = "missing";
    }
  };
  const refresh = () => {
    cancel();
    const dims = figureDims(id);
    if (dims) {
      img.width = Math.round(dims.w); img.height = Math.round(dims.h);
      // CSS width/height:auto ignores the intrinsic width attributes until an
      // image decodes. Reserve its model ratio/width now so idle preparation
      // cannot move the manuscript or the caret when the picture arrives.
      img.style.aspectRatio = `${dims.w} / ${dims.h}`;
      img.style.setProperty("--figure-width", `${dims.w}px`);
      img.style.setProperty("--figure-ratio", String(dims.w / dims.h));
    }
    const cached = cachedFigureImageUrl(id);
    if (cached) show(cached);
    else {
      img.removeAttribute("src");
      img.alt = dims ? "" : "Figure preview unavailable";
      img.dataset.figureState = dims ? "pending" : "missing";
    }
    if (dims && inView) cancel = requestFigureImageUrl(id, show, img);
  };
  const observer = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(entries => {
    const next = entries.some(e => e.isIntersecting);
    if (next !== inView) { inView = next; refresh(); }
  }, { rootMargin: "200px" }) : null;
  observer?.observe(img);
  const unsubscribe = imageRevision.subscribe(refresh);
  return () => { live = false; cancel(); unsubscribe(); observer?.disconnect(); };
}

/** Svelte action form of bindFigureImage: `<img use:figureImage={figId} />`. */
export function figureImage(node: HTMLImageElement, id: string): { update(id: string): void; destroy(): void } {
  let cancel = bindFigureImage(node, id);
  return {
    update(next: string) {
      cancel();
      cancel = bindFigureImage(node, next);
    },
    destroy() {
      cancel();
    },
  };
}

/** The DISK render (materializeRenders → fig/renders/<id>.svg for Quarto/DOCX):
 *  UN-namespaced and uncached, byte-identical to flux-core's renderFigureSvg
 *  for the same on-disk figure (verify-paper-render-overrides pins it). A file
 *  is standalone — no editor to collide with — and the parity invariant is
 *  worth more than caching a rare just-in-time export render. */
export function renderFigureSvgForDisk(id: string): string | undefined {
  return renderFigureInternal(id);
}

// The renderer journals through the host bridge (same seam as figbridge's
// save_fig) so a broken figure is diagnosable from .meta/journal.ndjson —
// before this, render failures left no trace anywhere.
function journalRenderError(id: string, e: unknown): void {
  const host = (globalThis as { fig?: { journalAppend?: (entry: unknown) => void } }).fig;
  host?.journalAppend?.({
    action: "render_error",
    target: id,
    detail: e instanceof Error ? e.message : String(e),
  });
}

export function figureById(id: string): Figure | undefined {
  return figuresById[id];
}

/** Write fig/renders/<id>.svg for every figure embedded in `docText`. Quarto (the DOCX
 *  export — and any bare `quarto render`) reads these from DISK; the in-app preview/PDF
 *  inline from memory, and W8 deliberately keeps MB-scale renders OFF the autosave path —
 *  so exports regenerate them just-in-time from the live figure model. flux-core has a
 *  headless twin (materializeRenders in flux-core/index.ts) for agents/CI. */
export async function materializeRenders(
  root: string,
  docText: string,
): Promise<{ wrote: number; failed: string[] }> {
  const fb = fileBridge();
  let wrote = 0;
  const failed: string[] = [];
  if (!root || !fb) return { wrote, failed };
  await (await import("../../../../lib/project/sourceBridge")).syncProjectSources(root);
  await loadFigures(root); // export uses the accepted source revision
  const ids = new Set<string>();
  for (const line of docText.split("\n")) {
    const m = EMBED_RE.exec(line);
    if (!m) continue;
    const fromPath = /fig\/renders\/([A-Za-z0-9_-]+)\.svg$/.exec(m[2]);
    if (fromPath) ids.add(fromPath[1]);
    else {
      const r = resolveFigure(m[3]);
      if (r && r.ref.id) ids.add(r.ref.id);
    }
  }
  if (!ids.size) return { wrote, failed };
  try {
    await fb.mkdir(`${root}/fig/renders`);
  } catch {
    /* exists */
  }
  for (const id of ids) {
    const svg = renderFigureSvgForDisk(id); // un-namespaced: byte-parity with flux-core
    if (!svg) {
      failed.push(id);
      continue;
    }
    try {
      await fb.writeText(`${root}/fig/renders/${id}.svg`, svg);
      wrote++;
    } catch {
      failed.push(id);
    }
  }
  return { wrote, failed };
}

// Dev-only seed so the headless harness can exercise chips/hover without a
// project on disk (browser demo has no file bridge).
export function __seedFigures(
  refs: FigureRef[],
  figs: Record<string, Figure>,
  data: Record<string, string> = {},
  families: FigureFamilyDef[] = [],
  manifests: Record<string, FluxPlotManifest> = {},
  assets: Asset[] = [],
  canvases: { id: string; name: string }[] = [],
): void {
  figuresById = figs;
  assetData = data;
  assetManifests = manifests;
  assetMeta = assets;
  familyDefs = families;
  renderCache.clear();
  loadGeneration++;
  revokeImageUrls(loadedRoot !== "__seed");
  loadedRoot = "__seed";
  figureCanvases.set(canvases);
  figureRefs.set(refs);
}
if (import.meta.env?.DEV) {
  (window as unknown as Record<string, unknown>).__fluxSeedFigures = __seedFigures;
  (window as unknown as Record<string, unknown>).__fluxFigures = {
    refs: () => get(figureRefs),
    resolve: resolveFigure,
    reload: (root: string | null) => loadFigures(root),
  };
}
