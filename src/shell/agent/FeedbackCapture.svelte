<script lang="ts">
  // "Note to agent" — the context-stamped quick-capture popover (Ctrl+Shift+M /
  // palette). The note is stamped with what the user is looking at RIGHT NOW
  // (figure/element/part, document + selection quote, slide + beat) and appended
  // to .meta/feedback.ndjson; Send marks the review-pass boundary.
  import { tick } from "svelte";
  import { popIn } from "../../lib/motion/actions";
  import { describeStamp, type FeedbackNote, type FeedbackStamp } from "../../lib/project/feedback";
  import { feedbackCaptureOpen, annotateCaptureOpen } from "../command/commandBus";
  import {
    addFeedbackNote,
    captureStamp,
    clearPendingSnapshot,
    feedbackState,
    pendingSnapshot,
    sendFeedback,
    setPendingSnapshot,
    snapshotOfNote,
    withdrawFeedbackNote,
  } from "./feedbackStore";

  let text = $state("");
  let stamp = $state<FeedbackStamp | null>(null);
  let busy = $state(false);
  let inputEl = $state<HTMLTextAreaElement | undefined>(undefined);
  /** The queued note being rewritten (Edit): Add to queue replaces it, Escape keeps it. */
  let editing = $state<FeedbackNote | null>(null);

  const openCount = $derived($feedbackState?.open.length ?? 0);
  // Newest first — the one you just sent by accident is on top.
  const queued = $derived([...($feedbackState?.open ?? [])].reverse());

  $effect(() => {
    if ($feedbackCaptureOpen) {
      if (!editing) void captureStamp().then((s) => (stamp = s));
      // The textarea mounts with the popover; focus it once it exists so the
      // first keystroke lands in the note, never on the canvas.
      void tick().then(() => inputEl?.focus());
    }
  });

  function close() {
    feedbackCaptureOpen.set(false);
    text = "";
    editing = null;
    clearPendingSnapshot(); // a cancelled note drops its snapshot (nothing was written)
  }
  /** Take a queued note back into the box: its text, its stamp and its snapshot. */
  async function edit(n: FeedbackNote) {
    if (busy) return;
    editing = n;
    text = n.text;
    stamp = n.context;
    setPendingSnapshot(await snapshotOfNote(n));
    inputEl?.focus();
  }
  async function withdraw(n: FeedbackNote) {
    if (busy) return;
    busy = true;
    try {
      await withdrawFeedbackNote(n.id);
      if (editing?.id === n.id) { editing = null; text = ""; clearPendingSnapshot(); }
    } finally {
      busy = false;
    }
  }
  /** Hand off to Snapshot & annotate: the popover hides, the draft text survives,
   *  and the overlay reopens the popover with the crop attached. */
  function annotate() {
    feedbackCaptureOpen.set(false);
    annotateCaptureOpen.set(true);
  }

  async function add(thenSend: boolean) {
    if (busy) return;
    busy = true;
    try {
      if (text.trim()) await addFeedbackNote(text, editing ? { replaces: editing.id, context: editing.context } : {});
      if (thenSend) await sendFeedback();
      close();
    } finally {
      busy = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void add(e.metaKey || e.ctrlKey); // Ctrl+Enter = add & send
    }
  }
</script>

<!-- Escape closes the popover from anywhere in it — after Edit / Withdraw the
     focus sits on a button (or nowhere), not in the textarea. The textarea's own
     handler stops propagation, so a typed Escape is not handled twice. -->
<svelte:window
  onkeydown={(e) => {
    if ($feedbackCaptureOpen && !$annotateCaptureOpen && e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    }
  }}
/>

