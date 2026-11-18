<script lang="ts">
  // One comment thread: what was said, by whom, with everything you can do to it. The same view
  // in the margin's Comments pane and in the card that opens on the highlighted text (owner,
  // 2026-11-18: "hover the comment-highlight, and get a popover card … reply/resolve/edit/delete
  // … right in the popover card"), so a comment reads and answers the same in both places.
  //
  // A NEW comment is written here too: its text, its tags, and where it goes. "Just for me" keeps
  // it out of the AI Inbox (agents are not shown it); "For Flux AI" sends it there.
  import { tick } from "svelte";
  import type { CommentBridge } from "../margin/types";
  import type { CommentMessage, CommentThread } from "./comments";
  import { commentInInbox } from "../../../../lib/project/comments";
  import FluxAiMark from "../../../agent/FluxAiMark.svelte";
  import CommentTags from "./CommentTags.svelte";

  let { thread, api, onOpenInMargin, onDone, lead = false }: {
    thread: CommentThread & { draft?: boolean };
    api: CommentBridge;
    /** Shown as an action when the view is NOT already in the margin. */
    onOpenInMargin?: () => void;
    /** A new comment was sent or dropped (the card closes; the pane does nothing). */
    onDone?: () => void;
    /** This view should take the keyboard when it appears (a card opened to write in). */
    lead?: boolean;
  } = $props();

  const inInbox = $derived(commentInInbox(thread));
  let draftText = $state("");
  let replying = $state(false);
  let replyText = $state("");
  let editing = $state(-1);
  let editText = $state("");
  let root = $state<HTMLElement | undefined>(undefined);

  const focusField = (node: HTMLTextAreaElement) => { node.focus(); node.setSelectionRange(node.value.length, node.value.length); };
  // Once, when it appears: a tag attached to the draft makes a new thread object, and taking
  // the keyboard again then would pull it out of the tag menu mid-word.
  let led = false;
  $effect(() => {
    if (!lead || !thread.draft || led) return;
    led = true;
    void tick().then(() => root?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
  });

  function sendDraft() {
    const text = draftText.trim();
    if (text) api.onSubmitNew(thread.id, text);
    else api.onCancelNew(thread.id);
    draftText = "";
    onDone?.();
  }
  function dropDraft() {
    api.onCancelNew(thread.id);
    onDone?.();
  }
  function sendReply() {
    const text = replyText.trim();
    if (text) api.onReply(thread.id, text);
    replyText = "";
    replying = false;
  }
  function startEdit(index: number, message: CommentMessage) {
    editing = index;
    editText = message.body;
  }
  function saveEdit() {
    const text = editText.trim();
    if (text && text !== thread.messages[editing]?.body) api.onEdit(thread.id, editing, text);
    editing = -1;
  }
  // Ctrl/⌘+Enter sends, Escape backs out: no composer here needs the mouse.
  function composerKey(e: KeyboardEvent, send: () => void, cancel: () => void) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  }
  function timeOf(iso: string): string {
    const d = new Date(iso);
    return isNaN(+d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function initials(name: string): string {
    return name.split(/\s+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
  }
</script>

<!-- Who it is for, as one switch: the same control while writing a comment and after. It wears
     the Flux AI mark because that is what the other choice means (at rest: nothing here moves). -->
{#snippet dest()}
  <button
    class="dest"
    class:ai={inInbox}
    aria-pressed={inInbox}
    aria-label={inInbox ? "For Flux AI" : "Just for me"}
    disabled={thread.resolved}
    title={inInbox ? "For Flux AI: it is in the AI Inbox, where agents can read and answer it. Click to keep it to yourself." : "Just for you: agents are not shown it. Click to send it to the AI Inbox."}
    onclick={(e) => { e.stopPropagation(); api.onInbox(thread.id, !inInbox); }}><FluxAiMark still size={12} tone={inInbox ? "live" : "ready"} /><span>{inInbox ? "For Flux AI" : "Just for me"}</span></button>
{/snippet}

<div class="ct" class:resolved={thread.resolved} bind:this={root} data-comment-thread={thread.id} data-inbox={inInbox}>
  {#if thread.draft}
    <div class="composer">
      <textarea
        class="mk-textarea"
        rows="3"
        bind:value={draftText}
        placeholder={inInbox ? "Ask or tell Flux AI about this passage…" : "A note on this passage…"}
        aria-label="New comment"
        onkeydown={(e) => composerKey(e, sendDraft, dropDraft)}></textarea>
      <CommentTags tags={thread.tags ?? []} defs={api.tagDefs} onChange={(tags) => api.onTags(thread.id, tags)} onDefine={api.onDefineTag} trailing={dest} />
      <div class="mk-foot">
        <span class="mk-hint mk-grow"><kbd>Ctrl ↵</kbd>send</span>
        <button class="mk-btn sm quiet" onclick={dropDraft}>Cancel</button>
        <button class="mk-btn sm primary send" onclick={sendDraft} title="Ctrl+Enter">{inInbox ? "Send to Flux AI" : "Comment"}</button>
      </div>
    </div>
  {:else}
    {#if thread.resolved}<div class="state mk-eyebrow">Resolved</div>{/if}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="msgs" onclick={() => api.onFocus(thread.id)}>
      {#each thread.messages as msg, i}
        <div class="msg" class:agent={msg.kind === "agent"}>
          <span class="av" aria-hidden="true">{initials(msg.author)}</span>
          <div class="mb">
            <div class="mh">
              <span class="who mk-clip">{msg.author}</span><span class="when mk-num" title={msg.editedAt ? `Edited ${timeOf(msg.editedAt)}` : undefined}>{timeOf(msg.createdAt)}{msg.editedAt ? " · edited" : ""}</span>
              {#if msg.kind !== "agent" && !thread.resolved && editing !== i}<button class="mini" aria-label="Edit this message" title="Edit what you wrote" onclick={(e) => { e.stopPropagation(); startEdit(i, msg); }}><svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M3 12.5 3.6 10 10.5 3.1a1.4 1.4 0 0 1 2 0l.4.4a1.4 1.4 0 0 1 0 2L6 12.4 3 12.5Z" /></svg></button>{/if}
            </div>
            {#if editing === i}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <div class="composer inline" onclick={(e) => e.stopPropagation()}>
                <textarea class="mk-textarea" rows="2" bind:value={editText} aria-label="Edit message" use:focusField onkeydown={(e) => composerKey(e, saveEdit, () => (editing = -1))}></textarea>
                <div class="mk-foot"><span class="mk-hint mk-grow"><kbd>Ctrl ↵</kbd>save</span><button class="mk-btn sm quiet" onclick={() => (editing = -1)}>Cancel</button><button class="mk-btn sm primary" onclick={saveEdit}>Save</button></div>
              </div>
            {:else}
              <div class="mtext">{msg.body}</div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
    <!-- What the comment carries besides its words: its tags, and who it is for. -->
    <div class="tagrow"><CommentTags tags={thread.tags ?? []} defs={api.tagDefs} editable={!thread.resolved} onChange={(tags) => api.onTags(thread.id, tags)} onDefine={api.onDefineTag} trailing={dest} /></div>
    {#if replying}
      <div class="composer reply">
        <textarea class="mk-textarea" rows="2" bind:value={replyText} placeholder="Reply…" aria-label="Reply" use:focusField onkeydown={(e) => composerKey(e, sendReply, () => (replying = false))}></textarea>
        <div class="mk-foot">
          <span class="mk-hint mk-grow"><kbd>Ctrl ↵</kbd>send</span>
          <button class="mk-btn sm quiet" onclick={() => (replying = false)}>Cancel</button>
          <button class="mk-btn sm primary" onclick={sendReply}>Reply</button>
        </div>
      </div>
    {:else}
      <div class="acts">
        {#if !thread.resolved}
          <button onclick={() => (replying = true)}>Reply</button>
          <button onclick={() => api.onResolve(thread.id)}>Resolve</button>
        {:else}
          <button onclick={() => api.onReopen(thread.id)}>Reopen</button>
        {/if}
        {#if onOpenInMargin}<button class="tomargin" onclick={onOpenInMargin} title="Open it in the margin's Comments pane (Alt+A)">In margin</button>{/if}
        <span class="mk-grow"></span>
        <button class="del" onclick={() => api.onDelete(thread.id)}>Delete</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .ct {
    display: grid;
    gap: 7px;
    min-width: 0;
  }
  .ct.resolved .msgs,
  .ct.resolved .tagrow {
    opacity: 0.62;
  }
  .state {
    color: var(--c-success);
  }
  .msgs {
    display: grid;
    gap: 9px;
    cursor: var(--cursor-cross-hover);
  }
  .msg {
    display: grid;
    grid-template-columns: calc(22px * var(--ts-scale, 1)) minmax(0, 1fr);
    column-gap: 8px;
    align-items: start;
  }
  .av {
    display: grid;
    place-items: center;
    width: calc(22px * var(--ts-scale, 1));
    height: calc(22px * var(--ts-scale, 1));
    border-radius: 50%;
    background: var(--mk-tint-2);
    color: var(--pane-c);
    font: 600 calc(9.5px * var(--ts-scale, 1)) / 1 var(--font-mono);
    letter-spacing: 0.02em;
  }
  .msg.agent .av {
    background: color-mix(in oklab, var(--c-accent) 14%, transparent);
    color: color-mix(in oklab, var(--c-accent) 78%, var(--c-tx));
  }
  .mb {
    min-width: 0;
  }
  .mh {
    display: flex;
    align-items: baseline;
    gap: 7px;
    min-width: 0;
    line-height: 1.25;
  }
  .who {
    font-size: var(--ts-sm);
    font-weight: 600;
    color: var(--c-tx);
  }
  .when {
    flex: 0 0 auto;
    color: var(--c-tx-faint);
    font-size: calc(10px * var(--ts-scale, 1));
  }
  /* Edit waits for the pointer (or the keyboard) to be on the message. */
  .mini {
    align-self: center;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    margin-left: auto;
    padding: 0;
    border: 0;
    border-radius: var(--r-ui);
    background: none;
    color: var(--c-tx-muted);
    opacity: 0;
    cursor: var(--cursor-cross-hover);
    transition: opacity 80ms linear;
  }
  .mini svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linejoin: round;
  }
  .msg:hover .mini,
  .mini:focus-visible {
    opacity: 1;
  }
  .mini:hover {
    background: var(--mk-tint-2);
    color: var(--pane-c);
  }
  .mtext {
    margin-top: 2px;
    color: var(--c-tx-2);
    font-size: var(--ts-sm);
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .composer {
    display: grid;
    gap: 6px;
  }
  .composer.inline {
    margin-top: 4px;
  }
  .composer.reply,
  .tagrow,
  .acts {
    margin-left: calc(30px * var(--ts-scale, 1));
  }
  /* Who the comment is for: one small switch at the end of the tag row. Quiet while it is
     yours alone; the accent, held as a tint and an edge, once it is in the AI Inbox. */
  .dest {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: calc(18px * var(--ts-scale, 1));
    padding: 0 6px 0 4px;
    border: 1px solid transparent;
    border-radius: var(--r-ui);
    background: none;
    color: var(--c-tx-muted);
    font: var(--ts-xs) / 1 var(--font-serif);
    white-space: nowrap;
    cursor: var(--cursor-cross-hover);
    transition:
      background 80ms linear,
      border-color 80ms linear,
      color 80ms linear;
  }
  .dest:hover:not(:disabled) {
    border-color: var(--mk-edge);
    background: var(--mk-tint);
    color: var(--c-tx);
  }
  .dest.ai {
    border-color: color-mix(in oklab, var(--c-accent) 45%, transparent);
    background: color-mix(in oklab, var(--c-accent) 9%, transparent);
    color: color-mix(in oklab, var(--c-accent) 80%, var(--c-tx));
    font-weight: 600;
  }
  .dest.ai:hover:not(:disabled) {
    border-color: var(--c-accent);
    background: color-mix(in oklab, var(--c-accent) 15%, transparent);
    color: color-mix(in oklab, var(--c-accent) 80%, var(--c-tx));
  }
  .dest:disabled {
    cursor: var(--cursor-cross);
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    margin-top: -1px;
  }
  .acts button {
    height: calc(22px * var(--ts-scale, 1));
    padding: 0 6px;
    border: 0;
    border-radius: var(--r-1);
    background: none;
    color: var(--c-tx-muted);
    font: var(--ts-xs) var(--font-serif);
    white-space: nowrap;
    cursor: var(--cursor-cross-hover);
    transition:
      color 80ms linear,
      background 80ms linear;
  }
  .acts button:first-child {
    margin-left: -6px;
  }
  .acts button:hover {
    color: var(--pane-c);
    background: var(--mk-tint-2);
  }
  .acts .del:hover {
    color: var(--c-danger);
    background: color-mix(in oklab, var(--c-danger) 10%, transparent);
  }
  @media (prefers-reduced-motion: reduce) {
    .mini,
    .dest,
    .acts button {
      transition: none;
    }
  }
</style>
