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
  // keyboard cockpit). The accent border reads pink for appearances, green
  // for transforms — the mockups' color language.
  import { selTrackIds, endpointEdit, enterEndpointEdit, refreshEndpointDisplay, commitDeckLive } from "../../../../lib/slide/store";
  import { familyOf } from "../../../../lib/slide/family";
  import { morphCompatible } from "../../../../lib/slide/player/morph";
  import { plotManifests } from "../../../../lib/plot/store";
  import type { Slide, Track, PresetName, Stagger, Influence } from "../../../../lib/slide/types";
  import { PRESET_COLOR, EDIT_PRESETS, EASINGS, INFLUENCE_PRESETS, chipLabel } from "./shared";
  import { withSelectedTracks, deleteSelectedTracks, duplicateSelectedTracks, toggleSelectedDisabled } from "./trackActions";

  let { slide, plotTags }: { slide: Slide; plotTags: Map<string, string> } = $props();

  const selTracks = $derived.by(() => {
    const all = slide.beats.flatMap((b) => b.tracks);
    return $selTrackIds.map((id) => all.find((t) => t.id === id)).filter((t): t is Track => !!t);
  });
  const curTrack = $derived(selTracks.length ? selTracks[selTracks.length - 1] : null);
  const curFamily = $derived(curTrack ? familyOf(curTrack) : null);
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
      (mixed((t) => t.preset) || mixed((t) => t.duration ?? 400) || mixed((t) => t.start ?? 0) ||
        mixed((t) => t.stagger?.perMs ?? 0) || mixed((t) => t.easing ?? "standard")),
  );

  const patchTrack = (p: Partial<Track>) => withSelectedTracks((t) => Object.assign(t, p));
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
    const mine = ee.entries.some((en) => en.trackId === curTrack.id || (ee.end === "t1" && en.target === curTrack.target));
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
  const morphTargets = $derived.by(() => {
    if (curTargetEl?.type !== "plot" || curFamily !== "transform") return [];
    const m = $plotManifests;
    const A = m[curTargetEl.assetId];
    return slide.elements
      .filter((e) => e.type === "plot" && e.id !== curTargetEl.id)
      .map((e) => {
        const assetId = (e as { assetId: string }).assetId;
        return { assetId, label: [plotTags.get(e.id), m[assetId]?.plotType].filter(Boolean).join(" · ") || assetId, compatible: morphCompatible(A, m[assetId]) };
      });
  });
  function setMorphTarget(assetId: string) {
    withCurTrack((t) => {
      t.to = { ...(t.to ?? {}) };
      if (!assetId) {
        delete t.to.assetId;
        delete t.to.svgPath;
        delete t.to.manifestPath;
      } else t.to.assetId = assetId;
    });
  }

  // --- trim-path params (drawOn/drawOff — rework §5) -------------------------
  const isTrim = $derived(curFamily === "appearance" && (curTrack?.preset === "drawOn" || curTrack?.preset === "drawOff"));
  const isWipe = $derived(curFamily === "appearance" && (curTrack?.preset === "writeOn" || curTrack?.preset === "wipeOut"));
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

