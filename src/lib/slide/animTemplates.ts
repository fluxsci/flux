// ---------------------------------------------------------------------------
// Flux Slide — animation PRESETS + TEMPLATES (animation rework §7): the pure
// payload shapes and the template MATCHING engine. A preset is one track's
// reusable settings; a template is an ordered bundle of preset slots with
// matchers that auto-map onto any object set with the same shape ("apply my
// x-axis build to this y-axis"; "apply my 2-rect-2-ellipse treatment to that
// group"). PURE by contract — the GUI applies through commitDeckLive and
// flux-core's apply_anim_template runs THIS engine, so the two can't drift.
// ---------------------------------------------------------------------------

import type { Element, Id } from "../types";
import type { Track } from "./types";
import type { FluxPlotManifest } from "../plot/types";
import { buildPartTree, type XrayNode } from "../plot/tree";
import { familyOf } from "./family";
import { newId } from "../ids";

// --- payload shapes -----------------------------------------------------------

/** The reusable half of a track — everything EXCEPT its binding (target/part/
 *  selector) and a transform's captured state (a preset carries HOW, never
 *  WHAT). */
export type PresetTrack = Pick<
  Track,
  "preset" | "params" | "start" | "duration" | "easing" | "influence" | "stagger"
>;

export interface AnimPreset {
  fluxPreset: 1;
  kind: "anim";
  name: string;
  savedAt?: string;
  family: "appearance" | "transform";
  track: PresetTrack;
}

export type SlotMatch =
  | { kind: "part"; role: string }
  | { kind: "element"; type: string; nth: number };

export interface AnimTemplateSlot {
  match: SlotMatch;
  track: PresetTrack;
}

export interface AnimTemplate {
  fluxPreset: 1;
  kind: "animTemplate";
  name: string;
  savedAt?: string;
  slots: AnimTemplateSlot[];
}

/** Validate an unknown payload as a preset/template (files are user-editable
 *  on disk — never trust them). Returns null when malformed. */
export function parseAnimPreset(v: unknown): AnimPreset | null {
  const p = v as AnimPreset;
  if (!p || p.fluxPreset !== 1 || p.kind !== "anim" || typeof p.name !== "string") return null;
  if (p.family !== "appearance" && p.family !== "transform") return null;
  if (!p.track || typeof p.track !== "object") return null;
  return p;
}
export function parseAnimTemplate(v: unknown): AnimTemplate | null {
  const t = v as AnimTemplate;
  if (!t || t.fluxPreset !== 1 || t.kind !== "animTemplate" || typeof t.name !== "string") return null;
  if (!Array.isArray(t.slots) || !t.slots.length) return null;
  for (const s of t.slots) {
    if (!s?.match || !s.track || typeof s.track !== "object") return null;
    if (s.match.kind === "part") {
      if (typeof s.match.role !== "string" || !s.match.role) return null;
    } else if (s.match.kind === "element") {
      if (typeof s.match.type !== "string" || typeof s.match.nth !== "number") return null;
    } else return null;
  }
  return t;
}

/** Strip a live track down to its reusable settings (the preset payload). */
export function presetTrackOf(t: Track): PresetTrack {
  const out: PresetTrack = {};
  if (t.preset != null) out.preset = t.preset;
  if (t.params != null) out.params = structuredClone(t.params);
  if (t.start != null) out.start = t.start;
  if (t.duration != null) out.duration = t.duration;
  if (t.easing != null) out.easing = t.easing;
  if (t.influence != null) out.influence = structuredClone(t.influence);
  if (t.stagger != null) out.stagger = structuredClone(t.stagger);
  return out;
}

export function makeAnimPreset(name: string, t: Track): AnimPreset {
  return {
    fluxPreset: 1,
    kind: "anim",
    name,
    savedAt: new Date().toISOString(),
    family: familyOf(t) === "transform" ? "transform" : "appearance",
    track: presetTrackOf(t),
  };
}

// --- slot derivation (save a template from selected tracks) -------------------

function findNode(root: XrayNode | null, id: string): XrayNode | null {
  if (!root) return null;
  if (root.id === id) return root;
  for (const c of root.children) {
    const f = findNode(c, id);
    if (f) return f;
  }
  return null;
}

export interface TemplateCtx {
  elements: readonly Element[];
  /** elementId → its plot manifest (part-role resolution). */
  manifestFor: (elementId: Id) => FluxPlotManifest | undefined;
}

/** Derive template slots from a set of tracks: part tracks record their
 *  part's ROLE (axis-agnostic — an x-axis-derived template stores "spine",
 *  never "axis.x.spine"); whole-element tracks record {type, nth} with nth =
 *  the element's rank AMONG SAME-TYPE members of the saved set, in the set's
 *  document order. Camera and unresolvable tracks are skipped (reported). */
