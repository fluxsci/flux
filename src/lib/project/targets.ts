// Targets: the exact thing the user means by "this". An annotation, the live
// bridge's app context and FluxChat's Ask all carry TargetRefs, so an agent
// receives a model object (plot "density" › series "control") instead of pixels
// and CSS selectors. Pure module (no Svelte, no DOM, no Node): the GUI resolves
// targets from its stores and hit-tests; flux-core reads them back from the
// annotation ledger and `inspect` resolves them against project files.

export type TargetRef =
  | { kind: "figure"; figureId: string; name?: string }
  | { kind: "element"; figureId: string; elementId: string; type?: string; name?: string }
  | { kind: "part"; figureId: string; elementId: string; partId: string; role?: string; label?: string; elementName?: string }
  | { kind: "caption"; figureId: string; panel?: string; figureName?: string }
  | { kind: "doc"; path: string; from: number; to: number; quote?: string; heading?: string }
  | { kind: "slide"; deckId: string; slideId: string; index?: number; name?: string }
  | { kind: "beat"; deckId: string; slideId: string; beat: number; label?: string }
  | { kind: "track"; deckId: string; slideId: string; trackId: string; family?: "appearance" | "transform" | "media" | "camera"; elementId?: string; beat?: number; label?: string }
  | { kind: "passage"; citekey: string; page: number; quote?: string; highlightId?: string; title?: string }
  | { kind: "library-item"; citekey: string; title?: string }
  | { kind: "region"; surface: string; rect: { x: number; y: number; w: number; h: number } };

export type TargetKind = TargetRef["kind"];

export const TARGET_KINDS: readonly TargetKind[] = [
  "figure", "element", "part", "caption", "doc", "slide", "beat", "track", "passage", "library-item", "region",
];

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const q = (s: string | undefined) => (s ? `"${clip(s, 60)}"` : "");

/** One line for people and agents: `plot "density" (fig-2) › series "control"`. */
export function describeTarget(t: TargetRef): string {
  switch (t.kind) {
    case "figure":
      return t.name ? `figure ${q(t.name)} (${t.figureId})` : `figure ${t.figureId}`;
    case "element": {
      const what = t.type || "element";
      return `${what} ${t.name ? q(t.name) : t.elementId} (${t.figureId}${t.name ? " · " + t.elementId : ""})`;
    }
    case "part": {
      const owner = t.elementName ? `plot ${q(t.elementName)}` : `plot ${t.elementId}`;
      const role = t.role || "part";
      return `${owner} (${t.figureId}) › ${role} ${t.label ? q(t.label) : t.partId}`;
    }
    case "caption":
      return `caption${t.panel ? ` panel ${t.panel}` : ""} of ${t.figureName ? q(t.figureName) : t.figureId}`;
    case "doc": {
      const where = `${t.path}:${t.from}–${t.to}`;
      const head = t.heading ? ` § ${q(t.heading)}` : "";
      return `text ${t.quote ? q(t.quote) + " " : ""}in ${where}${head}`;
    }
    case "slide":
      return `slide ${t.index !== undefined ? t.index + 1 : t.slideId}${t.name ? " " + q(t.name) : ""} (${t.deckId})`;
    case "beat":
      return `step ${t.beat}${t.label ? " " + q(t.label) : ""} of slide ${t.slideId} (${t.deckId})`;
    case "track":
      return `${t.family ?? "animation"} clip ${t.label ? q(t.label) : t.trackId}${t.beat !== undefined ? ` at step ${t.beat}` : ""} on slide ${t.slideId} (${t.deckId})`;
    case "passage":
      return `passage ${t.quote ? q(t.quote) + " " : ""}in ${t.citekey} p.${t.page}`;
    case "library-item":
      return `reference ${t.citekey}${t.title ? " " + q(t.title) : ""}`;
    case "region":
      return `region of the ${t.surface} view (${Math.round(t.rect.w)}×${Math.round(t.rect.h)} at ${Math.round(t.rect.x)},${Math.round(t.rect.y)})`;
  }
}

// ---------------------------------------------------------------------------
// Shorthand: a kind-prefixed, unambiguous one-token form for CLI arguments and
// agents (`flux inspect part:fig-2/el-9#control`). Names and quotes are display
// data and do not round-trip; ids do. Ids may not contain '/', '#' or '@';
// document paths may contain '/', so doc uses a trailing `@from-to`.
// ---------------------------------------------------------------------------

export function formatTarget(t: TargetRef): string {
  switch (t.kind) {
    case "figure": return `figure:${t.figureId}`;
    case "element": return `element:${t.figureId}/${t.elementId}`;
    case "part": return `part:${t.figureId}/${t.elementId}#${t.partId}`;
    case "caption": return `caption:${t.figureId}${t.panel ? "#" + t.panel : ""}`;
    case "doc": return `doc:${t.path}@${t.from}-${t.to}`;
    case "slide": return `slide:${t.deckId}/${t.slideId}`;
    case "beat": return `beat:${t.deckId}/${t.slideId}/${t.beat}`;
    case "track": return `track:${t.deckId}/${t.slideId}/${t.trackId}`;
    case "passage": return `passage:${t.citekey}@${t.page}`;
    case "library-item": return `library:${t.citekey}`;
    case "region": return `region:${t.surface}@${[t.rect.x, t.rect.y, t.rect.w, t.rect.h].map((n) => Math.round(n)).join(",")}`;
  }
}

