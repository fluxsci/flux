<script lang="ts">
  // The Animator's PROPERTIES mini-pane (rework §6 — the pink/green pane to
  // the left of the rail in the mockups): the selected track's parameters.
  //   • appearance tracks — preset (family-scoped list), start / duration /
  //     stagger (+ by / from), easing token + AE influence;
  //   • transform tracks — the t₁ | t₂ endpoint segment (drives the model
  //     checkout), timing + easing (the interpolation itself has no knobs —
  //     deliberately ours);
  //   • multi-selection bulk-edits every selected track (mixed flagged).
  // Absorbs the old TrackEditor strip (same data-fld letters for the dock's
  // keyboard cockpit). Presentation follows the editor-surface spec: hairline-
  // separated blocks, square controls, the preset colour only as a thin rail
  // on the header name (2026-09-15 surface redesign).
  import { deckOverlay, selTrackIds, endpointEdit, enterEndpointEdit, refreshEndpointDisplay, commitDeckLive, currentDeck, activeBeat } from "../../../../lib/slide/store";
  import { selection, setPartSelections } from "../../../../lib/store";
  import { objectLabel } from "./ghostEditing";
  import { familyOf } from "../../../../lib/slide/family";
  import { trackDuration, compileSlide } from "../../../../lib/slide/compile";
  import { flyDuration, type CameraPath } from "../../../../lib/slide/camera";
  import { hasTweenableSeries } from "../../../../lib/plot/project";
  import { plotManifests, plotDom, plotGen } from "../../../../lib/plot/store";
  import type { Slide, Track, PresetName, Stagger, Deck, BecomeSpec } from "../../../../lib/slide/types";
  import { PRESET_COLOR, EDIT_PRESETS, chipLabel, refLabel, presetLabel, transformWay, WAY_LABEL } from "./shared";
  import { clearTransformContent, linkTrackStyle, styleFromTrack, setAnimStyle, setTrackCurve, setTrack, setTrackAnchor, becomeTransform, removeTracks, setAnimation } from "../../../../lib/slide/ops";
  import { trackRef, targetPartIds, sameRef, isWholeElementRef, PAIR_POLICIES } from "../../../../lib/slide/targets";
  import { targetOutlines } from "../../../../lib/slide/targetGeometry";
  import { autoAnimateExcept } from "../../../../lib/slide/autobuild";
  import { buildPartTree, resolveTargets } from "../../../../lib/plot/tree";
  import { withSelectedTracks, deleteSelectedTracks, duplicateSelectedTracks, toggleSelectedDisabled } from "./trackActions";
  import CurveField, { type CurveEdit } from "./CurveField.svelte";
  import { resolveCurve } from "../../../../lib/slide/curves";
  import { openTrackCascade } from "./cascadeTracks";
  import { makeAnimPreset } from "../../../../lib/slide/animTemplates";
  import { saveAnimPreset } from "../../../../lib/slide/animPresets";
  import { resolveBeat, INHERITED_STYLE_FIELDS, type StyleContext } from "../../../../lib/slide/resolve";
  import { pushToast } from "../../../../lib/toast";

  let { slide, plotTags, onChooseMorph, onBecome }: {
    slide: Slide; plotTags: Map<string, string>;
    /** Plot data-only Become: pick the content target from the project gallery. */
    onChooseMorph?: (targetId: string, trackId?: string) => void;
    /** Arm the Become pick for this track's target at its step. */
    onBecome?: (targetId: string, beatIndex: number) => void;
  } = $props();

  // "Save as preset" (the mockup's pink button): name inline, Enter saves.
  let savingPreset = $state(false);
  let presetName = $state("");
  async function doSavePreset() {
    const t = curTrack;
    const name = presetName.trim();
    if (!t || !name) return;
    if (await saveAnimPreset(makeAnimPreset(name, t))) {
      pushToast("info", `Saved preset “${name}” — apply it from ☆ Library`);
      savingPreset = false;
      presetName = "";
    } else pushToast("error", "Couldn't save the preset.");
  }

  const rawSelTracks = $derived.by(() => {
    const all = slide.beats.flatMap((b) => b.tracks);
    return $selTrackIds.map((id) => all.find((t) => t.id === id)).filter((t): t is Track => !!t);
  });
  const deck: StyleContext = $derived($deckOverlay ?? {});
  const manifestFor = (target: string) => {
    const el = slide.elements.find(e => e.id === target);
    return el && "assetId" in el ? $plotManifests[el.assetId] : undefined;
  };
  const resolvedBeats = $derived(slide.beats.map(b => resolveBeat(b, deck, manifestFor)));
  const selTracks = $derived(rawSelTracks.map(t => resolvedBeats.flatMap(b => b.tracks).find(r => r.id === t.id)!));
  const rawTrack = $derived(rawSelTracks.at(-1) ?? null);
  const curBeatIndex = $derived(rawTrack ? slide.beats.findIndex(b => b.tracks.some(t => t.id === rawTrack.id)) : -1);
  let styleOpen = $state(false), savingStyle = $state(false), styleName = $state("");
  let editingStyleId = $state<string | null>(null);
  const editingStyle = $derived(deck.animStyles?.find(s => s.id === editingStyleId));
  const linkedStyle = $derived(rawTrack?.styleId ? deck.animStyles?.find(s => s.id === rawTrack.styleId) : undefined);
  const sameFamily = $derived(rawSelTracks.length > 0 && rawSelTracks.every(t => familyOf(t) === familyOf(rawSelTracks[0])));
  const sameStyle = $derived(!!linkedStyle && rawSelTracks.every(t => t.styleId === linkedStyle.id));
  const styleReason = $derived(!sameFamily ? "Select effects of one family to link a style." : familyOf(rawSelTracks[0] ?? {}) === "camera" ? "Camera effects do not share animation styles." : "");
  const familyStyles = $derived((deck.animStyles ?? []).filter(s => sameFamily && s.family === familyOf(rawSelTracks[0])));
  const linkedCount = $derived(editingStyle ? ($deckOverlay?.slides ?? []).reduce((n,s) => n+s.beats.reduce((n,b) => n+b.tracks.filter(t => t.styleId === editingStyle.id).length,0),0) : 0);
  const curTrack = $derived(editingStyle && rawTrack ? { ...rawTrack, ...Object.fromEntries(INHERITED_STYLE_FIELDS.map(k => [k, editingStyle.track[k]])), ...editingStyle.track, anchor: undefined } as Track : selTracks.at(-1) ?? null);
  const selectionContext = { key: "" };
  $effect(() => {
    const key = `${slide.id}:${$selTrackIds.join(",")}`;
    if (key === selectionContext.key) return;
    selectionContext.key = key; editingStyleId = null; styleOpen = false; savingStyle = false; anchorOpen = false; consumeArmed = false;
  });

  function linkStyle(id: string | null) {
    commitDeckLive(d => { for (const t of rawSelTracks) if (t.id) {
      const r = linkTrackStyle(d, slide.id, t.id, id); if (!r.ok) pushToast("error", r.reason!);
    } });
    styleOpen = false; editingStyleId = null;
  }
  function saveStyle() {
    if (!rawTrack?.id || !styleName.trim() || styleReason) return;
    commitDeckLive(d => {
      const style = styleFromTrack(d, slide.id, rawTrack.id!, styleName.trim());
      if (style) for (const t of rawSelTracks) if (t.id && t.id !== rawTrack.id) linkTrackStyle(d, slide.id, t.id, style.id);
    });
    savingStyle = false; styleName = ""; styleOpen = false;
  }
  // The same field controls edit either local overrides or the style itself.
  function editFields(fn: (t: Track, resolved: Track) => void) {
    if (editingStyle) {
      const id = editingStyle.id;
      commitDeckLive(d => {
        const style = d.animStyles?.find(s => s.id === id); if (!style) return;
        const t: Track = { target: rawTrack?.target ?? "", ...structuredClone(style.track) };
        fn(t, t);
        // Send only changed fields: resending preset would erase local preset overrides.
        const keys = [...INHERITED_STYLE_FIELDS, "preset"] as const;
        const patch = Object.fromEntries(keys.filter(k => JSON.stringify(t[k]) !== JSON.stringify(style.track[k])).map(k => [k, t[k]]));
        setAnimStyle(d, id, { track: patch });
      });
    } else withSelectedTracks(fn);
  }
  type StyleField = typeof INHERITED_STYLE_FIELDS[number] | "preset";
  function overridden(key: StyleField) {
    return !editingStyle && rawSelTracks.some(t => t.styleId && (key === "preset"
      ? t.preset !== deck.animStyles?.find(s => s.id === t.styleId)?.track.preset : t[key] != null));
  }
  function resetStyleField(key: StyleField) {
    withSelectedTracks(t => {
      if (!t.styleId) return;
      // Preset defines the family and always stays on the track (F1's write-through rule).
      if (key === "preset") { const style = deck.animStyles?.find(s => s.id === t.styleId); if (style) t.preset = style.track.preset; }
      else delete t[key];
    });
  }
  let anchorOpen = $state(false);
  const anchored = $derived(!editingStyle && rawSelTracks.some(t => t.anchor));
  const sameAnchor = $derived(!!rawTrack?.anchor && rawSelTracks.every(t => t.anchor?.trackId === rawTrack.anchor!.trackId && t.anchor?.edge === rawTrack.anchor!.edge));
  const anchorTrack = $derived(rawTrack?.anchor ? slide.beats[curBeatIndex]?.tracks.find(t => t.id === rawTrack.anchor!.trackId) : undefined);
  const anchorIssues = $derived(resolvedBeats.flatMap(b => b.issues).filter(i => rawSelTracks.some(t => t.id === i.trackId)));
  const anchorChoices = $derived(slide.beats[curBeatIndex]?.tracks.filter(t => t.id && !rawSelTracks.some(s => s.id === t.id)) ?? []);
  function anchorName(t: Track) { return chipLabel(t, slide, plotTags, deck, manifestFor); }
  function anchorTo(trackId: string, edge: "start" | "end") {
    if (!trackId) return;
    commitDeckLive(d => { for (const t of rawSelTracks) if (t.id) {
      const r = setTrackAnchor(d, slide.id, t.id, { trackId, edge, offsetMs: 0 });
      if (!r.ok) pushToast("error", r.reason!);
    } });
    anchorOpen = false;
  }
  function detachAnchor() {
    commitDeckLive(d => { for (const t of rawSelTracks) if (t.id && t.anchor) setTrack(d, slide.id, t.id, { anchor: null }, manifestFor); });
    anchorOpen = false;
  }
  function offset(value: string) {
    const n = Number(value); if (!value.trim() || !Number.isFinite(n)) return;
    commitDeckLive(d => { for (const t of rawSelTracks) if (t.id && t.anchor) setTrackAnchor(d, slide.id, t.id, { ...t.anchor, offsetMs: n }); });
  }
  const curFamily = $derived(curTrack ? familyOf(curTrack) : null);
  const curWay = $derived(curTrack && curFamily === "transform" ? transformWay(curTrack) : null);
  const handoff = $derived(curTrack?.to?.become?.mode === "handoff" ? curTrack.to.become : null);
  /** What the object becomes at this step, for the Destination row. */
  const destinationLabel = $derived.by(() => {
    if (!curTrack || curFamily !== "transform") return "";
    const st = (curTrack.to?.state ?? {}) as Record<string, unknown>;
    const kind = typeof st.type === "string" ? st.type : null;
    if (handoff) return `Hands off to ${refLabel(handoff.ref, slide, manifestFor, new Map(), 2)} · pair: ${handoff.pair ?? "auto"}`;
    if (curTrack.to?.become?.mode === "consume") {
      const consumedKind = kind ?? slide.elements.find(e => e.id === curTrack.target)?.type ?? "object";
      return `Became ${/^[aeiou]/.test(consumedKind) ? "an" : "a"} ${consumedKind} (consumed)`;
    }
    const data = curTrack.to?.assetId ? (curTrack.to.svgPath?.split("/").pop() || curTrack.to.assetId) : null;
    if (kind && data) return `Becomes a ${kind} showing ${data}`;
    if (kind) return `Becomes ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;
    if (data) return `Data becomes ${data}`;
    return curWay === "ghost" ? "Its own destination after this step" : "The object's own state after this step";
  });
  const anyGhost = $derived(selTracks.some(t => !!t.ghostFrom));
  const anyMedia = $derived(selTracks.some(t => familyOf(t) === "media"));
  const allMedia = $derived(selTracks.length > 0 && selTracks.every(t => familyOf(t) === "media"));
  const allCamera = $derived(selTracks.length > 0 && selTracks.every(t => t.preset === "camera"));
  const flySuggestions = $derived.by(() => {
    const values = new Map<string, number>(), deck = $deckOverlay;
    if (!allCamera || !deck || !selTracks.some(t => t.to?.path === "fly")) return values;
    const plan = compileSlide(slide, deck.stage, { animStyles: deck.animStyles, plotManifest: id => $plotManifests[id] });
    for (const track of selTracks) {
      if (!track.id || track.to?.path !== "fly") continue;
      const bi = plan.resolvedSlide.beats.findIndex(b => b.tracks.some(t => t.id === track.id));
      const resolved = plan.resolvedSlide.beats[bi]?.tracks.find(t => t.id === track.id);
      const from = plan.sample(bi, resolved?.start ?? 0).camera ?? { x: deck.stage.width / 2, y: deck.stage.height / 2, zoom: 1 };
      const to = { x: track.to.x ?? from.x, y: track.to.y ?? from.y, zoom: track.to.zoom ?? from.zoom };
      values.set(track.id, Math.max(1, Math.round(1000 * flyDuration(from, to, deck.stage))));
    }
    return values;
  });
  const flySuggestion = $derived(curTrack?.id ? flySuggestions.get(curTrack.id) : undefined);
  function cameraPath(path: CameraPath) {
    withSelectedTracks(t => {
      if (t.preset !== "camera") return;
      if (path === "fly") t.to = { ...t.to, path };
      else if (t.to) delete t.to.path;
    });
  }
  function applyFlyDuration() {
    const suggestions = flySuggestions;
    commitDeckLive(d => {
      for (const [id, duration] of suggestions) setTrack(d, slide.id, id, { duration });
    });
  }
  const groupLabel = $derived.by(() => {
    if (!curTrack?.groupId) return null;
    for (const b of slide.beats) {
      const g = b.groups?.find((x) => x.id === curTrack.groupId);
      if (g) return g.label;
    }
    return null;
  });
  function mixed<T>(get: (t: Track) => T): boolean {
    const vs = editingStyle && curTrack ? [get(curTrack)] : selTracks.map(get);
    return vs.length > 1 && vs.some((v) => v !== vs[0]);
  }
  const anyDisabled = $derived(selTracks.some((t) => t.disabled));
  const anyMixed = $derived(
    selTracks.length > 1 &&
      (mixed((t) => t.preset) || mixed((t) => trackDuration(t)) || mixed((t) => t.start ?? 0) ||
        mixed((t) => t.stagger?.perMs ?? 0) || mixed((t) => resolveCurve(t, familyOf(t)).key)),
  );

  const patchTrack = (p: Partial<Track>) => {
    if (anyGhost && ["target", "ghostFrom", "preset", "part", "selector"].some(key => key in p)) return;
    if (anyMedia && !allMedia && ["preset", "part", "selector", "target"].some(key => key in p)) return;
    editFields((t) => {
      Object.assign(t, p);
      if ("influence" in p && p.influence === undefined && t.styleId) t.influence = { in: 0, out: 0 };
    });
  };
  function timing(field: "start" | "duration", value: string) {
    const n = Number(value);
    if (!value.trim() || !Number.isFinite(n)) return;
    if (editingStyle) { patchTrack({ [field]: Math.max(field === "start" ? 0 : 1, n) }); return; }
    commitDeckLive(d => { for (const t of rawSelTracks) if (t.id) setTrack(d, slide.id, t.id, { [field]: Math.max(field === "start" ? 0 : 1, n) }, manifestFor); });
  }
  function patchStagger(p: Partial<Stagger>) {
    editFields((t, resolved) => {
      if (p.perMs === 0) { if (t.styleId) t.stagger = { perMs: 0 }; else t.stagger = undefined; return; }
      t.stagger = { perMs: resolved.stagger?.perMs ?? 40, ...resolved.stagger, ...p } as Stagger;
    });
  }
  function changeCurve(value: CurveEdit, keepArrival: boolean) {
    const patch = typeof value === "object" && "influence" in value ? { influence: value.influence } : { curve: value };
    const next = resolveCurve("influence" in patch ? { influence: patch.influence } : typeof patch.curve === "string" ? { easing: patch.curve } : { curve: patch.curve });
    const durationFor = (t: Track) => Math.max(150, Math.min(4000, trackDuration(t) * resolveCurve(t, familyOf(t)).arrival / next.arrival));
    if (editingStyle && curTrack) {
      const id = editingStyle.id, duration = durationFor(curTrack);
      const stylePatch: Partial<Track> = typeof value === "string" ? { easing: value } : "influence" in value ? { influence: value.influence } : { curve: value };
      commitDeckLive(d => setAnimStyle(d, id, { track: { ...stylePatch, ...(keepArrival ? { duration } : {}) } }));
    } else withSelectedTracks((t, resolved, d, sid) => {
      if (!t.id || familyOf(t) === "media") return;
      const duration = durationFor(resolved);
      if ("influence" in patch) setTrack(d, sid, t.id, patch);
      else setTrackCurve(d, sid, t.id, patch.curve);
      if (keepArrival) setTrack(d, sid, t.id, { duration });
    });
  }
  function resetCurve() {
    withSelectedTracks((t, _resolved, d, sid) => { if (t.id) setTrackCurve(d, sid, t.id, null); });
  }

  // t1|t2 segment (single transform selection): drives the endpoint checkout
  const epActive = $derived.by(() => {
    const ee = $endpointEdit;
    if (!ee || !curTrack?.id) return null;
    const mine = ee.entries.some((en) => en.trackId === curTrack.id || (ee.end === "t1" && en.target === (curTrack.ghostFrom ?? curTrack.target)));
    return mine ? ee.end : null;
  });
  function selectEndpoint(end: "t1" | "t2") {
    if (!curTrack?.id) return;
    enterEndpointEdit([curTrack.id], end);
  }
  const changedProps = $derived.by(() => {
    const st = curTrack?.to?.state as Record<string, unknown> | undefined;
    return st ? Object.keys(st) : [];
  });

  // --- transform Δ management (drop a captured prop / clear t2 / morph row) --
  function withCurTrack(fn: (t: Track, d: Deck) => void) {
    const id = curTrack?.id;
    if (!id) return;
    commitDeckLive((d) => {
      for (const s of d.slides) for (const b of s.beats) {
        const t = b.tracks.find((x) => x.id === id);
        if (t) fn(t, d);
      }
    });
    refreshEndpointDisplay();
  }
  const compile = (d: Deck, s: Slide) => compileSlide(s, d.stage, { animStyles: d.animStyles, plotManifest: id => $plotManifests[id] });
  function changeHandoff(patch: Partial<Pick<BecomeSpec, "pair" | "reveal" | "mode">>) {
    try {
      withCurTrack((t, d) => {
        const spec = t.to?.become, s = d.slides.find(s => s.id === slide.id);
        const b = s?.beats.find(b => b.tracks.includes(t));
        if (!spec || !s || !b) return;
        becomeTransform(d, s.id, b.id, trackRef(t), spec.ref, { ...spec, ...patch, compiled: compile(d, s) });
      });
    } catch (e) { pushToast("error", String(e instanceof Error ? e.message : e)); }
    consumeArmed = false;
  }
  let consumeArmed = $state(false);
  $effect(() => { void handoff; consumeArmed = false; });
  const destinationEl = $derived(handoff ? slide.elements.find(e => e.id === handoff.ref.element) : undefined);
  const canConsume = $derived(!!handoff && !!curTrack && isWholeElementRef(handoff.ref) && isWholeElementRef(trackRef(curTrack)) && !!destinationEl && !destinationEl.groupId);
  // A whole-plot hand-off reveals every part already: nothing is left to build.
  const canAutoAnimate = $derived(destinationEl?.type === "plot" && !!handoff && !handoff.ref.group && !isWholeElementRef(handoff.ref) && !!$plotManifests[destinationEl.assetId] && !slide.beats.some(b => b.tracks.some(t => t.target === destinationEl.id && familyOf(t) === "appearance")));
  function reverseHandoff(d: Deck, id: string) {
    const s = d.slides.find(s => s.id === slide.id)!;
    const b = s.beats.find(b => b.tracks.some(t => t.id === id))!;
    const t = b.tracks.find(t => t.id === id)!;
    const spec = t.to!.become!;
    if (spec.ref.group) throw new Error("Groups cannot be Become sources. Choose an object or plot parts.");
    if (t.ghostFrom) throw new Error("This track creates a ghost. Keep its birth and author a reverse hand-off in a later step.");
    if (b.tracks.some(other => other.id !== id && familyOf(other) === "transform" && sameRef(trackRef(other), spec.ref)))
      throw new Error("The destination already has a transform in this step.");
    const compiled = compile(d, s);
    const ctx = { manifest: (id: string) => $plotManifests[id], plotRoot: (id: string) => plotDom.get(id), groups: s.groups };
    if (!targetOutlines(spec.ref, compiled.sample(s.beats.indexOf(b)), ctx).length)
      throw new Error("The destination has no outline. Choose another object or plot part.");
    const resolved = compiled.resolvedSlide.beats[s.beats.indexOf(b)].tracks.find(x => x.id === id)!;
    const groups = b.groups;
    removeTracks(d, s.id, [id]);
    const result = becomeTransform(d, s.id, b.id, spec.ref, trackRef(t), { mode: "handoff", pair: spec.pair, reveal: spec.reveal,
      start: resolved.start ?? 0, duration: trackDuration(resolved), easing: resolved.easing, compiled: compile(d, s) });
    if (!result) throw new Error("This hand-off cannot be reversed.");
    const reverse = b.tracks.find(t => t.id === result.trackId)!;
    // Retain the authored HOW, including style inheritance, while changing the binding.
    const { target, part, parts, selector, to, id: oldId, ...how } = t;
    setAnimation(d, s.id, b.id, { ...how, ...trackBinding(reverse), to: reverse.to, id: result.trackId });
    b.groups = groups;
    for (const follower of b.tracks) if (follower.anchor?.trackId === id)
      setTrackAnchor(d, s.id, follower.id!, { ...follower.anchor, trackId: result.trackId });
    return result.trackId;
  }
  function trackBinding(t: Track) { return { target: t.target, part: t.part, parts: t.parts, selector: t.selector }; }
  const swapReason = $derived.by(() => {
    void $plotGen;
    if (!handoff || !curTrack?.id || !$deckOverlay) return "";
    try { reverseHandoff(structuredClone({ ...$deckOverlay, slides: [slide] }), curTrack.id); return ""; }
    catch (e) { return e instanceof Error ? e.message : String(e); }
  });
  function swapDirection() {
    if (!curTrack?.id || swapReason) return;
    try {
      const id = commitDeckLive(d => reverseHandoff(d, curTrack!.id!));
      selTrackIds.set([id]);
      const s = currentDeck()?.slides.find(s => s.id === slide.id), t = s?.beats.flatMap(b => b.tracks).find(t => t.id === id);
      if (t) { selection.set(new Set([t.target])); setPartSelections((trackRef(t).parts ?? []).map(partId => ({ elementId: t.target, partId }))); }
      enterEndpointEdit([id], "t2");
    } catch (e) { pushToast("error", String(e instanceof Error ? e.message : e)); }
  }
  function animateRest() {
    if (!handoff || destinationEl?.type !== "plot" || !canAutoAnimate) return;
    const beatId = slide.beats[curBeatIndex]?.id;
    commitDeckLive(d => {
      const s = d.slides.find(s => s.id === slide.id)!;
      const leaves = compile(d, s).resolveTarget(handoff.ref, curBeatIndex).flatMap(t => t.partIds ?? buildPartTree($plotManifests[destinationEl.assetId])?.targets ?? []);
      autoAnimateExcept(d, s.id, destinationEl.id, $plotManifests[destinationEl.assetId], leaves);
    });
    const bi = currentDeck()?.slides.find(s => s.id === slide.id)?.beats.findIndex(b => b.id === beatId);
    if (bi != null && bi >= 0) activeBeat.set(bi);
    refreshEndpointDisplay();
  }
  function armBecome() {
    if (!curTrack) return;
    selection.set(new Set([curTrack.target]));
    const parts = curTrack.selector ? targetPartIds(curTrack, manifestFor(curTrack.target)) : trackRef(curTrack).parts ?? [];
    setPartSelections(parts.map(partId => ({ elementId: curTrack.target, partId })));
    onBecome?.(curTrack.target, curBeatIndex);
  }
  function dropChangedProp(k: string) {
    withCurTrack((t) => {
      const st = (t.to?.state ?? {}) as Record<string, unknown>;
      delete st[k];
      t.to = { ...(t.to ?? {}), state: st };
    });
  }
  function clearT2() {
    withCurTrack((t) => {
      t.to = { ...(t.to ?? {}), state: {} };
    });
  }
  // morph-content row: other compatible plots on the slide (plot targets only)
  const curTargetEl = $derived(curTrack ? slide.elements.find((e) => e.id === curTrack.target) : null);
  const targetParts = $derived.by(() => {
    if (curTargetEl?.type !== "plot") return [] as string[];
    const tree = buildPartTree($plotManifests[curTargetEl.assetId]);
    const out: string[] = [];
    const walk = (n: NonNullable<typeof tree>) => { out.push(n.id); n.children.forEach(walk); };
    if (tree) walk(tree);
    return out;
  });
  const targetMissing = $derived(!!curTrack && !curTrack.target.startsWith("@") && (!curTargetEl || !!curTrack.part && curTargetEl.type === "plot" && !resolveTargets($plotManifests[curTargetEl.assetId], curTrack.part).length));
  function retarget(target: string) {
    if (!target || anyGhost) return;
    withSelectedTracks(t => { t.target = target; delete t.part; delete t.selector; });
  }
  function setPart(part: string) {
    if (anyGhost) return;
    withSelectedTracks(t => { if (part) t.part = part; else delete t.part; delete t.selector; });
  }
  /** A plot Become's data half: compatible structures tween, others crossfade. */
  const dataCompatible = $derived.by(() => {
    if (curTargetEl?.type !== "plot" || !curTrack?.to?.assetId) return null;
    const m = $plotManifests;
    return hasTweenableSeries(m[curTargetEl.assetId], m[curTrack.to.assetId]);
  });
  function keepOwnContent() {
    withCurTrack((t) => clearTransformContent(t));
  }

  // --- trim-path params (drawOn/drawOff — rework §5) -------------------------
  const isTrim = $derived(!anyGhost && curFamily === "appearance" && (curTrack?.preset === "drawOn" || curTrack?.preset === "drawOff"));
  const isWipe = $derived(!anyGhost && curFamily === "appearance" && (curTrack?.preset === "writeOn" || curTrack?.preset === "wipeOut"));
  const trimP = $derived((curTrack?.params ?? {}) as { anchor?: number | string; direction?: string; mode?: string; from?: number; to?: number });
  /** Write one trim param; a value equal to its default DELETES the key so
   *  default decks keep the legacy byte-identical compile path. */
  function setTrim(key: "anchor" | "direction" | "mode" | "from" | "to", value: unknown) {
    const DEF: Record<string, unknown> = { anchor: 0, direction: "forward", mode: "single", from: 0, to: 1 };
    editFields((t, resolved) => {
      const p = { ...(resolved.params ?? {}) } as Record<string, unknown>;
      const isDefault = value === DEF[key] || value === "" || value == null || (key === "anchor" && (value === "start" || value === 0));
      if (isDefault) delete p[key];
      else p[key] = value;
      t.params = Object.keys(p).length || t.styleId ? p : undefined;
    });
  }
  // the anchor pad: named positions laid out spatially (rect/ellipse corners +
  // edges; paths get start/middle/end below)
  const PAD: (string | null)[] = ["corner-tl", "top", "corner-tr", "left", null, "right", "corner-bl", "bottom", "corner-br"];
  const PAD_GLYPH: Record<string, string> = {
    "corner-tl": "◤", top: "▲", "corner-tr": "◥", left: "◀", right: "▶", "corner-bl": "◣", bottom: "▼", "corner-br": "◢",
  };
  const anchorIsNamed = $derived(typeof trimP.anchor === "string");
  const trimGeoKind = $derived.by(() => {
    const el = curTargetEl;
    if (!el) return "path";
    return el.type === "rect" || el.type === "ellipse" ? "shape" : "path";
  });
</script>

{#snippet overrideRow(key: StyleField)}
  {#if overridden(key)}<div class="override-row" data-override={key}><span class="mx">override</span><button aria-label={`Use style ${key}`} onclick={() => resetStyleField(key)}>↺ use style</button></div>{/if}
{/snippet}

<div class="props" class:tx={curFamily === "transform"} data-command-scope="animation">
  <div class="ttl">Effect</div>
  {#if !curTrack}
    <div class="hint">
      Select an effect in the timeline to edit its target and timing. Select an object or plot part and use the animation actions to add an effect.
    </div>

  {:else}
    <div class="hd" style={`--pc:${PRESET_COLOR[curTrack.preset ?? "fade"] ?? "#888"}`}>
      <span class="nm">
        {#if selTracks.length > 1}{selTracks.length} tracks{:else}{groupLabel ? `${groupLabel} › ` : ""}{chipLabel(curTrack, slide, plotTags, deck, manifestFor)}{/if}
      </span>
      <button class="style-picker" aria-label="Animation style" aria-expanded={styleOpen} disabled={!!styleReason || !!editingStyle}
        title={styleReason || "Link settings to a deck animation style"} onclick={() => styleOpen = !styleOpen}>Style{sameStyle ? ` · ${linkedStyle!.name}` : rawSelTracks.some(t => t.styleId) ? " · mixed" : ""} ▾</button>
      {#if anyMixed}<span class="mx" title="Selected tracks differ on some fields — editing a field sets it on ALL of them">mixed</span>{/if}
    </div>

    {#if styleReason}<div class="note style-reason">{styleReason}</div>{/if}
    {#if styleOpen}
      <div class="style-menu" aria-label="Animation styles">
        {#each familyStyles as style (style.id)}<button class="style-option" data-style-id={style.id} onclick={() => linkStyle(style.id)}>{style.name}</button>{/each}
        <button onclick={() => { savingStyle = true; styleOpen = false; }}>Save as new style…</button>
        <button disabled={!sameStyle} onclick={() => { editingStyleId = linkedStyle!.id; styleOpen = false; }}>Edit style…</button>
        <button disabled={!rawSelTracks.some(t => t.styleId)} onclick={() => linkStyle(null)}>Detach</button>
      </div>
    {/if}
    {#if savingStyle}
      <form class="style-save psave" onsubmit={e => { e.preventDefault(); saveStyle(); }}>
        <!-- svelte-ignore a11y_autofocus -->
        <input autofocus aria-label="New animation style name" placeholder="Style name…" bind:value={styleName} onkeydown={e => { if (e.key === "Escape") savingStyle = false; e.stopPropagation(); }}/>
        <button disabled={!styleName.trim()}>Save</button><button type="button" onclick={() => savingStyle = false}>Cancel</button>
      </form>
    {/if}
    {#if editingStyle}
      <div class="editing-style" role="status">Editing style ‹{editingStyle.name}› · {linkedCount} tracks <button onclick={() => editingStyleId = null}>Back to effect</button></div>
    {/if}
    {#if targetMissing && !editingStyle}<div class="target-warning">This target is missing. Choose an object or plot part below to reconnect the effect.</div>{/if}
    {#if curTrack.ghostFrom}
      <div class="note">Starts from <b>{objectLabel(slide, curTrack.ghostFrom)}</b> before this step. Edit this copy’s destination with <b>After</b>.</div>
    {/if}
    {#if anyGhost && selTracks.length > 1}
      <div class="note ghost-mixed-note">This selection includes ghost births. Timing and easing apply to all selected effects. Select one effect to edit its destination.</div>
    {/if}
    {#if anyMedia && !allMedia}<div class="note">This selection includes video controls. Start offsets apply to all selected effects; select a video control to edit its action.</div>{/if}
    {#if !editingStyle && curTrack.target !== "@camera" && !anyGhost && (!anyMedia || allMedia)}
      <label class="f">Object
        <select aria-label="Animation target" value={curTrack.target} onchange={e => retarget(e.currentTarget.value)}>
          {#if !curTargetEl}<option value={curTrack.target}>Missing object</option>{/if}
          {#each slide.elements.filter(e => !allMedia || e.type === "video") as e (e.id)}<option value={e.id}>{e.name || (e.type === "text" ? e.text.slice(0, 36) : e.type)}</option>{/each}
        </select>
      </label>
      {#if curTargetEl?.type === "plot" && curFamily !== "transform"}
        <label class="f">Plot part
          <select aria-label="Animation plot part" value={curTrack.part ?? ""} onchange={e => setPart(e.currentTarget.value)}>
            <option value="">Whole plot</option>
            {#if curTrack.part && !targetParts.includes(curTrack.part)}<option value={curTrack.part}>{curTrack.part} (missing)</option>{/if}
            {#each targetParts as part}<option value={part}>{part.replaceAll(".", " › ")}</option>{/each}
          </select>
        </label>
      {/if}
    {/if}

    {#if !editingStyle && curFamily === "transform" && selTracks.length === 1}
      <!-- the endpoint segment: t1 shows the before, t2 checks out the after -->
      <div class="seg" role="group" aria-label="Transform endpoint">
        <button class="sg" class:on={epActive === "t1"} title="Show/edit t₁ — the state the object transforms FROM"
          onclick={() => selectEndpoint("t1")}>{curTrack.ghostFrom ? "Source before" : "Before"}</button>
        <button class="sg" class:on={epActive === "t2"} title="Check out t₂ — edit the object on the canvas with every tool; the diff records here"
          onclick={() => selectEndpoint("t2")}>After</button>
      </div>
      {#if epActive === "t2"}
        <div class="note">Editing <b>After this step</b>. Change the object on the canvas or in Object properties.</div>
      {:else if epActive === "t1"}
        <div class="note">Editing the state <b>before this step</b>. The stage header names the initial state or earlier step receiving these edits.</div>
      {/if}
      {#if !handoff && changedProps.length}
        <div class="delta" title="The properties this transform changes at t₂ — ✕ drops one">
          <span class="dl">Δ</span>
          {#each changedProps as k (k)}
            <span class="dchip">{k}<button class="dx" title={`Drop the ${k} change`} onclick={() => dropChangedProp(k)}>✕</button></span>
          {/each}
          <button class="dclear" title="Reset t₂ to equal t₁ (drop every change)" onclick={clearT2}>clear t₂</button>
        </div>
      {/if}
      <!-- the DESTINATION: what this object becomes at the step, and the two
           ways to point it somewhere else (Become another object · plot data) -->
      <div class="dest" aria-label="Transform destination">
        <div class="dl">Destination</div>
        <div class="dv">{destinationLabel}{#if dataCompatible === false} <span class="warn" title="The two plots have different structures — the frame tweens and the plots crossfade">· crossfade</span>{/if}</div>
        {#if handoff}
          <label class="f">Pair ▾
            <select aria-label="Hand-off pair" value={handoff.pair ?? "auto"} onchange={e => changeHandoff({ pair: e.currentTarget.value as BecomeSpec["pair"] })}>
              {#each PAIR_POLICIES as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
            </select>
          </label>
          <div class="f">Reveal
            <div class="seg" role="group" aria-label="Hand-off reveal">
              {#each ["flip", "draw"] as reveal}<button class="sg" class:on={(handoff.reveal ?? "flip") === reveal} aria-pressed={(handoff.reveal ?? "flip") === reveal} onclick={() => changeHandoff({ reveal: reveal as BecomeSpec["reveal"] })}>{reveal}</button>{/each}
            </div>
          </div>
          <div class="dacts">
            <button class="pick-morph" disabled={!!swapReason} title={swapReason || "Reverse this hand-off in one undoable edit"} onclick={swapDirection}>↔ Swap direction</button>
            {#if canConsume}
              <button class="pick-morph" class:warn={consumeArmed} title="Consume removes the destination object and writes its appearance into the source" onclick={() => consumeArmed ? changeHandoff({ mode: "consume" }) : consumeArmed = true}>{consumeArmed ? "Confirm consume" : "Consume instead"}</button>
              {#if consumeArmed}<button class="pick-morph" onclick={() => consumeArmed = false}>Cancel</button>{/if}
            {/if}
            {#if canAutoAnimate}<button class="pick-morph" onclick={animateRest}>Auto-animate the rest…</button>{/if}
          </div>
        {/if}
        {#if curTargetEl && curBeatIndex > 0}
          <div class="dacts">
            <button class="pick-morph" onclick={armBecome} title="Pick another object on the slide (or draw one): this object turns into it at this step">Become an object…</button>
            {#if curTargetEl.type === "plot"}
              <button class="pick-morph" onclick={() => onChooseMorph?.(curTargetEl.id, curTrack?.id)} title="Keep the frame; the plot's data becomes another project plot's">Data from gallery…</button>
            {/if}
            {#if curTrack.to?.assetId}
              <button class="pick-morph" onclick={keepOwnContent} title="Drop the data target — the plot keeps its own content">Keep own data</button>
            {/if}
          </div>
        {/if}
      </div>
    {:else if allMedia}
      <label class="f">Action<kbd class="kc" title="shortcut: p">p</kbd>
        <select data-fld="p" aria-label="Video action" value={curTrack.preset}
          onchange={event => patchTrack({ preset: event.currentTarget.value as PresetName, duration: 0 })}>
          <option value="videoStart">Start video</option><option value="videoPause">Pause video</option><option value="videoStop">Stop video</option>
        </select>
      </label>
      <div class="note">{curTrack.preset === "videoStart" ? "Starts from the first frame. Playback continues across steps until the clip ends or a Pause/Stop action runs." : curTrack.preset === "videoPause" ? "Freezes the current frame. A later Start action plays again from the beginning." : "Stops playback and returns to the first frame."} Appearance is controlled separately.</div>
    {:else if curFamily === "appearance" && !anyGhost && !anyMedia}
      <label class="f">Effect<kbd class="kc" title="shortcut: p">p</kbd>
        <select data-fld="p" value={curTrack.preset ?? "fade"} onchange={(e) => patchTrack({ preset: e.currentTarget.value as PresetName })}>
          {#each EDIT_PRESETS as p (p)}<option value={p}>{presetLabel(p)}</option>{/each}
        </select>
      </label>
    {/if}

    {@render overrideRow("preset")}
    {#if allCamera}
      <div class="f">
        <span class="fl">Path</span>
        <div class="seg" role="group" aria-label="Camera path">
          <button class="sg" class:on={!mixed(t => t.to?.path ?? "pole") && curTrack.to?.path !== "fly"}
            aria-pressed={!mixed(t => t.to?.path ?? "pole") && curTrack.to?.path !== "fly"} onclick={() => cameraPath("pole")}>Zoom</button>
          <button class="sg" class:on={!mixed(t => t.to?.path ?? "pole") && curTrack.to?.path === "fly"}
            aria-pressed={!mixed(t => t.to?.path ?? "pole") && curTrack.to?.path === "fly"} onclick={() => cameraPath("fly")}>Fly</button>
        </div>
      </div>
      {#if flySuggestion !== undefined}
        <button class="camera-duration" data-camera-duration={flySuggestion} onclick={applyFlyDuration}
          title="Apply the suggested Fly duration to the selected camera tracks">suggested {flySuggestion} ms <span>Apply</span></button>
      {/if}
    {/if}

    <div class="start-row">
      {#if anchored}
        <div class="anchor-description">{#if sameAnchor}after {anchorTrack ? anchorName(anchorTrack) : "missing effect"} {rawTrack!.anchor!.edge} {mixed(t => t.anchor?.offsetMs ?? 0) ? "+ mixed offset" : `${(rawTrack!.anchor!.offsetMs ?? 0) < 0 ? "−" : "+"} ${Math.abs(rawTrack!.anchor!.offsetMs ?? 0)} ms`}{:else}Mixed timing anchors{/if}</div>
        {#if !sameAnchor}<div class="note">Offsets apply to the anchored effects in this selection.</div>{/if}
        <label class="f">offset<kbd class="kc" title="shortcut: t">t</kbd>
          <span class="unit"><input data-fld="t" aria-label="Timing anchor offset" type="number" step="50" placeholder="Mixed" value={mixed(t => t.anchor?.offsetMs ?? 0) ? "" : rawSelTracks.find(t => t.anchor)?.anchor?.offsetMs ?? 0} onchange={e => offset(e.currentTarget.value)}/><small>ms</small></span>
        </label>
        <div class="f"><small>Start {mixed(t => t.start ?? 0) ? "mixed" : `${curTrack.start ?? 0} ms`}</small><button class="anchor-toggle" aria-label="Detach timing anchor" onclick={detachAnchor}>⛓ Detach</button></div>
      {:else}
        <label class="f">start<kbd class="kc" title="shortcut: t">t</kbd>
          <span class="unit"><input data-fld="t" type="number" min="0" step="50" placeholder="Mixed" value={mixed(t => t.start ?? 0) ? "" : curTrack.start ?? 0} onchange={(e) => timing("start", e.currentTarget.value)} /><small>ms</small></span>
        </label>
        {#if !editingStyle}<button class="anchor-toggle" aria-label="Follow timing" aria-expanded={anchorOpen} onclick={() => anchorOpen = !anchorOpen}>⛓ Follow timing…</button>{/if}
      {/if}
      {@render overrideRow("start")}
      {#if anchorOpen && !editingStyle}<div class="anchor-choices">
        {#each anchorChoices as t (t.id)}<div>{anchorName(t)} <button onclick={() => anchorTo(t.id!, "start")}>start</button><button onclick={() => anchorTo(t.id!, "end")}>end</button></div>{/each}
        {#if !anchorChoices.length}<div class="note">Add another effect in this step to follow its timing.</div>{/if}
      </div>{/if}
      {#if !editingStyle}{#each anchorIssues as issue}<div class="target-warning anchor-issue">{issue.reason}</div>{/each}{/if}
    </div>
    {#if !anyMedia}<label class="f">duration<kbd class="kc" title="shortcut: d">d</kbd>
      <span class="unit"><input data-fld="d" type="number" min="1" step="50" placeholder="Mixed" value={mixed(t => trackDuration(t)) ? "" : trackDuration(curTrack)} onchange={(e) => timing("duration", e.currentTarget.value)} /><small>ms</small></span>
    </label>{@render overrideRow("duration")}{/if}
    {#if curFamily === "appearance" && !anyGhost && !anyMedia}
      <label class="f">stagger<kbd class="kc" title="shortcut: g">g</kbd>
        <span class="unit"><input data-fld="g" type="number" min="0" step="10" value={curTrack.stagger?.perMs ?? 0} onchange={(e) => patchStagger({ perMs: +e.currentTarget.value })} /><small>ms</small></span>
      </label>
      {@render overrideRow("stagger")}
      {#if curTrack.stagger?.perMs}
        <label class="f">by
          <select value={curTrack.stagger?.by ?? "index"} onchange={(e) => patchStagger({ by: e.currentTarget.value as Stagger["by"] })}>
            <option value="index">order</option><option value="x">x →</option><option value="y">y ↑</option>
          </select>
        </label>
        <label class="f">from
          <select value={curTrack.stagger?.from ?? "start"} onchange={(e) => patchStagger({ from: e.currentTarget.value as Stagger["from"] })}>
            <option value="start">start</option><option value="end">end</option><option value="center">center</option><option value="edges">edges</option>
          </select>
        </label>
      {/if}
    {/if}
    {#if isWipe}
      <label class="f">direction
        <select value={(curTrack.params?.direction as string) ?? "ltr"} title="Which way the reveal/wipe travels"
          onchange={(e) => { const v = e.currentTarget.value; editFields((t, resolved) => { const p = { ...(resolved.params ?? {}) }; if (v === "ltr") delete p.direction; else p.direction = v; t.params = Object.keys(p).length || t.styleId ? p : undefined; }); }}>
          <option value="ltr">left → right</option>
          <option value="rtl">right → left</option>
          <option value="ttb">top → bottom</option>
          <option value="btt">bottom → top</option>
        </select>
      </label>
    {/if}
    {#if isTrim}
      <!-- TRIM PATHS (rework §5) — the featured draw controls: where the draw
           anchors, which way it runs, single/both-ends/middle-out, and the
           final [from,to] window. Defaults keep the legacy compile path. -->
      <div class="trim">
        <div class="tl">Trim path</div>
        <div class="f seg2" role="group" aria-label="Trim mode">
          <button class="sg2" class:on={(trimP.mode ?? "single") === "single"} title="One window grows from the anchor" onclick={() => setTrim("mode", "single")}>single</button>
          <button class="sg2" class:on={trimP.mode === "both-ends"} title="Draw from both ends, meet in the middle" onclick={() => setTrim("mode", "both-ends")}>both ends</button>
          <button class="sg2" class:on={trimP.mode === "middle-out"} title="Grow outward from the anchor symmetrically" onclick={() => setTrim("mode", "middle-out")}>middle out</button>
        </div>
        <div class="f">
          <span class="fl">direction</span>
          <button class="dirb" class:on={(trimP.direction ?? "forward") === "forward"} title="Along the stroke direction" onclick={() => setTrim("direction", "forward")}>⟳ fwd</button>
          <button class="dirb" class:on={trimP.direction === "reverse"} title="Against the stroke direction" onclick={() => setTrim("direction", "reverse")}>⟲ rev</button>
        </div>
        <div class="f anch">
          <span class="fl">anchor</span>
          {#if trimGeoKind === "shape"}
            <span class="pad" role="group" aria-label="Draw anchor">
              {#each PAD as p, i (i)}
                {#if p}
                  <button class="pb" class:on={trimP.anchor === p} title={`Draw from ${p.replace("corner-", "the ")} ${p.startsWith("corner") ? "corner" : "edge midpoint"}`}
                    onclick={() => setTrim("anchor", p)}>{PAD_GLYPH[p]}</button>
                {:else}
                  <span class="pb void"></span>
                {/if}
              {/each}
            </span>
          {:else}
            <span class="unit">
              <button class="dirb" class:on={trimP.anchor == null || trimP.anchor === 0 || trimP.anchor === "start"} onclick={() => setTrim("anchor", 0)}>start</button>
              <button class="dirb" class:on={trimP.anchor === "middle" || trimP.anchor === 0.5} onclick={() => setTrim("anchor", "middle")}>mid</button>
              <button class="dirb" class:on={trimP.anchor === "end" || trimP.anchor === 1} onclick={() => setTrim("anchor", "end")}>end</button>
            </span>
          {/if}
        </div>
        <div class="f">
          <span class="fl" title="Fine anchor position along the stroke, 0–1 (overrides the pad)">at</span>
          <span class="unit">
            <input type="number" min="0" max="1" step="0.05" value={typeof trimP.anchor === "number" ? trimP.anchor : ""}
              placeholder={anchorIsNamed ? String(trimP.anchor) : "0"}
              onchange={(e) => { const v = e.currentTarget.value; setTrim("anchor", v === "" ? 0 : Math.max(0, Math.min(1, Number(v)))); }} />
          </span>
        </div>
        <div class="f">
          <span class="fl" title="Partial trim: the final drawn window of the stroke (fractions 0–1)">window</span>
          <span class="unit">
            <input type="number" min="0" max="1" step="0.05" value={trimP.from ?? 0} title="from" onchange={(e) => setTrim("from", Math.max(0, Math.min(1, Number(e.currentTarget.value))))} />
            <small>→</small>
            <input type="number" min="0" max="1" step="0.05" value={trimP.to ?? 1} title="to" onchange={(e) => setTrim("to", Math.max(0, Math.min(1, Number(e.currentTarget.value))))} />
          </span>
        </div>
      </div>
    {/if}
    {#if isTrim || isWipe}{@render overrideRow("params")}{/if}
    {#if !anyMedia}
      <CurveField tracks={editingStyle ? [curTrack] : selTracks} contextKey={`${slide.id}:${$selTrackIds.join(",")}:${editingStyleId ?? ""}`} onChange={changeCurve} />
      {#if ["easing", "influence", "curve"].some(k => overridden(k as StyleField))}
        <div class="override-row" data-override="curve"><span class="mx">override</span><button aria-label="Use style curve" onclick={resetCurve}>↺ use style</button></div>
      {/if}
    {/if}

    {#if selTracks.length === 1 && !anyMedia}
      {#if savingPreset}
        <div class="psave">
          <!-- svelte-ignore a11y_autofocus -->
          <input autofocus placeholder="Preset name…" value={presetName}
            oninput={(e) => (presetName = e.currentTarget.value)}
            onkeydown={(e) => { if (e.key === "Enter") void doSavePreset(); if (e.key === "Escape") savingPreset = false; e.stopPropagation(); }} />
          <button onclick={() => void doSavePreset()}>Save</button>
        </div>
      {:else}
        <button class="saveas" onclick={() => (savingPreset = true)}
          title="Save these exact settings as a reusable preset (☆ Library applies it to any object)">
          Save as {curFamily === "transform" ? "Transform" : curTrack.preset ?? "fade"} preset
        </button>
      {/if}
    {/if}

    {#if !editingStyle}<div class="acts">
      <button class="mini" title="Duplicate the selected track(s) — ⌘D" onclick={duplicateSelectedTracks}>⧉</button>
      <button class="mini" class:warn={anyDisabled} title={anyDisabled ? "Enable (x)" : "Disable — kept but not played (x)"} onclick={toggleSelectedDisabled}>{anyDisabled ? "◌" : "⏻"}</button>
      {#if selTracks.length >= 2}
        <button class="mini" title="Cascade a timing property across the selected tracks — ⌃⇧C" onclick={openTrackCascade}>⋯⃕</button>
      {/if}
      <span class="sp"></span>
      <button class="del" onclick={deleteSelectedTracks}>Delete</button>
    </div>{/if}
  {/if}
</div>

<style>
  .props {
    min-width: 0; display: flex; flex-direction: column; gap: 8px;
    padding: 0 10px 10px; overflow-y: auto; background: transparent;
    font: 12px/1.35 var(--font-ui); -webkit-font-smoothing: antialiased; color: var(--c-tx);
  }
  .props.tx { background: transparent; }
  /* section header: an eyebrow on a 28px line, hairline spanning the pane */
  .ttl {
    display: flex; align-items: center; height: 28px; flex: 0 0 auto; margin: 0 -10px; padding: 0 10px;
    border-bottom: 1px solid var(--c-line);
    font: 600 10.5px var(--font-mono); text-transform: uppercase; letter-spacing: .08em; color: var(--c-tx-muted);
  }
  .hint, .note { color: var(--c-tx-muted); font-size: 11px; line-height: 1.5; }
  .note b { color: var(--c-tx-2); font-weight: 600; }
  .camera-duration { display: flex; justify-content: space-between; align-items: center; min-height: 24px; padding: 3px 6px; font: 11px var(--font-mono); color: var(--c-tx-muted); background: transparent; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); cursor: var(--cursor-cross-hover); }
  .camera-duration span { font-family: var(--font-ui); color: var(--c-tx-2); }
  .camera-duration:hover { border-color: var(--c-tx-muted); }
  .target-warning { color: var(--c-warning); font-size: 11px; line-height: 1.5; }

  .hd { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-height: 20px; }
  .hd .nm { font-weight: 600; color: var(--c-tx-hi); box-shadow: inset 2px 0 0 var(--pc); padding-left: 7px; }
  .mx {
    font: 600 9.5px var(--font-mono); text-transform: uppercase; letter-spacing: .05em; line-height: 16px;
    border: 1px solid; border-radius: var(--r-ui); padding: 0 4px;
  }
  .style-picker, .style-menu button, .override-row button, .anchor-toggle, .anchor-choices button, .editing-style button {
    font: 11px var(--font-ui); color: var(--c-tx-2); background: transparent; border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui); padding: 3px 6px; cursor: var(--cursor-cross-hover);
  }
  .style-picker { color: var(--pc); }
  .style-picker:disabled, .style-menu button:disabled { opacity: .5; cursor: var(--cursor-cross); }
  .style-menu { display: flex; flex-direction: column; border: 1px solid var(--c-line-strong); background: var(--c-surface); padding: 3px; }
  .style-menu button { text-align: left; border: 0; min-height: 24px; }
  .style-menu button:hover:not(:disabled) { background: var(--c-accent-tint); }
  .editing-style { padding: 6px; border-left: 2px solid var(--c-accent); background: var(--c-accent-tint); line-height: 1.6; }
  .editing-style button { display: block; margin-top: 4px; }
  .override-row { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-top: -4px; }
  .override-row button { border: 0; color: var(--c-accent); }
  .anchor-description { font-size: 11px; color: var(--c-tx-2); overflow-wrap: anywhere; }
  .anchor-choices { display: grid; gap: 4px; padding: 4px 0; }
  .anchor-choices button { margin-left: 3px; }
  .start-row { display: grid; gap: 4px; }
  .mx { color: var(--c-tx-muted); border-color: var(--c-line-strong); }

  /* fields: label left, control right, 24px rows, mono values */
  .f { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-height: 24px; color: var(--c-tx-muted); }
  .f .fl { flex: 0 0 auto; }
  .unit { display: inline-flex; align-items: center; gap: 3px; }
  .f small { color: var(--c-tx-muted); font-size: 11px; }
  .props select, .props input {
    height: 24px; font: 12px var(--font-ui); color: var(--c-tx); background: var(--c-bg);
    border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); padding: 2px 6px;
  }
  .props input { font: 12px var(--font-mono); font-variant-numeric: tabular-nums; }
  .props select:focus, .props input:focus { border-color: var(--c-accent); outline: none; }
  .f select { max-width: 175px; min-width: 90px; }
  .f input { width: 56px; }
  .f input[data-fld="t"], .f input[data-fld="d"], .f input[data-fld="g"] { width: 68px; }

  /* buttons: square, hairline, flat; toggled = accent tint + accent border */
  .pick-morph, .dirb, .mini, .psave button, .saveas, .del, .dclear, .dx, .sg, .sg2, .pb {
    font: 12px var(--font-ui); line-height: 1; color: var(--c-tx-2); background: transparent;
    border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); cursor: var(--cursor-cross-hover);
  }
  .pick-morph, .psave button, .saveas, .del { height: 24px; padding: 3px 8px; }
  .pick-morph { text-align: left; }
  .pick-morph:disabled { opacity: .5; cursor: var(--cursor-cross); }
  .pick-morph:hover, .psave button:hover, .mini:hover, .dirb:hover, .pb:hover { border-color: var(--c-tx-muted); color: var(--c-tx-hi); }
  .dirb { height: 20px; padding: 0 6px; font-size: 11px; }
  .dirb.on, .pb.on { background: var(--c-accent-tint); border-color: var(--c-accent); color: var(--c-tx-hi); }

  /* joined segments: shared 1px borders, outer radius only */
  .seg, .seg2 { display: flex; gap: 0; border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); overflow: hidden; }
  .seg { width: max-content; }
  .sg, .sg2 { border: 0; border-radius: 0; height: 22px; }
  .sg { padding: 0 12px; }
  .sg2 { flex: 1; padding: 0 4px; font-size: 11px; white-space: nowrap; }
  .sg + .sg, .sg2 + .sg2 { border-left: 1px solid var(--c-line-strong); }
  .sg:hover, .sg2:hover { color: var(--c-tx-hi); background: var(--c-surface-2); }
  .sg.on, .sg2.on { background: var(--c-accent-tint); color: var(--c-tx-hi); box-shadow: inset 0 0 0 1px var(--c-accent); }

  /* blocks: an eyebrow under a hairline, never a bordered box */
  .delta, .dest, .trim { border-top: 1px solid var(--c-line); padding-top: 6px; }
  .delta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .dest, .trim { display: flex; flex-direction: column; gap: 5px; }
  .delta .dl, .dest .dl, .trim .tl {
    font: 600 10.5px var(--font-mono); text-transform: uppercase; letter-spacing: .08em; color: var(--c-tx-muted);
  }
  .dest .dv { font-size: 12px; color: var(--c-tx); line-height: 1.4; }
  .dest .warn { color: var(--c-warning); }
  .dacts { display: flex; flex-wrap: wrap; gap: 4px; }
  .dchip {
    display: inline-flex; align-items: center; gap: 2px; height: 18px;
    font: 11px var(--font-mono); color: var(--c-tx-2);
    border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); padding: 0 2px 0 5px;
  }
  .dx { border: 0; padding: 0 2px; font-size: 9px; color: var(--c-tx-muted); }
  .dx:hover { color: var(--c-danger); }
  .dclear { margin-left: auto; border: 0; padding: 0 2px; font-size: 11px; color: var(--c-tx-muted); }
  .dclear:hover { color: var(--c-danger); }
  .anch { align-items: flex-start; }
  .pad { display: grid; grid-template-columns: repeat(3, 18px); gap: 2px; }
  .pb { width: 18px; height: 18px; padding: 0; font-size: 8px; color: var(--c-tx-muted); }
  .pb.void { border: 0; background: none; cursor: var(--cursor-cross); }

  /* hotkey glyph: a 16px square on the accent tint */
  .kc {
    display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px;
    margin-left: 4px; border-radius: var(--r-ui); vertical-align: middle;
    font: 600 11px var(--font-mono); color: var(--c-accent); background: var(--c-accent-tint);
  }

  .saveas { text-align: center; background: var(--c-accent-tint); border-color: var(--c-accent); color: var(--c-tx-hi); }
  .saveas:hover { border-color: var(--c-accent-bright); }
  .psave { display: flex; gap: 4px; }
  .psave input { flex: 1; min-width: 0; }
  .acts { display: flex; align-items: center; gap: 4px; margin-top: auto; padding-top: 6px; border-top: 1px solid var(--c-line); }
  .sp { flex: 1; }
  .mini { width: 22px; height: 22px; padding: 0; font-size: 11px; }
  .mini.warn { color: var(--c-warning); }
  .del { border-color: transparent; color: var(--c-danger); }
  .del:hover { background: color-mix(in oklab, var(--c-danger) 12%, transparent); border-color: color-mix(in oklab, var(--c-danger) 45%, transparent); }
</style>
