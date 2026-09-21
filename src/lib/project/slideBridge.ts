import { generationBridgeIO } from "./generationBridgeIO";
import { withIpcLock } from "../references/libLock";
import { preparePlot } from "../plot/parse";
import { updateManifest } from "./manifestBridge";
import { decodeManifest } from "./manifestTransaction";
import { commitDeckGeneration } from "./deckGeneration";
import { recoverTextGeneration, bytesToBase64, type GenerationWrite, type TextGenerationIO } from "./textGeneration";
// ---------------------------------------------------------------------------
// slideBridge — adapter between the LIVE editing stores and the project's
// `slides/` subsystem. Slides-are-figures: a deck's static content loads into
// the app-global FIGURE store (projected via deckToProject) and its
// presentation overlay into the slide store; saving recombines them
// (projectIntoDeck) into ONE self-contained `slides/<deckId>/deck.json`
// (atomic by construction — every renderer writeText rides the fs:writeText
// IPC → atomicWriteMain). The deck is the source of truth;
// project.json.slides[] is the index. The user/agent can hand-edit deck.json —
// the app live-reloads it (conflict-guarded).
// ---------------------------------------------------------------------------

import { get } from "svelte/store";
import { fileBridge, joinPath, type ProjectManifest } from "./types";
import type { Asset } from "../types";
import type { Deck } from "../slide/types";
import { createDeck as createDeckModel, normalizeDeck } from "../slide/ops";
import { validateDeckFile } from "./validate";
import { quarantineCopy } from "./quarantine";
import { pushToast } from "../toast";
import { isNewerSchema, newerSchemaMessage } from "./types";
import { DECK_SCHEMA_VERSION } from "../slide/types";
import { loadDeckModel, currentDeck, externalAssetIds, commitDeckLive, replaceResolvedDeckAssets } from "../slide/store";
import { project as figProject, embeddedProjectRoot, editGen, capturePersistenceGeneration, dirty as figDirty } from "../store";
import { assertStoreTenant, storeTenant } from "../tenancy";
import { assetData, bytesToDataUrl, dataUrlToBytes, mimeFor, isAssetDirty, assetDirtyGeneration, clearAssetDirty, clearAllAssetsDirty } from "../assets";
import { cachePlot, clearPlots, hasPlotDom, plotManifests, plotRecipes, plotDom } from "../plot/store";
import { captureSnipMeta } from "../snipMeta";
import { isDerivedManifest } from "../plot/derive";
import { svgIntrinsicPx } from "../plot/compensate";
import { plotSourceCandidates, toProjectRelativeSource } from "../plot/source";
import type { FluxPlotManifest } from "../plot/types";
import { ConflictError } from "../autosave";
import { planSourceUpdates, writeSourceUpdates, type SourceUpdate } from "../plot/sourceSync";
import { deckSourceProject, applyDeckSourceUpdates, reconcileDeckExternalAssetSizes } from "../slide/sourceSync";
import { bumpSlideEmbeds } from "../../shell/scholar/revisions";
import { readProjectDependencies, slideRemovalBlocker } from "./dependencies";
import { readLiveFigureReferenceDocuments } from "./figureReferenceSync";
import { syncProjectSources } from "./sourceBridge";

export interface DeckListItem {
  id: string;
  path: string;
  title: string;
  slides: number;
}

const stamp = () => new Date().toISOString();
const deckRel = (deckId: string) => `slides/${deckId}/deck.json`;

