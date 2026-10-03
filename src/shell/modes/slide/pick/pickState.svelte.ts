// The Become picker — ONE temporary mode for Become, Appear from… and Animate
// like… (2026-10-02, owner: "once a person hits 'Become' they enter a UI
// interface that is really polished, nice, and intuitive").
//
//   pick  — the default sub-state. Canvas presses belong to the picker (no
//           element drags exist here): click toggles a unit, Alt+click picks
//           the whole object, a drag draws a fully-inside marquee, `a` widens
//           to siblings, double-click picks + confirms, `b`/Enter confirm.
//   add   — entered by a drawing tool, Ctrl+P (presets) or Alt+G (gallery):
//           the ordinary editor runs, and every element created meanwhile
//           joins the pick. Enter/Done returns to `pick`; Escape leaves first.
//
// Animate like… shares the accent, hover and Escape but stays single-click
// commit (one source effect). Commits go through the hooks SlideMode
// provides (`performBecome` / `performLike`), so the record written is exactly
// today's; the editor's selection is cleared while picking and restored on
// cancel. Pure rules live in `pickModel.ts`; DOM hit/rects in `stageHit.ts`.

import { get, fromStore } from "svelte/store";
import { untrack } from "svelte";
import { selection, partSelection, partSelections, setPartSelections, activeTool, xrayOpen, xrayRoot, project, importerOpen, hoverId, type PartSelection } from "../../../../lib/store";
import { presetPicker } from "../../../../lib/presets";
import { plotManifests } from "../../../../lib/plot/store";
import { scene3dManifests } from "../../../../lib/model3d/store";
import { pushToast } from "../../../../lib/toast";
import { xrayPickSink, type XrayPickUpdate } from "../../../../lib/xray/animateHook";
import { buildXrayTree, widenToSiblings, type XRow } from "../../../../lib/xray/buildXrayTree";
import { membersDeep } from "../../../../lib/groups";
import { buildPartTree } from "../../../../lib/plot/tree";
import { composeDestination as composeSetDestination } from "../../../../lib/slide/targets";
import type { Figure } from "../../../../lib/types";
import type { PairPolicy, TargetRef } from "../../../../lib/slide/types";
import {
  addUnits, composeDestination, isSourceUnit, removeUnits, sameUnit, targetsToUnits, toggleUnit, unitKey, unitsToRefs, widenParts,
  type PickUnit, type StageRect, type UnitContext,
} from "./pickModel";

export type PickSub = "pick" | "add";
export interface TargetPick {
  kind: "become" | "appearFrom";
  slideId: string;
  beatIndex: number;
  source: TargetRef;
  pair: PairPolicy;
  armedFrom: "become" | "appear-from";
  /** Ordered picks (the numbered badges). */
  units: PickUnit[];
  sub: PickSub;
}
export interface LikePick { kind: "animateLike"; slideId: string; trackIds: string[]; beatIndex: number }
export type PickMode = TargetPick | LikePick;

export interface PickHover {
  unit: PickUnit;
  /** The unit named as its lane names it (`refLabel`). */
  label: string;
  /** The unit's series (or other shared context) when its label lacks it. */
  context?: string;
  /** A plot part's data readout (x/y, a bar's height …), when it has one. */
  readout?: string;
  /** free = a click picks it; picked = a click removes it; source = the waiting
   *  object itself; effect / none = Animate like (has / lacks an effect here). */
  state: "free" | "picked" | "source" | "effect" | "none";
  detail?: string;
}

export interface PickMarquee { from: { x: number; y: number }; box: StageRect; remove: boolean; preview: PickUnit[] }

export interface PickerHooks {
  /** This pane is the visible, focused editor. */
  active(): boolean;
  /** The display figure (projected slide) the canvas paints. */
  fig(): Figure | null;
  refLabel(ref: TargetRef): string;
  commitTarget(pick: TargetPick, ref: TargetRef): void;
  /** Appear from… with several sources: they MERGE into the armed destination. */
  commitMerge(pick: TargetPick, sources: TargetRef[]): void;
  commitLike(pick: LikePick, elementId: string): void;
  /** Animate like: the effect an object has in the pick's step, or null. */
  likeEffect(pick: LikePick, elementId: string): string | null;
  /** The gallery is open for a data-only Become (From gallery…), not an insert. */
  morphImport(): boolean;
}

