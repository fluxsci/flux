// ---------------------------------------------------------------------------
// X-ray row CONTEXT (2026-10-23) — what a row is, beyond its bare label: where
// it sits ("X axis › Tick labels"), what it shows ("0 · 800 · 1600 · 2400",
// "Sigma power (µV²)", a series colour), and its state (restyled, hidden
// beneath, hidden by an ancestor). The owner's law for the X-ray: context is
// IMMEDIATELY visible on the row, never only behind a hover.
//
// Labels stay canonical. A row's `label` is the part label every gate, the
// `a` sibling rule and commonPartIds compare; context rides BESIDE it in its
// own fields, so "Tick marks" is still "Tick marks" — now with "X axis ›".
//
// Pure and memoised. The X-ray tree rebuilds on every project commit while it
// is open, so everything per-manifest is computed once per manifest OBJECT
// (and per pristine plot DOM root for text read from the drawing) and reused;
// per-element override state is O(override keys × depth), never O(members).
// ---------------------------------------------------------------------------

import type { FluxPlotManifest, PartNode } from "../plot/types";
import { aliasPartId, hiddenLeaves, inferRole, labelForPart, resolveTargets } from "../plot/tree";

/** Roles that are plot SCAFFOLDING: kept out of a row's context path (every
 *  part sits under them, so naming them says nothing). */
const SCAFFOLD = new Set(["figure", "plot-area"]);
/** Group roles whose members are text, and so carry a value preview each. */
const TEXT_MEMBER_ROLES = new Set(["tick-label", "colorbar-tick-label", "legend-label", "label", "annotation", "x-cluster-label", "x-dimension-label"]);
const TEXT_ROLES = new Set(["axis-title", "title", "subtitle", "annotation", "legend-label", "label", "colorbar-label", "tick-label", "colorbar-tick-label", "x-cluster-label", "x-dimension-label", "x-caption"]);

export interface PartCtx {
  /** Display labels of the meaningful ancestors, root-most first ("Panel a", "X axis"). */
  path: string[];
  /** One-line value preview (tick texts, a title's text, a series' name). */
  preview?: string;
  /** A colour that identifies the row (a series' / legend entry's paint). */
  swatch?: string;
  /** The axis this part belongs to ("x", "y", "x2" …), from its axis ancestor. */
  axis?: string;
  /** Group rows: their member leaf ids (a member row per id). */
  members?: string[];
  /** Member rows: the group that holds them. */
  group?: string;
}

interface Entry {
  node: PartNode;
  id: string;
  role: string;
  parent: string | null;
  path: string[];
  axis?: string;
  axisNode?: string;
  panel?: string;
  members?: string[];
  memberRole?: string;
  depth: number;
}

export interface ManifestIndex {
  manifest: FluxPlotManifest;
  entries: Map<string, Entry>;
  /** member leaf id → its group's id */
  memberOf: Map<string, string>;
  panels: number;
}

const keyOf = (n: PartNode): string | undefined => n.id ?? n.ref;
const clean = (s: string | undefined | null): string => (s ?? "").replace(/\s+/g, " ").trim();

const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻", "−": "⁻", "+": "⁺", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ" };
const SUB: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "-": "₋", "−": "₋", "+": "₊", "(": "₍", ")": "₎" };
const TEX: Record<string, string> = { times: "×", cdot: "·", pm: "±", mp: "∓", circ: "°", degree: "°", mu: "µ", alpha: "α", beta: "β", gamma: "γ", delta: "δ", Delta: "Δ", theta: "θ", lambda: "λ", sigma: "σ", Sigma: "Σ", pi: "π", omega: "ω", Omega: "Ω", infty: "∞", minus: "−", "%": "%", ",": " ", " ": " " };
// Unicode has no superscript for every character ("10^{-1.5}"): then the plain "10^(-1.5)".
const script = (s: string, map: Record<string, string>, mark: string) => [...s].every((c) => map[c]) ? [...s].map((c) => map[c]).join("") : s.length > 1 ? `${mark}(${s})` : `${mark}${s}`;

