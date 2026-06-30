// ---------------------------------------------------------------------------
// slideBridge — adapter between the slide editor's in-memory deck and the
// project's `slides/` subsystem (the closest model is figbridge.ts, but a deck
// is one self-contained file: `slides/<deckId>/deck.json`, plus a deck-local
// `assets/` dir). The deck is the source of truth; project.json.slides[] is the
// index. The user/agent can hand-edit deck.json — the app live-reloads it.
// ---------------------------------------------------------------------------

import { get } from "svelte/store";
import { fileBridge, joinPath, type ProjectManifest } from "./types";
import type { Deck } from "../slide/types";
import { createDeck as createDeckModel } from "../slide/ops";
import { deck as deckStore, loadDeckModel, deckDirty } from "../slide/store";

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
