<script lang="ts">
  // SlideStage — the WYSIWYG editor stage. Mounts the ONE renderer (player/render)
  // into a fixed StageSize scaled to fit, then overlays selection + drag/resize/
  // marquee/snap affordances. Reuses the figure canvas's pure interaction math
  // (geometry.selectionBBox/elementBBox/rectsIntersect, editing.resizeRemap) and
  // mirrors its un-exported handle/snap blocks, adapted to the slide's single
  // fit-scale (no pan, no per-figure offset — the slide IS the frame).
  //
  // Gesture pattern (from the figure canvas): capture originals at pointer-down,
  // preview live by mutating the rendered wrappers' geometry, and write the model
  // ONCE on pointer-up via a single commitDeck (no per-frame deck clone).
  import { renderSlide } from "../../../lib/slide/player/render";
  import { computeSlideAnims, applyStatic, baseCameraTransform } from "../../../lib/slide/player/player";
  import { plotGen, plotManifests } from "../../../lib/plot/store";
  import { get } from "svelte/store";
  import { selectionBBox, elementBBox, rectsIntersect } from "../../../lib/geometry";
  // WS-3.2: shared interaction core (Canvas + SlideStage) — math only. The
  // geometry/editing helpers are generic over ElementBase now, so SlideElement
  // flows through with NO casts.
  import { HANDLES, handlePos, cursorFor, type Handle } from "../../../lib/interact/handles";
  import { computeResizeBox } from "../../../lib/interact/gestureMath";
  import { snap, boxSnapTargets } from "../../../lib/interact/snap";
  import { resizeRemap } from "../../../lib/editing";
  import { commitDeck, selection, focusedPart, sealHistory, getClipboard, getClipboardTracks, setClipboard, figureMembers } from "../../../lib/slide/store";
  import { buildPartTree, type XrayNode } from "../../../lib/plot/tree";
  import {
    setElementBox, deleteElements, findElement, setTextBoxText, setMathTex,
    duplicateElements, pasteElements, groupElements, ungroupElements,
    bringToFront, sendToBack, raiseElements, lowerElements,
  } from "../../../lib/slide/ops";
  import { stageView, resetStageView, ZOOM_MIN, ZOOM_MAX } from "./stageView";
  import { slideXrayOpen } from "./animator/animatorState";
  import type { Slide, SlideElement, DeckTheme, StageSize } from "../../../lib/slide/types";

  let {
    slide,
    theme,
    stage,
    interactive = true,
    focused = true,
    beat = 0,
    assetUrl,
    figureSvg,
  }: {
    slide: Slide;
    theme: DeckTheme;
    stage: StageSize;
    interactive?: boolean;
    focused?: boolean;
    /** Freeze the stage at this beat's static (build) state for preview. */
    beat?: number;
    assetUrl?: (id: string) => string | undefined;
    figureSvg?: (id: string, groupId?: string) => string | undefined;
  } = $props();

  type Rect = { x: number; y: number; w: number; h: number };

  let viewport = $state<HTMLElement>();
  let scaledEl = $state<HTMLElement>();
  let stageEl = $state<HTMLElement>();
  let fitW = $state(0);
  let fitH = $state(0);
  // fit-to-viewport scale (what thumbnails always use); the live editor multiplies
  // it by the user's zoom. Everything downstream (the .stage transform, the overlay,
  // toAuthoring, hit tolerances) is expressed in terms of `scale`, so making it the
  // EFFECTIVE scale is all it takes to zoom the whole interactive surface coherently.
  const fitScale = $derived(fitW > 0 && fitH > 0 ? Math.min(fitW / stage.width, fitH / stage.height) : 0);
  const scale = $derived(interactive ? fitScale * $stageView.zoom : fitScale);
  const panX = $derived(interactive ? $stageView.panX : 0);
  const panY = $derived(interactive ? $stageView.panY : 0);

  // --- user zoom + pan (C2) ----------------------------------------------------
  let panGesture = $state<{ sx: number; sy: number; px: number; py: number } | null>(null);
  function clampPan(px: number, scaleP: number, axis: "x" | "y"): number {
    const span = (axis === "x" ? stage.width : stage.height) * scaleP;
    const fit = axis === "x" ? fitW : fitH;
    const over = Math.max(0, (span - fit) / 2);
    const lim = over + Math.min(fit, span) * 0.35; // a little slack past the edge
    return Math.max(-lim, Math.min(lim, px));
  }
  /** Set zoom, keeping the model point under (anchorX, anchorY) fixed on screen.
   *  Anchor defaults to the viewport centre (for keyboard / button zoom). */
  function applyZoom(nextZoom: number, anchorX?: number, anchorY?: number) {
    if (!interactive) return;
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nextZoom));
    // Soft magnetism: settle to exact centered fit when ARRIVING near 1 from
    // elsewhere — but never trap a zoom-out that starts at fit (zoom < 1 is a
    // real state now; ZOOM_MIN is reachable).
    const cur = get(stageView).zoom;
    if (cur !== 1 && Math.abs(z - 1) < 0.03) { resetStageView(); return; }
    if (!viewport || !scaledEl || fitScale <= 0) { stageView.update((v) => ({ ...v, zoom: z })); return; }
    const fr = viewport.getBoundingClientRect();
    const ax = anchorX ?? fr.left + fr.width / 2;
    const ay = anchorY ?? fr.top + fr.height / 2;
    const sr = scaledEl.getBoundingClientRect();
    const mx = (ax - sr.left) / scale; // model point under the anchor at the CURRENT scale
    const my = (ay - sr.top) / scale;
    const sp = fitScale * z;
    const cl0 = fr.left + fr.width / 2 - (stage.width * sp) / 2; // centered .scaled left at the new scale
    const ct0 = fr.top + fr.height / 2 - (stage.height * sp) / 2;
    stageView.set({ zoom: z, panX: clampPan(ax - mx * sp - cl0, sp, "x"), panY: clampPan(ay - my * sp - ct0, sp, "y") });
  }
  function onWheel(e: WheelEvent) {
    if (!interactive) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault(); // pinch-zoom / ctrl+wheel → zoom toward the cursor
      applyZoom(get(stageView).zoom * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    } else {
      const v = get(stageView);
      if (v.zoom <= 1) return; // at fit there's nothing to pan
      e.preventDefault();
      stageView.set({ zoom: v.zoom, panX: clampPan(v.panX - e.deltaX, scale, "x"), panY: clampPan(v.panY - e.deltaY, scale, "y") });
    }
  }

  // Pan resets when the slide changes (a new frame); zoom persists across slides.
  $effect(() => {
    void slide.id;
    if (interactive) stageView.update((v) => (v.panX || v.panY ? { ...v, panX: 0, panY: 0 } : v));
  });

  // Rendered wrappers (elId → div), refreshed each render so previews can mutate them.
  let wrappers = new Map<string, HTMLElement>();

  // Re-render the slide whenever its content/theme/plot-regen/beat changes, then
  // freeze it at the selected beat's static (build) state so the scrubber previews
  // builds. Editing happens against model coordinates regardless of preview styles.
  $effect(() => {
    const gen = $plotGen; // subscribe so plot hot-swaps re-render
    if (!stageEl) return;
    const opts = { theme, assetUrl, figureSvg, plotGen: gen, mode: "edit" as const, plotManifest: (id: string) => get(plotManifests)[id], figureMember: (fid: string, mid: string) => get(figureMembers)[fid]?.[mid] };
    // Render into a dedicated camera layer inside the (fit-scaled) .stage so an
    // @camera move's transform zooms the content WITHOUT clobbering the stage's
    // own scale. The layer is at inset:0, so element model coords are unchanged —
    // selection/hit-testing (which use model geometry) keep working.
    let cam = stageEl.querySelector(":scope > .sl-camera") as HTMLElement | null;
    if (!cam) {
      cam = document.createElement("div");
      cam.className = "sl-camera";
      cam.style.cssText = "position:absolute;inset:0;transform-origin:0 0;";
      stageEl.appendChild(cam);
    }
    // SLD-11: seed the resting camera to the slide's base pose (matches the player's buildSlide),
    // so an agent-authored zoomed slide looks the same while editing; applyStatic then re-applies
    // any per-beat @camera move on top.
    cam.style.transform = baseCameraTransform(slide, stage);
    const r = renderSlide(cam, slide, stage, opts);
    wrappers = r.elements;
    const specs = computeSlideAnims(slide, r, cam, stage, opts);
    applyStatic(specs, beat);
    // hide the element being inline-edited (the textarea overlay stands in for it)
    if (editingId) { const w = r.elements.get(editingId); if (w) w.style.visibility = "hidden"; }
  });

  // --- selection helpers (slide store is string[]; we work with a Set) ---------
  const els = $derived(slide.elements);
  function byId(id: string): SlideElement | undefined {
    return els.find((e) => e.id === id);
  }
  /** Expand a hit set to whole groups within this slide. */
  function expandGroups(ids: Set<string>): string[] {
    const groups = new Set<string>();
    for (const e of els) if (ids.has(e.id) && e.groupId) groups.add(e.groupId);
    const out = new Set(ids);
    if (groups.size) for (const e of els) if (e.groupId && groups.has(e.groupId)) out.add(e.id);
    return [...out];
  }
  const selectedEls = $derived(($selection.map(byId).filter(Boolean)) as SlideElement[]);
  const modelBox = $derived(selectionBBox(selectedEls));

  // The overlay box: a live preview during a gesture, else the model selection box.
  let previewBox = $state<Rect | null>(null);
  const overlayBox = $derived(previewBox ?? modelBox);

  // --- coordinate mapping (the one viewport adaptation) ------------------------
  function toAuthoring(cx: number, cy: number): { x: number; y: number } {
    const r = scaledEl!.getBoundingClientRect();
    return { x: (cx - r.left) / scale, y: (cy - r.top) / scale };
  }



  // --- gesture state -----------------------------------------------------------
  type Gesture =
    | { kind: "move"; ids: string[]; origs: Map<string, SlideElement>; ob: Rect; start: { x: number; y: number } }
    | { kind: "resize"; ids: string[]; origs: Map<string, SlideElement>; ob: Rect; handle: Handle }
    | { kind: "rotate"; id: string; cx: number; cy: number; startAngle: number; origRot: number }
    | { kind: "marquee"; x0: number; y0: number; add: Set<string> };
  let gesture: Gesture | null = null;
  let liveRot = 0; // committed rotation (deg) for the active rotate gesture
  // The committed delta/box for the active gesture, stashed during move so
  // pointer-up writes the model from numbers (not by parsing back DOM styles).
  let liveMove = { dx: 0, dy: 0 };
  let liveNb: Rect | null = null;
  let guideX = $state<number | null>(null);
  let guideY = $state<number | null>(null);
  let marquee = $state<Rect | null>(null);

  // --- inline text editing (dblclick → screen-space textarea overlay) ----------
  let editingId = $state<string | null>(null);
  let editText = $state("");
  let taEl = $state<HTMLTextAreaElement>();
  const editingEl = $derived(editingId ? byId(editingId) : undefined);
  // Box + font for the overlay textarea (screen px), or null if not editing.
  const editStyle = $derived.by(() => {
    const el = editingEl;
    if (!el || (el.type !== "textBox" && el.type !== "math")) return null;
    return {
      x: el.x, y: el.y, w: el.width, h: el.height,
      fs: el.fontSize ?? 32,
      weight: el.type === "textBox" ? (el.fontWeight ?? 400) : 400,
      align: el.type === "textBox" ? (el.align ?? "left") : "center",
      color: el.color ?? "var(--c-tx)",
    };
  });

  function cloneSel(ids: string[]): Map<string, SlideElement> {
    const m = new Map<string, SlideElement>();
    for (const id of ids) {
      const e = byId(id);
      if (e) m.set(id, structuredClone(e));
    }
    return m;
  }

  // Apply a transient {x,y,width,height} to a rendered wrapper (live preview).
  function previewEl(id: string, box: { x: number; y: number; width: number; height: number }) {
    const w = wrappers.get(id);
    if (!w) return;
    w.style.left = `${box.x}px`;
    w.style.top = `${box.y}px`;
    w.style.width = `${box.width}px`;
    w.style.height = `${box.height}px`;
  }

  function hitTest(p: { x: number; y: number }): SlideElement | null {
    const tol = 6 / scale; // grab tolerance — keeps thin/degenerate lines clickable
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.locked) continue;
      const b = elementBBox(e);
      if (p.x >= b.x - tol && p.x <= b.x + b.w + tol && p.y >= b.y - tol && p.y <= b.y + b.h + tol) return e;
    }
    return null;
  }

  /** The animatable parts-tree node (group/leaf) under a clicked DOM node inside a
   *  plot — direct manipulation: click a scatter point → focus "setosa.points",
   *  click the fit line → focus "fit.line". Falls back to the nearest container. */
  function partAtNode(target: EventTarget | null, plotElId: string): string | null {
    const el = els.find((x) => x.id === plotElId);
    const assetId = el && "assetId" in el ? (el as { assetId: string }).assetId : undefined;
    const tree = assetId ? buildPartTree(get(plotManifests)[assetId]) : null;
    if (!tree) return null;
    const animatable = new Set<string>();
    const containers = new Set<string>();
    const walk = (n: XrayNode) => { (n.children.length ? containers : animatable).add(n.id); n.children.forEach(walk); };
    walk(tree);
    const prefix = `${plotElId}__`;
    const chain: string[] = [];
    let node = target as Element | null;
    while (node) {
      const id = node.getAttribute?.("id");
      if (id && id.startsWith(prefix)) chain.push(id.slice(prefix.length));
      node = node.parentElement;
    }
    return chain.find((s) => animatable.has(s)) ?? chain.find((s) => containers.has(s)) ?? null;
  }

  function onStagePointerDown(e: PointerEvent) {
    // middle-button drag pans the zoomed canvas (no-op at fit)
    if (interactive && e.button === 1) {
      e.preventDefault();
      const v = get(stageView);
      if (v.zoom > 1) { panGesture = { sx: e.clientX, sy: e.clientY, px: v.panX, py: v.panY }; scaledEl!.setPointerCapture(e.pointerId); }
      return;
    }
    if (!interactive || e.button !== 0) return;
    const p = toAuthoring(e.clientX, e.clientY);
    const hit = hitTest(p);
    scaledEl!.setPointerCapture(e.pointerId);
    if (hit) {
      // Select (shift toggles; click on an unselected element replaces).
      let ids: string[];
      if (e.shiftKey) {
        const s = new Set($selection);
        s.has(hit.id) ? s.delete(hit.id) : s.add(hit.id);
        ids = expandGroups(s);
      } else {
        ids = $selection.includes(hit.id) ? $selection : expandGroups(new Set([hit.id]));
      }
      selection.set(ids);
      // direct manipulation: clicking inside a plot focuses the part under the cursor
      if (hit.type === "plot") {
        const part = partAtNode(e.target, hit.id);
        focusedPart.set(part ? { elId: hit.id, part } : null);
      } else focusedPart.set(null);
      const ob = selectionBBox(ids.map(byId).filter((e): e is SlideElement => !!e));
      if (ob) { gesture = { kind: "move", ids, origs: cloneSel(ids), ob, start: p }; liveMove = { dx: 0, dy: 0 }; }
    } else {
      // Empty: marquee select (clear unless shift-extending).
      if (!e.shiftKey) selection.set([]);
      focusedPart.set(null);
      gesture = { kind: "marquee", x0: p.x, y0: p.y, add: new Set(e.shiftKey ? $selection : []) };
    }
  }

  function onHandleDown(e: PointerEvent, handle: Handle) {
    if (!interactive) return;
    e.stopPropagation();
    const ids = $selection;
    const ob = selectionBBox(ids.map(byId).filter((e): e is SlideElement => !!e));
    if (!ob) return;
    scaledEl!.setPointerCapture(e.pointerId);
    gesture = { kind: "resize", ids, origs: cloneSel(ids), ob, handle };
    liveNb = null;
  }

  const DEG = 180 / Math.PI;
  function onRotateDown(e: PointerEvent) {
    if (!interactive) return;
    e.stopPropagation();
    const id = $selection[0];
    const el = id ? byId(id) : undefined;
    if (!el) return;
    const cx = el.x + el.width / 2;
    const cy = el.y + el.height / 2;
    const p = toAuthoring(e.clientX, e.clientY);
    scaledEl!.setPointerCapture(e.pointerId);
    liveRot = el.rotation ?? 0;
    gesture = { kind: "rotate", id, cx, cy, startAngle: Math.atan2(p.y - cy, p.x - cx) * DEG, origRot: el.rotation ?? 0 };
  }

  function onPointerMove(e: PointerEvent) {
    if (panGesture) {
      stageView.update((v) => ({
        ...v,
        panX: clampPan(panGesture!.px + (e.clientX - panGesture!.sx), scale, "x"),
        panY: clampPan(panGesture!.py + (e.clientY - panGesture!.sy), scale, "y"),
      }));
      return;
    }
    if (!gesture) return;
    const p = toAuthoring(e.clientX, e.clientY);
    if (gesture.kind === "move") {
      let dx = p.x - gesture.start.x;
      let dy = p.y - gesture.start.y;
      const { xs, ys } = boxSnapTargets(els, new Set(gesture.ids), { w: stage.width, h: stage.height });
      const b = gesture.ob;
      const sX = snap([b.x + dx, b.x + b.w / 2 + dx, b.x + b.w + dx], xs, 6 / scale);
      const sY = snap([b.y + dy, b.y + b.h / 2 + dy, b.y + b.h + dy], ys, 6 / scale);
      if (sX.line != null) { dx += sX.off; guideX = sX.line; } else guideX = null;
      if (sY.line != null) { dy += sY.off; guideY = sY.line; } else guideY = null;
      liveMove = { dx, dy };
      for (const id of gesture.ids) {
        const o = gesture.origs.get(id)!;
        previewEl(id, { x: o.x + dx, y: o.y + dy, width: o.width, height: o.height });
      }
      previewBox = { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
    } else if (gesture.kind === "resize") {
      const nb = computeResizeBox(gesture.ob, gesture.handle, p, e.shiftKey);
      liveNb = nb;
      for (const id of gesture.ids) {
        const o = gesture.origs.get(id)!;
        const tmp = structuredClone(o);
        resizeRemap(tmp, o, gesture.ob, nb);
        previewEl(id, { x: tmp.x, y: tmp.y, width: tmp.width, height: tmp.height });
      }
      previewBox = nb;
    } else if (gesture.kind === "rotate") {
      const ang = Math.atan2(p.y - gesture.cy, p.x - gesture.cx) * DEG;
      let rot = gesture.origRot + (ang - gesture.startAngle);
      // Shift OR a near-hit snaps to 15° increments (Figma-style), so clean angles
      // land exactly. Otherwise round to whole degrees.
      const snapped = Math.round(rot / 15) * 15;
      if (e.shiftKey || Math.abs(rot - snapped) < 4) rot = snapped;
      else rot = Math.round(rot);
      liveRot = rot;
      const w = wrappers.get(gesture.id);
      if (w) w.style.transform = `rotate(${rot}deg)`;
    } else if (gesture.kind === "marquee") {
      const r: Rect = {
        x: Math.min(gesture.x0, p.x), y: Math.min(gesture.y0, p.y),
        w: Math.abs(p.x - gesture.x0), h: Math.abs(p.y - gesture.y0),
      };
      marquee = r;
      const hit = new Set(gesture.add);
      for (const el of els) if (rectsIntersect(elementBBox(el), r)) hit.add(el.id);
      selection.set(expandGroups(hit));
    }
  }

  function onPointerUp() {
    if (panGesture) { panGesture = null; return; }
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    guideX = guideY = null;
    marquee = null;
    previewBox = null;
    if (g.kind === "move") {
      const { dx, dy } = liveMove;
      if (dx === 0 && dy === 0) return; // a click, not a drag
      commitDeck((d) => {
        for (const id of g.ids) {
          const o = g.origs.get(id)!;
          setElementBox(d, id, { x: o.x + dx, y: o.y + dy });
        }
      });
    } else if (g.kind === "resize" && liveNb) {
      const nb = liveNb;
      const ob = g.ob;
      commitDeck((d) => {
        for (const id of g.ids) {
          const orig = g.origs.get(id);
          const found = findElement(d, id); // → { slide, el } | null
          // resizeRemap handles every type correctly: scales boxes, remaps line
          // endpoints, and scales text font-size (mirrors the figure canvas).
          if (orig && found) resizeRemap(found.el, orig, ob, nb);
        }
      });
    } else if (g.kind === "rotate") {
      if (liveRot === g.origRot) return; // no actual turn
      const rot = liveRot;
      commitDeck((d) => setElementBox(d, g.id, { rotation: rot }));
    }
  }

  // --- inline editing (mirror Canvas.svelte's textarea-overlay pattern) --------
  function startEdit(el: SlideElement) {
    if (el.type !== "textBox" && el.type !== "math") return;
    gesture = null; previewBox = null;
    selection.set([el.id]);
    editingId = el.id;
    editText = el.type === "textBox" ? el.blocks.map((b) => b.text).join("\n") : el.tex;
    requestAnimationFrame(() => { taEl?.focus(); taEl?.select(); });
  }
  function onEditInput() {
    const id = editingId;
    if (!id) return;
    const t = editingEl?.type;
    // Coalesce the typing burst into ONE undo step (per element), so Cmd+Z after
    // editing reverts the whole edit, not one character at a time.
    commitDeck((d) => {
      if (t === "textBox") setTextBoxText(d, id, editText);
      else if (t === "math") setMathTex(d, id, editText);
    }, { coalesce: `edit:${id}` });
  }
  function finishEdit() {
    editingId = null;
    sealHistory(); // end the coalesced typing run — the next edit is a fresh undo step
  }
  function onEditKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); finishEdit(); }
    else if (e.key === "Enter" && editingEl?.type === "math") { e.preventDefault(); finishEdit(); }
  }
  function onStageDblClick(e: MouseEvent) {
    if (!interactive) return;
    const hit = hitTest(toAuthoring(e.clientX, e.clientY));
    if (hit) startEdit(hit);
  }

  // --- keyboard: delete + nudge (only when this stage has a selection) ---------
  function onKey(e: KeyboardEvent) {
    if (!interactive || !focused) return;
    if (get(slideXrayOpen)) return; // the Plot X-ray owns arrows/Esc while it's open
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
    // zoom keys work regardless of selection
    if (e.key === "+" || e.key === "=") { e.preventDefault(); applyZoom(get(stageView).zoom * 1.2); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); applyZoom(get(stageView).zoom / 1.2); return; }
    if (e.key === "0") { e.preventDefault(); resetStageView(); return; }

    // element ops (⌘/Ctrl): select-all + paste work with no selection; the rest
    // act on the current selection. Copy stashes clones; the deck-edit ops commit
    // (so they undo). Shift promotes ]/[ to front/back and G to ungroup.
    const mod = e.metaKey || e.ctrlKey;
    const sid = slide?.id;
    const els = slide?.elements ?? [];
    if (mod && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      selection.set(els.map((el) => el.id));
      return;
    }
    if (mod && (e.key === "v" || e.key === "V")) {
      e.preventDefault();
      const clip = getClipboard();
      const clipTracks = getClipboardTracks(); // SLD-10: carry the copied elements' animations
      if (sid && clip.length) {
        let ids: string[] = [];
        commitDeck((d) => { ids = pasteElements(d, sid, clip, 24, 24, clipTracks); });
        selection.set(ids);
      }
      return;
    }
    if ($selection.length === 0) return;
    const cur = $selection;
    if (mod && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      if (sid) { let ids: string[] = []; commitDeck((d) => { ids = duplicateElements(d, sid, cur); }); selection.set(ids); }
      return;
    }
    if (mod && (e.key === "c" || e.key === "C")) {
      e.preventDefault();
      // SLD-10: capture the copied elements AND the animation tracks that target them (tagged by
      // beat index) so paste/duplicate re-attach the animation, not just the static element.
      const copiedIds = new Set(cur);
      const tracks: { beatIndex: number; track: (typeof slide.beats)[number]["tracks"][number] }[] = [];
      slide.beats.forEach((b, bi) => {
        for (const t of b.tracks) if (copiedIds.has(t.target)) tracks.push({ beatIndex: bi, track: t });
      });
      setClipboard(els.filter((el) => copiedIds.has(el.id)), tracks);
      return;
    }
    if (mod && (e.key === "g" || e.key === "G")) {
      e.preventDefault();
      if (sid) commitDeck((d) => (e.shiftKey ? ungroupElements(d, sid, cur) : groupElements(d, sid, cur)));
      return;
    }
    // Bracket z-order: match on e.code (physical key) not e.key — with Shift held
    // the browser reports "}"/"{", so e.key === "]" would miss the front/back variant.
    if (mod && e.code === "BracketRight") {
      e.preventDefault();
      if (sid) commitDeck((d) => (e.shiftKey ? bringToFront(d, sid, cur) : raiseElements(d, sid, cur)));
      return;
    }
    if (mod && e.code === "BracketLeft") {
      e.preventDefault();
      if (sid) commitDeck((d) => (e.shiftKey ? sendToBack(d, sid, cur) : lowerElements(d, sid, cur)));
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      const ids = $selection;
      commitDeck((d) => deleteElements(d, ids));
      selection.set([]);
    } else if (e.key === "Escape") {
      selection.set([]);
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      const ids = $selection;
      commitDeck((d) => {
        for (const id of ids) {
          const el = d.slides.flatMap((s) => s.elements).find((x) => x.id === id);
          if (el) setElementBox(d, id, { x: el.x + dx, y: el.y + dy });
        }
      });
    }
  }
