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
  import { selTrackIds, endpointEdit, enterEndpointEdit } from "../../../../lib/slide/store";
  import { familyOf } from "../../../../lib/slide/family";
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
        <div class="delta" title="The properties this transform changes at t₂">
          Δ {changedProps.join(", ")}
        </div>
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
    font-size: 10px; color: #879a39; border: 1px dashed color-mix(in oklab, #66800b 45%, transparent);
    border-radius: 4px; padding: 3px 6px; overflow: hidden; text-overflow: ellipsis;
  }
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
