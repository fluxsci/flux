<script lang="ts">
  // The animation preset/template LIBRARY popover (rework §7) — reachable
  // from the Animator bar. Presets tab: apply one track's saved settings to
  // the current selection (smart per-kind targeting under the preset's
  // settings). Templates tab: apply a preset BUNDLE onto a matching object
  // set (the selected plot part container / plot / element set), one labeled
  // TrackGroup, one undo step, partial matches reported; save the currently
  // selected lanes as a new template.
  import { get } from "svelte/store";
  import { activeBeat, commitDeckLive, selTrackIds } from "../../../../lib/slide/store";
  import { selection, partSelection, activeFigureId } from "../../../../lib/store";
  import { plotManifests } from "../../../../lib/plot/store";
  import { slideById, addBeat as addBeatOp, setAnimation, setTransform, groupTracks } from "../../../../lib/slide/ops";
  import { suggestElementTrack, suggestTrack, animatePart } from "../../../../lib/slide/autobuild";
  import {
    applyTemplate, deriveTemplateSlots, makeAnimPreset,
    type AnimPreset, type AnimTemplate, type TemplateScope,
  } from "../../../../lib/slide/animTemplates";
  import {
    listAnimPresets, listAnimTemplates, saveAnimTemplate, deleteAnimEntry, type AnimLibEntry,
  } from "../../../../lib/slide/animPresets";
  import { pushToast } from "../../../../lib/toast";
  import type { Slide, Track } from "../../../../lib/slide/types";
  import { PRESET_COLOR } from "./shared";

  let { slide, onClose }: { slide: Slide; onClose: () => void } = $props();

  let tab = $state<"presets" | "templates">("presets");
  let presets = $state<AnimLibEntry<AnimPreset>[]>([]);
  let templates = $state<AnimLibEntry<AnimTemplate>[]>([]);
  let saveName = $state("");
  let el = $state<HTMLDivElement | null>(null);

  async function refresh() {
    presets = await listAnimPresets();
    templates = await listAnimTemplates();
  }
  $effect(() => {
    void refresh();
  });

  /** Ensure a build beat and return its id (never beat 0). */
  function buildBeatId(d: import("../../../../lib/slide/types").Deck, sid: string): string {
    const s = slideById(d, sid)!;
    if (s.beats.length <= 1) addBeatOp(d, sid, { label: "Beat 1", advance: "click" });
    const bi = Math.min(Math.max(1, get(activeBeat)), slideById(d, sid)!.beats.length - 1);
    return slideById(d, sid)!.beats[bi].id;
  }

  function applyPreset(entry: AnimLibEntry<AnimPreset>) {
    const sid = get(activeFigureId);
    const ps = get(partSelection);
    const ids = ps ? [ps.elementId] : [...get(selection)];
    if (!sid || !ids.length) {
      pushToast("info", "Select an object first — the preset applies to the selection.");
      return;
    }
    // $state deep-proxies the loaded entries — snapshot before structuredClone
    const p = $state.snapshot(entry.payload) as AnimPreset;
    const newIds: string[] = [];
    commitDeckLive((d) => {
      const beatId = buildBeatId(d, sid);
      for (const id of ids) {
        if (p.family === "transform") {
          const t = setTransform(d, sid, beatId, id, {
            start: p.track.start, duration: p.track.duration, easing: p.track.easing, influence: p.track.influence,
          });
          if (t?.id) newIds.push(t.id);
          continue;
        }
        const s = slideById(d, sid)!;
        const el2 = s.elements.find((e) => e.id === id);
        if (!el2) continue;
        // smart target defaults under the preset's settings (preset wins)
        const base: Track = ps
          ? suggestTrack($plotManifests[(el2 as { assetId?: string }).assetId ?? ""], id, ps.partId)
          : suggestElementTrack(el2);
        const track: Track = { ...base, ...structuredClone(p.track), target: id, ...(ps ? { part: ps.partId } : {}) };
        setAnimation(d, sid, beatId, track);
        if (track.id) newIds.push(track.id);
      }
    });
    if (newIds.length) selTrackIds.set(newIds);
    pushToast("info", `Applied “${p.name}” to ${ids.length} object${ids.length > 1 ? "s" : ""}`);
    onClose();
  }

  function templateScope(): TemplateScope | null {
    const ps = get(partSelection);
    if (ps) return { kind: "part-container", elementId: ps.elementId, partId: ps.partId };
    const ids = [...get(selection)];
    if (ids.length) return { kind: "elements", ids };
    return null;
  }

  function applyTpl(entry: AnimLibEntry<AnimTemplate>) {
    const sid = get(activeFigureId);
    const scope = templateScope();
    if (!sid || !scope) {
      pushToast("info", "Select the target first — a plot part (like an axis), a plot, or a set of elements.");
      return;
    }
    const tpl = $state.snapshot(entry.payload) as AnimTemplate; // un-proxy before cloning
    const ctx = {
      elements: slide.elements,
      manifestFor: (id: string) => {
        const e = slide.elements.find((x) => x.id === id);
        return e && "assetId" in e ? $plotManifests[(e as { assetId: string }).assetId] : undefined;
      },
    };
    const res = applyTemplate(tpl, scope, ctx);
    if (!res.tracks.length) {
      pushToast("error", `“${tpl.name}” matched nothing here`, { detail: res.unmatched.join("\n") });
      return;
    }
    const newIds: string[] = [];
    commitDeckLive((d) => {
      const beatId = buildBeatId(d, sid);
      for (const t of res.tracks) {
        setAnimation(d, sid, beatId, t);
        if (t.id) newIds.push(t.id);
      }
      groupTracks(d, sid, beatId, newIds, tpl.name);
    });
    selTrackIds.set(newIds);
    pushToast(
      res.matched === res.total ? "info" : "error",
      `Applied ${res.matched}/${res.total} — “${tpl.name}”`,
      res.unmatched.length ? { detail: res.unmatched.join("\n") } : undefined,
    );
    onClose();
  }

  async function saveTemplateFromSelection() {
    const name = saveName.trim();
    const ids = get(selTrackIds);
    if (!name) {
      pushToast("info", "Name the template first.");
      return;
    }
    if (!ids.length) {
      pushToast("info", "Select the lanes to bundle (in the rail), then save.");
      return;
    }
    const tracks = slide.beats.flatMap((b) => b.tracks).filter((t) => t.id && ids.includes(t.id));
    const { slots, skipped } = deriveTemplateSlots(tracks, {
      elements: slide.elements,
      manifestFor: (id: string) => {
        const e = slide.elements.find((x) => x.id === id);
        return e && "assetId" in e ? $plotManifests[(e as { assetId: string }).assetId] : undefined;
      },
    });
    if (!slots.length) {
      pushToast("error", "Nothing templatable in the selection", { detail: skipped.join("\n") });
      return;
    }
    const tpl: AnimTemplate = { fluxPreset: 1, kind: "animTemplate", name, savedAt: new Date().toISOString(), slots };
    if (await saveAnimTemplate(tpl)) {
      pushToast("info", `Saved template “${name}” (${slots.length} slot${slots.length > 1 ? "s" : ""})`,
        skipped.length ? { detail: `Skipped: ${skipped.join("; ")}` } : undefined);
      saveName = "";
      await refresh();
    } else pushToast("error", "Couldn't save the template.");
  }

  async function remove(kind: "preset" | "template", rel: string) {
    await deleteAnimEntry(kind, rel);
    await refresh();
  }

  function onWin(e: PointerEvent) {
    if (el && !el.contains(e.target as Node)) onClose();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onpointerdown={onWin} onkeydown={onKey} />
<div class="animlib" bind:this={el} role="dialog" aria-label="Animation presets and templates">
  <div class="tabs">
    <button class="tab" class:on={tab === "presets"} onclick={() => (tab = "presets")}>Presets</button>
    <button class="tab" class:on={tab === "templates"} onclick={() => (tab = "templates")}>Templates</button>
    <button class="x" onclick={onClose}>✕</button>
  </div>
  {#if tab === "presets"}
    {#if !presets.length}
      <div class="empty">No saved presets yet — select a track and use “Save as preset” in the Properties pane.</div>
    {/if}
    <div class="list">
      {#each presets as p (p.rel)}
        <div class="row" style={`--pc:${PRESET_COLOR[p.payload.track.preset ?? "fade"] ?? (p.payload.family === "transform" ? "#66800b" : "#888")}`}>
          <button class="apply" title={`Apply to the selection (${p.payload.family})`} onclick={() => applyPreset(p)}>
            <span class="dot"></span>{p.payload.name}
            <small>{p.payload.family === "transform" ? "transform" : p.payload.track.preset ?? "fade"}</small>
          </button>
          <button class="del" title="Delete this preset" onclick={() => remove("preset", p.rel)}>✕</button>
        </div>
      {/each}
    </div>
  {:else}
    {#if !templates.length}
      <div class="empty">No templates yet — select several lanes in the rail, name a bundle below, and save.</div>
    {/if}
    <div class="list">
      {#each templates as t (t.rel)}
        <div class="row" style="--pc:#8b7ec8">
          <button class="apply" title={`Apply onto the selected scope — ${t.payload.slots.length} slots`} onclick={() => applyTpl(t)}>
            <span class="dot"></span>{t.payload.name}
            <small>{t.payload.slots.length} slots</small>
          </button>
          <button class="del" title="Delete this template" onclick={() => remove("template", t.rel)}>✕</button>
        </div>
      {/each}
    </div>
    <div class="save">
      <input placeholder="Template name…" value={saveName} oninput={(e) => (saveName = e.currentTarget.value)}
        onkeydown={(e) => { if (e.key === "Enter") void saveTemplateFromSelection(); e.stopPropagation(); }} />
      <button onclick={() => void saveTemplateFromSelection()} title="Bundle the selected lanes into a reusable template (part lanes save their ROLE; element lanes their type + order)">Save selection</button>
    </div>
  {/if}
</div>

<style>
  .animlib {
    position: absolute; bottom: calc(100% + 4px); left: 0; z-index: 30; width: 260px;
    display: flex; flex-direction: column; gap: 0; padding: 0;
    background: var(--c-surface); border: 1px solid var(--c-line-strong);
    border-radius: var(--r-panel); box-shadow: var(--elev-2);
    font: 12px/1.35 var(--font-ui); -webkit-font-smoothing: antialiased; color: var(--c-tx);
  }
  /* header: the two tabs on one 30px line, hairline below */
  .tabs { display: flex; align-items: center; height: 30px; padding: 0 4px 0 2px; border-bottom: 1px solid var(--c-line); }
  .tab {
    height: 30px; padding: 0 10px; font: 12px var(--font-ui); color: var(--c-tx-muted);
    background: none; border: 0; border-radius: 0; cursor: pointer;
  }
  .tab:hover { color: var(--c-tx-hi); }
  .tab.on { color: var(--c-tx-hi); box-shadow: inset 0 -2px 0 var(--c-accent); }
  .x {
    margin-left: auto; width: 20px; height: 20px; padding: 0; border: 0; border-radius: var(--r-ui);
    background: none; color: var(--c-tx-muted); cursor: pointer; font-size: 11px;
  }
  .x:hover { color: var(--c-tx-hi); background: var(--c-surface-2); }
  .empty { color: var(--c-tx-muted); font-size: 11px; line-height: 1.5; padding: 8px 10px 4px; }
  .list { display: flex; flex-direction: column; gap: 0; max-height: 210px; overflow-y: auto; padding: 4px 0; }
  .row { display: flex; align-items: center; gap: 0; }
  .apply {
    flex: 1; display: flex; align-items: center; gap: 6px; text-align: left; height: 24px; min-width: 0;
    border: 0; border-radius: 0; background: none; color: var(--c-tx); padding: 0 10px; cursor: pointer;
    font: 12px var(--font-ui);
  }
  .apply:hover { background: var(--c-surface-2); color: var(--c-tx-hi); }
  .apply .dot { width: 7px; height: 7px; border-radius: 1px; background: var(--pc); flex: 0 0 auto; }
  .apply small { margin-left: auto; color: var(--c-tx-muted); font: 10px var(--font-mono); }
  .del { border: 0; background: none; color: var(--c-tx-faint); cursor: pointer; font-size: 9px; height: 24px; padding: 0 8px; }
  .del:hover { color: var(--c-danger); }
  .save { display: flex; gap: 4px; border-top: 1px solid var(--c-line); padding: 6px; }
  .save input {
    flex: 1; min-width: 0; height: 24px; font: 12px var(--font-mono); color: var(--c-tx); background: var(--c-bg);
    border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); padding: 2px 6px;
  }
  .save input:focus { border-color: var(--c-accent); outline: none; }
  .save button {
    height: 24px; font: 12px var(--font-ui); color: var(--c-tx-2); background: transparent;
    border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); padding: 3px 8px; cursor: pointer; white-space: nowrap;
  }
  .save button:hover { border-color: var(--c-tx-muted); color: var(--c-tx-hi); }
</style>
