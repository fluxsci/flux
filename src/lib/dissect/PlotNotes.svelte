<script lang="ts">
  import { listPlotNotes, plotNote, savePlotNote, notesRevision, type PlotNote } from "./notes";
  import { dissectionsRevision } from "../../shell/scholar/revisions";
  import TextNoteEditor from "./TextNoteEditor.svelte";
  let { root, plotKey, onChanged }: { root: string; plotKey: string; onChanged?: () => void } = $props();
  let notes = $state.raw<PlotNote[]>([]), chosen = $state.raw<PlotNote | null>(null), name = $state(""), adding = $state(false), error = $state("");
  let editor = $state<ReturnType<typeof TextNoteEditor>>();
  let revision = $state(0);
  let missingChosen = $state(false);
  $effect(() => {
    const r = root, k = plotKey; revision; $notesRevision; $dissectionsRevision;
    let alive = true;
    error = "";
    void listPlotNotes(r, k).then(files => {
      if (!alive) return;
      missingChosen = !!chosen && !files.some(n => n.path === chosen?.path);
      if (missingChosen && chosen && editor?.hasDraft()) {
        // An external deletion may not evict the only view of an unsaved draft.
        notes = [...files, chosen];
        error = "This note was removed outside Flux. Your draft is kept; copy it or restore the note.";
      } else {
        notes = files;
        if (!chosen || missingChosen) chosen = files[0] ?? null;
        missingChosen = false;
      }
    }).catch(e => { if (alive) error = String(e?.message ?? e); });
    return () => { alive = false; };
  });
  async function select(note: PlotNote) { if (editor && !(await editor.flush())) { error = "The current note could not be saved. Your draft is kept."; return; } error = ""; chosen = note; }
  async function create() {
    if (editor && !(await editor.flush())) { error = "The current note could not be saved. Your draft is kept."; return; }
    error = "";
    try {
      const filename = /\.txt$/i.test(name.trim()) ? name.trim() : `${name.trim()}.txt`;
      if (!name.trim()) throw new Error("Give the note a name");
      const note = plotNote(root, plotKey, "", filename);
      await savePlotNote(note, "", null);
      chosen = note; name = ""; adding = false; revision++; onChanged?.();
    } catch (e) { error = String((e as Error)?.message ?? e); }
  }
</script>
<div class="notes" data-plot-notes>
  <div class="files" aria-label="Plot notes">
    {#each notes as note (note.path)}<button class:chosen={chosen?.path === note.path} onclick={() => select(note)}>{note.group ? `${note.group}/` : ""}{note.name}</button>{/each}
    <button class="add" aria-label="Add plot note" onclick={() => adding = !adding}>+ Note</button>
  </div>
  {#if adding}<form onsubmit={e => { e.preventDefault(); void create(); }}><input aria-label="New note name" bind:value={name} placeholder="notes.txt" spellcheck="false" /><button>Create</button></form>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if chosen}<TextNoteEditor note={chosen} missing={missingChosen} bind:this={editor} onSaved={onChanged} />{:else}<p class="empty">Add a text note to this plot. Notes are stored with its dissections; search their contents with Notes in the gallery search.</p>{/if}
</div>
<style>
  .notes { display:flex; flex-direction:column; flex:1; min-height:0; } .files { display:flex; flex-wrap:wrap; gap:4px; padding:5px 8px; border-bottom:1px solid var(--c-line); }
  button { padding:3px 7px; border:1px solid var(--c-line-strong); border-radius:var(--r-ui); background:none; color:var(--c-tx-2); font:11px var(--font-mono); cursor:var(--cursor-cross-hover); } button:hover { color:var(--c-tx-hi); } button.chosen { color:var(--c-tx-hi); border-color:var(--c-accent); background:var(--c-accent-tint); } .add { color:var(--c-accent); }
  form { display:flex; gap:4px; padding:5px 8px; } input { flex:1; min-width:0; padding:4px; border:1px solid var(--c-line-strong); background:var(--c-bg); color:var(--c-tx); font:11px var(--font-mono); }
  .error,.empty { margin:0; padding:8px; color:var(--c-tx-muted); font:11.5px/1.5 var(--font-ui); } .error { color:var(--c-danger); }
</style>
