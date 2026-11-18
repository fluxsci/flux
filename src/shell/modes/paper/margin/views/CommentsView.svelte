<script lang="ts">
  import type { MarginHost, MarginApi } from "../types";

  let { host }: { host: MarginHost; margin: MarginApi } = $props();

  const c = $derived(host.comments);
  // PAP-8: bucket by status, not by mark presence. A RESOLVED thread has no live range (its
  // mark was removed on resolve) but is NOT detached — it belongs in the main list so its
  // Reopen action is reachable. Only a thread that is unresolved, not a draft, and whose
  // anchor no longer resolves in the text is genuinely detached (delete-only).
  const anchored = $derived(c.threads.filter((t) => t.draft || t.resolved || c.ranges.has(t.id)));
  const detached = $derived(c.threads.filter((t) => !t.draft && !t.resolved && !c.ranges.has(t.id)));

  let draftText = $state("");
  let replyingId = $state<string | null>(null);
  let replyText = $state("");

  function submitDraft(id: string) {
    const t = draftText.trim();
    if (t) c.onSubmitNew(id, t);
    else c.onCancelNew(id);
    draftText = "";
  }
  function submitReply(id: string) {
    const t = replyText.trim();
    if (t) c.onReply(id, t);
    replyText = "";
    replyingId = null;
  }
  function timeOf(iso: string): string {
    const d = new Date(iso);
    return isNaN(+d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function initials(name: string): string {
    return name.split(/\s+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
  }
  // Ctrl/⌘+Enter sends, Escape backs out: the composer never needs the mouse.
  function composerKey(e: KeyboardEvent, send: () => void, cancel: () => void) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  }
  const resolvedCount = $derived(c.threads.filter((t) => t.resolved).length);
</script>

<div class="cv mk-pane">
  <div class="head mk-row-flex">
    <span class="count mk-grow"><b class="mk-num">{c.count}</b> open{#if resolvedCount}<span class="dot" aria-hidden="true">·</span><span class="mk-meta">{resolvedCount} resolved</span>{/if}</span>
    <button class="new mk-btn sm" onclick={c.onStart} title="Comment on the selected text (Ctrl+Alt+M)">+ Comment</button>
  </div>

  {#if anchored.length === 0 && detached.length === 0}
    <p class="mk-empty">Select text in the manuscript, then <b>+ Comment</b> to leave a note on it.</p>
  {/if}

  <div class="threads">
    {#each anchored as t (t.id)}
      <div class="card" class:active={t.id === c.activeId} class:resolved={t.resolved}>
        {#if t.draft}
          <div class="composer">
            <!-- svelte-ignore a11y_autofocus -->
            <textarea
              class="mk-textarea"
              rows="3"
              bind:value={draftText}
              placeholder="Add a comment…"
              aria-label="New comment"
              autofocus
              onkeydown={(e) => composerKey(e, () => submitDraft(t.id), () => c.onCancelNew(t.id))}></textarea>
            <div class="mk-foot">
              <span class="mk-hint mk-grow"><kbd>Ctrl ↵</kbd>send</span>
              <button class="mk-btn sm quiet ghost" onclick={() => c.onCancelNew(t.id)}>Cancel</button>
              <button class="mk-btn sm primary" onclick={() => submitDraft(t.id)}>Comment</button>
            </div>
          </div>
        {:else}
          {#if t.resolved}<div class="state mk-eyebrow">Resolved</div>{/if}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="msgs" onclick={() => c.onFocus(t.id)}>
            {#each t.messages as msg}
              <div class="msg">
                <span class="av" aria-hidden="true">{initials(msg.author)}</span>
                <div class="mb">
                  <div class="mh"><span class="who mk-clip">{msg.author}</span><span class="when mk-num">{timeOf(msg.createdAt)}</span></div>
                  <div class="mtext">{msg.body}</div>
                </div>
              </div>
            {/each}
          </div>
          {#if replyingId === t.id}
            <div class="composer reply">
              <!-- svelte-ignore a11y_autofocus -->
              <textarea
                class="mk-textarea"
                rows="2"
                bind:value={replyText}
                placeholder="Reply…"
                aria-label="Reply"
                autofocus
                onkeydown={(e) => composerKey(e, () => submitReply(t.id), () => (replyingId = null))}></textarea>
              <div class="mk-foot">
                <span class="mk-hint mk-grow"><kbd>Ctrl ↵</kbd>send</span>
                <button class="mk-btn sm quiet ghost" onclick={() => (replyingId = null)}>Cancel</button>
                <button class="mk-btn sm primary" onclick={() => submitReply(t.id)}>Reply</button>
              </div>
            </div>
          {:else}
            <div class="acts">
              {#if !t.resolved}
                <button onclick={() => (replyingId = t.id)}>Reply</button>
                <button onclick={() => c.onResolve(t.id)}>Resolve</button>
              {:else}
                <button onclick={() => c.onReopen(t.id)}>Reopen</button>
              {/if}
              <button class="del" onclick={() => c.onDelete(t.id)}>Delete</button>
            </div>
          {/if}
        {/if}
      </div>
    {/each}

    {#if detached.length}
      <div class="detached-h mk-eyebrow" title="Their text is gone from the manuscript">Detached</div>
      {#each detached as t (t.id)}
        <div class="card detached">
          <div class="msgs">
            {#each t.messages.slice(0, 1) as msg}
              <div class="mtext muted">{msg.body}</div>
            {/each}
          </div>
          <div class="acts"><button class="del" onclick={() => c.onDelete(t.id)}>Delete</button></div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .head {
    flex: 0 0 auto;
  }
  .count {
    font-size: var(--ts-sm);
    color: var(--c-tx);
  }
  .count b {
    font-weight: 600;
    font-size: 1em;
  }
  .dot {
    margin: 0 6px;
    color: var(--c-tx-faint);
  }
  .threads {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    margin: 0 -12px -10px;
    padding: 0 0 6px;
    border-top: 1px solid var(--c-line);
    scrollbar-width: thin;
    scrollbar-color: color-mix(in oklab, var(--c-tx) 22%, transparent) transparent;
  }
  /* One thread: a band between hairlines. The thread your caret is in carries the rail. */
  .card {
    padding: 10px 12px 8px 14px;
    border-bottom: 1px solid var(--c-line);
    transition:
      background 80ms linear,
      box-shadow 80ms linear;
  }
  .card:hover {
    background: var(--mk-tint);
  }
  .card.active {
    background: var(--mk-tint);
    box-shadow: inset 2px 0 0 var(--pane-c);
  }
  .card.resolved .msgs {
    opacity: 0.62;
  }
  .state {
    margin-bottom: 6px;
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
  .mtext {
    margin-top: 2px;
    color: var(--c-tx-2);
    font-size: var(--ts-sm);
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .mtext.muted {
    color: var(--c-tx-muted);
    font-style: italic;
  }
  .composer {
    display: grid;
    gap: 6px;
  }
  .composer.reply {
    margin: 9px 0 2px calc(30px * var(--ts-scale, 1));
  }
  .acts {
    display: flex;
    gap: 2px;
    margin: 6px 0 0 calc(24px * var(--ts-scale, 1));
  }
  .card.detached .acts {
    margin-left: -6px;
  }
  .acts button {
    height: calc(22px * var(--ts-scale, 1));
    padding: 0 6px;
    border: 0;
    border-radius: var(--r-1);
    background: none;
    color: var(--c-tx-muted);
    font: var(--ts-xs) var(--font-serif);
    cursor: var(--cursor-cross-hover);
    transition:
      color 80ms linear,
      background 80ms linear;
  }
  .acts button:hover {
    color: var(--pane-c);
    background: var(--mk-tint-2);
  }
  .acts .del:hover {
    color: var(--c-danger);
    background: color-mix(in oklab, var(--c-danger) 10%, transparent);
  }
  .detached-h {
    padding: 10px 12px 4px 14px;
  }
</style>
