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
  import { selTrackIds, endpointEdit, enterEndpointEdit, refreshEndpointDisplay, commitDeckLive } from "../../../../lib/slide/store";
  import { objectLabel } from "./ghostEditing";
  import { familyOf } from "../../../../lib/slide/family";
  import { trackDuration } from "../../../../lib/slide/compile";
  import { morphCompatible } from "../../../../lib/slide/player/morph";
  import { plotManifests } from "../../../../lib/plot/store";
  import type { Slide, Track, PresetName, Stagger, Influence } from "../../../../lib/slide/types";
  import { PRESET_COLOR, EDIT_PRESETS, EASINGS, INFLUENCE_PRESETS, chipLabel, presetLabel, transformWay, WAY_LABEL } from "./shared";
  import { clearTransformContent } from "../../../../lib/slide/ops";
  import { buildPartTree, resolveTargets } from "../../../../lib/plot/tree";
  import { withSelectedTracks, deleteSelectedTracks, duplicateSelectedTracks, toggleSelectedDisabled } from "./trackActions";
  import { openTrackCascade } from "./cascadeTracks";
  import { makeAnimPreset } from "../../../../lib/slide/animTemplates";
  import { saveAnimPreset } from "../../../../lib/slide/animPresets";
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

  const selTracks = $derived.by(() => {
    const all = slide.beats.flatMap((b) => b.tracks);
    return $selTrackIds.map((id) => all.find((t) => t.id === id)).filter((t): t is Track => !!t);
  });
  const curTrack = $derived(selTracks.length ? selTracks[selTracks.length - 1] : null);
  const curFamily = $derived(curTrack ? familyOf(curTrack) : null);
  const curWay = $derived(curTrack && curFamily === "transform" ? transformWay(curTrack) : null);
  const curBeatIndex = $derived(curTrack ? slide.beats.findIndex((b) => b.tracks.some((t) => t.id === curTrack.id)) : -1);
  /** What the object becomes at this step, for the Destination row. */
  const destinationLabel = $derived.by(() => {
    if (!curTrack || curFamily !== "transform") return "";
    const st = (curTrack.to?.state ?? {}) as Record<string, unknown>;
    const kind = typeof st.type === "string" ? st.type : null;
    const data = curTrack.to?.assetId ? (curTrack.to.svgPath?.split("/").pop() || curTrack.to.assetId) : null;
    if (kind && data) return `Becomes a ${kind} showing ${data}`;
    if (kind) return `Becomes ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`;
    if (data) return `Data becomes ${data}`;
    return curWay === "ghost" ? "Its own destination after this step" : "The object's own state after this step";
  });
  const anyGhost = $derived(selTracks.some(t => !!t.ghostFrom));
  const anyMedia = $derived(selTracks.some(t => familyOf(t) === "media"));
  const allMedia = $derived(selTracks.length > 0 && selTracks.every(t => familyOf(t) === "media"));
  const groupLabel = $derived.by(() => {
    if (!curTrack?.groupId) return null;
    for (const b of slide.beats) {
      const g = b.groups?.find((x) => x.id === curTrack.groupId);
      if (g) return g.label;
    }
    return null;
  });
  function mixed<T>(get: (t: Track) => T): boolean {
    const vs = selTracks.map(get);
    return vs.length > 1 && vs.some((v) => v !== vs[0]);
  }
  const anyDisabled = $derived(selTracks.some((t) => t.disabled));
  const anyMixed = $derived(
    selTracks.length > 1 &&
      (mixed((t) => t.preset) || mixed((t) => trackDuration(t)) || mixed((t) => t.start ?? 0) ||
        mixed((t) => t.stagger?.perMs ?? 0) || mixed((t) => t.easing ?? "standard")),
  );

  const patchTrack = (p: Partial<Track>) => {
    if (anyGhost && ["target", "ghostFrom", "preset", "part", "selector"].some(key => key in p)) return;
    if (anyMedia && !allMedia && ["preset", "part", "selector", "target"].some(key => key in p)) return;
    withSelectedTracks((t) => Object.assign(t, p));
  };
  function timing(field: "start" | "duration", value: string) {
    const n = Number(value);
    if (value.trim() && Number.isFinite(n)) patchTrack({ [field]: Math.max(field === "start" ? 0 : 1, n) });
  }
  function patchStagger(p: Partial<Stagger>) {
    withSelectedTracks((t) => {
      if (p.perMs === 0) { delete t.stagger; return; }
      t.stagger = { perMs: t.stagger?.perMs ?? 40, ...t.stagger, ...p } as Stagger;
    });
  }
  function setInfluence(p: Partial<Influence>) {
    withSelectedTracks((t) => {
      const next = { in: 0, out: 0, ...t.influence, ...p } as Influence;
      if (next.in <= 0 && next.out <= 0) delete t.influence;
      else t.influence = { in: Math.max(0, Math.min(100, next.in)), out: Math.max(0, Math.min(100, next.out)) };
    });
  }
  function applyInfluencePreset(p: { in: number; out: number }) {
    withSelectedTracks((t) => { if (p.in <= 0 && p.out <= 0) delete t.influence; else t.influence = { in: p.in, out: p.out }; });
  }
  const inflActive = (p: { in: number; out: number }) =>
    !!curTrack && (curTrack.influence ? curTrack.influence.in === p.in && curTrack.influence.out === p.out : p.in === 0 && p.out === 0);

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
  function withCurTrack(fn: (t: Track) => void) {
    const id = curTrack?.id;
    if (!id) return;
    commitDeckLive((d) => {
      for (const s of d.slides) for (const b of s.beats) {
        const t = b.tracks.find((x) => x.id === id);
        if (t) fn(t);
      }
    });
    refreshEndpointDisplay();
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
    return morphCompatible(m[curTargetEl.assetId], m[curTrack.to.assetId]);
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
    withSelectedTracks((t) => {
      const p = { ...(t.params ?? {}) } as Record<string, unknown>;
      const isDefault = value === DEF[key] || value === "" || value == null || (key === "anchor" && (value === "start" || value === 0));
      if (isDefault) delete p[key];
      else p[key] = value;
      if (Object.keys(p).length) t.params = p;
      else delete t.params;
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

<div class="props" class:tx={curFamily === "transform"} data-command-scope="animation">
  <div class="ttl">Effect</div>
  {#if !curTrack}
    <div class="hint">
      Select an effect in the timeline to edit its target and timing. Select an object or plot part and use the animation actions to add an effect.
    </div>

  {:else}
    <div class="hd" style={`--pc:${PRESET_COLOR[curTrack.preset ?? "fade"] ?? "#888"}`}>
      <span class="nm">
        {#if selTracks.length > 1}{selTracks.length} tracks{:else}{groupLabel ? `${groupLabel} › ` : ""}{chipLabel(curTrack, slide, plotTags)}{/if}
      </span>
      {#if curFamily === "transform"}
        <span class="chip">transform · {WAY_LABEL[curWay ?? "change"]}</span>
      {:else if selTracks.length === 1}
        <span class="chip">{presetLabel(curTrack.preset ?? "fade")}</span>
      {/if}
      {#if anyMixed}<span class="mx" title="Selected tracks differ on some fields — editing a field sets it on ALL of them">mixed</span>{/if}
    </div>

    {#if targetMissing}<div class="target-warning">This target is missing. Choose an object or plot part below to reconnect the effect.</div>{/if}
    {#if curTrack.ghostFrom}
      <div class="note">Starts from <b>{objectLabel(slide, curTrack.ghostFrom)}</b> before this step. Edit this copy’s destination with <b>After</b>.</div>
    {/if}
    {#if anyGhost && selTracks.length > 1}
      <div class="note ghost-mixed-note">This selection includes ghost births. Timing and easing apply to all selected effects. Select one effect to edit its destination.</div>
    {/if}
    {#if anyMedia && !allMedia}<div class="note">This selection includes video controls. Start offsets apply to all selected effects; select a video control to edit its action.</div>{/if}
    {#if curTrack.target !== "@camera" && !anyGhost && (!anyMedia || allMedia)}
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

    {#if curFamily === "transform" && selTracks.length === 1}
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
      {#if changedProps.length}
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
        {#if curTargetEl && curBeatIndex > 0}
          <div class="dacts">
            <button class="pick-morph" onclick={() => onBecome?.(curTargetEl.id, curBeatIndex)} title="Pick another object on the slide (or draw one): this object turns into it at this step">Become an object…</button>
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

    <label class="f">start<kbd class="kc" title="shortcut: t">t</kbd>
      <span class="unit"><input data-fld="t" type="number" min="0" step="50" placeholder="Mixed" value={mixed(t => t.start ?? 0) ? "" : curTrack.start ?? 0} onchange={(e) => timing("start", e.currentTarget.value)} /><small>ms</small></span>
    </label>
    {#if !anyMedia}<label class="f">duration<kbd class="kc" title="shortcut: d">d</kbd>
      <span class="unit"><input data-fld="d" type="number" min="1" step="50" placeholder="Mixed" value={mixed(t => trackDuration(t)) ? "" : trackDuration(curTrack)} onchange={(e) => timing("duration", e.currentTarget.value)} /><small>ms</small></span>
    </label>{/if}
    {#if curFamily === "appearance" && !anyGhost && !anyMedia}
      <label class="f">stagger<kbd class="kc" title="shortcut: g">g</kbd>
        <span class="unit"><input data-fld="g" type="number" min="0" step="10" value={curTrack.stagger?.perMs ?? 0} onchange={(e) => patchStagger({ perMs: +e.currentTarget.value })} /><small>ms</small></span>
      </label>
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
          onchange={(e) => { const v = e.currentTarget.value; withSelectedTracks((t) => { const p = { ...(t.params ?? {}) }; if (v === "ltr") delete p.direction; else p.direction = v; if (Object.keys(p).length) t.params = p; else delete t.params; }); }}>
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
    {#if !anyMedia}<label class="f">easing<kbd class="kc" title="shortcut: e">e</kbd>
      <select data-fld="e" value={curTrack.easing ?? (curFamily === "transform" ? "smooth" : "standard")} onchange={(e) => patchTrack({ easing: e.currentTarget.value as Track["easing"], influence: undefined })}>
        {#each EASINGS as ee (ee)}<option value={ee}>{ee}</option>{/each}
      </select>
    </label>
    <details class="advanced"><summary>Custom easing {curTrack.influence ? "· active" : ""}</summary>
    <div class="f infl" title="Velocity profile. When active, this replaces the named easing above.">
      <span class="fl">influence</span>
      <span class="unit">
        <input data-fld="o" type="number" min="0" max="100" step="5" value={curTrack.influence?.out ?? 0} onchange={(e) => setInfluence({ out: +e.currentTarget.value })} /><small>out<kbd class="kc" title="shortcut: o">o</kbd></small>
        <input type="number" min="0" max="100" step="5" value={curTrack.influence?.in ?? 0} onchange={(e) => setInfluence({ in: +e.currentTarget.value })} /><small>in</small>
      </span>
      <span class="ipresets">
        {#each INFLUENCE_PRESETS as p (p.name)}
          <button class="ichip" class:on={inflActive(p)} title={`out ${p.out} · in ${p.in}`} onclick={() => applyInfluencePreset(p)}>{p.name}</button>
        {/each}
      </span>
    </div>
    </details>{/if}

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

    <div class="acts">
      <button class="mini" title="Duplicate the selected track(s) — ⌘D" onclick={duplicateSelectedTracks}>⧉</button>
      <button class="mini" class:warn={anyDisabled} title={anyDisabled ? "Enable (x)" : "Disable — kept but not played (x)"} onclick={toggleSelectedDisabled}>{anyDisabled ? "◌" : "⏻"}</button>
      {#if selTracks.length >= 2}
        <button class="mini" title="Cascade a timing property across the selected tracks — ⌃⇧C" onclick={openTrackCascade}>⋯⃕</button>
      {/if}
      <span class="sp"></span>
      <button class="del" onclick={deleteSelectedTracks}>Delete</button>
    </div>
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
  .target-warning { color: var(--c-warning); font-size: 11px; line-height: 1.5; }

  .hd { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-height: 20px; }
  .hd .nm { font-weight: 600; color: var(--c-tx-hi); box-shadow: inset 2px 0 0 var(--pc); padding-left: 7px; }
  .hd .chip, .mx {
    font: 600 9.5px var(--font-mono); text-transform: uppercase; letter-spacing: .05em; line-height: 16px;
    border: 1px solid; border-radius: var(--r-ui); padding: 0 4px;
  }
  .hd .chip { color: var(--pc); border-color: color-mix(in oklab, var(--pc) 55%, transparent); }
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
  .infl { flex-wrap: wrap; }
  .infl input { width: 46px; }

  /* buttons: square, hairline, flat; toggled = accent tint + accent border */
  .pick-morph, .dirb, .ichip, .mini, .psave button, .saveas, .del, .dclear, .dx, .sg, .sg2, .pb {
    font: 12px var(--font-ui); line-height: 1; color: var(--c-tx-2); background: transparent;
    border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); cursor: var(--cursor-cross-hover);
  }
  .pick-morph, .psave button, .saveas, .del { height: 24px; padding: 3px 8px; }
  .pick-morph { text-align: left; }
  .pick-morph:hover, .psave button:hover, .mini:hover, .dirb:hover, .ichip:hover, .pb:hover { border-color: var(--c-tx-muted); color: var(--c-tx-hi); }
  .dirb, .ichip { height: 20px; padding: 0 6px; font-size: 11px; }
  .dirb.on, .ichip.on, .pb.on { background: var(--c-accent-tint); border-color: var(--c-accent); color: var(--c-tx-hi); }
  .ipresets { display: flex; gap: 2px; flex-wrap: wrap; }

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
  .advanced { border-top: 1px solid var(--c-line); padding-top: 6px; }
  .advanced summary { cursor: var(--cursor-cross-hover); color: var(--c-tx-2); margin-bottom: 6px; }

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
