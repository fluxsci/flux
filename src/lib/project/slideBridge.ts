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
import { validateDeckFile, sanitizeProjectGeometry } from "./validate";
import { quarantineCopy } from "./quarantine";
import { pushToast } from "../toast";
import { isNewerSchema, newerSchemaMessage } from "./types";
import { DECK_SCHEMA_VERSION } from "../slide/types";
import { loadDeckModel, currentDeck, externalAssetIds } from "../slide/store";
import { project as figProject, editGen, dirty as figDirty } from "../store";
import { assertStoreTenant } from "../tenancy";
import { assetData, bytesToDataUrl, dataUrlToBytes, mimeFor, isAssetDirty, clearAssetDirty, clearAllAssetsDirty } from "../assets";
import { cachePlot, clearPlots, hasPlotDom, plotManifests, plotDom } from "../plot/store";
import { captureSnipMeta } from "../snipMeta";
import { isDerivedManifest } from "../plot/derive";
import { svgIntrinsicPx } from "../plot/compensate";
import type { FluxPlotManifest } from "../plot/types";
import { ConflictError } from "../autosave";

export interface DeckListItem {
  id: string;
  path: string;
  title: string;
  slides: number;
}

const stamp = () => new Date().toISOString();
const deckRel = (deckId: string) => `slides/${deckId}/deck.json`;

// Divergence guard (fig/'s baseline mechanism, mirrored). Keyed by absolute
// deck path (deck ids repeat across projects); seeded at read, adopted after
// every save. saveDeckFrom compares disk against it and throws ConflictError
// instead of clobbering an external (agent/CLI) edit.
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
      deckBaseline.set(joinPath(root, rel), text); // what we believe is on disk
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
}

function assetMime(kind: string): string {
  return kind === "svg" ? "image/svg+xml" : "image/png";
}