<div class="props" class:tx={curFamily === "transform"}>
  <div class="ttl">Properties</div>
  {#if !curTrack}
    <div class="hint">
      Select a lane — or select an object on the canvas (or in the X-ray) and press
      <kbd>⌃⇧A</kbd> appear · <kbd>⌃⇧D</kbd> disappear · <kbd>⌃⇧T</kbd> transform.
    </div>
  {:else}
    <div class="hd" style={`--pc:${PRESET_COLOR[curTrack.preset ?? "fade"] ?? "#888"}`}>
      <span class="nm">
        {#if selTracks.length > 1}{selTracks.length} tracks{:else}{groupLabel ? `${groupLabel} › ` : ""}{chipLabel(curTrack, slide, plotTags)}{/if}
      </span>
      {#if curFamily === "transform"}
        <span class="chip">transform</span>
      {:else if selTracks.length === 1}
        <span class="chip">{curTrack.preset ?? "fade"}</span>
      {/if}
      {#if anyMixed}<span class="mx" title="Selected tracks differ on some fields — editing a field sets it on ALL of them">mixed</span>{/if}
    </div>

    {#if curFamily === "transform" && selTracks.length === 1}
      <!-- the endpoint segment: t1 shows the before, t2 checks out the after -->
      <div class="seg" role="group" aria-label="Transform endpoint">
        <button class="sg" class:on={epActive === "t1"} title="Show/edit t₁ — the state the object transforms FROM"
          onclick={() => selectEndpoint("t1")}>t₁</button>
        <button class="sg" class:on={epActive === "t2"} title="Check out t₂ — edit the object on the canvas with every tool; the diff records here"
          onclick={() => selectEndpoint("t2")}>t₂</button>
      </div>
      {#if epActive === "t2"}
        <div class="note">Editing <b>t₂</b> — change the object on the canvas (position, size, shape, colors, text…). Esc when done.</div>
      {:else if epActive === "t1"}
        <div class="note">Editing <b>t₁</b> — this rewrites the previous transform's end state.</div>
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
      {#if morphTargets.length}
        <label class="f">data morph
          <select value={curTrack.to?.assetId ?? ""} title="Also morph the plot's DATA into another plot on the slide (same-structure plots only) while the frame transforms"
            onchange={(e) => setMorphTarget(e.currentTarget.value)}>
            <option value="">none</option>
            {#each morphTargets as m (m.assetId)}
              <option value={m.assetId} disabled={!m.compatible}>{m.label}{m.compatible ? "" : " (incompatible)"}</option>
            {/each}
          </select>
        </label>
      {/if}
    {:else if curFamily !== "transform"}
      <label class="f">preset<kbd class="kc" title="shortcut: p">p</kbd>
        <select data-fld="p" value={curTrack.preset ?? "fade"} onchange={(e) => patchTrack({ preset: e.currentTarget.value as PresetName })}>
          {#each EDIT_PRESETS as p (p)}<option value={p}>{p}</option>{/each}
        </select>
      </label>
    {/if}

    <label class="f">start<kbd class="kc" title="shortcut: t">t</kbd>
      <span class="unit"><input data-fld="t" type="number" min="0" step="50" value={curTrack.start ?? 0} onchange={(e) => patchTrack({ start: +e.currentTarget.value })} /><small>ms</small></span>
    </label>
    <label class="f">duration<kbd class="kc" title="shortcut: d">d</kbd>
      <span class="unit"><input data-fld="d" type="number" min="0" step="50" value={curTrack.duration ?? (curFamily === "transform" ? 600 : 400)} onchange={(e) => patchTrack({ duration: +e.currentTarget.value })} /><small>ms</small></span>
    </label>
    {#if curFamily !== "transform"}
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
    <label class="f">easing<kbd class="kc" title="shortcut: e">e</kbd>
      <select data-fld="e" value={curTrack.easing ?? (curFamily === "transform" ? "smooth" : "standard")} onchange={(e) => patchTrack({ easing: e.currentTarget.value as Track["easing"] })}>
        {#each EASINGS as ee (ee)}<option value={ee}>{ee}</option>{/each}
      </select>
    </label>
    <div class="f infl" title="Velocity profile (After Effects influence). out = slow-out at the start, in = slow-in at the end. When either is > 0 it overrides the named ease.">
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

    <div class="acts">
      <button class="mini" title="Duplicate the selected track(s) — ⌘D" onclick={duplicateSelectedTracks}>⧉</button>
      <button class="mini" class:warn={anyDisabled} title={anyDisabled ? "Enable (x)" : "Disable — kept but not played (x)"} onclick={toggleSelectedDisabled}>{anyDisabled ? "◌" : "⏻"}</button>
      <span class="sp"></span>
      <button class="del" onclick={deleteSelectedTracks}>Delete</button>
    </div>
  {/if}
</div>

<style>
  .props {
    flex: 0 0 208px; min-width: 0; display: flex; flex-direction: column; gap: 7px;
    border: 1.5px solid color-mix(in oklab, #ce5d97 65%, transparent); border-radius: 9px;
    padding: 7px 9px 9px; overflow-y: auto; font-size: 11px;
    background: color-mix(in oklab, #ce5d97 4%, transparent);
  }
  .props.tx { border-color: color-mix(in oklab, #66800b 70%, transparent); background: color-mix(in oklab, #66800b 5%, transparent); }
  .ttl {
    font-size: 12px; font-style: italic; font-weight: 600; color: var(--c-tx-2, #b7b5ac);
    letter-spacing: 0.02em; margin-bottom: -1px;
  }
  .hint { color: var(--c-tx-3, #878580); line-height: 1.55; font-size: 10.5px; }
  .hint kbd {
    padding: 0 3px; border-radius: 3px; font: 600 9px var(--font-mono, ui-monospace, monospace);
    color: var(--c-tx-2, #878580); background: var(--c-bg-2, #1c1b1a); border: 1px solid var(--c-line, #403e3c);
  }
  .hd { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
  .hd .nm { font-weight: 600; color: var(--c-tx-hi, #cecdc3); border-left: 3px solid var(--pc); padding-left: 6px; }
  .hd .chip {
    font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--pc); border: 1px solid color-mix(in oklab, var(--pc) 55%, transparent);
    border-radius: 3px; padding: 0 4px;
  }
  .mx {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--c-tx-3, #878580); border: 1px solid var(--c-line, #403e3c);
    border-radius: 3px; padding: 0 4px;
  }
  .seg { display: flex; gap: 0; border: 1px solid color-mix(in oklab, #66800b 55%, transparent); border-radius: 5px; overflow: hidden; width: max-content; }
  .sg {
    font: 600 11px var(--font-mono, ui-monospace, monospace); color: #66800b;
    background: var(--c-bg, #100f0f); border: none; padding: 3px 14px; cursor: pointer;
  }
  .sg + .sg { border-left: 1px solid color-mix(in oklab, #66800b 45%, transparent); }
  .sg.on { color: var(--c-bg, #100f0f); background: #879a39; }
  .note { color: var(--c-tx-3, #878580); font-size: 10px; line-height: 1.5; }
  .note b { color: var(--c-tx-2, #b7b5ac); }
  .delta {
    display: flex; flex-wrap: wrap; align-items: center; gap: 3px;
    font-size: 10px; color: #879a39; border: 1px dashed color-mix(in oklab, #66800b 45%, transparent);
    border-radius: 4px; padding: 3px 6px;
  }
  .delta .dl { font-weight: 700; }
  .dchip {
    display: inline-flex; align-items: center; gap: 2px;
    border: 1px solid color-mix(in oklab, #66800b 40%, transparent); border-radius: 3px; padding: 0 2px 0 4px;
    color: var(--c-tx-2, #b7b5ac);
  }
  .dx { border: none; background: none; color: var(--c-tx-3, #878580); cursor: pointer; font-size: 8px; padding: 0 2px; }
  .dx:hover { color: var(--c-danger, #d14d41); }
  .dclear {
    margin-left: auto; border: none; background: none; cursor: pointer;
    color: var(--c-tx-3, #878580); font-size: 9px; text-decoration: underline dotted;
  }
  .dclear:hover { color: var(--c-danger, #d14d41); }
  .trim {
    display: flex; flex-direction: column; gap: 5px;
    border: 1px solid color-mix(in oklab, #4385be 35%, transparent); border-radius: 6px; padding: 5px 7px;
  }
  .trim .tl { font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #4385be; }
  .seg2 { display: flex; gap: 0; border: 1px solid var(--c-line-strong, #343331); border-radius: 4px; overflow: hidden; }
  .sg2 {
    flex: 1; font-size: 9.5px; color: var(--c-tx-3, #878580); background: var(--c-bg, #100f0f);
    border: none; padding: 2px 4px; cursor: pointer; white-space: nowrap;
  }
  .sg2 + .sg2 { border-left: 1px solid var(--c-line, #282726); }
  .sg2.on { color: var(--c-on-accent, #fff); background: var(--c-accent, #4385be); }
  .dirb {
    font-size: 9.5px; color: var(--c-tx-3, #878580); background: var(--c-bg, #100f0f);
    border: 1px solid var(--c-line, #403e3c); border-radius: 3px; padding: 1px 6px; cursor: pointer;
  }
  .dirb.on { color: var(--c-on-accent, #fff); background: var(--c-accent, #4385be); border-color: var(--c-accent, #4385be); }
  .anch { align-items: flex-start; }
  .pad { display: grid; grid-template-columns: repeat(3, 17px); gap: 2px; }
  .pb {
    width: 17px; height: 15px; padding: 0; font-size: 8px; line-height: 1; cursor: pointer;
    color: var(--c-tx-3, #878580); background: var(--c-bg, #100f0f);
    border: 1px solid var(--c-line, #403e3c); border-radius: 3px;
  }
  .pb:hover { color: var(--c-tx-hi, #cecdc3); border-color: var(--c-tx-3, #878580); }
  .pb.on { color: var(--c-on-accent, #fff); background: var(--c-accent, #4385be); border-color: var(--c-accent, #4385be); }
  .pb.void { border: none; background: none; cursor: default; }
  .f { display: flex; align-items: center; justify-content: space-between; gap: 6px; color: var(--c-tx-3, #878580); }
  .f .fl { flex: 0 0 auto; }
  .unit { display: inline-flex; align-items: center; gap: 3px; }
  .f select, .f input {
    font-size: 11px; color: var(--c-tx, #cecdc3); background: var(--c-bg, #100f0f);
    border: 1px solid var(--c-line-strong, #343331); border-radius: 4px; padding: 2px 5px;
  }
  .f input { width: 52px; }
  .f small { color: var(--c-tx-3, #6f6e69); }
  .infl { flex-wrap: wrap; }
  .infl input { width: 42px; }
  .ipresets { display: flex; gap: 2px; flex-wrap: wrap; }
  .ichip {
    font-size: 9.5px; color: var(--c-tx-3, #878580); background: var(--c-bg, #100f0f);
    border: 1px solid var(--c-line, #403e3c); border-radius: 3px; padding: 1px 5px; cursor: pointer;
  }
  .ichip:hover { color: var(--c-tx-hi, #cecdc3); border-color: var(--c-tx-3, #878580); }
  .ichip.on { color: var(--c-on-accent, #fff); background: var(--c-accent, #4385be); border-color: var(--c-accent, #4385be); }
  .kc {
    margin-left: 3px; padding: 0 3px; border-radius: 3px; vertical-align: middle;
    font: 600 9px/1.5 var(--font-mono, ui-monospace, monospace);
    color: var(--c-accent, #4385be);
    background: color-mix(in oklab, var(--c-accent, #4385be) 16%, transparent);
    border: 1px solid color-mix(in oklab, var(--c-accent, #4385be) 32%, transparent);
  }
  .acts { display: flex; align-items: center; gap: 4px; margin-top: auto; padding-top: 4px; }
  .sp { flex: 1; }
  .mini {
    font-size: 11px; width: 22px; height: 20px; padding: 0; cursor: pointer;
    border: 1px solid var(--c-line-strong, #343331); background: var(--c-bg-2, #1c1b1a);
    color: var(--c-tx-2, #b7b5ac); border-radius: 4px;
  }
  .mini:hover { border-color: var(--c-accent, #4385be); color: var(--c-tx-hi, #fff); }
  .mini.warn { color: var(--c-warning, #d0a215); }
  .del {
    font-size: 11px; color: var(--c-danger, #d14d41); background: none;
    border: 1px solid color-mix(in oklab, var(--c-danger, #d14d41) 50%, transparent);
    border-radius: 4px; padding: 3px 9px; cursor: pointer;
  }
  .del:hover { background: color-mix(in oklab, var(--c-danger, #d14d41) 14%, transparent); }
</style>