</script>

<!-- Only the interactive stage listens for keys; filmstrip thumbnails (interactive=false)
     must NOT each attach a window listener that fires on every keystroke (A19). -->
<svelte:window onkeydown={interactive ? onKey : undefined} />

<div class="fit" bind:this={viewport} bind:clientWidth={fitW} bind:clientHeight={fitH} onwheel={onWheel}>
  {#if scale > 0}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="scaled"
      class:panning={panGesture}
      bind:this={scaledEl}
      style={`width:${stage.width * scale}px;height:${stage.height * scale}px;transform:translate(${panX}px,${panY}px)`}
      onpointerdown={onStagePointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      ondblclick={onStageDblClick}>
      <div
        class="stage"
        bind:this={stageEl}
        style={`width:${stage.width}px;height:${stage.height}px;transform:scale(${scale});transform-origin:0 0`}>
      </div>

      {#if interactive}
        <!-- overlay: screen-px, sibling of .stage; positions at value*scale -->
        <svg class="overlay" width={stage.width * scale} height={stage.height * scale}>
          {#if guideX != null}
            <line class="guide" x1={guideX * scale} y1={0} x2={guideX * scale} y2={stage.height * scale} />
          {/if}
          {#if guideY != null}
            <line class="guide" x1={0} y1={guideY * scale} x2={stage.width * scale} y2={guideY * scale} />
          {/if}
          {#if marquee}
            <rect class="marquee" x={marquee.x * scale} y={marquee.y * scale}
              width={marquee.w * scale} height={marquee.h * scale} />
          {/if}
          {#if overlayBox}
            <rect class="selbox" x={overlayBox.x * scale} y={overlayBox.y * scale}
              width={overlayBox.w * scale} height={overlayBox.h * scale} />
            {#each HANDLES as h (h)}
              {@const pos = handlePos(h, overlayBox)}
              <rect
                class="handle"
                x={pos[0] * scale - 5} y={pos[1] * scale - 5} width={10} height={10}
                style={`cursor:${cursorFor[h]}`}
                onpointerdown={(e) => onHandleDown(e, h)} />
            {/each}
            {#if $selection.length === 1}
              {@const cxp = (overlayBox.x + overlayBox.w / 2) * scale}
              {@const typ = overlayBox.y * scale}
              {@const byp = (overlayBox.y + overlayBox.h) * scale}
              <!-- Near the stage top the knob would render under the deckbar
                   (dead to the pointer — a rotated AABB can poke past y=0), so
                   it flips BELOW the box, Figma-style. -->
              {@const flip = typ - 28 < 0}
              {@const anchor = flip ? byp : typ}
              {@const kyp = flip ? byp + 22 : typ - 22}
              <line class="rot-stem" x1={cxp} y1={anchor} x2={cxp} y2={kyp} />
              <circle
                class="handle rot-knob"
                cx={cxp} cy={kyp} r={6}
                onpointerdown={(e) => onRotateDown(e)} />
            {/if}
          {/if}
        </svg>
      {/if}

      {#if interactive && editStyle}
        <!-- inline text editor: screen-space textarea over the element being edited -->
        <textarea
          class="inline-edit"
          bind:this={taEl}
          bind:value={editText}
          spellcheck="false"
          style={`left:${editStyle.x * scale}px;top:${editStyle.y * scale}px;width:${editStyle.w * scale}px;height:${editStyle.h * scale}px;font-size:${editStyle.fs * scale}px;font-weight:${editStyle.weight};text-align:${editStyle.align};color:${editStyle.color};`}
          oninput={onEditInput}
          onblur={finishEdit}
          onkeydown={onEditKey}
          onpointerdown={(e) => e.stopPropagation()}
        ></textarea>
      {/if}
    </div>
  {/if}
</div>

<style>
  .fit {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .scaled {
    position: relative;
    border: 1px solid var(--c-line-strong, #343331);
    /* a crisp light hairline reads against the near-black canvas regardless of
     *  the slide's own background colour; the deeper shadow lifts it off. */
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.08),
      0 16px 48px rgba(0, 0, 0, 0.62);
    touch-action: none;
    will-change: transform;
  }
  .scaled.panning { cursor: grabbing; }
  .stage {
    position: absolute;
    top: 0;
    left: 0;
    overflow: hidden;
  }
  .overlay {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    overflow: visible;
  }
  .selbox {
    fill: none;
    stroke: var(--c-accent, #4385be);
    stroke-width: 1;
  }
  .handle {
    fill: var(--c-bg, #100f0f);
    stroke: var(--c-accent, #4385be);
    stroke-width: 1.5;
    pointer-events: all;
  }
  .rot-knob {
    cursor: grab;
  }
  .rot-knob:active {
    cursor: grabbing;
  }
  .rot-stem {
    stroke: var(--c-accent, #4385be);
    stroke-width: 1;
    pointer-events: none;
  }
  .guide {
    stroke: var(--c-accent-bright, #66a0c8);
    stroke-width: 1;
    stroke-dasharray: 4 3;
  }
  .marquee {
    fill: color-mix(in oklab, var(--c-accent, #4385be) 14%, transparent);
    stroke: var(--c-accent, #4385be);
    stroke-width: 1;
  }
  .inline-edit {
    position: absolute;
    z-index: 10;
    margin: 0;
    padding: 0;
    border: 1px dashed var(--c-accent, #4385be);
    border-radius: 2px;
    background: color-mix(in oklab, var(--c-bg, #100f0f) 70%, transparent);
    font-family: var(--font-serif, Georgia, "Times New Roman", serif);
    line-height: 1.2;
    resize: none;
    outline: none;
    box-sizing: border-box;
    overflow: hidden;
  }
</style>