export async function resolveDeckAssets(root: string, deck: Deck): Promise<ResolvedDeckAssets> {
  const fig = fileBridge();
  const assets: Asset[] = [];
  const external = new Set<string>();
  const data: Record<string, string> = {};
  const diagnostics: DeckDiag[] = [];
  if (!fig) return { assets: [...deck.assets], external, data, diagnostics };

  const haveRealManifest = (assetId: string) => {
    const m = get(plotManifests)[assetId];
    return !!m && !isDerivedManifest(m);
  };
  const readManifestFile = async (rel: string): Promise<FluxPlotManifest | undefined> => {
    try {
      return JSON.parse(await fig.readText(joinPath(root, rel))) as FluxPlotManifest;
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
      const bytes = new Uint8Array(await fig.readFile(joinPath(root, "slides", deck.id, a.path)));
      data[a.id] = bytesToDataUrl(bytes, assetMime(a.kind));
      if (a.kind === "svg" && !hasPlotDom(a.id)) {
        const manifest = await readManifestFile(`slides/${deck.id}/assets/${a.id}.fluxplot.json`);
        cachePlot(a.id, new TextDecoder().decode(bytes), manifest);
      }
      if (a.kind === "png") captureSnipMeta(a.id, bytes); // paper-snip provenance → copy citation
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

  const resolveExternal = async (assetId: string, forPlot: { svgPath?: string; manifestPath?: string } | null): Promise<void> => {
    if (have.has(assetId)) return;
    // (a) an explicit plot source path (plots/…, project-relative)
    if (forPlot?.svgPath) {
      try {
        const svgText = await fig.readText(joinPath(root, forPlot.svgPath));
        const manifestPath = forPlot.manifestPath ?? forPlot.svgPath.replace(/\.svg$/i, ".fluxplot.json");
        const manifest = await readManifestFile(manifestPath);
        if (!hasPlotDom(assetId)) cachePlot(assetId, svgText, manifest);
        else if (manifest && !haveRealManifest(assetId)) plotManifests.update((m) => ({ ...m, [assetId]: manifest }));
        data[assetId] = bytesToDataUrl(new TextEncoder().encode(svgText), "image/svg+xml");
        const dom = plotDom.get(assetId);
        const nat = dom ? svgIntrinsicPx(dom) : { w: 240, h: 180 };
        assets.push({
          id: assetId,
          name: forPlot.svgPath.split("/").pop() ?? assetId,
          kind: "svg",
          path: forPlot.svgPath,
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
    // (b) by id against fig/ (figure-derived content)
    const fa = figAssets.find((x) => x.id === assetId);
    if (fa && fa.path) {
      try {
        const bytes = new Uint8Array(await fig.readFile(joinPath(root, "fig", fa.path)));
        data[assetId] = bytesToDataUrl(bytes, assetMime(fa.kind));
        if (fa.kind === "svg" && !hasPlotDom(assetId)) {
          const manifest = await readManifestFile(`fig/assets/${assetId}.fluxplot.json`);
          cachePlot(assetId, new TextDecoder().decode(bytes), manifest);
        }
        if (fa.kind !== "svg") captureSnipMeta(assetId, bytes); // fig-derived png snip
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
        /* missing bytes */
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
    // 2b. morph TARGETS referenced only by tracks (to.assetId) — they never
    // appear as elements, so without this the compat gate sees no manifest and
    // the morph silently holds at A in preview.
    for (const b of s.beats)
      for (const t of b.tracks) {
        if (t.preset !== "morph" || !t.to?.assetId || have.has(t.to.assetId)) continue;
        // Candidate order mirrors flux-core's collectPlot: the authored source
        // path, the plots/<id>.svg convention, then fig/assets/<id>.svg — a
        // figure-derived target (Send to deck / headless import) has no
        // plots/ entry, and a bare assetId used to resolve nothing here, so
        // the morph silently held at A in preview while the export worked.
        const authored = t.to.svgPath as string | undefined;
        const sps = [...(authored ? [authored] : []), `plots/${t.to.assetId}.svg`, `fig/assets/${t.to.assetId}.svg`];
        if (!hasPlotDom(t.to.assetId) || !haveRealManifest(t.to.assetId)) {
          let resolved = false;
          for (const svgPath of sps) {
            try {
              const svgText = await fig.readText(joinPath(root, svgPath));
              const manifestPath =
                (svgPath === authored ? (t.to.manifestPath as string | undefined) : undefined) ??
                svgPath.replace(/\.svg$/i, ".fluxplot.json");
              const manifest = await readManifestFile(manifestPath);
              if (!hasPlotDom(t.to.assetId)) cachePlot(t.to.assetId, svgText, manifest);
              else if (manifest) plotManifests.update((m) => ({ ...m, [t.to!.assetId!]: manifest }));
              resolved = true;
              break;
            } catch {
              /* next candidate */
            }
          }
          if (!resolved) {
            diagnostics.push({
              severity: "warning",
              assetId: t.to.assetId,
              path: sps[0],
              reason: `morph target "${t.to.assetId}" unresolvable (tried ${sps.join(", ")}) — the morph will hold at A`,
            });
          }
        }
      }
  }

  return { assets, external, data, diagnostics };
}

/** Load a deck into the live editing stores (figure store + slide overlay).
 *  Returns the deck + resolution diagnostics, or null. */
export async function loadDeckInto(root: string, deckId: string): Promise<{ deck: Deck; diagnostics: DeckDiag[] } | null> {
  const deck = await readDeck(root, deckId);
  if (!deck) return null;
  clearPlots();
  const resolved = await resolveDeckAssets(root, deck);
  loadDeckModel(deck, resolved.assets, resolved.external);
  assetData.set(resolved.data);
  clearAllAssetsDirty(); // freshly loaded — every asset is in sync with disk
  return { deck, diagnostics: resolved.diagnostics };
}

/** Ensure a deck is registered in project.json.slides[] (id/path/title/order). */
async function registerDeck(root: string, deck: Deck): Promise<void> {
  const m = await readManifest(root);
  if (!m) return;
  m.slides = Array.isArray(m.slides) ? m.slides : [];
  const idx = m.slides.findIndex((s) => s.id === deck.id);
  // Preserve a manifest-customized path — readDeck resolves through the
  // manifest, so forcing the default here would split reads and writes.
  const rel = (idx >= 0 ? m.slides[idx].path : undefined) ?? deckRel(deck.id);
  const order = idx >= 0 ? m.slides[idx].order ?? idx + 1 : m.slides.length + 1;
  const entry = { id: deck.id, path: rel, title: deck.title, order };
  if (idx >= 0) m.slides[idx] = { ...m.slides[idx], ...entry };
  else m.slides.push(entry);
  await writeManifest(root, m);
}

/** Persist the live deck (figure store + overlay recombined) to
 *  slides/<id>/deck.json, plus any new/changed DECK-OWNED asset bytes into
 *  slides/<id>/assets/ (the slide-mode asset sink — imports through the figure
 *  pipeline land here, never in fig/assets/). Conflict-guarded; tenancy-
 *  asserted (a kept-alive cross-mode save is structurally impossible). */
export async function saveDeckFrom(root: string, opts: { force?: boolean } = {}): Promise<void> {
  assertStoreTenant("slide", "deck save");
  const fig = fileBridge();
  const d = currentDeck();
  if (!fig || !d) return;
  // Conflict guard: refuse to clobber a deck.json that changed on disk since
  // we read/wrote it. `force` = the banner's Overwrite. The abs path must
  // match readDeck's seed — resolve through the manifest the same way.
  const m0 = await readManifest(root);
  const rel = m0?.slides?.find((s) => s.id === d.id)?.path ?? deckRel(d.id);
  const abs = joinPath(root, rel);
  const baseline = deckBaseline.get(abs);
  if (!opts.force && baseline != null && (await readDeckText(fig, abs)) !== baseline) {
    throw new ConflictError("deck changed on disk");
  }
  const genAtStart = editGen.n; // only clear dirty if no edit lands mid-save

  // Never persist NaN/Infinity — JSON turns them into null, which the load
  // gate would then (rightly) reject. Clamp on the live project (the same
  // object the deck was composed from) so both halves agree.
  {
    const fixed = sanitizeProjectGeometry(get(figProject));
    if (fixed) {
      pushToast("info", `Repaired ${fixed} non-finite geometry value(s) while saving`);
      for (const s of d.slides) {
        for (const e of s.elements as unknown as Record<string, unknown>[]) {
          for (const k of ["x", "y", "width", "height", "rotation"]) {
            const v = e[k];
            if (typeof v === "number" && !Number.isFinite(v)) e[k] = k === "width" || k === "height" ? 1 : 0;
          }
        }
      }
    }
  }

  d.modified = stamp();
  await fig.mkdir(joinPath(root, "slides", d.id));
  await fig.mkdir(joinPath(root, "slides", d.id, "assets"));

  // Asset sink: (re)write NEW or CHANGED deck-owned asset bytes (imports flow
  // through the shared figure pipeline into assetData + the dirty set; the
  // deck-relative "assets/<id>.<kind>" path was fixed at import). A real plot
  // manifest sidecar persists next to the bytes (derived manifests never do —
  // sidecar presence is the fluxplot/vanilla discriminator).
  const dataUrls = get(assetData);
  const manifests = get(plotManifests);
  for (const a of d.assets) {
    const url = dataUrls[a.id];
    if (!url) continue;
    if (!a.path) a.path = `assets/${a.id}.${a.kind}`;
    if (!isAssetDirty(a.id) && (await fig.exists(joinPath(root, "slides", d.id, a.path)))) continue;
    await fig.writeFile(joinPath(root, "slides", d.id, a.path), dataUrlToBytes(url));
    const man = manifests[a.id];
    if (man && !isDerivedManifest(man)) {
      await fig.writeText(joinPath(root, "slides", d.id, "assets", `${a.id}.fluxplot.json`), JSON.stringify(man, null, 2));
    }
    clearAssetDirty(a.id);
  }

  const text = JSON.stringify(d, null, 2) + "\n";
  await fig.writeText(abs, text); // atomic via the fs:writeText IPC path
  deckBaseline.set(abs, text); // adopt what we just wrote
  await registerDeck(root, d);
  // Provenance for the human's save (Electron only; mem/demo bridge no-ops).
  const host = (globalThis as { fig?: { journalAppend?: (e: unknown) => void } }).fig;
  host?.journalAppend?.({ action: "save_deck", target: d.id, client: "human" });
  // An edit landing during the writes above keeps the dirty flag; the autosave
  // controller's trailing save persists it instead of it being silently dropped.
  if (editGen.n === genAtStart) figDirty.set(false);
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
export async function exportDeck(root: string, deckId: string): Promise<string> {
  const f = fileBridge() as {
    exportDeck?: (r: string, d: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  } | null;
  if (!f?.exportDeck) throw new Error("Export is only available in the desktop app.");
  const res = await f.exportDeck(root, deckId);
  if (!res?.ok || !res.path) throw new Error(res?.error || "Export failed.");
  return res.path;
}

/** Create a new deck in the project (write + register), and load it into the
 *  editor stores. Returns the new deck. */
export async function createDeckInProject(
  root: string,
  opts: { title?: string; theme?: string } = {},
): Promise<Deck> {
  const fig = fileBridge();
  const d = createDeckModel({ title: opts.title, theme: opts.theme });
  if (fig) {
    await fig.mkdir(joinPath(root, "slides", d.id));
    await fig.mkdir(joinPath(root, "slides", d.id, "assets"));
    const text = JSON.stringify(d, null, 2) + "\n";
    await fig.writeText(joinPath(root, deckRel(d.id)), text);
    deckBaseline.set(joinPath(root, deckRel(d.id)), text);
    await registerDeck(root, d);
  }
  await loadDeckIntoStores(root, d);
  return d;
}

/** Load an in-memory deck into the stores (asset resolution included). */
async function loadDeckIntoStores(root: string, d: Deck): Promise<void> {
  clearPlots();
  const resolved = await resolveDeckAssets(root, d);
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
  // copy each deck-local asset file (paths are deck-relative, same names)
  for (const a of dupe.assets ?? []) {
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
  await fig.writeText(joinPath(root, deckRel(dupe.id)), JSON.stringify(dupe, null, 2) + "\n");
  await registerDeck(root, dupe);
  return dupe.id;
}

/** Remove a deck from the project registry (project.json.slides[]). The
 *  deck's files are left on disk — a safe, reversible "remove from project".
 *  No-op if it's the only deck. */
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

/** Write a deck back to disk WITHOUT the live stores (the Send-to-deck path
 *  from figure mode — slide mode is never resident then, so this cannot race
 *  the editor). Adopts the baseline so a later slide-mode open is clean. */
export async function writeDeckDirect(root: string, deck: Deck): Promise<void> {
  const fig = fileBridge();
  if (!fig) throw new Error("no file bridge");
  deck.modified = stamp();
  await fig.mkdir(joinPath(root, "slides", deck.id));
  await fig.mkdir(joinPath(root, "slides", deck.id, "assets"));
  const m = await readManifest(root);
  const rel = m?.slides?.find((s) => s.id === deck.id)?.path ?? deckRel(deck.id);
  const text = JSON.stringify(deck, null, 2) + "\n";
  await fig.writeText(joinPath(root, rel), text);
  deckBaseline.set(joinPath(root, rel), text);
  await registerDeck(root, deck);
}

/** Test seam: forget all divergence baselines (headless gates re-seed). */
export function resetDeckBaselines(): void {
  deckBaseline.clear();
}