const ID = /^[^/#@\s]+$/;

function ids(body: string, n: number, what: string): string[] {
  const parts = body.split("/");
  if (parts.length !== n || !parts.every((p) => ID.test(p))) throw new Error(`invalid ${what} target "${body}"`);
  return parts;
}

/** Inverse of formatTarget. Throws a readable error on malformed input. */
export function parseTarget(s: string): TargetRef {
  const text = s.trim();
  const colon = text.indexOf(":");
  if (colon <= 0) throw new Error(`invalid target "${s}" — expected kind:ids, e.g. part:fig-2/el-9#control`);
  const kind = text.slice(0, colon);
  const body = text.slice(colon + 1);
  switch (kind) {
    case "figure": {
      const [figureId] = ids(body, 1, "figure");
      return { kind, figureId };
    }
    case "element": {
      const [figureId, elementId] = ids(body, 2, "element");
      return { kind, figureId, elementId };
    }
    case "part": {
      const hash = body.lastIndexOf("#");
      if (hash < 0) throw new Error(`invalid part target "${body}" — expected fig/el#part`);
      const [figureId, elementId] = ids(body.slice(0, hash), 2, "part");
      const partId = body.slice(hash + 1);
      if (!partId) throw new Error(`invalid part target "${body}" — empty part id`);
      return { kind, figureId, elementId, partId };
    }
    case "caption": {
      const hash = body.indexOf("#");
      const [figureId] = ids(hash < 0 ? body : body.slice(0, hash), 1, "caption");
      const panel = hash < 0 ? undefined : body.slice(hash + 1);
      return panel ? { kind, figureId, panel } : { kind, figureId };
    }
    case "doc": {
      const at = body.lastIndexOf("@");
      const m = at > 0 ? /^(\d+)-(\d+)$/.exec(body.slice(at + 1)) : null;
      if (!m) throw new Error(`invalid doc target "${body}" — expected path@from-to`);
      const from = Number(m[1]), to = Number(m[2]);
      if (to < from) throw new Error(`invalid doc target "${body}" — range ends before it starts`);
      return { kind, path: body.slice(0, at), from, to };
    }
    case "slide": {
      const [deckId, slideId] = ids(body, 2, "slide");
      return { kind, deckId, slideId };
    }
    case "beat": {
      const [deckId, slideId, beat] = ids(body, 3, "beat");
      if (!/^\d+$/.test(beat)) throw new Error(`invalid beat target "${body}" — step must be a number`);
      return { kind, deckId, slideId, beat: Number(beat) };
    }
    case "track": {
      const [deckId, slideId, trackId] = ids(body, 3, "track");
      return { kind, deckId, slideId, trackId };
    }
    case "passage": {
      const at = body.lastIndexOf("@");
      if (at <= 0 || !/^\d+$/.test(body.slice(at + 1))) throw new Error(`invalid passage target "${body}" — expected citekey@page`);
      return { kind, citekey: body.slice(0, at), page: Number(body.slice(at + 1)) };
    }
    case "library": {
      if (!body || /\s/.test(body)) throw new Error(`invalid library target "${body}"`);
      return { kind: "library-item", citekey: body };
    }
    case "region": {
      const at = body.lastIndexOf("@");
      const nums = at > 0 ? body.slice(at + 1).split(",").map(Number) : [];
      if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) throw new Error(`invalid region target "${body}" — expected surface@x,y,w,h`);
      return { kind, surface: body.slice(0, at), rect: { x: nums[0], y: nums[1], w: nums[2], h: nums[3] } };
    }
    default:
      throw new Error(`unknown target kind "${kind}" — one of ${TARGET_KINDS.map((k) => (k === "library-item" ? "library" : k)).join(", ")}`);
  }
}

/** Same object? Identity only (ids and ranges), never display names. */
export function sameTarget(a: TargetRef, b: TargetRef): boolean {
  return formatTarget(a) === formatTarget(b);
}

/**
 * The next-wider target (Alt+↑ in the Annotate surface): part → element →
 * figure, caption → figure, track → beat → slide. Returns null at the top.
 */
export function widenTarget(t: TargetRef): TargetRef | null {
  switch (t.kind) {
    case "part":
      return { kind: "element", figureId: t.figureId, elementId: t.elementId, type: "plot", ...(t.elementName ? { name: t.elementName } : {}) };
    case "element":
    case "caption":
      return { kind: "figure", figureId: t.figureId };
    case "track":
      return t.beat !== undefined
        ? { kind: "beat", deckId: t.deckId, slideId: t.slideId, beat: t.beat }
        : { kind: "slide", deckId: t.deckId, slideId: t.slideId };
    case "beat":
      return { kind: "slide", deckId: t.deckId, slideId: t.slideId };
    case "passage":
      return { kind: "library-item", citekey: t.citekey, ...(t.title ? { title: t.title } : {}) };
    default:
      return null;
  }
}

/** The figure a target lives in, if any (inbox filtering by figure). */
export function targetFigureId(t: TargetRef): string | null {
  return t.kind === "figure" || t.kind === "element" || t.kind === "part" || t.kind === "caption" ? t.figureId : null;
}

/** The deck a target lives in, if any. */
export function targetDeckId(t: TargetRef): string | null {
  return t.kind === "slide" || t.kind === "beat" || t.kind === "track" ? t.deckId : null;
}

/** A page shorthand can address several distinct selected passages/highlights. */
export function resolvedTargetKey(t: TargetRef): string {
  return t.kind === "passage" ? JSON.stringify([formatTarget(t), t.highlightId ?? "", t.quote ?? ""]) : formatTarget(t);
}

/** De-duplicate resolved objects, retaining distinct anchors on the same PDF page. */
export function uniqueTargets(list: readonly TargetRef[]): TargetRef[] {
  const seen = new Set<string>();
  const out: TargetRef[] = [];
  for (const t of list) {
    const k = resolvedTargetKey(t);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}