{#if $feedbackCaptureOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="fc-scrim" onclick={close}></div>
  <div class="fc" class:with-cap={!!$pendingSnapshot} transition:popIn>
    <div class="fc-head">
      <span class="fc-title">{editing ? "Edit queued note" : "Note to agent"}</span>
      {#if stamp}<span class="fc-stamp" title="Captured with the note">{describeStamp(stamp)}</span>{/if}
    </div>
    {#if editing}
      <div class="fc-editing">Rewriting a queued note — <b>Add to queue</b> replaces it, <b>Escape</b> keeps the original.</div>
    {/if}
    {#if $pendingSnapshot}
      <!-- The attached crop, large enough to read: the note is ABOUT this picture. -->
      <figure class="fc-cap" title="Attached to this note">
        {#if $pendingSnapshot.preview}<img class="fc-cap-img" src={$pendingSnapshot.preview} alt="Snapshot preview" />{/if}
        <figcaption class="fc-cap-row">
          <span class="fc-cap-txt">
            snapshot · {$pendingSnapshot.info.marks.length} mark{$pendingSnapshot.info.marks.length === 1 ? "" : "s"}{$pendingSnapshot.png || $pendingSnapshot.info.image ? "" : " · no screenshot in the browser build"}
          </span>
          <button class="fc-cap-x" type="button" aria-label="Remove snapshot" onclick={clearPendingSnapshot}>×</button>
        </figcaption>
      </figure>
    {/if}
    <textarea
      bind:this={inputEl}
      bind:value={text}
      onkeydown={onKey}
      rows="3"
      placeholder="e.g. “this legend overlaps the curve — move it out”"
      spellcheck="true"></textarea>
    {#if queued.length}
      <!-- The queue itself: what you already added, newest first — a stray Enter
           is one click from Edit or Withdraw (an append-only withdraw line). -->
      <div class="fc-queue" aria-label="Queued notes">
        <div class="fc-queue-head">Queued · {queued.length}</div>
        {#each queued as n (n.id)}
          <div class="fc-q" class:editing={editing?.id === n.id}>
            <div class="fc-q-body">
              <div class="fc-q-text">{n.text}</div>
              {#if n.context}<div class="fc-q-where" title={describeStamp(n.context)}>{describeStamp(n.context)}</div>{/if}
            </div>
            <button class="fc-q-edit" type="button" disabled={busy} onclick={() => void edit(n)} title="Put this note back in the box">Edit</button>
            <button class="fc-q-x" type="button" disabled={busy} onclick={() => void withdraw(n)} title="Take this note out of the queue">Withdraw</button>
          </div>
        {/each}
      </div>
    {/if}
    <div class="fc-foot">
      <span class="fc-open">{openCount} open note{openCount === 1 ? "" : "s"}</span>
      <div class="fc-btns">
        <button class="ghost fc-annot" disabled={busy} onclick={annotate} title="Freeze the window and draw on it (Ctrl+Shift+S)">
          Snapshot &amp; annotate
        </button>
        <button class="ghost" disabled={busy || openCount === 0} onclick={() => void sendFeedback().then(close)}>
          Send {openCount || ""}
        </button>
        <button class="ghost" disabled={busy || !text.trim()} onclick={() => void add(false)} title="Queue this note for the agent (Enter)">
          Add to queue
        </button>
        <button class="primary" disabled={busy || !text.trim()} onclick={() => void add(true)} title="Ctrl+Enter">
          Add &amp; send
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .fc-scrim {
    position: fixed;
    inset: 0;
    z-index: 140;
    background: color-mix(in oklab, var(--flx-black) 10%, transparent);
  }
  .fc {
    position: fixed;
    left: 50%;
    bottom: 12%;
    transform: translateX(-50%);
    z-index: 141;
    width: min(620px, 80%);
    background: var(--c-surface);
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-3);
    box-shadow: var(--elev-3);
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .fc-head {
    display: flex;
    align-items: baseline;
    gap: var(--sp-3);
  }
  .fc-title {
    font-family: var(--font-serif);
    font-size: var(--ts-md);
    color: var(--c-tx-hi);
  }
  .fc-stamp {
    margin-left: auto;
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 60%;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    background: transparent;
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    color: var(--c-tx);
    font: inherit;
    font-size: var(--ts-base);
    padding: 8px 10px;
    outline: none;
  }
  textarea:focus {
    border-color: var(--c-accent);
  }
  /* With a snapshot attached the popover widens and the crop is shown large —
     the note is about that picture, so it must be readable, not a thumbnail. */
  .fc.with-cap {
    width: min(1040px, 94vw);
    max-height: calc(100vh - 32px);
    overflow: auto;
  }
  .fc-cap {
    margin: 0;
    padding: 8px;
    border: 1px solid var(--c-line);
    border-radius: var(--r-1);
    background: var(--c-bg-raised);
  }
  .fc-cap-img {
    display: block;
    max-width: 100%;
    max-height: min(52vh, 620px);
    margin: 0 auto;
    border: 1px solid var(--c-line-strong);
    border-radius: var(--r-ui);
  }
  .fc-cap-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-top: 6px;
  }
  .fc-cap-txt {
    flex: 1;
    min-width: 0;
    font: 11px var(--font-mono);
    color: var(--c-tx-2);
  }
  .fc-cap-x {
    background: none;
    border: 0;
    color: var(--c-tx-muted);
    font-size: 16px;
    line-height: 1;
    padding: 2px 6px;
    cursor: var(--cursor-cross-hover);
  }
  .fc-cap-x:hover {
    color: var(--c-tx-hi);
  }
  .fc-editing {
    font: 11px var(--font-mono);
    color: var(--c-accent);
  }
  .fc-queue {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 30vh;
    overflow: auto;
    border-top: 1px solid var(--c-line);
    padding-top: 6px;
  }
  .fc-queue-head {
    font: 600 10.5px var(--font-mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--c-tx-muted);
    padding: 2px 4px 4px;
  }
  .fc-q {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: var(--r-ui);
  }
  .fc-q:hover {
    background: var(--c-bg-raised);
  }
  .fc-q.editing {
    background: var(--c-accent-tint);
    box-shadow: inset 2px 0 0 var(--c-accent);
  }
  .fc-q-body {
    flex: 1;
    min-width: 0;
  }
  .fc-q-text {
    font-size: var(--ts-sm);
    color: var(--c-tx);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fc-q-where {
    font: 10.5px var(--font-mono);
    color: var(--c-tx-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fc-q-edit,
  .fc-q-x {
    background: none;
    border: 1px solid transparent;
    color: var(--c-tx-2);
    font: 11px var(--font-ui);
    padding: 2px 8px;
  }
  .fc-q-edit:hover:not(:disabled),
  .fc-q-x:hover:not(:disabled) {
    color: var(--c-tx-hi);
    border-color: var(--c-line-strong);
  }
  .fc-foot {
    display: flex;
    align-items: center;
  }
  .fc-open {
    font-size: var(--ts-xs);
    color: var(--c-tx-faint);
  }
  .fc-btns {
    margin-left: auto;
    display: flex;
    gap: 8px;
  }
  button {
    font: inherit;
    font-size: var(--ts-sm);
    border-radius: var(--r-1);
    padding: 5px 12px;
    cursor: var(--cursor-cross-hover);
  }
  button.ghost {
    background: none;
    border: 1px solid var(--c-edge);
    color: var(--c-tx-2);
  }
  button.ghost:hover:not(:disabled) {
    color: var(--c-tx-hi);
    border-color: var(--c-accent);
  }
  button.primary {
    background: var(--c-accent);
    border: 1px solid var(--c-accent);
    color: var(--flx-paper, #fff);
  }
  button:disabled {
    opacity: 0.5;
    cursor: var(--cursor-cross);
  }
</style>