/** fluxplot mathtext labels arrive as `$\mathdefault{10^{-8}}$` in the manifest:
 *  render them as the text a reader sees ("10⁻⁸"), so a preview never depends
 *  on whether the plot's drawing happens to be loaded. */
export function plainTickLabel(s: string): string {
  if (!s.includes("$")) return clean(s);
  // Odd segments are math (`a $\mu$m` → "a ", "\mu", "m"): convert each on its own.
  return clean(s.split("$").map((seg, i) => (i % 2 ? texToText(seg) : seg)).join(""));
}
function texToText(src: string): string {
  let t = src;
  t = t.replace(/\^\{([^{}]*)\}/g, (_, x: string) => script(x, SUP, "^")).replace(/\^([^\\{(])/g, (_, x: string) => script(x, SUP, "^"));
  t = t.replace(/_\{([^{}]*)\}/g, (_, x: string) => script(x, SUB, "_")).replace(/_([^\\{(])/g, (_, x: string) => script(x, SUB, "_"));
  t = t.replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1/$2").replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, "");
  for (let k = 0; k < 3; k++) t = t.replace(/\\(?:mathdefault|mathregular|mathrm|mathit|mathbf|mathsf|mathtt|textrm|text|operatorname|boldsymbol)\{([^{}]*)\}/g, "$1");
  // A known symbol → its character; an escaped character (\%) → itself; any other command drops.
  t = t.replace(/\\([A-Za-z]+|.)/g, (_, name: string) => TEX[name] ?? (name.length === 1 ? name : ""));
  return t.replace(/[{}]/g, "");
}

const indexMemo = new WeakMap<FluxPlotManifest, ManifestIndex>();

/** The manifest's parts tree flattened into id → entry (parent, context path,
 *  axis, panel, members). Memoised per manifest object. */
export function manifestIndex(manifest: FluxPlotManifest): ManifestIndex {
  const hit = indexMemo.get(manifest);
  if (hit) return hit;
  const entries = new Map<string, Entry>();
  const memberOf = new Map<string, string>();
  let panels = 0;
  const root = manifest.parts as PartNode | undefined;
  const count = (n: PartNode) => { if (n.role === "panel") panels++; for (const c of n.children ?? []) count(c); };
  if (root) count(root);
  const walk = (n: PartNode, parent: string | null, path: string[], axis: string | undefined, axisNode: string | undefined, panel: string | undefined, depth: number) => {
    const id = keyOf(n);
    if (!id) return;
    const role = n.role === "group" ? n.groupRole ?? "group" : n.role ?? inferRole(id);
    const members = n.role === "group" && n.members?.length && !(n.members.length === 1 && n.members[0] === id) ? n.members.slice() : undefined;
    const ownAxis = n.role === "axis" ? n.axis ?? /(?:^|\.)axis\.([a-z0-9]+)$/.exec(id)?.[1] : undefined;
    const e: Entry = { node: n, id, role, parent, path, axis: ownAxis ?? axis, axisNode: ownAxis ? id : axisNode, panel: n.role === "panel" ? id : panel, members, memberRole: n.memberRole ?? undefined, depth };
    if (!entries.has(id)) entries.set(id, e);
    if (members) for (const m of members) if (!memberOf.has(m)) memberOf.set(m, id);
    // What this node contributes to its descendants' path: nothing for
    // scaffolding, nothing for a lone panel (it would label every row the same).
    const own = SCAFFOLD.has(role) || (n.role === "panel" && panels < 2) ? null : labelForPart(n);
    const next = own ? [...path, own] : path;
    for (const c of n.children ?? []) walk(c, id, next, e.axis, e.axisNode, e.panel, depth + 1);
  };
  if (root) walk(root, null, [], undefined, undefined, undefined, 0);
  const index: ManifestIndex = { manifest, entries, memberOf, panels };
  indexMemo.set(manifest, index);
  return index;
}

/** The manifest's axes[] entry for an axis node id (`axis.x`, `panel.a.axis.y`,
 *  `panel.twin.axis.y2`): matched by panel prefix, the sole entry otherwise. */
function axisSpec(manifest: FluxPlotManifest, axisNodeId: string, axisName: string): { label?: string; scale?: string; ticks?: { value: number; label: string }[] } | undefined {
  const prefix = axisNodeId.replace(/(?:^|\.)axis\.[a-z0-9]+$/, "");
  const axes = manifest.axes ?? [];
  const entry = axes.find((a) => (a.panelId ?? "") === prefix || (a.id ?? "").replace(/\.plot-area$/, "") === prefix) ?? (axes.length === 1 ? axes[0] : undefined);
  return (entry as unknown as Record<string, { label?: string; scale?: string; ticks?: { value: number; label: string }[] } | undefined> | undefined)?.[axisName];
}

/** Text read from the plot's drawing, by part id (pristine DOM ids are the
 *  manifest's own). Absent DOM → undefined everywhere (manifest fallbacks). */
export type TextOf = (partId: string) => string | undefined;

const domTextMemo = new WeakMap<Element, Map<string, string>>();
/** An id → collapsed-text lookup over a pristine plot DOM, built once per DOM root. */
export function domTextLookup(root: Element | null | undefined): TextOf {
  if (!root) return () => undefined;
  let map = domTextMemo.get(root);
  if (!map) {
    map = new Map();
    for (const n of Array.from(root.querySelectorAll("[id]"))) {
      if (map.has(n.id)) continue;
      const tag = n.tagName.toLowerCase();
      // Only TEXT-bearing nodes: a container's textContent would concatenate its children.
      if (tag === "text" || n.querySelector("text")) {
        const t = clean(n.textContent);
        if (t) map.set(n.id, t);
      }
    }
    domTextMemo.set(root, map);
  }
  const m = map;
  return (id) => m.get(id);
}

const paintMemo = new WeakMap<Element, Map<string, string | null>>();
/** The paint a part is DRAWN with (its first drawable's fill, else stroke; "none" skipped),
 *  read from inline style / attributes of the pristine drawing — the fallback swatch for
 *  manifests that carry no colour (older fluxplot). Never computed style: no layout. */
export function domPaint(root: Element | null | undefined, id: string, prefer: "fill" | "stroke" = "fill"): string | undefined {
  if (!root) return undefined;
  let memo = paintMemo.get(root);
  if (!memo) { memo = new Map(); paintMemo.set(root, memo); }
  const key = prefer + "|" + id;
  if (memo.has(key)) return memo.get(key) ?? undefined;
  const node = root.querySelector(`[id="${id.replace(/["\\]/g, "\\$&")}"]`);
  const d = node ? (node.matches("path,circle,ellipse,rect,line,polyline,polygon,use,text") ? node : node.querySelector("path,circle,ellipse,rect,line,polyline,polygon,use,text")) : null;
  const read = (prop: string) => {
    const inline = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(d?.getAttribute("style") ?? "")?.[1]?.trim();
    const v = inline ?? d?.getAttribute(prop) ?? undefined;
    return v && v !== "none" && !/^url\(/.test(v) ? v : undefined;
  };
  const out = prefer === "stroke" ? read("stroke") ?? read("fill") : read("fill") ?? read("stroke");
  memo.set(key, out ?? null);
  return out;
}

const ctxMemo = new WeakMap<ManifestIndex, WeakMap<object, Map<string, PartCtx>>>();
const NO_DOM = {};

function joinPreview(texts: string[], max = 14): string | undefined {
  const t = texts.filter(Boolean);
  if (!t.length) return undefined;
  return t.slice(0, max).join(" · ") + (t.length > max ? " …" : "");
}

/** Context for one part id of a manifest: memoised per (manifest, drawing). */
export function partContext(manifest: FluxPlotManifest, partId: string, dom: Element | null = null): PartCtx {
  const index = manifestIndex(manifest);
  let byDom = ctxMemo.get(index);
  if (!byDom) { byDom = new WeakMap(); ctxMemo.set(index, byDom); }
  const domKey = dom ?? NO_DOM;
  let memo = byDom.get(domKey);
  if (!memo) { memo = new Map(); byDom.set(domKey, memo); }
  const id = aliasPartId(manifest, partId);
  const hit = memo.get(id);
  if (hit) return hit;
  const ctx = computeContext(index, id, domTextLookup(dom), dom);
  memo.set(id, ctx);
  return ctx;
}

function computeContext(index: ManifestIndex, id: string, textOf: TextOf, dom: Element | null): PartCtx {
  const { manifest, entries, memberOf } = index;
  const e = entries.get(id);
  if (!e) {
    // A group MEMBER leaf (one tick label, one point): the group's context + the group itself.
    const gid = memberOf.get(id);
    const g = gid ? entries.get(gid) : undefined;
    if (!g) return { path: [] };
    const groupLabel = labelForPart(g.node);
    const text = TEXT_MEMBER_ROLES.has(g.role) || TEXT_ROLES.has(g.memberRole ?? "") ? memberTickText(index, g, id) ?? textOf(id) : undefined;
    return { path: [...g.path, groupLabel], axis: g.axis, group: gid, ...(text ? { preview: text } : {}) };
  }
  const out: PartCtx = { path: e.path, ...(e.axis ? { axis: e.axis } : {}), ...(e.members ? { members: e.members } : {}) };
  const preview = previewOf(index, e, textOf);
  if (preview.text) out.preview = preview.text;
  if (preview.swatch) out.swatch = preview.swatch;
  // A series the manifest gives no colour: the paint of its first drawn mark.
  else if (role(e) === "series" && dom) {
    const leaf = resolveTargets(index.manifest, e.id)[0];
    const line = (e.node.children ?? []).some((c) => keyOf(c)?.endsWith(".line"));
    const paint = leaf ? domPaint(dom, leaf, line ? "stroke" : "fill") : undefined;
    if (paint && /^#[0-9a-f]{3,8}$|^rgb/i.test(paint)) out.swatch = paint;
  }
  return out;
}

/** A member tick label's text from axes[].ticks, index-aligned with `…ticklabel.N`
 *  (fluxplot numbers every tick it writes, in order — verified over 2,742 labels).
 *  Trusted only when every member index has a tick; otherwise none (never a guess). */
function memberTickText(index: ManifestIndex, g: Entry, memberId: string): string | undefined {
  if (!g.axisNode || !g.axis || g.role !== "tick-label") return undefined;
  const ticks = axisSpec(index.manifest, g.axisNode, g.axis)?.ticks;
  if (!ticks?.length) return undefined;
  const ix = (id: string) => Number(/\.(\d+)$/.exec(id)?.[1] ?? NaN);
  if (!(g.members ?? []).every((m) => ix(m) < ticks.length)) return undefined;
  const t = ticks[ix(memberId)]?.label;
  return t ? plainTickLabel(t) || undefined : undefined;
}

/** A group's member texts — the MANIFEST first (stable whether or not the plot's
 *  drawing is loaded), the drawn text when the manifest has none. */
function groupTexts(index: ManifestIndex, g: Entry, textOf: TextOf): string[] {
  const members = g.members ?? [];
  const fromManifest = members.map((m) => memberTickText(index, g, m) ?? "");
  if (fromManifest.some(Boolean)) return fromManifest.filter(Boolean);
  return members.map((m) => textOf(m) ?? "").filter(Boolean);
}

/** The first text found in a subtree (a node's own text, else its first text leaf). */
function firstText(index: ManifestIndex, e: Entry, textOf: TextOf, depth = 0): string | undefined {
  const own = textOf(e.id);
  if (own) return own;
  if (depth > 3) return undefined;
  for (const c of e.node.children ?? []) {
    const k = keyOf(c);
    const ce = k ? index.entries.get(k) : undefined;
    if (ce && (TEXT_ROLES.has(ce.role) || (ce.node.children?.length ?? 0) > 0)) {
      const t = firstText(index, ce, textOf, depth + 1);
      if (t) return t;
    }
  }
  return undefined;
}

const HEX = /^#[0-9a-f]{3,8}$/i;

const role = (e: Entry) => e.role;
function previewOf(index: ManifestIndex, e: Entry, textOf: TextOf): { text?: string; swatch?: string } {
  const m = index.manifest;
  const role = e.role;
  if (e.members) {
    if (TEXT_MEMBER_ROLES.has(role)) return { text: joinPreview(groupTexts(index, e, textOf)) };
    if (role === "tick" && e.parent) {
      // Tick MARKS: their range, read from the sibling tick labels.
      const sib = [...index.entries.values()].find((x) => x.parent === e.parent && x.role === "tick-label" && x.members);
      const texts = sib ? groupTexts(index, sib, textOf) : [];
      return texts.length > 1 ? { text: `${texts[0]} … ${texts[texts.length - 1]}` } : {};
    }
    return {};
  }
  if (e.node.role === "axis") {
    const title = [...index.entries.values()].find((x) => x.parent === e.id && x.role === "axis-title");
    const text = (e.axisNode && e.axis ? plainTickLabel(axisSpec(m, e.axisNode, e.axis)?.label ?? "") : "") || (title && textOf(title.id)) || "";
    const scale = e.axisNode && e.axis ? axisSpec(m, e.axisNode, e.axis)?.scale : undefined;
    const parts = [text, scale && scale !== "linear" && scale !== "category" ? scale : ""].filter(Boolean);
    return parts.length ? { text: parts.join(" · ") } : {};
  }
  if (role === "axis-title") {
    const t = (e.axisNode && e.axis ? plainTickLabel(axisSpec(m, e.axisNode, e.axis)?.label ?? "") : "") || textOf(e.id) || "";
    return t ? { text: t } : {};
  }
  if (role === "series") {
    const s = (m.series ?? []).find((x) => x.id === e.id);
    if (!s) return {};
    const name = clean(s.label ?? s.name);
    const n = s.points?.length ?? s.data?.y?.length ?? s.data?.x?.length;
    const kind = clean(s.kind ?? "");
    // The display name only when it says more than the id the label already shows.
    const slug = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const sameAsId = !name || slug(e.id) === slug(name) || slug(e.id).endsWith("-" + slug(name));
    const parts = [sameAsId ? "" : name, kind && kind !== "line" ? kind : "", n && n > 1 ? `${n} pts` : ""].filter(Boolean);
    const hex = s.color?.hex;
    return { ...(parts.length ? { text: parts.join(" · ") } : {}), ...(hex && HEX.test(hex) ? { swatch: hex } : {}) };
  }
  if (role === "legend-entry") {
    for (const g of m.guides ?? []) for (const en of g.entries ?? []) {
      const kids = (e.node.children ?? []).map(keyOf);
      if ((en.label && kids.includes(en.label)) || (en.swatch && kids.includes(en.swatch)) || en.part === e.id) {
        const s = en.series ? (m.series ?? []).find((x) => x.id === en.series) : undefined;
        const hex = s?.color?.hex;
        const text = clean(en.text) || (en.label ? textOf(en.label) ?? "" : "");
        return { ...(text ? { text } : {}), ...(hex && HEX.test(hex) ? { swatch: hex } : {}) };
      }
    }
    const t = firstText(index, e, textOf);
    return t ? { text: t } : {};
  }
  if (role === "legend") {
    const texts = (e.node.children ?? []).map((c) => { const k = keyOf(c); const ce = k ? index.entries.get(k) : undefined; return ce ? previewOf(index, ce, textOf).text ?? "" : ""; });
    return { text: joinPreview(texts, 8) };
  }
  if (role === "colorbar") {
    const g = (m.guides ?? []).find((x) => x.role === "colorbar" && (x.svgId === e.id || x.id === e.id));
    const parts = [clean(g?.label) || firstText(index, e, textOf) || "", clean(g?.cmap)].filter(Boolean);
    return parts.length ? { text: parts.join(" · ") } : {};
  }
  if (TEXT_ROLES.has(role) || e.node.kind === "text") {
    const o = (m.overlays ?? []).find((x) => x.svgId === e.id || x.id === e.id);
    const t = plainTickLabel(o?.text ?? "") || textOf(e.id);
    return t ? { text: t } : {};
  }
  if (e.node.role === "panel" || role === "title") {
    const t = firstText(index, e, textOf);
    return t ? { text: t } : {};
  }
  return {};
}

/** A plot's identity hint for its element row: its title, else its y-axis
 *  title, else its x-axis title (what a scientist reads a panel by). */
export function plotHint(manifest: FluxPlotManifest | undefined, dom: Element | null = null): string | undefined {
  if (!manifest) return undefined;
  const index = manifestIndex(manifest);
  const textOf = domTextLookup(dom);
  for (const e of index.entries.values()) if (e.role === "title" && e.depth <= 3) { const t = textOf(e.id); if (t) return t; }
  const axes = [...index.entries.values()].filter((e) => e.node.role === "axis");
  for (const want of ["y", "x"]) for (const a of axes.filter((x) => x.axis === want)) {
    const t = previewOf(index, a, textOf).text;
    if (t) return t;
  }
  return undefined;
}

// --- per-element override state ----------------------------------------------
export interface OverrideState {
  /** ids whose OWN override carries a non-hidden property (aliased) */
  styled: Set<string>;
  /** ids with a restyled descendant (member leaves count) */
  styledBeneath: Set<string>;
  /** ids whose own override says hidden: true (aliased) */
  ownHidden: Set<string>;
  /** leaf → drawn hidden?, by THE rule (plot/tree.ts hiddenLeaves) */
  hiddenLeaf: Map<string, boolean>;
}

/** Invert an element's overrides once: which rows are restyled or hold a
 *  restyled part beneath, and which leaves are drawn hidden (the rendering
 *  rule itself, so a row's eye never disagrees with the canvas). Keys go
 *  through aliasPartId (an id an older fluxplot emitted still marks the row). */
export function overrideState(manifest: FluxPlotManifest | undefined, overrides: Record<string, Record<string, unknown> | undefined> | undefined): OverrideState {
  const out: OverrideState = { styled: new Set(), styledBeneath: new Set(), ownHidden: new Set(), hiddenLeaf: new Map() };
  if (!overrides) return out;
  const index = manifest ? manifestIndex(manifest) : null;
  out.hiddenLeaf = hiddenLeaves(manifest, overrides as Record<string, { hidden?: boolean | null }>);
  for (const [raw, ov] of Object.entries(overrides)) {
    if (!ov) continue;
    const id = manifest ? aliasPartId(manifest, raw) : raw;
    if (ov.hidden === true) out.ownHidden.add(id);
    const isStyled = Object.keys(ov).some((k) => k !== "hidden" && ov[k] !== undefined && ov[k] !== null);
    if (!isStyled) continue;
    out.styled.add(id);
    if (!index) continue;
    for (let up = parentOf(index, id); up; up = index.entries.get(up)?.parent ?? null) out.styledBeneath.add(up);
  }
  return out;
}

/** A part's parent id: a member's group, a tree node's parent. */
function parentOf(index: ManifestIndex, id: string): string | null {
  return index.entries.has(id) ? index.entries.get(id)!.parent : index.memberOf.get(id) ?? null;
}

/** Is `id` at or beneath `ancestor` in the parts tree (members included)? */
export function isWithin(manifest: FluxPlotManifest, id: string, ancestor: string): boolean {
  const index = manifestIndex(manifest);
  for (let at: string | null = aliasPartId(manifest, id); at; at = parentOf(index, at)) if (at === ancestor) return true;
  return false;
}

/** The hidden writes one eye toggle makes on a part, as a key → hidden patch
 *  (true / false / null = clear). The toggle NORMALISES the part's subtree:
 *  every key beneath it loses its own hidden flag (so "x" on Tick labels shows
 *  or hides ALL of them, the Layers rule — and no stale `false` is left to
 *  outrank a later family hide), and the part itself is set — to `false` only
 *  when an ancestor would otherwise still hide it, else cleared. Rendering
 *  applies keys in order (the later wins), so an exception must also come
 *  AFTER that ancestor: see hiddenNeedsReorder. */
export function hiddenToggleWrites(manifest: FluxPlotManifest | undefined, overrides: Record<string, { hidden?: boolean | null } | undefined> | undefined, partId: string, hide: boolean): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  const id = manifest ? aliasPartId(manifest, partId) : partId;
  for (const [k, ov] of Object.entries(overrides ?? {})) {
    if (ov?.hidden == null) continue;
    const kid = manifest ? aliasPartId(manifest, k) : k;
    if (kid !== id && manifest && isWithin(manifest, kid, id)) out[k] = null;
    if (kid === id && k !== partId) out[k] = null; // an aliased (old-id) key for the same part
  }
  if (hide) { out[partId] = true; return out; }
  // Would an ancestor still hide it once its own flag is cleared?
  const next: Record<string, { hidden?: boolean | null } | undefined> = { ...(overrides ?? {}) };
  for (const [k, v] of Object.entries(out)) next[k] = { ...(next[k] ?? {}), hidden: v };
  next[partId] = { ...(next[partId] ?? {}), hidden: null };
  const leaves = resolveTargets(manifest, partId);
  const still = hiddenLeaves(manifest, next);
  out[partId] = leaves.some((l) => still.get(l)) ? false : null;
  return out;
}

// --- plot identity across a set -------------------------------------------------
/** For labels shown side by side (several plots x-rayed together), the part of
 *  each label that tells it apart: the PREFIX every label shares is split off
 *  at a word boundary (`-` `_` `.` space `/`) and drawn dim, so the distinctive
 *  rest reads first ("sd-early-…-bandpower-" + "low-gamma"). Only the prefix:
 *  a shared suffix ("-gamma") is part of the name. `[prefix, key]` per label;
 *  the key is never empty. Identical labels (one plot placed twice) are told
 *  apart by `ordinal` (1-based, in list order) — null where the label is unique. */
export function distinctiveParts(labels: string[]): { prefix: string; key: string; ordinal: number | null }[] {
  const counts = new Map<string, number>(), seen = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const ordinals = labels.map((l) => ((counts.get(l) ?? 0) > 1 ? (seen.set(l, (seen.get(l) ?? 0) + 1), seen.get(l)!) : null));
  const distinct = [...counts.keys()];
  let pre = 0;
  if (distinct.length > 1) {
    const a = distinct[0];
    while (pre < a.length && distinct.every((l) => l[pre] === a[pre])) pre++;
    while (pre > 0 && !/[-_.\s/]/.test(a[pre - 1])) pre--;
    if (distinct.some((l) => !l.slice(pre).trim())) pre = 0;
  }
  return labels.map((l, i) => ({ prefix: l.slice(0, pre), key: l.slice(pre), ordinal: ordinals[i] }));
}

// --- search ----------------------------------------------------------------------
/** A query split into tokens (whitespace), lower-cased. */
export function queryTokens(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Where `token` occurs in `hay` at a WORD START (string start or after a
 *  non-alphanumeric character), or -1. "x" finds "X axis", not "Box". */
export function wordStart(hay: string, token: string, from = 0): number {
  if (!token) return -1;
  let i = hay.indexOf(token, from);
  while (i >= 0) {
    if (i === 0 || !/[\p{L}\p{N}]/u.test(hay[i - 1])) return i;
    i = hay.indexOf(token, i + 1);
  }
  return -1;
}

export interface SearchFields {
  /** the row's own text: its label (and preview) */
  own: string[];
  /** context text: plot key, path */
  context: string[];
}

/** A row's searchable text: its OWN (label, preview — a member only by its value:
 *  "tick" must never list every tick label) and its CONTEXT (path, owning plot). */
export function rowSearchFields(row: { label: string; preview?: string; path?: string[]; member?: boolean }, plotLabel?: string): SearchFields {
  const own = row.member ? (row.preview ? [row.preview] : []) : [row.label, ...(row.preview && row.preview !== "varies" ? [row.preview] : [])];
  return { own, context: [...(row.path ?? []), ...(plotLabel ? [plotLabel] : [])] };
}

/** Every token must occur at a word start somewhere in the row's text, and at
 *  least one of them in the row's OWN text (so "legend" finds the Legend, not
 *  every entry beneath it; "x tick" finds the x axis's tick rows). */
export function matchesQuery(fields: SearchFields, tokens: string[]): boolean {
  if (!tokens.length) return true;
  const own = fields.own.map((s) => s.toLowerCase());
  const ctx = fields.context.map((s) => s.toLowerCase());
  let ownHit = false;
  for (const t of tokens) {
    const inOwn = own.some((s) => wordStart(s, t) >= 0);
    if (inOwn) { ownHit = true; continue; }
    if (!ctx.some((s) => wordStart(s, t) >= 0)) return false;
  }
  return ownHit;
}

/** Highlight ranges ([start, end)) of the tokens in one text, merged. */
export function highlightRanges(text: string, tokens: string[]): [number, number][] {
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const t of tokens) {
    for (let i = wordStart(lower, t); i >= 0; i = wordStart(lower, t, i + t.length)) ranges.push([i, i + t.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Text split into plain / marked segments for rendering. */
export function highlightSegments(text: string, tokens: string[]): { text: string; hit: boolean }[] {
  const ranges = highlightRanges(text, tokens);
  if (!ranges.length) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [s, e] of ranges) {
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

// --- family (one level up) ----------------------------------------------------------
/** A part's FAMILY — the node one level up that a scientist means by "all of
 *  these": a group member → its group (one tick label → the tick labels); a
 *  tree node → its parent, scaffolding skipped (the axis title → its axis).
 *  Null at the top (the family of a top-level part is the plot itself). */
export function partFamily(manifest: FluxPlotManifest | undefined, partId: string): string | null {
  if (!manifest) return null;
  const index = manifestIndex(manifest);
  const id = aliasPartId(manifest, partId);
  const group = index.memberOf.get(id);
  if (group && !index.entries.has(id)) return group;
  let up = index.entries.get(id)?.parent ?? null;
  while (up) {
    const e = index.entries.get(up);
    if (!e) return null;
    if (!SCAFFOLD.has(e.role)) return up;
    up = e.parent;
  }
  return null;
}

/** Is a plot part DRAWN hidden — every leaf it covers hidden by the rendering rule? */
export function partDrawnHidden(manifest: FluxPlotManifest | undefined, overrides: Record<string, { hidden?: boolean | null } | undefined> | undefined, partId: string): boolean {
  const leaves = resolveTargets(manifest, partId);
  const hidden = hiddenLeaves(manifest, overrides);
  return leaves.length > 0 && leaves.every((l) => hidden.get(l));
}

/** After a toggle's writes, does the part's own flag still lose to a key written
 *  after it (an ancestor's)? Then the part's key must move to the end — the only
 *  case a toggle reorders keys, so other properties keep their precedence. */
export function hiddenNeedsReorder(manifest: FluxPlotManifest | undefined, overrides: Record<string, { hidden?: boolean | null } | undefined> | undefined, partId: string): boolean {
  const own = overrides?.[partId]?.hidden;
  if (own == null) return false;
  const drawn = hiddenLeaves(manifest, overrides);
  return resolveTargets(manifest, partId).some((l) => drawn.get(l) !== own);
}
