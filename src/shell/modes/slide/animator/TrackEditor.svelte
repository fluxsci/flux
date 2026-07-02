<script lang="ts">
  // The per-track editor strip — bulk-edits EVERY selected track in one commit
  // (preset / duration / start / stagger / easing / AE-style influence), plus
  // duplicate, disable, delete. Field values come from the PRIMARY (last
  // selected); "mixed" flags disagreement.
  import { selTrackIds } from "../../../../lib/slide/store";
  import type { Slide, Track, PresetName, Stagger, Influence } from "../../../../lib/slide/types";
  import { PRESET_COLOR, EDIT_PRESETS, EASINGS, INFLUENCE_PRESETS, chipLabel } from "./shared";
  import { withSelectedTracks, deleteSelectedTracks, duplicateSelectedTracks, toggleSelectedDisabled } from "./trackActions";

  let { slide, plotTags }: { slide: Slide; plotTags: Map<string, string> } = $props();

  const selTracks = $derived.by(() => {
    const all = slide.beats.flatMap((b) => b.tracks);
    return $selTrackIds.map((id) => all.find((t) => t.id === id)).filter((t): t is Track => !!t);
  });
  const curTrack = $derived(selTracks.length ? selTracks[selTracks.length - 1] : null);
  function mixed<T>(get: (t: Track) => T): boolean {
    const vs = selTracks.map(get);
    return vs.length > 1 && vs.some((v) => v !== vs[0]);
  }
  const anyDisabled = $derived(selTracks.some((t) => t.disabled));

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
</script>

{#if curTrack}
  <div class="track-editor">
    <span class="te-nm" style={`--pc:${PRESET_COLOR[curTrack.preset ?? "fade"] ?? "#888"}`}>{selTracks.length > 1 ? `${selTracks.length} tracks` : chipLabel(curTrack, slide, plotTags)}</span>
    {#if selTracks.length > 1 && (mixed((t) => t.preset) || mixed((t) => t.duration ?? 400) || mixed((t) => t.start ?? 0) || mixed((t) => t.stagger?.perMs ?? 0) || mixed((t) => t.easing ?? "standard"))}
      <span class="te-mixed" title="Selected tracks differ on some fields — editing a field sets it on ALL of them">mixed</span>
    {/if}
    <label>preset<kbd class="kc" title="shortcut: p">p</kbd>
      <select data-fld="p" value={curTrack.preset ?? "fade"} onchange={(e) => patchTrack({ preset: e.currentTarget.value as PresetName })}>
        {#each EDIT_PRESETS as p (p)}<option value={p}>{p}</option>{/each}
      </select>
    </label>
    <label>dur<kbd class="kc" title="shortcut: d">d</kbd> <input data-fld="d" type="number" min="0" step="50" value={curTrack.duration ?? 400} onchange={(e) => patchTrack({ duration: +e.currentTarget.value })} /><small>ms</small></label>
    <label>start<kbd class="kc" title="shortcut: t">t</kbd> <input data-fld="t" type="number" min="0" step="50" value={curTrack.start ?? 0} onchange={(e) => patchTrack({ start: +e.currentTarget.value })} /><small>ms</small></label>
    <label>stagger<kbd class="kc" title="shortcut: g">g</kbd> <input data-fld="g" type="number" min="0" step="10" value={curTrack.stagger?.perMs ?? 0} onchange={(e) => patchStagger({ perMs: +e.currentTarget.value })} /><small>ms</small></label>
    {#if curTrack.stagger?.perMs}
      <label>by
        <select value={curTrack.stagger?.by ?? "index"} onchange={(e) => patchStagger({ by: e.currentTarget.value as Stagger["by"] })}>
          <option value="index">order</option><option value="x">x →</option><option value="y">y ↑</option>
        </select>
      </label>
      <label>from
        <select value={curTrack.stagger?.from ?? "start"} onchange={(e) => patchStagger({ from: e.currentTarget.value as Stagger["from"] })}>
          <option value="start">start</option><option value="end">end</option><option value="center">center</option><option value="edges">edges</option>
        </select>
      </label>
    {/if}
    <label>ease<kbd class="kc" title="shortcut: e">e</kbd>
      <select data-fld="e" value={curTrack.easing ?? "standard"} onchange={(e) => patchTrack({ easing: e.currentTarget.value as Track["easing"] })}>
        {#each EASINGS as ee (ee)}<option value={ee}>{ee}</option>{/each}
      </select>
    </label>
    <span class="infl" title="Velocity profile (After Effects influence). out = slow-out at the start, in = slow-in at the end. When either is > 0 it overrides the named ease.">
      <small>infl</small>
      <input data-fld="o" type="number" min="0" max="100" step="5" value={curTrack.influence?.out ?? 0} onchange={(e) => setInfluence({ out: +e.currentTarget.value })} /><small>out<kbd class="kc" title="shortcut: o">o</kbd></small>
      <input type="number" min="0" max="100" step="5" value={curTrack.influence?.in ?? 0} onchange={(e) => setInfluence({ in: +e.currentTarget.value })} /><small>in</small>
      <span class="ipresets">
        {#each INFLUENCE_PRESETS as p (p.name)}
          <button class="ichip" class:on={inflActive(p)} title={`out ${p.out} · in ${p.in}`} onclick={() => applyInfluencePreset(p)}>{p.name}</button>
        {/each}
      </span>
    </span>
    <span class="spacer"></span>
    <button class="mini" title="Duplicate the selected track(s) — ⌘D" onclick={duplicateSelectedTracks}>⧉</button>
    <button class="mini" class:warn={anyDisabled} title={anyDisabled ? "Enable (x)" : "Disable — kept but not played (x)"} onclick={toggleSelectedDisabled}>{anyDisabled ? "◌" : "⏻"}</button>
    <button class="del" onclick={deleteSelectedTracks}>Delete</button>
    <button class="closex" title="Close editor" onclick={() => selTrackIds.set([])}>✕</button>
  </div>
{/if}

<style>
  .track-editor {
    flex: 0 0 auto; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 6px 8px; border: 1px solid var(--c-accent, #4385be); border-radius: 6px;
    background: color-mix(in oklab, var(--c-accent, #4385be) 8%, var(--c-bg-2, #1c1b1a));
    font-size: 11px;
  }
  .te-nm { font-weight: 600; color: var(--c-tx-hi, #cecdc3); border-left: 3px solid var(--pc); padding-left: 6px; }
  .te-mixed {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--c-tx-3, #878580); border: 1px solid var(--c-line, #403e3c);
    border-radius: 3px; padding: 0 4px;
  }
  .track-editor label { display: inline-flex; align-items: center; gap: 4px; color: var(--c-tx-3, #878580); }
  .track-editor small { color: var(--c-tx-3, #6f6e69); }
  .track-editor select, .track-editor input {
    font-size: 11px; color: var(--c-tx, #cecdc3); background: var(--c-bg, #100f0f);
    border: 1px solid var(--c-line-strong, #343331); border-radius: 4px; padding: 2px 5px;
  }
  .track-editor input { width: 52px; }
  .infl { display: inline-flex; align-items: center; gap: 3px; color: var(--c-tx-3, #878580); }
  .infl input { width: 42px; }
  .ipresets { display: inline-flex; gap: 2px; margin-left: 4px; }
  .ichip {
    font-size: 10px; color: var(--c-tx-3, #878580); background: var(--c-bg, #100f0f);
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
  .spacer { flex: 1; }
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
  .closex { border: none; background: none; color: var(--c-tx-3, #6f6e69); cursor: pointer; font-size: 11px; padding: 2px; }
</style>
