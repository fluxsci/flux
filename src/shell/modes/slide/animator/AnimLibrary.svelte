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
    position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 30; width: 250px;
    display: flex; flex-direction: column; gap: 6px;
    background: var(--c-bg-2, #1c1b1a); border: 1px solid var(--c-line-strong, #343331);
    border-radius: 8px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45); padding: 8px;
    font-size: 11px;
  }
  .tabs { display: flex; gap: 4px; align-items: center; }
  .tab {
    font-size: 11px; color: var(--c-tx-3, #878580); background: none;
    border: 1px solid var(--c-line, #403e3c); border-radius: 4px; padding: 2px 9px; cursor: pointer;
  }
  .tab.on { color: var(--c-tx-hi, #fff); border-color: var(--c-accent, #4385be); background: color-mix(in oklab, var(--c-accent, #4385be) 16%, transparent); }
  .x { margin-left: auto; border: none; background: none; color: var(--c-tx-3, #6f6e69); cursor: pointer; }
  .empty { color: var(--c-tx-3, #878580); font-size: 10.5px; line-height: 1.5; padding: 2px 2px 4px; }
  .list { display: flex; flex-direction: column; gap: 2px; max-height: 210px; overflow-y: auto; }
  .row { display: flex; align-items: center; gap: 2px; }
  .apply {
    flex: 1; display: flex; align-items: center; gap: 6px; text-align: left;
    border: none; background: none; color: var(--c-tx, #cecdc3); border-radius: 4px;
    padding: 4px 6px; cursor: pointer; font-size: 11px;
  }
  .apply:hover { background: color-mix(in oklab, var(--pc) 16%, transparent); }
  .apply .dot { width: 7px; height: 7px; border-radius: 2px; background: var(--pc); flex: 0 0 auto; }
  .apply small { margin-left: auto; color: var(--c-tx-3, #6f6e69); font-size: 9.5px; }
  .del { border: none; background: none; color: var(--c-tx-faint, #575653); cursor: pointer; font-size: 9px; padding: 2px 4px; }
  .del:hover { color: var(--c-danger, #d14d41); }
  .save { display: flex; gap: 4px; border-top: 1px solid var(--c-line, #282726); padding-top: 7px; }
  .save input {
    flex: 1; font-size: 11px; color: var(--c-tx, #cecdc3); background: var(--c-bg, #100f0f);
    border: 1px solid var(--c-line-strong, #343331); border-radius: 4px; padding: 3px 6px;
  }
  .save button {
    font-size: 10.5px; color: var(--c-tx-2, #b7b5ac); background: var(--c-bg, #100f0f);
    border: 1px solid var(--c-line-strong, #343331); border-radius: 4px; padding: 3px 8px; cursor: pointer;
  }
  .save button:hover { border-color: var(--c-accent, #4385be); color: var(--c-tx-hi, #fff); }
</style>