/** IO and locking only; the publication policy is shared with Node. */
const deckGenerationIO = generationBridgeIO;
async function withDeckMutation<T>(root: string, fn: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
  return withIpcLock("project", "project", projectLease => withIpcLock("project", "slides", async slideLease => {
    const assertOwned = async () => { await projectLease.assertOwned?.(); await slideLease.assertOwned?.(); };
    await withIpcLock("project", "manifest", async manifestLease => { await recoverTextGeneration(deckGenerationIO(root),async()=>{await assertOwned();await manifestLease.assertOwned?.()}); }, { root });
    return fn(assertOwned);
  }, { root }), { root });
}
async function persistDeckCandidate(root: string, deck: Deck, writes: ReadonlyMap<string, GenerationWrite>, assertOwned: () => Promise<void>, evidence?: { path: string; text: string | null }) {
  return withIpcLock("project", "manifest", manifestLease => commitDeckGeneration(deckGenerationIO(root), deck, {
    writes, ...(evidence ? { expectedPath: evidence.path.slice(root.replace(/\/$/, "").length + 1), expectedText: evidence.text } : {}),
    assertOwned: async () => { await assertOwned(); await manifestLease.assertOwned?.(); },
  }), { root });
}
async function sourceWrites(root: string, deck: Deck, updates: readonly SourceUpdate[]): Promise<Map<string, GenerationWrite>> {
  const writes = new Map<string, GenerationWrite>();
  const relative = (abs: string) => abs.slice(root.replace(/\/$/, "").length + 1);
  await writeSourceUpdates(root, updates, { writeText: async (p,t) => { writes.set(relative(p),t); }, remove: async p => { writes.set(relative(p),null); } }, deckSourceProject(deck), { assetBase: `slides/${deck.id}` });
  return writes;
}
function stagedDeckReader(root: string, writes: ReadonlyMap<string, GenerationWrite>) {
  const fb = fileBridge()!, relative = (p: string) => p.startsWith(root + "/") ? p.slice(root.length + 1) : "";
  const bytes = (value: GenerationWrite | undefined) => {
    if (value == null) throw new Error("Staged asset is absent");
    return typeof value === "string" ? new TextEncoder().encode(value) : Uint8Array.from(atob(value.base64), c => c.charCodeAt(0));
  };
  return { ...fb,
    exists: async (p: string) => writes.has(relative(p)) ? writes.get(relative(p)) !== null : fb.exists(p),
    readText: async (p: string) => writes.has(relative(p)) ? new TextDecoder().decode(bytes(writes.get(relative(p)))) : fb.readText(p),
    readFile: async (p: string) => writes.has(relative(p)) ? bytes(writes.get(relative(p))).buffer as ArrayBuffer : fb.readFile(p),
  };
}
function sourceFingerprint(deck: Deck): string {
  return JSON.stringify({ assets: deck.assets, sources: deck.slides.map(s => ({ id: s.id, elements: s.elements.filter(e => e.type === "plot").map(e => ({ id: e.id, assetId: e.assetId, source: e.source })), tracks: s.beats.flatMap(b => b.tracks.filter(t => t.to?.assetId).map(t => ({ id: t.id, target: t.target, assetId: t.to!.assetId, svgPath: t.to!.svgPath, manifestPath: t.to!.manifestPath, recipePath: t.to!.recipePath, external: t.to!.external, frozen: t.to!.frozen }))) })) });
}

// Divergence guard (fig/'s baseline mechanism, mirrored). Keyed by absolute
// deck path (deck ids repeat across projects); seeded at read, adopted after
// every save. saveDeckFrom compares disk against it and throws ConflictError
// instead of clobbering an external (agent/CLI) edit.
const deckBaseline = new Map<string, string>();
const deckReadEvidence = new WeakMap<Deck, { path: string; text: string }>();

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

/** Has this deck's file changed on disk since we read/wrote it? */
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
  if (!fig || !await fig.exists(joinPath(root, 'project.json'))) return null;
  return decodeManifest(await fig.readText(joinPath(root, 'project.json')));
}

/** The project's decks (from project.json.slides[]), enriched with title +
 *  slide count (best-effort). */
