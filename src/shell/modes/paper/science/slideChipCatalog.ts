// The synchronous label catalog behind Paper's slide-embed chip
// ("▷ Deck 3 · Slide 4"). The decoration pass must resolve a label without
// waiting (the way `resolveFigure(label)` does for figure chips), so this keeps
// `{deckId → {title, slides:[{id,name}]}}` for exactly the decks the document
// references, filled from the embed repository's deck reads.
//
// IO happens only on a deck's first lookup and on repository invalidation
// (deck/slide/figure revisions), never per keystroke. On invalidation the old
// entry keeps answering until the fresh read settles, so a chip never flashes
// back to its fallback; `onChange` fires only when a settled entry differs.
// No DOM, no CodeMirror: `verify-slide-embed-chip.ts` drives it hermetically.

import type { SlideEmbedRef } from "../../../../lib/slide/embed";

export interface SlideCatalogDeck {
  title?: string;
  slides: { id: string; name?: string }[];
}
/** The repository surface the catalog needs (`SlideRepository` satisfies it). */
export interface SlideCatalogSource {
  deck(id: string): Promise<SlideCatalogDeck>;
  subscribe(fn: () => void): () => void;
}

export type SlideChipInfo =
  | { state: "pending" }
  | { state: "resolved"; deckTitle: string; ordinal: number; count: number; slideName: string }
  | { state: "missing"; reason: string; deckTitle?: string };

interface DeckEntry {
  title: string;
  slides: { id: string; name: string }[];
}
/** slide id → 0-based ordinal, per settled deck (a 1,000-slide deck is a real fixture). */
const ordinals = new WeakMap<DeckEntry, Map<string, number>>();
const ordinalOf = (deck: DeckEntry, id: string): number => {
  let m = ordinals.get(deck);
  if (!m) {
    m = new Map();
    deck.slides.forEach((s, i) => { if (!m!.has(s.id)) m!.set(s.id, i); });
    ordinals.set(deck, m);
  }
  return m.get(id) ?? -1;
};
type Settled = { deck: DeckEntry } | { error: string };

export interface SlideChipCatalog {
  /** Synchronous; an unseen deck schedules its one read and answers `pending`. */
  lookup(ref: Pick<SlideEmbedRef, "deck" | "slide">): SlideChipInfo;
  dispose(): void;
}

export function createSlideChipCatalog(source: SlideCatalogSource, onChange: () => void): SlideChipCatalog {
  const decks = new Map<string, { value?: Settled; ticket: number }>();
  let generation = 0,
    disposed = false,
    scheduled = false;
  const notify = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    // Coalesce several decks settling in one tick into one decoration refresh.
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed) onChange();
    });
  };
  const settle = (id: string, ticket: number, value: Settled) => {
    const rec = decks.get(id);
    if (disposed || !rec || rec.ticket !== ticket) return; // superseded by an invalidation
    const changed = JSON.stringify(rec.value) !== JSON.stringify(value);
    rec.value = value;
    if (changed) notify();
  };
  const read = (id: string) => {
    const rec = decks.get(id)!;
    const ticket = (rec.ticket = ++generation);
    let pending: Promise<SlideCatalogDeck>;
    try {
      pending = source.deck(id);
    } catch (e) {
      pending = Promise.reject(e);
    }
    pending.then(
      (d) =>
        settle(id, ticket, {
          deck: {
            title: d.title?.trim() || "Untitled deck",
            slides: (d.slides ?? []).map((s) => ({ id: s.id, name: s.name ?? "" })),
          },
        }),
      (e) => settle(id, ticket, { error: e instanceof Error ? e.message : String(e) }),
    );
  };
  const off = source.subscribe(() => {
    if (!disposed) for (const id of decks.keys()) read(id);
  });
  return {
    lookup(ref) {
      if (!ref.deck || !ref.slide) return { state: "missing", reason: "The embed names no deck or slide" };
      let rec = decks.get(ref.deck);
      if (!rec) {
        rec = { ticket: 0 };
        decks.set(ref.deck, rec);
        if (!disposed) read(ref.deck);
      }
      const v = rec.value;
      if (!v) return { state: "pending" };
      if ("error" in v) return { state: "missing", reason: v.error };
      const index = ordinalOf(v.deck, ref.slide);
      if (index < 0) return { state: "missing", reason: "The slide is no longer in its deck", deckTitle: v.deck.title };
      return {
        state: "resolved",
        deckTitle: v.deck.title,
        ordinal: index + 1,
        count: v.deck.slides.length,
        slideName: v.deck.slides[index].name,
      };
    },
    dispose() {
      disposed = true;
      off();
      decks.clear();
    },
  };
}

export interface SlideChipLabel {
  text: string;
  /** False only when the deck/slide is known to be missing (dimmed chip). */
  resolved: boolean;
  pending: boolean;
  tooltip: string;
}

/** Short, stable fallback while a deck is read: `Slide murfeg`. */
const shortId = (id: string) => id.replace(/^slide[_-]?/, "").slice(0, 6) || id.slice(0, 6);

/** Chip text: deck TITLE + the slide's 1-based ORDINAL, mid-dot like the
 *  widget footer. The slide's own name rides the tooltip (names drift from
 *  position — Deck 3's "Title" slide sits second). */
export function slideChipLabel(ref: Pick<SlideEmbedRef, "deck" | "slide">, info: SlideChipInfo, raw: string): SlideChipLabel {
  const source = raw.trim();
  const how = "Click to place the caret (reveals the source); double-click to open in Slide";
  if (info.state === "resolved") {
    const at = `Slide ${info.ordinal}`;
    const name = info.slideName && info.slideName !== at ? ` — “${info.slideName}”` : "";
    return {
      text: `${info.deckTitle} · ${at}`,
      resolved: true,
      pending: false,
      tooltip: `${info.deckTitle} · ${at} of ${info.count}${name}\n${source}\n${how}`,
    };
  }
  if (info.state === "pending") {
    return { text: `Slide ${shortId(ref.slide)}`, resolved: true, pending: true, tooltip: `${source}\n${how}` };
  }
  return {
    text: info.deckTitle ? `${info.deckTitle} · missing slide` : "Missing slide deck",
    resolved: false,
    pending: false,
    tooltip: `Unresolved slide embed — ${info.reason}: ${source}`,
  };
}
