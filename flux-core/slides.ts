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
import type { Deck } from "../src/lib/slide/types";
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
  deck.modified = stamp();
  await withLock(root, "slides", getClient(), async () => {
    await writeText(safeJoin(root, deckRel(deck.id)), JSON.stringify(deck, null, 2) + "\n");
    await registerDeck(root, deck);
  });
  await journal(root, { action, deck: deck.id, slides: deck.slides.length });
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
  const deck = await loadDeck(root, deckId);
  const slide = slideOps.addSlide(deck, opts);
  await saveDeck(root, deck, "add_slide");
  return { slideId: slide.id };
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
 *  asset is simply absent (the element shows its placeholder). */
export async function gatherDeckPayload(root: string, deckId: string): Promise<ExportPayload> {
  const deck = await loadDeck(root, deckId);
  const assets: Record<string, string> = {};
  const plots: Record<string, { svg: string; manifest: FluxPlotManifest }> = {};
  const figures: Record<string, string> = {};

  for (const a of deck.assets ?? []) {
    if (!a.path) continue;
    try {
      const buf = await fs.readFile(safeJoin(root, j("slides", deck.id, a.path)));
      assets[a.id] = `data:${assetMime(a.kind)};base64,${buf.toString("base64")}`;
    } catch { /* missing media */ }
  }

  const manifest = await loadManifest(root).catch(() => null);
  const plotIndex = ((manifest as unknown as { plots?: { id: string; path?: string; svgPath?: string; manifestPath?: string }[] })?.plots) ?? [];
  const collectPlot = async (assetId: string, svgPath?: string, manifestPath?: string) => {
    if (plots[assetId]) return;
    const entry = plotIndex.find((p) => p.id === assetId);
    const sp = svgPath ?? entry?.svgPath ?? entry?.path;
    const mp = manifestPath ?? entry?.manifestPath;
    if (!sp) return;
    try {
      const svg = await fs.readFile(safeJoin(root, sp), "utf8");
      let m: FluxPlotManifest | undefined;
      if (mp) try { m = JSON.parse(await fs.readFile(safeJoin(root, mp), "utf8")) as FluxPlotManifest; } catch { /* optional */ }
      plots[assetId] = { svg, manifest: m ?? ({ axes: [], series: [] } as unknown as FluxPlotManifest) };
    } catch { /* unreadable plot */ }
  };

  for (const s of deck.slides) {
    for (const el of s.elements) {
      if (el.type === "plot") await collectPlot(el.assetId, el.source?.svgPath, el.source?.manifestPath);
      else if (el.type === "embedFigure") {
        try { figures[el.figureId] = await renderFigureSvg(root, el.figureId); } catch { /* no figure */ }
      }
    }
    for (const b of s.beats) for (const t of b.tracks) {
      if (t.preset === "morph" && t.to?.assetId) await collectPlot(t.to.assetId);
    }
  }
  return { deck, plots, figures, assets };
}

/** export-deck: gather + emit the self-contained .html (defaults to
 *  exports/<deckId>.html). Journals the export. */
export async function exportDeck(
  root: string,
  deckId: string,
  opts: { out?: string } = {},
): Promise<{ path: string; bytes: number; warnings: string[] }> {
  const payload = await gatherDeckPayload(root, deckId);
  const { html, bytes, warnings } = await exportDeckHtml(payload);
  const out = opts.out ?? safeJoin(root, j("exports", `${deckId}.html`));
  await writeText(out, html);
  await journal(root, { action: "export_deck", deck: deckId, bytes });
  return { path: out, bytes, warnings };
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
