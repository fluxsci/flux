<script lang="ts">
  import { activeBeat, selTrackIds, commitDeckLive } from "../../../../lib/slide/store";
  import { selection, partSelection } from "../../../../lib/store";
  import { duplicateTrack } from "../../../../lib/slide/ops";
  import type { Slide } from "../../../../lib/slide/types";
  import { ghostBirth, ghostSiblings, objectLabel } from "./ghostEditing";
  let {slide, onEditGhost}: {slide: Slide; onEditGhost: (id: string) => void} = $props();
  const curTrack = $derived(slide.beats.flatMap(b => b.tracks).find(t => t.id === $selTrackIds[$selTrackIds.length - 1]));
  const ghostContext = $derived.by(() => {
    const id = curTrack?.target ?? [...$selection][0];
    if (!id) return null;
    const birth = ghostBirth(slide, id);
    if (birth) return birth;
    const sourceBirth = slide.beats[$activeBeat]?.tracks.find(t => t.ghostFrom === id);
    return sourceBirth ? {track: sourceBirth, beatIndex: $activeBeat} : null;
  });
  const copies = $derived(ghostContext ? ghostSiblings(slide, ghostContext) : []);
  const selectedCopyIndex = $derived(copies.findIndex(t => $selection.has(t.target)));
  function selectCopy(id: string) { onEditGhost?.(id); }
  function selectOriginal() {
    const id = ghostContext?.track.ghostFrom;
    if (!id) return;
    selection.set(new Set([id])); partSelection.set(null);
    selTrackIds.set((slide.beats[ghostContext!.beatIndex]?.tracks ?? []).filter(t => t.target === id).map(t => t.id!).filter(Boolean));
  }
  function addCopy() {
    const birth = ghostContext;
    if (!birth?.track.id) return;
    const target = commitDeckLive(d => {
      const id = duplicateTrack(d, slide.id, birth.track.id!);
      const track = d.slides.find(s => s.id === slide.id)?.beats.flatMap(b => b.tracks).find(t => t.id === id);
      if (track) track.to = {state: {}};
      return track?.target;
    });
    if (target) selectCopy(target);
  }
</script>

  {#if ghostContext}
    <section class="ghost-copies" aria-label="Ghost copies">
      <strong>Ghosts of {objectLabel(slide, ghostContext.track.ghostFrom!)}</strong>
      <small>Born at step {ghostContext.beatIndex} · independent destinations</small>
      <label>Copy <select aria-label="Selected ghost" value={selectedCopyIndex >= 0 ? copies[selectedCopyIndex].target : ""} onchange={e => selectCopy(e.currentTarget.value)}>
        <option value="" disabled>Select a copy</option>
        {#each copies as copy}<option value={copy.target}>{objectLabel(slide, copy.target)}{copy.disabled ? " (disabled)" : ""}</option>{/each}
      </select></label>
      {#if selectedCopyIndex >= 0}
        <label>Name <input aria-label="Ghost name" value={objectLabel(slide, copies[selectedCopyIndex].target)} onchange={e => {
          const name = e.currentTarget.value.trim(), id = copies[selectedCopyIndex].target;
          if (name) commitDeckLive(d => { const el = d.slides.find(s => s.id === slide.id)?.elements.find(e => e.id === id); if (el) el.name = name; });
        }}/></label>
      {/if}
      <div class="copy-actions">
        <button aria-label="Previous ghost" disabled={selectedCopyIndex <= 0} onclick={() => selectCopy(copies[selectedCopyIndex - 1].target)}>←</button>
        <button aria-label="Next ghost" disabled={selectedCopyIndex >= copies.length - 1} onclick={() => selectCopy(copies[selectedCopyIndex + 1].target)}>→</button>
        <button onclick={addCopy}>Add copy</button><button onclick={selectOriginal}>Select original</button>
      </div>
    </section>
  {/if}
<style>
  /* a rail section: hairline below, no box-in-box */
  .ghost-copies {
    display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; margin: 0;
    border: 0; border-bottom: 1px solid var(--c-line); border-radius: 0;
    font: 12px/1.35 var(--font-ui); -webkit-font-smoothing: antialiased; color: var(--c-tx);
  }
  .ghost-copies strong { font-weight: 600; color: var(--c-tx); }
  .ghost-copies small { color: var(--c-tx-muted); font-size: 11px; margin-top: -4px; }
  .ghost-copies label { display: flex; gap: 8px; align-items: center; justify-content: space-between; min-height: 24px; color: var(--c-tx-muted); }
  .ghost-copies select, .ghost-copies input { min-width: 0; flex: 1; max-width: 170px; }
  .copy-actions { display: flex; flex-wrap: wrap; gap: 4px; }
  button, select, input {
    height: 24px; font: 12px var(--font-ui); color: var(--c-tx); background: transparent;
    border: 1px solid var(--c-line-strong); border-radius: var(--r-ui); padding: 2px 8px;
  }
  select, input { background: var(--c-bg); padding: 2px 6px; }
  input { font: 12px var(--font-mono); }
  button { cursor: var(--cursor-cross-hover); color: var(--c-tx-2); }
  button:hover:not(:disabled) { border-color: var(--c-tx-muted); color: var(--c-tx-hi); }
  button:disabled { opacity: .4; cursor: var(--cursor-cross); }
  select:focus, input:focus { border-color: var(--c-accent); outline: none; }
  button:focus-visible { outline: 1px solid var(--c-accent); outline-offset: 1px; }
</style>