/** Tools that draw something new: choosing one while picking enters Add mode. */
export const DRAW_TOOLS: ReadonlySet<string> = new Set(["text", "rect", "ellipse", "line", "arrow", "pen"]);

/** Destination sets (`TargetRef.members`, slide/targets.ts) landed with the
 *  picker: several picks compose into ONE set destination. */
export const supportsSets = true;

export class BecomePicker {
  mode = $state.raw<PickMode | null>(null);
  hover = $state.raw<PickHover | null>(null);
  marquee = $state.raw<PickMarquee | null>(null);
  #restore: { ids: string[]; parts: PartSelection[] } | null = null;
  #addBaseline: Set<string> | null = null;
  #widenBase: PickUnit[] | null = null;
  #hinted = false;
  #xrayWasOpen = false;

  constructor(private hooks: PickerHooks) {}

  get target(): TargetPick | null { return this.mode && this.mode.kind !== "animateLike" ? this.mode : null; }
  get like(): LikePick | null { return this.mode?.kind === "animateLike" ? this.mode : null; }
  /** The picker owns canvas presses (pick sub-state, or Animate like). */
  get picking(): boolean { return !!this.like || this.target?.sub === "pick"; }
  get adding(): boolean { return this.target?.sub === "add"; }
  get units(): PickUnit[] { return this.target?.units ?? []; }

  unitContext(): UnitContext {
    const fig = this.hooks.fig();
    return { membersOf: (gid) => (fig ? membersDeep(fig, gid).map((e) => e.id) : []) };
  }