export async function listProjectDecks(root: string): Promise<DeckListItem[]> {
  const fig = fileBridge();
  const m = await readManifest(root);
  // Respect the registry's `order` — a stable deck order, newest appended last.
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

/** Read a deck file (without touching the live stores). Forward-version guard
 *  FIRST; then normalizeDeck (0.2.0 → 0.3.0 migration + id normalization);
 *  then the load-gate validation — a structurally invalid deck (including any
 *  pre-0.2.0 deck: clean break, no migration) is quarantined (bytes
 *  preserved) and skipped, never half-loaded. */
export async function readDeck(root: string, deckId: string): Promise<Deck | null> {
  const fig = fileBridge();
  if (!fig) return null;
  const m = await readManifest(root);
  const rel = m?.slides?.find((s) => s.id === deckId)?.path ?? deckRel(deckId);
  try {
    if (await fig.exists(joinPath(root, rel))) {
      const text = await fig.readText(joinPath(root, rel));
      const rawDeck = JSON.parse(text) as Deck;
      // Forward-version guard FIRST (before validation): a newer deck must not
      // be normalized down or judged by our schema.
      if (isNewerSchema(rawDeck.schemaVersion, DECK_SCHEMA_VERSION)) {
        pushToast("error", `Deck "${deckId}" written by a newer Flux — skipped`, {
          detail: newerSchemaMessage(rel, rawDeck.schemaVersion, DECK_SCHEMA_VERSION),
        });
        return null;
      }
      const deck = normalizeDeck(rawDeck);
      const errs = validateDeckFile(deck);
      if (errs.length) {
        const q = await quarantineCopy(fig, joinPath(root, rel), text);
        pushToast("error", `Deck "${deckId}" failed validation — skipped`, {
          detail: `${errs.slice(0, 5).join("\n")}${q ? `\nOriginal preserved at ${q}` : ""}`,
        });
        return null;
      }
      if (deck.id !== deckId) throw new Error("Deck identity does not match its registration");
      deckReadEvidence.set(deck, { path: joinPath(root, rel), text });
      return deck;
    }
  } catch {
    /* unreadable */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Asset resolution — feed the renderer caches (assetData + plot cache) with
// everything the projected slides need: deck-local media by path, and
// project-owned content (plots/, fig/assets/) BY ID, never copied into the
// deck. Returns the Asset entries for the projection + the external id set +
// diagnostics (a resolution gap is surfaced, never swallowed).
// ---------------------------------------------------------------------------

export interface DeckDiag {
  severity: "warning" | "error";
  assetId?: string;
  path?: string;
  reason: string;
}

interface ResolvedDeckAssets {
  assets: Asset[];
  external: Set<string>;
  data: Record<string, string>; // assetId → data URL (assetData payload)
  diagnostics: DeckDiag[];
  publish(): void;
}

// A refresh may inspect every deck dependency, but unchanged accepted bundles
// do not parse SVG or invalidate every thumbnail. DOM identity detects an
// intervening reimport/eviction outside this adapter.
const acceptedPlotCache = new Map<string, { svg: string; manifest: string; recipe: string; dom: SVGSVGElement | undefined }>();

function assetMime(kind: string): string {
  return kind === "svg" ? "image/svg+xml" : "image/png";
}

export async function resolveDeckAssets(root: string, deck: Deck, isCurrent: () => boolean = () => true, deferPublication = false, reader = fileBridge()): Promise<ResolvedDeckAssets> {
  const fig = reader;
  const assets: Asset[] = [];
  const external = new Set<string>();
  const data: Record<string, string> = {};
  const diagnostics: DeckDiag[] = [];
  const publications: (() => void)[] = [];
  const publish = () => { if (isCurrent()) for (const fn of publications.splice(0)) fn(); };
  if (!fig) return { assets: [...deck.assets], external, data, diagnostics, publish };
  const cacheAccepted = (id: string, svg: string, manifest?: FluxPlotManifest, recipe?: unknown) => {
    if (deferPublication) { publications.push(() => publishAccepted(id, svg, manifest, recipe)); return; }
    publishAccepted(id, svg, manifest, recipe);
  };
  const publishAccepted = (id: string, svg: string, manifest?: FluxPlotManifest, recipe?: unknown) => {
    if (!isCurrent() || isAssetDirty(id)) return;
    const key = `${root}\0${id}`, text = JSON.stringify(manifest ?? null), recipeText = JSON.stringify(recipe ?? null), prior = acceptedPlotCache.get(key);
    if (prior?.svg === svg && prior.manifest === text && prior.dom === plotDom.get(id) && hasPlotDom(id)) {
      if (prior.recipe !== recipeText) {
        plotRecipes.update((all) => { const next = { ...all }; if (recipe === undefined) delete next[id]; else next[id] = recipe; return next; });
        prior.recipe = recipeText;
      }
      return;
    }
    if (cachePlot(id, svg, manifest, recipe)) acceptedPlotCache.set(key, { svg, manifest: text, recipe: recipeText, dom: plotDom.get(id) });
  };

  const readManifestFile = async (rel: string): Promise<FluxPlotManifest | undefined> => {
    const abs = joinPath(root, rel);
    if (!(await fig.exists(abs))) return undefined;
    return JSON.parse(await fig.readText(abs)) as FluxPlotManifest;
  };
  /** Same, for a path already resolved to absolute (plot sources — see below). */
  const readManifestAbs = async (abs: string): Promise<FluxPlotManifest | undefined> => {
    try {
      return JSON.parse(await fig.readText(abs)) as FluxPlotManifest;
    } catch {
      return undefined;
    }
  };

  // 1. Deck-local media (slides/<id>/assets/*): bytes → data URLs; every svg
  // is ALSO cached as an inline semantic plot (a persisted .fluxplot.json
  // sidecar next to the bytes supplies real semantics, else a derived one).
  for (const a of deck.assets ?? []) {
    if (!a.path) continue;
    try {
      if (a.kind === "mp4") {
        // Native range streaming keeps large clips out of renderer memory. A
        // browser-only fixture may use its injected bridge and small data URLs.
        if (fig.videoMediaUrl) data[a.id] = await fig.videoMediaUrl({ root, path: `slides/${deck.id}/${a.path}` });
        else {
          const bytes = new Uint8Array(await fig.readFile(joinPath(root, "slides", deck.id, a.path)));
          data[a.id] = bytesToDataUrl(bytes, "video/mp4");
        }
        assets.push({ ...a });
        continue;
      }
      const bytes = new Uint8Array(await fig.readFile(joinPath(root, "slides", deck.id, a.path)));
      if (isCurrent() && a.kind === "svg" && !isAssetDirty(a.id)) {
        const manifest = await readManifestFile(`slides/${deck.id}/assets/${a.id}.fluxplot.json`);
        const recipe = await readManifestFile(`slides/${deck.id}/assets/${a.id}.recipe.json`);
        cacheAccepted(a.id, new TextDecoder().decode(bytes), manifest, recipe);
      }
      data[a.id] = bytesToDataUrl(bytes, assetMime(a.kind));
      if (a.kind === "png") { if (deferPublication) publications.push(() => captureSnipMeta(a.id, bytes)); else if (isCurrent()) captureSnipMeta(a.id, bytes); } // paper-snip provenance → copy citation
      assets.push({ ...a });
    } catch {
      assets.push({ ...a }); // keep the entry — the element shows a placeholder
      diagnostics.push({
        severity: "warning",
        assetId: a.id,
        path: a.path,
        reason: `media asset "${a.id}" missing (${a.path}) — its element will show a placeholder`,
      });
    }
  }
  const have = new Set(assets.map((a) => a.id));

  // fig/index.json asset metadata — the by-id resolution table for
  // figure-derived content (Send to deck / add_slide_figure copies).
  let figAssets: { id: string; kind: string; path?: string; name?: string; naturalWidth?: number; naturalHeight?: number; dpi?: number }[] = [];
  try {
    const p = joinPath(root, "fig", "index.json");
    if (await fig.exists(p)) {
      figAssets = (JSON.parse(await fig.readText(p)) as { assets?: typeof figAssets }).assets ?? [];
    }
  } catch {
    /* no fig index — nothing figure-derived to resolve */
  }

  const resolveExternal = async (assetId: string, forPlot: { svgPath?: string; manifestPath?: string; external?: boolean } | null): Promise<void> => {
    if (have.has(assetId)) return;
    // (b) by id against fig/ (figure-derived content)
    const fa = figAssets.find((x) => x.id === assetId);
    if (fa && fa.path) {
      try {
        const bytes = new Uint8Array(await fig.readFile(joinPath(root, "fig", fa.path)));
        if (isCurrent() && fa.kind === "svg" && !isAssetDirty(assetId)) {
          const manifest = await readManifestFile(`fig/assets/${assetId}.fluxplot.json`);
          const recipe = await readManifestFile(`fig/assets/${assetId}.recipe.json`);
          cacheAccepted(assetId, new TextDecoder().decode(bytes), manifest, recipe);
        }
        data[assetId] = bytesToDataUrl(bytes, assetMime(fa.kind));
        if (fa.kind !== "svg") { if (deferPublication) publications.push(() => captureSnipMeta(assetId, bytes)); else if (isCurrent()) captureSnipMeta(assetId, bytes); } // fig-derived png snip
        assets.push({
          id: assetId,
          name: fa.name ?? assetId,
          kind: (fa.kind === "svg" ? "svg" : "png") as Asset["kind"],
          path: `fig/${fa.path}`,
          naturalWidth: fa.naturalWidth ?? 240,
          naturalHeight: fa.naturalHeight ?? 180,
          ...(fa.dpi != null ? { dpi: fa.dpi } : {}),
        });
        have.add(assetId);
        external.add(assetId);
        return;
      } catch {
        // Registered copies are authoritative, including frozen versions.
        // Never pair a failed accepted read with a different raw source.
        diagnostics.push({ severity: "warning", assetId, reason: `Saved asset "${assetId}" is unreadable; its source was not substituted` });
        return;
      }
    }
    // (a) an explicit plot source path. Probed through plot/source.ts rather
    // than joined straight onto root: the stored value may be project-relative
    // (canonical), a foreign absolute path (imported on another machine, or
    // before this project moved), or a bare filename from drag-drop.
    if (forPlot?.svgPath) {
      try {
        let svgAbs = "";
        for (const c of plotSourceCandidates(root, forPlot.svgPath, forPlot)) {
          if (await fig.exists(c)) {
            svgAbs = c;
            break;
          }
        }
        if (!svgAbs) throw new Error(`plot source not found: ${forPlot.svgPath}`);
        const svgText = await fig.readText(svgAbs);
        // An authored manifestPath wins, but it carries the same stale shapes —
        // re-anchor it too, then fall back to the sidecar beside the file we
        // actually resolved.
        let manifest: FluxPlotManifest | undefined;
        if (forPlot.manifestPath) {
          for (const c of plotSourceCandidates(root, forPlot.manifestPath, forPlot)) {
            manifest = await readManifestAbs(c);
            if (manifest) break;
          }
        }
        if (!manifest) manifest = await readManifestAbs(svgAbs.replace(/\.svg$/i, ".fluxplot.json"));
        let recipe: unknown;
        try { recipe = JSON.parse(await fig.readText(svgAbs.replace(/\.svg$/i, ".recipe.json"))); } catch { /* optional recipe */ }
        cacheAccepted(assetId, svgText, manifest, recipe);
        data[assetId] = bytesToDataUrl(new TextEncoder().encode(svgText), "image/svg+xml");
        const dom = deferPublication ? preparePlot(svgText, manifest).root : plotDom.get(assetId);
        const nat = dom ? svgIntrinsicPx(dom) : { w: 240, h: 180 };
        assets.push({
          id: assetId,
          name: svgAbs.split("/").pop() ?? assetId,
          kind: "svg",
          // The path the deck records is the PORTABLE one, not whatever shape
          // the canvas happened to store.
          path: toProjectRelativeSource(root, svgAbs),
          naturalWidth: nat.w,
          naturalHeight: nat.h,
        });
        have.add(assetId);
        external.add(assetId);
        return;
      } catch {
        /* fall through to fig/-by-id */
      }
    }
    diagnostics.push({
      severity: "warning",
      assetId,
      ...(forPlot?.svgPath ? { path: forPlot.svgPath } : {}),
      reason: `asset "${assetId}" unresolvable — its element will show a placeholder`,
    });
  };

  // 2. Elements referencing assets the deck does not own.
  for (const s of deck.slides) {
    for (const el of s.elements) {
      if (el.type === "plot") await resolveExternal(el.assetId, el.source ?? null);
      else if (el.type === "image") await resolveExternal(el.assetId, null);
    }
    // Targets referenced only by Change/morph effects need the same accepted
    // asset and sidecar resolution as placed plots.
    for (const b of s.beats) for (const t of b.tracks) {
      if (!t.to?.assetId) continue;
      await resolveExternal(t.to.assetId, {
        svgPath: typeof t.to.svgPath === "string" ? t.to.svgPath : `plots/${t.to.assetId}.svg`,
        ...(typeof t.to.manifestPath === "string" ? { manifestPath: t.to.manifestPath } : {}),
        ...(typeof t.to.external === "boolean" ? { external: t.to.external } : {}),
      });
    }
  }

  return { assets, external, data, diagnostics, publish };
}

/** Prepare a private candidate; adopt it only after its exact source and
 * composition generation is durably committed. */
async function syncDeckSourceFiles(root: string, deck: Deck, isCurrent: () => boolean = () => true): Promise<void> {
  await withDeckMutation(root, async leaseOwned => {
    const fb = fileBridge(); if (!fb || !isCurrent()) return;
    const candidate = structuredClone(deck), model = deckSourceProject(candidate);
    const plan = await planSourceUpdates(root, model, fb, { assetBase: `slides/${deck.id}`, watchProject: deckSourceProject(candidate, { includeExternal: true }) });
    const resolved = await resolveDeckAssets(root, candidate, () => false, true);
    const externalChanged = reconcileDeckExternalAssetSizes(candidate, resolved.assets);
    if ((!plan.updates.length && !externalChanged) || !isCurrent()) return;
    const evidence = deckReadEvidence.get(deck);
    const assertOwned = async () => { await leaseOwned(); if (!isCurrent()) throw new ConflictError("Deck changed while its sources were prepared"); };
    const writes = await sourceWrites(root, candidate, plan.updates);
    applyDeckSourceUpdates(candidate, plan.updates);
    const published = await persistDeckCandidate(root, candidate, writes, assertOwned, evidence);
    Object.assign(deck, published.deck);
    deckReadEvidence.set(deck, { path: joinPath(root, published.path), text: published.text });
  });
}

const sourceRefreshes = new Map<string, Promise<void>>();
const pendingSourceRefresh = new Set<string>();
/** Persistence precedes all accepted-byte, cache and intrinsic-size history
 * publication. User geometry edited during preparation is merged into the
 * candidate; a later edit remains dirty and is never overwritten by a clone. */
export function refreshDeckSources(root: string): Promise<void> {
  const existing = sourceRefreshes.get(root);
  if (existing) { pendingSourceRefresh.add(root); return existing; }
  const run = () => withDeckMutation(root, async leaseOwned => {
    const fb = fileBridge(), snapshot = currentDeck(), loadGeneration = deckLoadGeneration;
    if (!fb || !snapshot || storeTenant() !== "slide" || get(embeddedProjectRoot) !== root) return;
    const current = () => loadGeneration === deckLoadGeneration && storeTenant() === "slide" && get(embeddedProjectRoot) === root && currentDeck()?.id === snapshot.id;
    const fingerprint = sourceFingerprint(snapshot);
    const plan = await planSourceUpdates(root, deckSourceProject(snapshot), fb, { assetBase: `slides/${snapshot.id}`, watchProject: deckSourceProject(snapshot, { includeExternal: true }) });
    if (!current()) return;
    const candidate = currentDeck()!, generation = editGen.n;
    if (sourceFingerprint(candidate) !== fingerprint) throw new ConflictError("Slide source ownership changed while reading; retry source refresh");
    const updates = plan.updates.filter(u => !isAssetDirty(u.assetId));
    const writes = await sourceWrites(root, candidate, updates);
    applyDeckSourceUpdates(candidate, updates);
    const resolved = await resolveDeckAssets(root, candidate, current, true, stagedDeckReader(root, writes));
    if (!current()) return;
    const accepted = resolved.assets.filter(a => resolved.external.has(a.id) && !isAssetDirty(a.id));
    const resized = reconcileDeckExternalAssetSizes(candidate, accepted);
    const assertOwned = async () => {
      await leaseOwned();
      if (!current() || sourceFingerprint(currentDeck()!) !== fingerprint || updates.some(u => isAssetDirty(u.assetId))) throw new ConflictError("Slide source ownership changed before publication; retry source refresh");
    };
    let published: Awaited<ReturnType<typeof persistDeckCandidate>> | undefined;
    if (updates.length || resized) {
      const m = await readManifest(root), rel = m?.slides?.find(s => s.id === candidate.id)?.path ?? deckRel(candidate.id);
      const baseline = deckBaseline.get(joinPath(root, rel));
      if (baseline === undefined) throw new ConflictError("Slide has no accepted disk baseline");
      capturePersistenceGeneration();
      published = await persistDeckCandidate(root, candidate, writes, assertOwned, { path: joinPath(root, rel), text: baseline });
    }
    // No await between the owner check and this single accepted transition.
    if (!current()) return;
    if (sourceFingerprint(currentDeck()!) !== fingerprint || updates.some(u => isAssetDirty(u.assetId))) throw new ConflictError("Slide changed after persistence; saved source retained, reload to reconcile");
    const unchanged = editGen.n === generation;
    if (updates.length || resized) commitDeckLive(deck => { applyDeckSourceUpdates(deck, updates); reconcileDeckExternalAssetSizes(deck, accepted); }, { history: false });
    resolved.publish();
    replaceResolvedDeckAssets(resolved.assets);
    const oldData = get(assetData), changedData = Object.fromEntries(Object.entries(resolved.data).filter(([id,url]) => !isAssetDirty(id) && oldData[id] !== url));
    if (Object.keys(changedData).length) assetData.update(data => ({ ...data, ...changedData }));
    if (published) { deckBaseline.set(joinPath(root, published.path), published.text); bumpSlideEmbeds(); if (unchanged) figDirty.set(false); }
    for (const status of plan.statuses) if (status.status === "error" || status.status === "missing") pushToast("error", `Slide source ${status.status === "missing" ? "missing" : "update failed"}`, { detail: `${status.path}: ${status.detail ?? "Last saved version retained"}` });
  });
  const promise = (async () => { do { pendingSourceRefresh.delete(root); await run(); } while (pendingSourceRefresh.has(root)); })().finally(() => { sourceRefreshes.delete(root); pendingSourceRefresh.delete(root); });
  sourceRefreshes.set(root, promise); return promise;
}

/** Load a deck into the live editing stores (figure store + slide overlay).
 *  Returns the deck + resolution diagnostics, or null. */
let deckLoadGeneration = 0;
export async function loadDeckInto(root: string, deckId: string, opts: { isCurrent?: () => boolean } = {}): Promise<{ deck: Deck; diagnostics: DeckDiag[] } | null> {
  const generation = ++deckLoadGeneration, tenant = storeTenant(), previousRoot = get(embeddedProjectRoot), editingGeneration = editGen.n;
  if (previousRoot !== null && previousRoot !== root) return null;
  const current = () => generation === deckLoadGeneration && editGen.n === editingGeneration && storeTenant() === tenant && get(embeddedProjectRoot) === previousRoot && (opts.isCurrent?.() ?? true);
  const deck = await readDeck(root, deckId);
  if (!deck || !current()) return null;
  if (await fileBridge()?.exists(joinPath(root, "fig/index.json"))) await syncProjectSources(root, { isCurrent: current });
  await syncDeckSourceFiles(root, deck, current);
  if (!current()) return null;
  const resolved = await resolveDeckAssets(root, deck, current, true);
  if (!current()) return null;
  return withDeckMutation(root, async assertOwned => {
    const evidence = deckReadEvidence.get(deck);
    if (evidence && await fileBridge()!.readText(evidence.path) !== evidence.text) throw new ConflictError("deck changed while opening");
    await assertOwned();
    if (!current()) return null;
    clearPlots(); acceptedPlotCache.clear(); resolved.publish();
    if (evidence) deckBaseline.set(evidence.path,evidence.text);
    loadDeckModel(deck,resolved.assets,resolved.external);assetData.set(resolved.data);clearAllAssetsDirty();
    return {deck,diagnostics:resolved.diagnostics};
  });
}

export async function saveDeckFrom(root: string, opts: { force?: boolean } = {}): Promise<void> {
  return withDeckMutation(root, owned => saveDeckOwned(root, opts, owned));
}
async function saveDeckOwned(root: string, opts: { force?: boolean }, leaseOwned: () => Promise<void>): Promise<void> {
  assertStoreTenant("slide", "saveDeckFrom");
  const fig = fileBridge(), d = currentDeck(); if (!fig || !d) return;
  const deckId = d.id, loadGeneration = deckLoadGeneration;
  const owner = () => loadGeneration === deckLoadGeneration && storeTenant() === "slide" && get(embeddedProjectRoot) === root && currentDeck()?.id === deckId;
  if (!owner()) throw new Error("Deck save does not own this project");
  const genAtStart = editGen.n; capturePersistenceGeneration();
  const data = { ...get(assetData) }, manifests = structuredClone(get(plotManifests)), recipes = structuredClone(get(plotRecipes));
  const assetGenerations = new Map(d.assets.map(a => [a.id, assetDirtyGeneration(a.id)]));
  reconcileDeckExternalAssetSizes(d, get(figProject).assets.filter(a => externalAssetIds().has(a.id) && !isAssetDirty(a.id)));
  const m = await readManifest(root), rel = m?.slides?.find(s => s.id === deckId)?.path ?? deckRel(deckId), abs = joinPath(root, rel);
  const before = await fig.exists(abs) ? await fig.readText(abs) : null, baseline = deckBaseline.get(abs);
  if (!opts.force && baseline != null && before !== baseline) throw new ConflictError("deck changed on disk");
  const writes = new Map<string, GenerationWrite>();
  for (const a of d.assets) {
    const url = data[a.id]; if (!a.path) a.path = `assets/${a.id}.${a.kind}`;
    const assetPath = `slides/${d.id}/${a.path}`, exists = await fig.exists(joinPath(root, assetPath));
    if (a.kind === "mp4" && exists) continue;
    if (a.kind === "mp4" && !url?.startsWith("data:video/")) throw new Error(`Video clip is missing: ${a.name}`);
    if (!url && !exists) throw new Error(`Deck asset is missing: ${a.name}`);
    if (!url || !isAssetDirty(a.id) && exists) continue;
    writes.set(assetPath, { base64: bytesToBase64(dataUrlToBytes(url)) });
    const man = manifests[a.id], sidecar = `slides/${d.id}/assets/${a.id}`;
    writes.set(sidecar + ".fluxplot.json", man && !isDerivedManifest(man) ? JSON.stringify(man,null,2) : null);
    writes.set(sidecar + ".recipe.json", man && !isDerivedManifest(man) && recipes[a.id] !== undefined ? JSON.stringify(recipes[a.id],null,2) : null);
  }
  const assertOwned = async () => { await leaseOwned(); if (!owner()) throw new Error("Deck changed before save could publish"); };
  const published = await persistDeckCandidate(root, d, writes, assertOwned, before === null ? undefined : { path: abs, text: before });
  if (owner()) {
    deckBaseline.set(joinPath(root,published.path),published.text);
    for (const [id,generation] of assetGenerations) clearAssetDirty(id,generation);
    if (editGen.n === genAtStart) figDirty.set(false);
  }
  if (published.text !== before || writes.size) bumpSlideEmbeds();
  const host = globalThis as { fig?: { journalAppend?: (e: unknown) => void } };
  host.fig?.journalAppend?.({ action: "save_deck", target: d.id, client: "human" });
}

// --- export: self-contained offline .html, via the main process --------------
/** True when the host can export a deck. The engine is Node-only (esbuild +
 *  fs), so export is desktop-only — gated on the bridge method existing. */
export function canExportDeck(): boolean {
  const f = fileBridge() as { exportDeck?: unknown } | null;
  return typeof f?.exportDeck === "function";
}

/** Export a deck to a self-contained offline .html via the main process.
 *  Returns the written path; throws with the reason on failure. */
export async function exportDeck(root: string, deckId: string): Promise<{ path: string; warnings: string[] }> {
  const f = fileBridge() as {
    exportDeck?: (r: string, d: string) => Promise<{ ok: boolean; path?: string; warnings?: string[]; error?: string }>;
  } | null;
  if (!f?.exportDeck) throw new Error("Export is only available in the desktop app.");
  const res = await f.exportDeck(root, deckId);
  if (!res?.ok || !res.path) throw new Error(res?.error || "Export failed.");
  return { path: res.path, warnings: res.warnings ?? [] };
}

/** Create a new deck in the project (write + register), and load it into the
 *  editor stores. Returns the new deck. */
export async function createDeckInProject(
  root: string,
  opts: { title?: string; theme?: string } = {},
): Promise<Deck> {
  const fig = fileBridge(), owner = get(embeddedProjectRoot);
  if (owner !== null && owner !== root) throw new Error("Deck creation does not own this project");
  const d = createDeckModel({ title: opts.title, theme: opts.theme });
  if (fig) await writeDeckDirect(root, d, { expectedText: null });
  if (get(embeddedProjectRoot) === owner) await loadDeckIntoStores(root, d);
  return d;
}

/** Load an in-memory deck into the stores (asset resolution included). */
async function loadDeckIntoStores(root: string, d: Deck): Promise<void> {
  const generation = ++deckLoadGeneration, tenant = storeTenant(), previousRoot = get(embeddedProjectRoot), editingGeneration = editGen.n;
  if (previousRoot !== null && previousRoot !== root) return;
  const current = () => generation === deckLoadGeneration && tenant === storeTenant() && previousRoot === get(embeddedProjectRoot) && editingGeneration === editGen.n;
  const resolved = await resolveDeckAssets(root, d, current, true);
  if (!current()) return;
  clearPlots(); acceptedPlotCache.clear(); resolved.publish();
  const evidence = deckReadEvidence.get(d); if (evidence) deckBaseline.set(evidence.path, evidence.text);
  loadDeckModel(d, resolved.assets, resolved.external);
  assetData.set(resolved.data);
  clearAllAssetsDirty();
}

/** Duplicate a deck on disk (new id + " copy" title, assets copied) and
 *  register it. Returns the new deck id. Does NOT load it. */
export async function duplicateDeckInProject(root: string, srcId: string): Promise<string | null> {
  const fig = fileBridge();
  const src = await readDeck(root, srcId);
  if (!fig || !src) return null;
  const dupe: Deck = structuredClone(src);
  dupe.id = createDeckModel({ withTitleSlide: false }).id; // fresh deck id
  dupe.title = `${src.title} copy`;
  dupe.created = stamp();
  dupe.modified = stamp();
  await fig.mkdir(joinPath(root, "slides", dupe.id));
  await fig.mkdir(joinPath(root, "slides", dupe.id, "assets"));
  const requiredMediaIds = new Set(dupe.assets.filter(a => a.kind === "mp4").map(a => a.id));
  for (const slide of dupe.slides) for (const element of slide.elements) if (element.type === "video") {
    requiredMediaIds.add(element.assetId); requiredMediaIds.add(element.posterAssetId);
  }
  const requiredMedia = dupe.assets.filter(a => requiredMediaIds.has(a.id));
  const missingMedia = [...requiredMediaIds].filter(id => !dupe.assets.some(a => a.id === id));
  if (missingMedia.length) throw new Error(`Video asset metadata is missing: ${missingMedia.join(", ")}`);
  if (requiredMedia.length) {
    if (!fig.copySlideVideoAssets) throw new Error("Duplicating a deck with video requires the Flux desktop app.");
    // The native batch copies movies and their posters directly on disk. It
    // rolls back its new files on failure, before this deck can be published.
    await fig.copySlideVideoAssets({ root, sourceDeckId: srcId, deckId: dupe.id, paths: requiredMedia.map(a => a.path) });
  }
  // copy each deck-local asset file (paths are deck-relative, same names)
  for (const a of dupe.assets ?? []) {
    if (requiredMediaIds.has(a.id)) continue;
    try {
      const bytes = new Uint8Array(await fig.readFile(joinPath(root, "slides", srcId, a.path)));
      await fig.writeFile(joinPath(root, "slides", dupe.id, a.path), bytes);
    } catch {
      /* skip an unreadable asset — the deck still opens */
    }
    try {
      const man = await fig.readText(joinPath(root, "slides", srcId, "assets", `${a.id}.fluxplot.json`));
      await fig.writeText(joinPath(root, "slides", dupe.id, "assets", `${a.id}.fluxplot.json`), man);
    } catch {
      /* no sidecar */
    }
  }
  await writeDeckDirect(root, dupe, { expectedText: null });
  return dupe.id;
}

/** Remove a deck from the project registry (project.json.slides[]). The
 *  deck's files are left on disk — a safe, reversible "remove from project".
 *  No-op if it's the only deck. */
export async function deleteDeckFromProject(root: string, deckId: string, force = false): Promise<boolean> {
  const fig = fileBridge();
  const m = await readManifest(root);
  if (!fig || !m) return false;
  if (!force) { const blocker = await embeddedSlideRemovalBlocker(root, deckId); if (blocker) throw new Error(blocker); }
  let removed = false;
  await updateManifest(root, fresh => {
    const slides = fresh.slides ?? [];
    if (slides.length <= 1) return;
    fresh.slides = slides.filter(s => s.id !== deckId);
    removed = fresh.slides.length !== slides.length;
  });
  if (!removed) return false;
  bumpSlideEmbeds();
  return true;
}

/** The direct/conversion path shares the same durable publication as a live
 * save. An explicit parent assertion means the caller owns project+slides. */
export async function writeDeckDirect(root: string, deck: Deck, opts: { assertOwned?: () => Promise<void>; expectedText?: string | null } = {}): Promise<void> {
  const publish = async (assertOwned: () => Promise<void>) => {
    const m = await readManifest(root), path = joinPath(root, m?.slides?.find(s=>s.id===deck.id)?.path ?? deckRel(deck.id));
    const evidence = deckReadEvidence.get(deck) ?? (opts.expectedText !== undefined ? {path,text:opts.expectedText} : undefined);
    const result = await persistDeckCandidate(root, deck, new Map(), assertOwned, evidence);
    Object.assign(deck,result.deck);
    deckReadEvidence.set(deck,{path:joinPath(root,result.path),text:result.text});
    bumpSlideEmbeds();
  };
  if (opts.assertOwned) await publish(opts.assertOwned);
  else await withDeckMutation(root,publish);
}

/** Test seam: forget all divergence baselines (headless gates re-seed). */
export function resetDeckBaselines(): void {
  deckBaseline.clear();
}

/** Includes every open unsaved Paper buffer, even in another pane. */
export async function embeddedSlideRemovalBlocker(root: string, deck: string, slide?: string): Promise<string | null> {
  const fb = fileBridge();
  if (!fb) return "Document references could not be checked";
  const live = await readLiveFigureReferenceDocuments(root);
  return slideRemovalBlocker(await readProjectDependencies(root, fb, live), deck, slide);
}

/** Prepare an embed without borrowing the authoring stores. The open deck is
 * refreshed through its existing edit-preserving service; closed decks use IO. */
export async function prepareEmbeddedDeck(root: string, id: string): Promise<string[]> {
  const fb = fileBridge();
  if (!fb) return [];
  if (storeTenant() === "slide" && get(embeddedProjectRoot) === root && currentDeck()?.id === id) {
    await refreshDeckSources(root);
    return [];
  }
  const { withIpcLock } = await import("../references/libLock");
  const { syncEmbeddedDeckSources } = await import("../slide/embedSources");
  return withIpcLock("project", "slides", () => syncEmbeddedDeckSources(root, id, fb,
    () => !(storeTenant() === "slide" && get(embeddedProjectRoot) === root && currentDeck()?.id === id)));
}
