<script lang="ts">
  import { onDestroy } from "svelte";
  import { readPlotNote, type PlotNote } from "./notes";
  import { acquireNoteDraft } from "./noteDrafts";
  import type { NoteDraft, NoteDraftState } from "./noteDraftCore";
  import { nativeClick, nativeEvent } from "../ui/nativeEvents";
  const nativeInput = nativeEvent("input"), nativeBlur = nativeEvent("blur"), nativeKey = nativeEvent("keydown");
  let { note, onSaved, missing = false, named = true }: {
    note: PlotNote; onSaved?: () => void; missing?: boolean;
    /** The bar names the file (off where note tabs already do). */
    named?: boolean;
  } = $props();
  let noteState = $state.raw<NoteDraftState>({ text: "", saved: "", pending: false, error: "" });
  let controller = $state.raw<NoteDraft | null>(null);
  let loading = $state(true), loadError = $state("");
  let componentAlive = true;
  onDestroy(() => { componentAlive = false; });
  const dirty = $derived(noteState.text !== noteState.saved);
  $effect(() => {
    const n = note;
    let alive = true, release: (() => void) | undefined, unsubscribe: (() => void) | undefined;
    loading = true; loadError = ""; controller = null;
    void readPlotNote(n).then(text => {
      if (!alive) return;
      const handle = acquireNoteDraft(n, text);
      controller = handle.draft; release = handle.release;
      unsubscribe = handle.draft.subscribe(s => { noteState = s; });
    }).catch(e => { if (alive) loadError = String(e?.message ?? e); }).finally(() => { if (alive) loading = false; });
    return () => { alive = false; unsubscribe?.(); release?.(); };
  });
  export function hasDraft() { const st = controller?.current(); return !!st && (st.pending || st.text !== st.saved); }
  export async function flush() {
    const draft = controller;
    try { await draft?.flush(); const st = draft?.current(); return !st || (!st.pending && st.text === st.saved); }
    catch { return false; }
  }
  async function save() {
    const draft = controller, callback = onSaved;
    if (missing || !draft) return;
    try { await draft.flush(); if (componentAlive && draft === controller) callback?.(); }
    catch { /* The controller retains the failed draft and its shell owner. */ }
  }
  $effect(() => {
    const st = noteState, draft = controller;
    if (!draft || st.pending || st.error || st.text === st.saved || loading || missing) return;
    const timer = setTimeout(() => { void save(); }, 400);
    return () => clearTimeout(timer);
  });
  async function reload() {
    const draft = controller, n = note;
    if (!draft || noteState.pending) return;
    try { const text = await readPlotNote(n); if (componentAlive && draft === controller) { draft.reload(text); loadError = ""; } }
    catch(e) { if (componentAlive) loadError = String((e as Error)?.message ?? e); }
  }
  async function restoreMissing() {
    const draft = controller, callback = onSaved;
    if (!draft || noteState.pending) return;
    try {
      // Explicit recovery recreates only a missing file; a reappearing external file wins.
      await draft.restore();
      if (componentAlive && draft === controller) { loadError = ""; callback?.(); }
    } catch(e) { if (componentAlive) loadError = String((e as Error)?.message ?? e); }
  }
</script>
<div class="note-editor" data-plot-note={note.path}>
  <div class="bar" class:floating={!named}>{#if named}<span class="nm">{note.group ? `${note.group}/` : ""}{note.name}</span>{/if}<span class="grow"></span><span class="status" aria-live="polite" title="Notes save as you type · Ctrl+S saves now">{noteState.pending ? "Saving…" : loading ? "Opening…" : dirty ? "Unsaved" : controller ? "Saved" : ""}</span></div>
  {#if missing}<p class="error"><button disabled={noteState.pending} use:nativeClick={restoreMissing}>Restore deleted note</button></p>{/if}
  {#if loadError || noteState.error}<p class="error" role="alert">{loadError || noteState.error} <button disabled={noteState.pending} use:nativeClick={reload}>Discard draft and reload</button></p>{/if}
  <textarea aria-label={`Notes in ${note.name}`} spellcheck="false" disabled={loading || !controller} value={noteState.text} use:nativeInput={e => controller?.edit((e.currentTarget as HTMLTextAreaElement).value)} use:nativeBlur={() => void save()} use:nativeKey={e => { if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.key.toLowerCase() === "s")) { e.preventDefault(); e.stopPropagation(); void save(); } }} placeholder="Write a note about this plot. Tags such as #TODO are searchable across plots. Notes save as you type."></textarea>
</div>
<style>
  .note-editor { position:relative; display:flex; flex-direction:column; flex:1; min-height:130px; background:var(--c-bg-raised); font:11.5px var(--font-ui); }
  .bar { display:flex; align-items:center; gap:6px; padding:5px 8px; border-bottom:1px solid var(--c-line); min-width:0; }
  /* Without a name the status floats in the field's corner instead of taking a row. */
  .bar.floating { position:absolute; top:4px; right:10px; z-index:1; padding:0; border:0; pointer-events:none; }
  .bar .nm { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font:11px var(--font-mono); color:var(--c-tx-hi); }
  .grow { flex:1; } .status { color:var(--c-tx-muted); font-size:10px; }
  button { padding:2px 7px; background:none; color:var(--c-tx); border:1px solid var(--c-line-strong); border-radius:var(--r-ui); font:inherit; } button:disabled { opacity:.4; } button:hover:not(:disabled) { border-color:var(--c-accent); }
  textarea { flex:1; min-height:100px; width:100%; box-sizing:border-box; resize:none; padding:9px; border:0; outline:0; background:var(--c-bg); color:var(--c-tx); font:12px/1.55 var(--font-mono); user-select:text; }
  textarea:focus { box-shadow:inset 0 0 0 1px var(--c-accent); }
  .error { margin:0; padding:6px 8px; color:var(--c-danger); overflow-wrap:anywhere; }
</style>