export function deriveTemplateSlots(
  tracks: readonly Track[],
  ctx: TemplateCtx,
): { slots: AnimTemplateSlot[]; skipped: string[] } {
  const slots: AnimTemplateSlot[] = [];
  const skipped: string[] = [];
  // document order of the saved element set, per type
  const order = new Map<Id, number>();
  ctx.elements.forEach((e, i) => order.set(e.id, i));
  const elementTracks = tracks.filter((t) => !t.part && !t.target.startsWith("@"));
  const perType = new Map<string, Id[]>();
  for (const t of [...elementTracks].sort((a, b) => (order.get(a.target) ?? 0) - (order.get(b.target) ?? 0))) {
    const el = ctx.elements.find((e) => e.id === t.target);
    if (!el) continue;
    const list = perType.get(el.type) ?? [];
    if (!list.includes(el.id)) list.push(el.id);
    perType.set(el.type, list);
  }
  for (const t of tracks) {
    if (t.target.startsWith("@")) {
      skipped.push(`${t.target} (camera/stage tracks don't template)`);
      continue;
    }
    const el = ctx.elements.find((e) => e.id === t.target);
    if (!el) {
      skipped.push(`${t.target} (missing element)`);
      continue;
    }
    if (t.part) {
      const tree = buildPartTree(ctx.manifestFor(el.id));
      const node = findNode(tree, t.part);
      if (!node?.role) {
        skipped.push(`${t.part} (no role in the part tree)`);
        continue;
      }
      slots.push({ match: { kind: "part", role: node.role }, track: presetTrackOf(t) });
    } else {
      const nth = (perType.get(el.type) ?? []).indexOf(el.id);
      slots.push({ match: { kind: "element", type: el.type, nth: Math.max(0, nth) }, track: presetTrackOf(t) });
    }
  }
  return { slots, skipped };
}

// --- template application ------------------------------------------------------

export type TemplateScope =
  | { kind: "part-container"; elementId: Id; partId: string }
  | { kind: "elements"; ids: Id[] };

export interface TemplateApplyResult {
  /** Fully-bound tracks (fresh ids) ready for the active beat. */
  tracks: Track[];
  matched: number;
  total: number;
  /** Human strings for the partial-application toast. */
  unmatched: string[];
}

/** Resolve a template against a scope. Part slots resolve WITHIN the scope's
 *  part subtree by role (first unclaimed node of that role, tree order —
 *  axis-agnostic, so an x-axis template lands on a y-axis container); element
 *  slots bucket scope elements by type in document order and bind by nth.
 *  Partial application is allowed and REPORTED (predictable > clever). */
export function applyTemplate(
  template: AnimTemplate,
  scope: TemplateScope,
  ctx: TemplateCtx,
): TemplateApplyResult {
  const out: Track[] = [];
  const unmatched: string[] = [];
  if (scope.kind === "part-container") {
    const el = ctx.elements.find((e) => e.id === scope.elementId);
    const tree = el ? buildPartTree(ctx.manifestFor(el.id)) : null;
    const container = scope.partId ? findNode(tree, scope.partId) : tree;
    if (!el || !container) {
      return { tracks: [], matched: 0, total: template.slots.length, unmatched: template.slots.map((s) => describeSlot(s)) };
    }
    // nodes by role within the subtree, tree order (containers before leaves)
    const byRole = new Map<string, XrayNode[]>();
    const walk = (n: XrayNode) => {
      const list = byRole.get(n.role) ?? [];
      list.push(n);
      byRole.set(n.role, list);
      n.children.forEach(walk);
    };
    walk(container);
    const claimed = new Set<string>();
    for (const slot of template.slots) {
      if (slot.match.kind !== "part") {
        unmatched.push(`${describeSlot(slot)} (an element slot can't bind inside a plot part)`);
        continue;
      }
      const role = slot.match.role;
      const node = (byRole.get(role) ?? []).find((n) => !claimed.has(n.id));
      if (!node) {
        unmatched.push(`no ${role} in scope`);
        continue;
      }
      claimed.add(node.id);
      out.push({ id: newId("track"), target: el.id, part: node.id, ...structuredClone(slot.track) });
    }
  } else {
    const els = scope.ids
      .map((id) => ctx.elements.find((e) => e.id === id))
      .filter((e): e is Element => !!e);
    const perType = new Map<string, Element[]>();
    for (const e of els) {
      const list = perType.get(e.type) ?? [];
      list.push(e);
      perType.set(e.type, list);
    }
    const claimed = new Set<Id>();
    for (const slot of template.slots) {
      if (slot.match.kind === "part") {
        // a part slot against an element scope: bind within the FIRST plot in
        // scope that has that role unclaimed (covers "apply the axis template
        // to this plot element")
        let bound = false;
        for (const e of els) {
          if (e.type !== "plot") continue;
          const tree = buildPartTree(ctx.manifestFor(e.id));
          if (!tree) continue;
          const byRole: XrayNode[] = [];
          const walk = (n: XrayNode) => {
            if (n.role === (slot.match as { role: string }).role) byRole.push(n);
            n.children.forEach(walk);
          };
          walk(tree);
          const node = byRole.find((n) => !claimed.has(`${e.id}|${n.id}` as Id));
          if (node) {
            claimed.add(`${e.id}|${node.id}` as Id);
            out.push({ id: newId("track"), target: e.id, part: node.id, ...structuredClone(slot.track) });
            bound = true;
            break;
          }
        }
        if (!bound) unmatched.push(`no ${slot.match.role} in scope`);
        continue;
      }
      const pool = perType.get(slot.match.type) ?? [];
      const el = pool[slot.match.nth];
      if (!el || claimed.has(el.id)) {
        unmatched.push(`no ${slot.match.type} #${slot.match.nth + 1} in scope`);
        continue;
      }
      claimed.add(el.id);
      out.push({ id: newId("track"), target: el.id, ...structuredClone(slot.track) });
    }
  }
  return { tracks: out, matched: out.length, total: template.slots.length, unmatched };
}

function describeSlot(s: AnimTemplateSlot): string {
  return s.match.kind === "part" ? `part:${s.match.role}` : `${s.match.type} #${s.match.nth + 1}`;
}