  // --- arming / leaving --------------------------------------------------------------------------
  armTarget(init: Omit<TargetPick, "units" | "sub" | "pair"> & { units?: PickUnit[]; pair?: PairPolicy }) {
    this.#restore = { ids: [...get(selection)], parts: [...get(partSelections)] };
    this.#reset();
    this.mode = { ...init, pair: init.pair ?? "auto", units: init.units ?? [], sub: "pick" };
    this.#clearSelection();
  }
  armLike(init: Omit<LikePick, "kind">) {
    this.#restore = null;
    this.#reset();
    this.mode = { kind: "animateLike", ...init };
    this.#clearSelection();
  }
  /** Leave without a commit; the source selection comes back (Escape / Cancel / step change). */
  cancel({ restore = true }: { restore?: boolean } = {}) {
    if (!this.mode) return;
    const back = restore ? this.#restore : null;
    this.mode = null;
    this.#reset();
    this.#restore = null;
    if (get(xrayOpen)) xrayOpen.set(false);
    if (get(activeTool) !== "select" && DRAW_TOOLS.has(get(activeTool))) activeTool.set("select");
    if (back) { selection.set(new Set(back.ids)); setPartSelections(back.parts); }
  }
  /** A commit landed: the caller owns the selection from here. */
  finish() { this.mode = null; this.#reset(); }
  /** A commit failed: back to picking with the same picks. */
  resume(pick: TargetPick) { this.mode = { ...pick, sub: "pick" }; this.#clearSelection(); }
  #reset() { this.hover = null; this.marquee = null; this.#addBaseline = null; this.#widenBase = null; this.#xrayWasOpen = false; }
  #clearSelection() { if (get(selection).size) selection.set(new Set()); if (get(partSelection)) partSelection.set(null); }

  // --- the pick set ------------------------------------------------------------------------------
  setPair(pair: PairPolicy) { const t = this.target; if (t) this.mode = { ...t, pair }; }
  setUnits(units: PickUnit[], { keepWiden = false } = {}) {
    const t = this.target;
    if (!t) return;
    if (!keepWiden) this.#widenBase = null;
    this.mode = { ...t, units };
  }
  /** Plain click: toggle the unit. */
  toggle(unit: PickUnit) {
    const t = this.target;
    if (!t) return;
    const r = toggleUnit(t.units, unit, t.source, this.unitContext());
    this.setUnits(r.units);
  }
  add(units: readonly PickUnit[]) { const t = this.target; if (t) this.setUnits(addUnits(t.units, units, t.source, this.unitContext())); }
  remove(units: readonly PickUnit[]) { const t = this.target; if (t) this.setUnits(removeUnits(t.units, units)); }
  clear() { this.setUnits([]); }
  /** Double-click: make sure the unit is picked, then confirm. */
  pickAndConfirm(unit: PickUnit) {
    const t = this.target;
    if (!t) return;
    if (!t.units.some((u) => sameUnit(u, unit))) this.add([unit]);
    this.confirm();
  }

  /** `a`: widen the last pick to its siblings — the X-ray's own rule
   *  (`widenToSiblings`). A plot part widens over the plot's part tree: first
   *  the other members of its group (the caps of one box plot), then the rule
   *  itself (the same part of every sibling series, then the parent's other
   *  children). A grouped object widens over its group, a loose one over the
   *  slide's loose objects of its kind. Repeated presses grow from the last
   *  widening. */
  widen(): boolean {
    const t = this.target, fig = this.hooks.fig();
    if (!t || !fig || !t.units.length) return false;
    const base = this.#widenBase?.length ? this.#widenBase : [t.units[t.units.length - 1]];
    const anchor = base[base.length - 1];
    let grown: PickUnit[] = [];
    if (anchor.part) {
      const el = fig.elements.find((e) => e.id === anchor.element);
      const manifest = el?.type === "plot" ? get(plotManifests)[el.assetId] : undefined;
      grown = widenParts(manifest, anchor.element, base.filter((u) => u.element === anchor.element && u.part).map((u) => u.part!));
    } else if (!anchor.group) {
      const el = fig.elements.find((e) => e.id === anchor.element);
      if (!el) return false;
      let tree: XRow | null;
      if (el.groupId) tree = buildXrayTree(get(project), { kind: "group", figId: fig.id, groupId: el.groupId }, get(plotManifests), get(scene3dManifests));
      else {
        // Loose objects: the slide's loose objects by kind, so the rule's first
        // step is "every loose ellipse", never "everything on the slide".
        const loose = fig.elements.filter((e) => !e.groupId);
        tree = { id: "slide", kind: "set", label: "Slide", role: "set", isGroup: true, children: [...new Set(loose.map((e) => e.type))].map((k) => ({
          id: `kind:${k}`, kind: "set", label: k, role: "set", isGroup: true,
          children: loose.filter((e) => e.type === k).map((e) => ({ id: `el:${e.id}`, kind: "element", label: e.id, role: e.type, elementId: e.id, isGroup: false, children: [] } as XRow)),
        } as XRow)) };
      }
      const rows = new Map<string, XRow>();
      const walk = (n: XRow) => { rows.set(n.id, n); n.children.forEach(walk); };
      if (tree) walk(tree);
      const picked = base.filter((u) => !u.part && !u.group).map((u) => rows.get(`el:${u.element}`)).filter((r): r is XRow => !!r);
      const next = widenToSiblings(tree, picked);
      grown = next ? [...next].map((id) => rows.get(id)).flatMap((r) => (r?.kind === "element" && r.elementId ? [{ element: r.elementId }] : [])) : [];
    }
    const ctx = this.unitContext();
    const added = grown.filter((u) => !t.units.some((o) => sameUnit(o, u)) && !isSourceUnit(u, t.source, ctx));
    if (!added.length) { pushToast("info", "Nothing more to widen to", { detail: "Every sibling of that pick is already picked." }); return false; }
    this.setUnits(addUnits(t.units, added, t.source, ctx), { keepWiden: true });
    this.#widenBase = grown;
    return true;
  }

  // --- confirm -----------------------------------------------------------------------------------
  confirm() {
    const t = this.target;
    if (!t) return;
    if (!t.units.length) {
      if (!this.#hinted) { this.#hinted = true; pushToast("info", t.kind === "appearFrom" ? "Pick what it appears from first" : "Pick what it becomes first", { detail: "Click objects or plot parts, or drag a box around them; then press b." }); }
      return;
    }
    const refs = unitsToRefs(t.units);
    // Appear from… with several sources is a MERGE: one hand-off per source
    // into the armed destination (the picks are sources, not a set).
    if (refs.length > 1 && t.kind === "appearFrom") { this.hooks.commitMerge(t, refs); return; }
    let ref: TargetRef | null;
    try {
      // Several picks become ONE destination set (group picks expand to their
      // objects; a lone pick stays itself) — the shared slide/targets.ts rule.
      ref = refs.length > 1 ? composeSetDestination(refs, (gid) => [...(this.unitContext().membersOf?.(gid) ?? [])]) : composeDestination(refs);
    } catch (error) {
      pushToast("info", "Couldn't use that set", { detail: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (ref) this.hooks.commitTarget(t, ref);
  }
  likeEffectOf(elementId: string): string | null { const l = this.like; return l ? this.hooks.likeEffect(l, elementId) : null; }
  /** Animate like: one click commits. */
  pickLike(elementId: string) { const l = this.like; if (l) this.hooks.commitLike(l, elementId); }

  // --- Add mode ----------------------------------------------------------------------------------
  enterAdd() {
    const t = this.target, fig = this.hooks.fig();
    if (!t || t.sub === "add") return;
    this.hover = null; this.marquee = null;
    this.#addBaseline = new Set(fig?.elements.map((e) => e.id) ?? []);
    this.mode = { ...t, sub: "add" };
  }
  /** Done: back to picking with everything added still picked. */
  exitAdd() {
    const t = this.target;
    if (!t || t.sub !== "add") return;
    this.#absorbAdded();
    this.#addBaseline = null;
    this.mode = { ...(this.target ?? t), sub: "pick" };
    if (get(activeTool) !== "select") activeTool.set("select");
    this.#clearSelection();
  }
  #absorbAdded() {
    const t = this.target, fig = this.hooks.fig(), base = this.#addBaseline;
    if (!t || !fig || !base) return;
    const created = fig.elements.filter((e) => !base.has(e.id)).map((e) => ({ element: e.id }));
    for (const u of created) base.add(u.element);
    if (created.length) this.setUnits(addUnits(t.units, created, t.source, this.unitContext()));
  }

  // --- X-ray parity ------------------------------------------------------------------------------
  /** Rows picked in the X-ray replace the picks of the objects its tree covers. */
  onXrayUpdate(update: XrayPickUpdate) {
    const t = this.target;
    if (!t) return;
    // Only what the X-ray can show is the X-ray's to replace: its seeded rows
    // and its own earlier picks. A point picked on the canvas that has no row
    // of its own (a series member) stays picked.
    const covered = new Set(update.rootElementIds);
    const owned = this.#xrayOwned;
    const kept = t.units.filter((u) => u.group || !covered.has(u.element) || !owned.has(unitKey(u)));
    const next = targetsToUnits(update.targets);
    this.#xrayOwned = new Set([...owned, ...next.map(unitKey)]);
    this.setUnits(addUnits(kept, next, t.source, this.unitContext()));
  }
  #xrayOwned = new Set<string>();
  /** Alt+R: open the X-ray on a plot, its current picks pre-selected as rows. */
  openXray(plotId: string) {
    const t = this.target, fig = this.hooks.fig();
    if (!t || !fig) return;
    const el = fig.elements.find((e) => e.id === plotId);
    const tree = el?.type === "plot" ? buildPartTree(get(plotManifests)[el.assetId]) : null;
    const rowIds = new Set<string>();
    const walk = (n: NonNullable<typeof tree>) => { rowIds.add(n.id); n.children.forEach(walk); };
    if (tree) walk(tree);
    const seeded = t.units.filter((u) => u.element === plotId && u.part && rowIds.has(u.part));
    this.#xrayOwned = new Set(seeded.map(unitKey));
    selection.set(new Set([plotId]));
    setPartSelections(seeded.map((u) => ({ elementId: plotId, partId: u.part! })));
    xrayRoot.set({ kind: "element", figId: fig.id, elementId: plotId });
    xrayOpen.set(true);
  }

  // --- keyboard ----------------------------------------------------------------------------------
  /** The picker's keys (capture phase, after SlideMode's modal/typing guards).
   *  Returns true when the key was consumed. */
  onKey(e: KeyboardEvent): boolean {
    const mode = this.mode;
    if (!mode) return false;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    const inXray = get(xrayOpen);
    if (e.key === "Escape") {
      if (this.marquee) { this.marquee = null; return true; }
      // The gallery and the preset library close themselves first.
      if (get(importerOpen) || get(presetPicker)) return false;
      if (inXray) { xrayOpen.set(false); return true; } // closing the X-ray keeps the picks
      if (this.target?.sub === "add") {
        if (get(activeTool) !== "select") return false; // the tool's own Escape first
        this.exitAdd();
        return true;
      }
      this.cancel();
      return true;
    }
    if (this.like) return false;
    const t = this.target!;
    if (inXray || get(importerOpen) || get(presetPicker)) return false; // the X-ray owns b / Enter / a
    if (e.key === "Enter" && plain && !e.shiftKey) {
      if (t.sub === "add") this.exitAdd(); else this.confirm();
      return true;
    }
    if (e.code === "KeyB" && plain && !e.shiftKey) {
      if (t.sub === "add") this.exitAdd();
      this.confirm();
      return true;
    }
    if (t.sub !== "pick") return false;
    if (e.code === "KeyA" && plain && !e.shiftKey) { this.widen(); return true; }
    if ((e.key === "Backspace" || e.key === "Delete") && plain) {
      if (t.units.length) this.setUnits(t.units.slice(0, -1));
      return true;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyR") {
      const fig = this.hooks.fig();
      // The hovered plot, else the last picked one, else the source (the old selection fallback).
      const ids = [this.hover?.unit.element, get(hoverId), ...[...t.units].reverse().map((u) => u.element), t.source.element];
      const plot = ids.map((id) => fig?.elements.find((el) => el.id === id && el.type === "plot")).find(Boolean);
      if (plot) this.openXray(plot.id);
      else pushToast("info", "Hover a plot, then press Alt+R to pick its parts.");
      return true;
    }
    return false;
  }

  // --- live wiring (call once, during component init) --------------------------------------------
  install() {
    const tool = fromStore(activeTool), presets = fromStore(presetPicker), gallery = fromStore(importerOpen);
    const sel = fromStore(selection), parts = fromStore(partSelections), xray = fromStore(xrayOpen), proj = fromStore(project);
    // Add mode is entered by any route that creates something.
    $effect(() => {
      const t = this.target;
      if (!t || t.sub !== "pick") return;
      if (DRAW_TOOLS.has(tool.current) || presets.current?.mode === "insert" || (gallery.current && !untrack(() => this.hooks.morphImport()))) untrack(() => this.enterAdd());
    });
    // Everything created while adding joins the pick; deleted picks leave it.
    $effect(() => {
      void proj.current;
      const t = this.target;
      if (!t) return;
      untrack(() => {
        if (t.sub === "add") this.#absorbAdded();
        const fig = this.hooks.fig();
        if (!fig) return;
        const ids = new Set(fig.elements.map((e) => e.id));
        if (!ids.has(t.source.element)) { this.cancel({ restore: false }); return; }
        const cur = this.target!;
        const alive = cur.units.filter((u) => ids.has(u.element));
        if (alive.length !== cur.units.length) this.setUnits(alive);
      });
    });
    // Other selection routes (a Layers row, Ctrl+A) add to the pick; the
    // canvas never selects while picking. The X-ray's own row selection is
    // mirrored through the sink instead, and discarded when it closes.
    $effect(() => {
      const t = this.target, ids = sel.current, ps = parts.current, inXray = xray.current;
      if (!t || t.sub !== "pick") return;
      untrack(() => {
        if (inXray) { this.#xrayWasOpen = true; return; }
        if (this.#xrayWasOpen) { this.#xrayWasOpen = false; this.#clearSelection(); return; }
        if (!ids.size && !ps.length) return;
        const fig = this.hooks.fig();
        const units: PickUnit[] = [...ids].flatMap((id) => {
          const mine = ps.filter((p) => p.elementId === id);
          return mine.length ? mine.map((p) => ({ element: id, part: p.partId })) : [{ element: id }];
        }).filter((u) => fig?.elements.some((e) => e.id === u.element));
        this.add(units);
        this.#clearSelection();
      });
    });
    $effect(() => {
      const on = !!this.target && this.hooks.active();
      xrayPickSink.set(on ? (u) => this.onXrayUpdate(u) : null);
      return () => xrayPickSink.set(null);
    });
  }
}

/** Badge numbers are shown up to this many picks (dense marker sets stay calm). */
export const BADGE_LIMIT = 20;
export { unitKey };
